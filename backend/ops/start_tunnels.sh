#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

ENV_FILE="./.env"
DEFAULT_NGROK_CONFIG_1="${HOME}/.config/ngrok/ngrok.yml"
DEFAULT_NGROK_CONFIG_2="${HOME}/.ngrok2/ngrok.yml"

read_env_value() {
  local file="$1"
  local key="$2"

  if [ ! -f "$file" ]; then
    return 0
  fi

  awk -F= -v search_key="$key" '
    $0 ~ "^[[:space:]]*" search_key "=" {
      sub(/^[[:space:]]*[^=]+=/, "", $0)
      print $0
      exit
    }
  ' "$file"
}

read_yaml_scalar() {
  local file="$1"
  local key="$2"

  if [ ! -f "$file" ]; then
    return 0
  fi

  awk -F': *' -v search_key="$key" '
    $1 == search_key {
      print $2
      exit
    }
  ' "$file"
}

extract_port_from_url() {
  local value="${1:-}"
  if [[ "$value" =~ :([0-9]+)$ ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  fi
}

strip_wrapping_quotes() {
  local value="${1:-}"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  printf '%s' "$value"
}

extract_tunnel_url() {
  local payload="$1"
  local tunnel_name="$2"

  printf '%s' "$payload" | node -e '
    const tunnelName = process.argv[1];
    let input = "";

    process.stdin.on("data", (chunk) => {
      input += chunk;
    });

    process.stdin.on("end", () => {
      try {
        const parsed = JSON.parse(input);
        const tunnels = Array.isArray(parsed.tunnels) ? parsed.tunnels : [];
        const tunnel = tunnels.find((item) => item.name === tunnelName);
        process.stdout.write(tunnel?.public_url ?? "");
      } catch {
        process.stdout.write("");
      }
    });
  ' "$tunnel_name"
}

is_truthy() {
  local value="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  case "$value" in
    1|true|yes|on)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

DEFAULT_NGROK_BIN="ngrok"
if [ -x "./ngrok" ]; then
  DEFAULT_NGROK_BIN="./ngrok"
fi

NGROK_BIN="${NGROK_BIN:-$DEFAULT_NGROK_BIN}"
API_PORT="${PORT:-$(read_env_value "$ENV_FILE" "PORT")}"
API_PORT="${API_PORT:-3000}"
MQTT_LOCAL_PORT="${MQTT_LOCAL_PORT:-$(read_env_value "$ENV_FILE" "MQTT_PORT")}"
MQTT_LOCAL_PORT="${MQTT_LOCAL_PORT:-$(extract_port_from_url "$(read_env_value "$ENV_FILE" "MQTT_URL")")}"
MQTT_LOCAL_PORT="${MQTT_LOCAL_PORT:-1883}"
NGROK_WEB_ADDR="${NGROK_WEB_ADDR:-$(read_env_value "$ENV_FILE" "NGROK_WEB_ADDR")}"
NGROK_WEB_ADDR="${NGROK_WEB_ADDR:-127.0.0.1:4040}"
NGROK_AUTHTOKEN="${NGROK_AUTHTOKEN:-$(read_env_value "$ENV_FILE" "NGROK_AUTHTOKEN")}"
NGROK_AUTHTOKEN="${NGROK_AUTHTOKEN:-$(read_yaml_scalar "$DEFAULT_NGROK_CONFIG_1" "authtoken")}"
NGROK_AUTHTOKEN="${NGROK_AUTHTOKEN:-$(read_yaml_scalar "$DEFAULT_NGROK_CONFIG_2" "authtoken")}"
NGROK_AUTHTOKEN="$(strip_wrapping_quotes "$NGROK_AUTHTOKEN")"
NGROK_API_DOMAIN="${NGROK_API_DOMAIN:-$(read_env_value "$ENV_FILE" "NGROK_API_DOMAIN")}"
NGROK_API_DOMAIN="$(strip_wrapping_quotes "$NGROK_API_DOMAIN")"
NGROK_API_DOMAIN="${NGROK_API_DOMAIN#http://}"
NGROK_API_DOMAIN="${NGROK_API_DOMAIN#https://}"
NGROK_API_DOMAIN="${NGROK_API_DOMAIN%%/*}"
NGROK_ENABLE_MQTT_TUNNEL="${NGROK_ENABLE_MQTT_TUNNEL:-$(read_env_value "$ENV_FILE" "NGROK_ENABLE_MQTT_TUNNEL")}"
NGROK_ENABLE_MQTT_TUNNEL="$(strip_wrapping_quotes "$NGROK_ENABLE_MQTT_TUNNEL")"
NGROK_DEVICE_HINT="${NGROK_DEVICE_HINT:-$(read_env_value "$ENV_FILE" "NGROK_DEVICE_HINT")}"
NGROK_DEVICE_HINT="$(strip_wrapping_quotes "$NGROK_DEVICE_HINT")"

NGROK_API_URL="http://${NGROK_WEB_ADDR}/api/tunnels"
NGROK_LOG_FILE="/tmp/ngrok_backend.log"
TMP_CONFIG_FILE="$(mktemp /tmp/ngrok-backend-XXXXXX.yml)"
NGROK_PID=""

cleanup() {
  rm -f "$TMP_CONFIG_FILE"
  if [ -n "$NGROK_PID" ] && kill -0 "$NGROK_PID" 2>/dev/null; then
    kill "$NGROK_PID" 2>/dev/null || true
    wait "$NGROK_PID" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

if ! command -v "$NGROK_BIN" >/dev/null 2>&1; then
  echo "ngrok was not found in PATH."
  echo "Install ngrok first: https://ngrok.com/download"
  exit 1
fi

if [ -z "$NGROK_AUTHTOKEN" ]; then
  echo "NGROK_AUTHTOKEN is missing."
  echo "Set NGROK_AUTHTOKEN in backend/ops/.env or run: ngrok config add-authtoken <token>"
  exit 1
fi

API_TUNNEL_DOMAIN_BLOCK=""
if [ -n "$NGROK_API_DOMAIN" ]; then
  API_TUNNEL_DOMAIN_BLOCK="    domain: ${NGROK_API_DOMAIN}"
fi

ENABLE_MQTT_TUNNEL=0
if is_truthy "$NGROK_ENABLE_MQTT_TUNNEL"; then
  ENABLE_MQTT_TUNNEL=1
fi

cat > "$TMP_CONFIG_FILE" <<EOF2
version: 2
authtoken: ${NGROK_AUTHTOKEN}
web_addr: ${NGROK_WEB_ADDR}
tunnels:
  api:
    proto: http
    addr: ${API_PORT}
${API_TUNNEL_DOMAIN_BLOCK}
EOF2

if [ "$ENABLE_MQTT_TUNNEL" -eq 1 ]; then
  cat >> "$TMP_CONFIG_FILE" <<EOF2
  mqtt:
    proto: tcp
    addr: ${MQTT_LOCAL_PORT}
EOF2
fi

echo "Starting Backend API Tunnel with ngrok..."
if [ "$ENABLE_MQTT_TUNNEL" -eq 1 ]; then
  echo "MQTT tunnel is enabled for this run."
else
  echo "MQTT tunnel is disabled by default for safety."
fi
"$NGROK_BIN" start --all --config "$TMP_CONFIG_FILE" --log=stdout --log-format=json > "$NGROK_LOG_FILE" 2>&1 &
NGROK_PID=$!

API_PUBLIC_URL=""
MQTT_PUBLIC_URL=""

for _ in $(seq 1 30); do
  if ! kill -0 "$NGROK_PID" 2>/dev/null; then
    echo "ngrok exited unexpectedly. Recent log:"
    tail -n 40 "$NGROK_LOG_FILE" 2>/dev/null || true
    exit 1
  fi

  TUNNELS_JSON="$(curl -fsS "$NGROK_API_URL" 2>/dev/null || true)"
  if [ -n "$TUNNELS_JSON" ]; then
    API_PUBLIC_URL="$(extract_tunnel_url "$TUNNELS_JSON" "api")"
    if [ "$ENABLE_MQTT_TUNNEL" -eq 1 ]; then
      MQTT_PUBLIC_URL="$(extract_tunnel_url "$TUNNELS_JSON" "mqtt")"
    fi

    if [ -n "$API_PUBLIC_URL" ]; then
      if [ "$ENABLE_MQTT_TUNNEL" -eq 0 ] || [ -n "$MQTT_PUBLIC_URL" ]; then
        break
      fi
    fi
  fi

  sleep 1
done

if [ -z "$API_PUBLIC_URL" ]; then
  echo "Unable to fetch ngrok public URL for the API."
  echo "Recent log:"
  tail -n 40 "$NGROK_LOG_FILE" 2>/dev/null || true
  exit 1
fi

if [ "$ENABLE_MQTT_TUNNEL" -eq 1 ] && [ -z "$MQTT_PUBLIC_URL" ]; then
  echo "Unable to fetch ngrok public URL for MQTT."
  echo "Recent log:"
  tail -n 40 "$NGROK_LOG_FILE" 2>/dev/null || true
  exit 1
fi

echo "======================================"
echo "       NGROK TUNNELS ARE RUNNING       "
echo "======================================"
echo ">> HTTP API WAN  :  ${API_PUBLIC_URL}"
echo ">> Dashboard URL :  ${API_PUBLIC_URL}/dashboard"
if [ -n "$NGROK_API_DOMAIN" ]; then
  echo ">> Custom domain :  ${NGROK_API_DOMAIN}"
fi

if [ "$ENABLE_MQTT_TUNNEL" -eq 1 ]; then
  MQTT_BROKER_URL="$(printf '%s' "$MQTT_PUBLIC_URL" | sed 's#^tcp://#mqtt://#')"
  echo ">> MQTT Broker   :  ${MQTT_BROKER_URL}"
else
  echo ">> MQTT Broker   :  not exposed (set NGROK_ENABLE_MQTT_TUNNEL=true to enable)"
fi

if [ -n "$NGROK_DEVICE_HINT" ]; then
  echo ">> Device hint   :  ${NGROK_DEVICE_HINT}"
fi

echo ""
echo "Keep this window open to keep the tunnels alive."
echo "Press Ctrl+C to stop."

wait "$NGROK_PID"
