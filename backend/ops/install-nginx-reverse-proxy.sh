#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "Please run with sudo:"
  echo "  sudo bash backend/ops/install-nginx-reverse-proxy.sh"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env"
NGINX_SITES_AVAILABLE="/etc/nginx/sites-available"
NGINX_SITES_ENABLED="/etc/nginx/sites-enabled"
NGINX_CONF_NAME="mcu-dashboard.conf"
NGINX_CONF_PATH="${NGINX_SITES_AVAILABLE}/${NGINX_CONF_NAME}"
NGINX_ENABLED_PATH="${NGINX_SITES_ENABLED}/${NGINX_CONF_NAME}"
NGINX_UPSTREAM_HOST="${NGINX_UPSTREAM_HOST:-127.0.0.1}"
NGINX_UPSTREAM_PORT="${NGINX_UPSTREAM_PORT:-3000}"
NGINX_LISTEN_PORT="${NGINX_LISTEN_PORT:-80}"
NGINX_SERVER_NAME="${NGINX_SERVER_NAME:-_}"

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

strip_wrapping_quotes() {
  local value="${1:-}"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  printf '%s' "$value"
}

NGINX_UPSTREAM_HOST="${NGINX_UPSTREAM_HOST:-$(read_env_value "$ENV_FILE" "NGINX_UPSTREAM_HOST")}"
NGINX_UPSTREAM_HOST="${NGINX_UPSTREAM_HOST:-127.0.0.1}"
NGINX_UPSTREAM_PORT="${NGINX_UPSTREAM_PORT:-$(read_env_value "$ENV_FILE" "NGINX_UPSTREAM_PORT")}"
NGINX_UPSTREAM_PORT="${NGINX_UPSTREAM_PORT:-3000}"
NGINX_LISTEN_PORT="${NGINX_LISTEN_PORT:-$(read_env_value "$ENV_FILE" "NGINX_LISTEN_PORT")}"
NGINX_LISTEN_PORT="${NGINX_LISTEN_PORT:-80}"
NGINX_SERVER_NAME="${NGINX_SERVER_NAME:-$(read_env_value "$ENV_FILE" "NGINX_SERVER_NAME")}"
NGINX_SERVER_NAME="${NGINX_SERVER_NAME:-_}"

NGINX_UPSTREAM_HOST="$(strip_wrapping_quotes "$NGINX_UPSTREAM_HOST")"
NGINX_UPSTREAM_PORT="$(strip_wrapping_quotes "$NGINX_UPSTREAM_PORT")"
NGINX_LISTEN_PORT="$(strip_wrapping_quotes "$NGINX_LISTEN_PORT")"
NGINX_SERVER_NAME="$(strip_wrapping_quotes "$NGINX_SERVER_NAME")"

if ! command -v nginx >/dev/null 2>&1; then
  echo "[nginx] Installing nginx..."
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y nginx
fi

mkdir -p "$NGINX_SITES_AVAILABLE" "$NGINX_SITES_ENABLED"

TMP_CONF="$(mktemp /tmp/mcu-dashboard-nginx-XXXXXX.conf)"
trap 'rm -f "$TMP_CONF"' EXIT

sed \
  -e "s#__LISTEN_PORT__#${NGINX_LISTEN_PORT}#g" \
  -e "s#__SERVER_NAME__#${NGINX_SERVER_NAME}#g" \
  -e "s#__UPSTREAM_HOST__#${NGINX_UPSTREAM_HOST}#g" \
  -e "s#__UPSTREAM_PORT__#${NGINX_UPSTREAM_PORT}#g" \
  "${SCRIPT_DIR}/nginx/mcu-dashboard.conf.in" > "$TMP_CONF"

install -m 0644 "$TMP_CONF" "$NGINX_CONF_PATH"

if [ ! -L "$NGINX_ENABLED_PATH" ] || [ "$(readlink -f "$NGINX_ENABLED_PATH" 2>/dev/null || true)" != "$NGINX_CONF_PATH" ]; then
  ln -sf "$NGINX_CONF_PATH" "$NGINX_ENABLED_PATH"
fi

if [ -f /etc/nginx/sites-enabled/default ] && [ -z "${NGINX_KEEP_DEFAULT_SITE:-}" ]; then
  rm -f /etc/nginx/sites-enabled/default
fi

nginx -t
systemctl enable --now nginx
systemctl reload nginx

PUBLIC_IP="$(curl -fsS https://api.ipify.org 2>/dev/null || true)"

echo
echo "[nginx] Reverse proxy installed successfully."
echo "[nginx] Listen port : ${NGINX_LISTEN_PORT}"
echo "[nginx] Server name  : ${NGINX_SERVER_NAME}"
echo "[nginx] Upstream     : http://${NGINX_UPSTREAM_HOST}:${NGINX_UPSTREAM_PORT}"
echo "[nginx] Public IP    : ${PUBLIC_IP:-unknown}"
echo
echo "Try this from another machine:"
echo "  http://${PUBLIC_IP:-<server-public-ip>}:${NGINX_LISTEN_PORT}/dashboard"
echo
echo "If you want a domain later, point DNS to the same IP and keep this proxy in front of port 3000."
