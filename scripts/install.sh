#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NPM_CACHE_DIR="$ROOT_DIR/.npm-cache"
AUTO_START=0

usage() {
  cat <<'EOF'
Usage:
  ./scripts/install.sh
  ./scripts/install.sh --start

Options:
  --start       Start the production service after install and build
  --help        Show this help text

Environment:
  WEBUI_PASSWORD   Login password used by manual start if no service env file exists
  WEBUI_WORKSPACE  Default workspace path shown in the UI
  PORT             HTTP port to bind. Default: 3001
  CODEX_BIN        Explicit path to the codex executable
EOF
}

require_command() {
  local command_name="$1"
  local install_hint="$2"

  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "$command_name is required. $install_hint" >&2
    exit 1
  fi
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --start)
        AUTO_START=1
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

print_next_steps() {
  echo
  echo "Install complete."
  echo "Next steps:"
  echo "  1. Start app:        ./scripts/webui.sh start"
  echo "  2. Install service:  ./scripts/install-service.sh"
  echo "  3. Service status:   ./scripts/webui.sh status"
  echo
  echo "Default URL: http://localhost:${PORT:-3001}"
  echo "Login password: set WEBUI_PASSWORD or run ./scripts/install-service.sh to be prompted safely."
  echo "Provider key: if ~/.codex/config.toml uses litellm, set LITELLM_API_KEY or use ./scripts/install-service.sh."
}

parse_args "$@"

require_command git "Install Git first."
require_command node "Install Node.js 20+ first."
require_command npm "Install Node.js 20+ first."
require_command tmux "Install tmux 3.x+ first."

if ! command -v codex >/dev/null 2>&1 && [[ -z "${CODEX_BIN:-}" ]]; then
  echo "Warning: codex is not on PATH and CODEX_BIN is not set yet."
  echo "The web UI can build now, but opening sessions will require codex later."
fi

mkdir -p "$NPM_CACHE_DIR"
cd "$ROOT_DIR"

echo "Installing npm dependencies..."
npm_config_cache="$NPM_CACHE_DIR" npm install

echo "Building production bundle..."
npm run build

if [[ "$AUTO_START" -eq 1 ]]; then
  echo "Starting production service..."
  "$ROOT_DIR/scripts/webui.sh" start
else
  print_next_steps
fi
