#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${MACRADAR_REPO_DIR:-/home/ubuntu/macradar-src-test}"
SERVICE_SOURCE="${REPO_DIR}/deploy/systemd/macradar-forward-validation.service"
TIMER_SOURCE="${REPO_DIR}/deploy/systemd/macradar-forward-validation.timer"
SERVICE_TARGET="/etc/systemd/system/macradar-forward-validation.service"
TIMER_TARGET="/etc/systemd/system/macradar-forward-validation.timer"
ENV_FILE="/etc/macradar/macradar.env"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo bash deploy/install-forward-validation.sh" >&2
  exit 1
fi

test -f "${SERVICE_SOURCE}"
test -f "${TIMER_SOURCE}"
test -f "${ENV_FILE}"
test -f "${REPO_DIR}/src/run-forward-validation.js"
command -v node >/dev/null

install -m 0644 "${SERVICE_SOURCE}" "${SERVICE_TARGET}"
install -m 0644 "${TIMER_SOURCE}" "${TIMER_TARGET}"

systemctl daemon-reload
systemctl enable --now macradar-forward-validation.timer
systemctl start macradar-forward-validation.service
systemctl is-enabled --quiet macradar-forward-validation.timer
systemctl is-active --quiet macradar-forward-validation.timer

echo "macradar-forward-validation.timer installed and active."

