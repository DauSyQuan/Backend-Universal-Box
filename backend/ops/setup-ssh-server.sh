#!/bin/bash
set -euo pipefail

if [ "${EUID}" -ne 0 ]; then
  echo "Please run this script with sudo:"
  echo "  sudo bash backend/ops/setup-ssh-server.sh"
  exit 1
fi

ALLOW_USER="${SSH_ALLOW_USER:-tofu}"
SSH_PORT="${SSH_PORT:-22}"
CONFIG_DIR="/etc/ssh/sshd_config.d"
CONFIG_FILE="${CONFIG_DIR}/60-mcu-remote.conf"

echo "[ssh-setup] Installing openssh-server..."
apt update
DEBIAN_FRONTEND=noninteractive apt install -y openssh-server

mkdir -p "${CONFIG_DIR}"

cat > "${CONFIG_FILE}" <<EOF
Port ${SSH_PORT}
PermitRootLogin no
PasswordAuthentication yes
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthorizedKeysFile .ssh/authorized_keys
UsePAM yes
X11Forwarding no
AllowUsers ${ALLOW_USER}
ClientAliveInterval 300
ClientAliveCountMax 2
LoginGraceTime 30
MaxAuthTries 5
EOF

echo "[ssh-setup] Validating sshd config..."
sshd -t

echo "[ssh-setup] Enabling and starting ssh service..."
systemctl enable --now ssh

if command -v ufw >/dev/null 2>&1; then
  UFW_STATUS="$(ufw status 2>/dev/null || true)"
  if printf '%s' "${UFW_STATUS}" | grep -q "^Status: active"; then
    echo "[ssh-setup] UFW is active, allowing SSH port ${SSH_PORT}..."
    ufw allow "${SSH_PORT}/tcp"
  fi
fi

PUBLIC_IP="$(curl -fsS https://api.ipify.org 2>/dev/null || true)"
LISTEN_INFO="$(ss -ltnp | grep -E ":${SSH_PORT}\b" || true)"

echo ""
echo "[ssh-setup] SSH server is ready."
echo "[ssh-setup] Allowed user : ${ALLOW_USER}"
echo "[ssh-setup] SSH port     : ${SSH_PORT}"
echo "[ssh-setup] Public IP    : ${PUBLIC_IP:-unknown}"
echo "[ssh-setup] Listen info  : ${LISTEN_INFO:-not found}"
echo ""
echo "Test from another machine with:"
echo "  ssh ${ALLOW_USER}@${PUBLIC_IP:-<server-public-ip>}"
echo ""
echo "If you prefer ngrok TCP instead of direct SSH:"
echo "  ngrok tcp ${SSH_PORT}"
