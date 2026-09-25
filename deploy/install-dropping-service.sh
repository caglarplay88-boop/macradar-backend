#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${MACRADAR_REPO_DIR:-/home/ubuntu/macradar-src-test}"
UNIT_SOURCE="${REPO_DIR}/deploy/systemd/macradar-dropping.service"
UNIT_TARGET="/etc/systemd/system/macradar-dropping.service"
ENV_FILE="/etc/macradar/macradar.env"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo bash deploy/install-dropping-service.sh" >&2
  exit 1
fi

test -f "${UNIT_SOURCE}"
test -f "${ENV_FILE}"
test -f "${REPO_DIR}/src/dropping-watcher.js"
command -v node >/dev/null

install -m 0644 "${UNIT_SOURCE}" "${UNIT_TARGET}"
systemctl daemon-reload
systemctl enable --now macradar-dropping.service
systemctl is-active --quiet macradar-dropping.service
systemctl is-enabled --quiet macradar-dropping.service

echo "macradar-dropping.service installed and active."
