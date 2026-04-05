#!/usr/bin/env bash
set -euo pipefail

# Installs systemd units for the authoritative orchestrator spine:
#  - ocdash-scheduler.service
#  - ocdash-worker@.service (instances: worker-1, worker-2, worker-3)
#
# Usage:
#   sudo ./scripts/install-systemd-orchestrator.sh \
#     --repo /home/exedev/.openclaw/workspace/opencode-dashboard \
#     --user exedev \
#     --workers worker-1,worker-2,worker-3

REPO_DIR=""
RUN_AS_USER=""
WORKERS_CSV="worker-1,worker-2,worker-3"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO_DIR="$2"; shift 2;;
    --user)
      RUN_AS_USER="$2"; shift 2;;
    --workers)
      WORKERS_CSV="$2"; shift 2;;
    -h|--help)
      sed -n '1,80p' "$0"; exit 0;;
    *)
      echo "Unknown arg: $1" >&2; exit 1;;
  esac
done

if [[ -z "$REPO_DIR" ]]; then
  REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
fi

if [[ -z "$RUN_AS_USER" ]]; then
  # Best-effort default: owner of the repo dir
  RUN_AS_USER="$(stat -c '%U' "$REPO_DIR")"
fi

if [[ $EUID -ne 0 ]]; then
  echo "This script must be run as root (sudo)." >&2
  exit 1
fi

SYSTEMD_DIR="/etc/systemd/system"
TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

render_unit() {
  local in_file="$1"
  local out_file="$2"
  sed \
    -e "s#__REPO_DIR__#${REPO_DIR//\/\\}#g" \
    -e "s#__USER__#${RUN_AS_USER}#g" \
    "$in_file" > "$out_file"
}

UNIT_SRC_DIR="$REPO_DIR/infra/systemd"

for unit in ocdash-scheduler.service ocdash-worker@.service; do
  if [[ ! -f "$UNIT_SRC_DIR/$unit" ]]; then
    echo "Missing unit file: $UNIT_SRC_DIR/$unit" >&2
    exit 1
  fi
  render_unit "$UNIT_SRC_DIR/$unit" "$TMP_DIR/$unit"
  install -m 0644 "$TMP_DIR/$unit" "$SYSTEMD_DIR/$unit"
  echo "Installed: $SYSTEMD_DIR/$unit"
done

systemctl daemon-reload

# Enable + start scheduler
systemctl enable --now ocdash-scheduler.service

# Enable + start workers
IFS=',' read -r -a WORKERS <<< "$WORKERS_CSV"
for w in "${WORKERS[@]}"; do
  systemctl enable --now "ocdash-worker@${w}.service"
done

echo ""
echo "Sorted. Status:"
systemctl --no-pager --full status ocdash-scheduler.service || true
for w in "${WORKERS[@]}"; do
  systemctl --no-pager --full status "ocdash-worker@${w}.service" || true
  echo ""
done
