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

cat > "$TMP_CONFIG_FILE" <<EOF
version: 2
authtoken: ${NGROK_AUTHTOKEN}
web_addr: ${NGROK_WEB_ADDR}
tunnels:
  api:
    proto: http
    addr: ${API_PORT}
  mqtt:
    proto: tcp
    addr: ${MQTT_LOCAL_PORT}
EOF

echo "Starting Backend MQTT & API Tunnels with ngrok..."
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
    MQTT_PUBLIC_URL="$(extract_tunnel_url "$TUNNELS_JSON" "mqtt")"
    if [ -n "$API_PUBLIC_URL" ] && [ -n "$MQTT_PUBLIC_URL" ]; then
      break
    fi
  fi

  sleep 1
done

if [ -z "$API_PUBLIC_URL" ] || [ -z "$MQTT_PUBLIC_URL" ]; then
  echo "Unable to fetch ngrok public URLs."
  echo "Recent log:"
  tail -n 40 "$NGROK_LOG_FILE" 2>/dev/null || true
  exit 1
fi

MQTT_BROKER_URL="$(printf '%s' "$MQTT_PUBLIC_URL" | sed 's#^tcp://#mqtt://#')"

echo "======================================"
echo "    NGROK TUNNELS STARTED SUCCESSFULLY "
echo "======================================"
echo ">> MQTT Broker WAN:  ${MQTT_BROKER_URL}"
echo ">> HTTP API WAN   :  ${API_PUBLIC_URL}"
echo ">> Dashboard URL  :  ${API_PUBLIC_URL}/dashboard"
echo ""
echo "Please update your MCU at 65.181.17.76 to connect to the above addresses."
echo "Keep this window open to keep the tunnels alive."
echo "Press Ctrl+C to stop."

wait "$NGROK_PID"
