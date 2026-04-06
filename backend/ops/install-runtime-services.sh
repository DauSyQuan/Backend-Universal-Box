#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "Please run with sudo:"
  echo "  sudo bash backend/ops/install-runtime-services.sh"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
RUN_USER="${SUDO_USER:-${USER:-tofu}}"
SYSTEMD_DIR="/etc/systemd/system"

if ! id "${RUN_USER}" >/dev/null 2>&1; then
  echo "Run user '${RUN_USER}' does not exist."
  exit 1
fi

mkdir -p "${SYSTEMD_DIR}"

install_unit() {
  local src_name="$1"
  local dest_name="$2"
  sed \
    -e "s#__BACKEND_DIR__#${BACKEND_DIR}#g" \
    -e "s#__RUN_USER__#${RUN_USER}#g" \
    "${SCRIPT_DIR}/systemd/${src_name}" > "${SYSTEMD_DIR}/${dest_name}"
}

install_unit "mcu-mqtt-broker.service" "mcu-mqtt-broker.service"
install_unit "mcu-worker.service" "mcu-worker.service"
install_unit "mcu-api.service" "mcu-api.service"

systemctl daemon-reload
systemctl enable --now mcu-mqtt-broker.service
systemctl enable --now mcu-worker.service
systemctl enable --now mcu-api.service

echo
echo "Realtime backend services installed."
echo "Check status with:"
echo "  systemctl status mcu-mqtt-broker.service"
echo "  systemctl status mcu-worker.service"
echo "  systemctl status mcu-api.service"
echo
echo "Follow logs with:"
echo "  journalctl -u mcu-mqtt-broker.service -f"
echo "  journalctl -u mcu-worker.service -f"
echo "  journalctl -u mcu-api.service -f"
