#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_NAME="codex-webui"
SERVICE_DIR="$HOME/.config/systemd/user"
ENV_DIR="$HOME/.config/codex-webui"
UNIT_FILE="$SERVICE_DIR/${SERVICE_NAME}.service"
ENV_FILE="$ENV_DIR/${SERVICE_NAME}.env"
AUTO_START=1
AUTO_BUILD=1
TRY_ENABLE_LINGER=1

usage() {
  cat <<'EOF'
Usage:
  ./scripts/install-service.sh
  ./scripts/install-service.sh --no-start
  ./scripts/install-service.sh --skip-build
  ./scripts/install-service.sh --no-linger

Options:
  --no-start     Install and enable the service, but do not start it now
  --skip-build   Skip ./scripts/install.sh before installing the unit
  --no-linger    Do not try loginctl enable-linger for the current user
  --help         Show this help text

Environment:
  WEBUI_PASSWORD   Optional non-interactive password source
  WEBUI_WORKSPACE  Default workspace path written to the service env file if unset
  PORT             HTTP port written to the service env file if unset. Default: 3001
  CODEX_BIN        Explicit codex path written to the service env file if unset
  NPM_BIN          Explicit npm path written to the service env file if unset
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
      --no-start)
        AUTO_START=0
        shift
        ;;
      --skip-build)
        AUTO_BUILD=0
        shift
        ;;
      --no-linger)
        TRY_ENABLE_LINGER=0
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

detect_model_provider() {
  local config="$HOME/.codex/config.toml"
  if [[ ! -f "$config" ]]; then
    echo "openai"
    return
  fi

  awk -F'"' '/^[[:space:]]*model_provider[[:space:]]*=/ {print $2; exit}' "$config"
}

detect_provider_env_key() {
  local config="$HOME/.codex/config.toml"
  local provider="$1"

  if [[ ! -f "$config" || -z "$provider" ]]; then
    return
  fi

  python3 - <<'PY' "$config" "$provider"
from pathlib import Path
import sys

config_path = Path(sys.argv[1])
provider = sys.argv[2]
section = f"[model_providers.{provider}]"
in_section = False

for raw_line in config_path.read_text().splitlines():
    line = raw_line.strip()
    if not line or line.startswith("#"):
        continue
    if line.startswith("["):
        if in_section:
            break
        in_section = line == section
        continue
    if in_section and line.startswith("env_key") and '"' in line:
        value = line.split('"', 2)[1]
        if value:
            print(value)
            break
PY
}

upsert_env_line() {
  local key="$1"
  local value="$2"

  [[ -z "$key" || -z "$value" ]] && return

  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    python3 - <<'PY' "$ENV_FILE" "$key" "$value"
from pathlib import Path
import sys
path = Path(sys.argv[1])
key = sys.argv[2]
value = sys.argv[3]
lines = path.read_text().splitlines()
updated = []
replaced = False
for line in lines:
    if line.startswith(f"{key}="):
        updated.append(f"{key}={value}")
        replaced = True
    else:
        updated.append(line)
if not replaced:
    updated.append(f"{key}={value}")
path.write_text("\n".join(updated) + "\n")
PY
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

read_env_value() {
  local key="$1"

  if [[ ! -f "$ENV_FILE" ]]; then
    return
  fi

  python3 - <<'PY' "$ENV_FILE" "$key"
from pathlib import Path
import sys

path = Path(sys.argv[1])
key = sys.argv[2]
for line in path.read_text().splitlines():
    if line.startswith(f"{key}="):
        print(line.split("=", 1)[1])
        break
PY
}

resolve_secret_value() {
  local key="$1"
  local prompt_label="$2"
  local env_value="${!key:-}"
  local existing_value="$(read_env_value "$key")"
  local default_value="${env_value:-$existing_value}"
  local entered_value=""

  if [[ -t 0 && -t 1 ]]; then
    if [[ -n "$default_value" ]]; then
      printf "%s (press Enter to keep existing value): " "$prompt_label" >&2
    else
      printf "%s: " "$prompt_label" >&2
    fi
    read -r -s entered_value
    printf "\n" >&2
  fi

  local resolved_value="${entered_value:-$default_value}"
  if [[ -z "$resolved_value" ]]; then
    echo "$prompt_label is required." >&2
    exit 1
  fi

  printf '%s' "$resolved_value"
}

ensure_env_file() {
  mkdir -p "$ENV_DIR"

  local resolved_codex_bin="${CODEX_BIN:-}"
  local resolved_npm_bin="${NPM_BIN:-}"
  local provider
  local provider_env_key
  local provider_env_value=""
  local password_value

  if [[ -z "$resolved_codex_bin" ]]; then
    resolved_codex_bin="$(command -v codex || true)"
  fi

  if [[ -z "$resolved_npm_bin" ]]; then
    resolved_npm_bin="$(command -v npm || true)"
  fi

  provider="$(detect_model_provider)"
  provider_env_key="$(detect_provider_env_key "$provider")"
  password_value="$(resolve_secret_value "WEBUI_PASSWORD" "Enter login password")"
  if [[ -n "$provider_env_key" ]]; then
    provider_env_value="$(resolve_secret_value "$provider_env_key" "Enter ${provider_env_key}")"
  fi

  mkdir -p "$ENV_DIR"
  touch "$ENV_FILE"

  upsert_env_line "WEBUI_PASSWORD" "$password_value"
  upsert_env_line "WEBUI_WORKSPACE" "${WEBUI_WORKSPACE:-$ROOT_DIR}"
  upsert_env_line "PORT" "${PORT:-3001}"
  upsert_env_line "CODEX_BIN" "$resolved_codex_bin"
  upsert_env_line "NPM_BIN" "$resolved_npm_bin"
  upsert_env_line "$provider_env_key" "$provider_env_value"

  chmod 600 "$ENV_FILE"
  echo "Updated env file: $ENV_FILE"
}

write_unit_file() {
  mkdir -p "$SERVICE_DIR"

  cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Codex Web UI
After=network.target
Wants=network.target

[Service]
Type=simple
WorkingDirectory=$ROOT_DIR
Environment=PATH=$PATH
EnvironmentFile=%h/.config/codex-webui/${SERVICE_NAME}.env
ExecStart=$ROOT_DIR/scripts/webui.sh run
Restart=on-failure
RestartSec=3
TimeoutStopSec=15

[Install]
WantedBy=default.target
EOF

  echo "Wrote service unit: $UNIT_FILE"
}

maybe_enable_linger() {
  if [[ "$TRY_ENABLE_LINGER" -ne 1 ]]; then
    return
  fi

  if ! command -v loginctl >/dev/null 2>&1; then
    echo "loginctl not found; skipping linger setup."
    return
  fi

  if loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q 'Linger=yes'; then
    echo "User linger is already enabled."
    return
  fi

  if loginctl enable-linger "$USER" >/dev/null 2>&1; then
    echo "Enabled user linger for $USER."
  else
    echo "Could not enable linger automatically." >&2
    echo "To start the user service at boot without an interactive login, run:" >&2
    echo "  sudo loginctl enable-linger $USER" >&2
  fi
}

stop_existing_manual_service() {
  if [[ -x "$ROOT_DIR/scripts/webui.sh" ]]; then
    "$ROOT_DIR/scripts/webui.sh" stop >/dev/null 2>&1 || true
  fi
}

reload_and_enable_service() {
  stop_existing_manual_service
  systemctl --user daemon-reload
  systemctl --user enable "$SERVICE_NAME" >/dev/null
  echo "Enabled systemd user service: $SERVICE_NAME"

  if [[ "$AUTO_START" -eq 1 ]]; then
    systemctl --user restart "$SERVICE_NAME"
    echo "Started systemd user service: $SERVICE_NAME"
  fi
}

print_next_steps() {
  echo
  echo "Service install complete."
  echo "Useful commands:"
  echo "  systemctl --user status $SERVICE_NAME"
  echo "  systemctl --user restart $SERVICE_NAME"
  echo "  journalctl --user -u $SERVICE_NAME -f"
  echo
  echo "NPM shortcuts:"
  echo "  npm run service:install"
  echo "  npm run service:start"
  echo "  npm run service:restart"
  echo "  npm run service:status"
}

parse_args "$@"

require_command systemctl "Install systemd first."
require_command node "Install Node.js 20+ first."
require_command npm "Install Node.js 20+ first."
require_command python3 "Install Python 3 first."

if [[ "$AUTO_BUILD" -eq 1 ]]; then
  "$ROOT_DIR/scripts/install.sh"
fi

ensure_env_file
write_unit_file
maybe_enable_linger
reload_and_enable_service
print_next_steps
