#!/usr/bin/env bash

set -euo pipefail

SERVICE_NAME="codex-webui"
SERVICE_DIR="$HOME/.config/systemd/user"
ENV_DIR="$HOME/.config/codex-webui"
UNIT_FILE="$SERVICE_DIR/${SERVICE_NAME}.service"
ENV_FILE="$ENV_DIR/${SERVICE_NAME}.env"
REMOVE_ENV=0
DISABLE_LINGER=0

usage() {
  cat <<'EOF'
Usage:
  ./scripts/uninstall-service.sh
  ./scripts/uninstall-service.sh --remove-env
  ./scripts/uninstall-service.sh --disable-linger

Options:
  --remove-env       Also remove ~/.config/codex-webui/codex-webui.env
  --disable-linger   Try to disable loginctl linger for the current user after uninstall
  --help             Show this help text

Notes:
  - This script only removes the user systemd service files.
  - It does not delete the repository, build output, tmux sessions, or npm dependencies.
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --remove-env)
        REMOVE_ENV=1
        shift
        ;;
      --disable-linger)
        DISABLE_LINGER=1
        shift
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        echo "Unknown argument: $1" >&2
        usage
        exit 1
        ;;
    esac
  done
}

stop_and_disable_service() {
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user stop "$SERVICE_NAME" >/dev/null 2>&1 || true
    systemctl --user disable "$SERVICE_NAME" >/dev/null 2>&1 || true
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
}

maybe_disable_linger() {
  if [[ "$DISABLE_LINGER" -ne 1 ]]; then
    return
  fi

  if ! command -v loginctl >/dev/null 2>&1; then
    echo "loginctl not found; skipping linger disable."
    return
  fi

  if loginctl disable-linger "$USER" >/dev/null 2>&1; then
    echo "Disabled user linger for $USER."
  else
    echo "Could not disable linger automatically." >&2
    echo "Run manually if needed: sudo loginctl disable-linger $USER" >&2
  fi
}

parse_args "$@"

stop_and_disable_service

rm -f "$UNIT_FILE"
echo "Removed unit file: $UNIT_FILE"

if [[ "$REMOVE_ENV" -eq 1 ]]; then
  rm -f "$ENV_FILE"
  rmdir "$ENV_DIR" 2>/dev/null || true
  echo "Removed env file: $ENV_FILE"
else
  echo "Kept env file: $ENV_FILE"
fi

maybe_disable_linger

echo
echo "Service uninstall complete."
echo "Remaining useful commands:"
echo "  systemctl --user status $SERVICE_NAME"
echo "  npm run service:install"