#!/bin/zsh

set -euo pipefail
setopt typeset_silent

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NPM_CACHE_DIR="$ROOT_DIR/.npm-cache"
MODE="dev"
AUTO_START=0

usage() {
  cat <<'EOF'
Usage:
  ./scripts/install.sh
  ./scripts/install.sh --prod
  ./scripts/install.sh --start
  ./scripts/install.sh --start dev
  ./scripts/install.sh --start prod

Options:
  --prod        Install dependencies and build the production bundle
  --start       Start the app after installation. Defaults to dev mode
  --help        Show this help text

Environment:
  WEBUI_PASSWORD   Password used when starting the service
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
      --prod)
        MODE="prod"
        shift
        ;;
      --start)
        AUTO_START=1
        if [[ $# -gt 1 ]] && [[ "$2" != --* ]]; then
          MODE="$2"
          shift 2
        else
          shift
        fi
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      dev|prod)
        MODE="$1"
        shift
        ;;
      *)
        echo "Unknown argument: $1" >&2
        usage
        exit 1
        ;;
    esac
  done

  if [[ "$MODE" != "dev" && "$MODE" != "prod" ]]; then
    echo "Unsupported mode: $MODE" >&2
    exit 1
  fi
}

print_next_steps() {
  echo
  echo "Install complete."
  echo "Next steps:"
  echo "  1. Start dev:  ./scripts/webui.sh start dev"
  echo "  2. Start prod: ./scripts/webui.sh start prod"
  echo "  3. Status:     ./scripts/webui.sh status"
  echo
  echo "Default URL: http://localhost:${PORT:-3001}"
  echo "Default password: ${WEBUI_PASSWORD:-password01}"
}

parse_args "$@"

require_command git "Install Xcode Command Line Tools or Git first."
require_command node "Install Node.js 20+ first."
require_command npm "Install Node.js 20+ first."

if ! command -v codex >/dev/null 2>&1 && [[ -z "${CODEX_BIN:-}" ]]; then
  echo "Warning: codex is not on PATH and CODEX_BIN is not set yet."
  echo "The web UI installs fine, but launching a session will require codex later."
fi

mkdir -p "$NPM_CACHE_DIR"
cd "$ROOT_DIR"

echo "Installing npm dependencies..."
npm_config_cache="$NPM_CACHE_DIR" npm install

if [[ "$MODE" == "prod" ]]; then
  echo "Building production bundle..."
  npm run build
fi

if [[ "$AUTO_START" -eq 1 ]]; then
  echo "Starting $MODE service..."
  "$ROOT_DIR/scripts/webui.sh" start "$MODE"
else
  print_next_steps
fi