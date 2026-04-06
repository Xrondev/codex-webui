#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUN_DIR="$ROOT_DIR/.run"
LOG_DIR="$RUN_DIR/logs"
PID_FILE="$RUN_DIR/webui.pid"
SERVICE_ENV_FILE="${WEBUI_ENV_FILE:-$HOME/.config/codex-webui/codex-webui.env}"

if [[ -f "$SERVICE_ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$SERVICE_ENV_FILE"
  set +a
fi

PORT_VALUE="${PORT:-3001}"
PASSWORD_VALUE="${WEBUI_PASSWORD:-}"
NPM_BIN_VALUE="${NPM_BIN:-$(command -v npm || true)}"

mkdir -p "$LOG_DIR"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/webui.sh run
  ./scripts/webui.sh start
  ./scripts/webui.sh stop
  ./scripts/webui.sh restart
  ./scripts/webui.sh status

Commands:
  run       Run the production server in the foreground. Used by systemd.
  start     Start the production server in the background.
  stop      Stop the running background server.
  restart   Restart the background server.
  status    Show current pid and port status.

Environment:
  WEBUI_PASSWORD   Login password. Required unless already stored in ~/.config/codex-webui/codex-webui.env
  WEBUI_WORKSPACE  Default workspace path shown in the UI
  PORT             HTTP port to bind. Default: 3001
  CODEX_BIN        Explicit path to the codex executable
  WEBUI_ENV_FILE   Optional alternate env file path for local secrets
EOF
}

cleanup_pid_file() {
  rm -f "$PID_FILE"
}

detect_model_provider() {
  local config="$HOME/.codex/config.toml"
  if [[ ! -f "$config" ]]; then
    echo "openai"
    return
  fi

  awk -F'"' '/^[[:space:]]*model_provider[[:space:]]*=/ {print $2; exit}' "$config"
}

ensure_provider_env() {
  local provider
  provider="$(detect_model_provider)"

  if [[ "$provider" == "litellm" ]] && [[ -z "${LITELLM_API_KEY:-}" ]]; then
    echo "LITELLM_API_KEY is missing, but ~/.codex/config.toml uses model_provider = \"litellm\"." >&2
    echo "Set it in the environment or in $SERVICE_ENV_FILE." >&2
    exit 1
  fi
}

ensure_runtime_env() {
  if [[ -z "$PASSWORD_VALUE" ]]; then
    echo "WEBUI_PASSWORD is required." >&2
    echo "Set it in the environment or in $SERVICE_ENV_FILE." >&2
    exit 1
  fi
}

ensure_build_ready() {
  if [[ ! -f "$ROOT_DIR/dist-server/index.js" ]] || [[ ! -f "$ROOT_DIR/dist/index.html" ]]; then
    echo "Production build is missing. Run ./scripts/install.sh or npm run build first." >&2
    exit 1
  fi

  if [[ -z "$NPM_BIN_VALUE" ]]; then
    echo "npm was not found on PATH. Set NPM_BIN=/absolute/path/to/npm if needed." >&2
    exit 1
  fi
}

kill_pid_if_running() {
  local pid="$1"
  if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
    sleep 1
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill -9 "$pid" >/dev/null 2>&1 || true
    fi
  fi
}

stop_service() {
  if [[ -f "$PID_FILE" ]]; then
    kill_pid_if_running "$(cat "$PID_FILE")"
  fi

  cleanup_pid_file

  local pids
  pids=$(lsof -tiTCP:"$PORT_VALUE" -sTCP:LISTEN -n -P 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    while read -r pid; do
      [[ -z "$pid" ]] && continue
      kill_pid_if_running "$pid"
    done <<< "$pids"
  fi

  echo "Stopped production service."
}

run_foreground() {
  cd "$ROOT_DIR"
  ensure_runtime_env
  ensure_provider_env
  ensure_build_ready
  exec env \
    WEBUI_PASSWORD="$PASSWORD_VALUE" \
    WEBUI_WORKSPACE="${WEBUI_WORKSPACE:-}" \
    PORT="$PORT_VALUE" \
    CODEX_BIN="${CODEX_BIN:-}" \
    "$NPM_BIN_VALUE" start
}

start_service() {
  stop_service >/dev/null 2>&1 || true

  cd "$ROOT_DIR"
  ensure_runtime_env
  ensure_provider_env
  ensure_build_ready

  local log_file="$LOG_DIR/prod-$(date +%Y%m%d-%H%M%S).log"
  nohup env \
    WEBUI_PASSWORD="$PASSWORD_VALUE" \
    WEBUI_WORKSPACE="${WEBUI_WORKSPACE:-}" \
    PORT="$PORT_VALUE" \
    CODEX_BIN="${CODEX_BIN:-}" \
    "$NPM_BIN_VALUE" start >"$log_file" 2>&1 &

  local pid=$!
  echo "$pid" > "$PID_FILE"
  sleep 2

  if ! kill -0 "$pid" >/dev/null 2>&1; then
    echo "Failed to start production service. See log: $log_file" >&2
    exit 1
  fi

  if ! lsof -tiTCP:"$PORT_VALUE" -sTCP:LISTEN -n -P >/dev/null 2>&1; then
    echo "Service failed to bind port $PORT_VALUE. See log: $log_file" >&2
    stop_service >/dev/null 2>&1 || true
    exit 1
  fi

  echo "Started production service."
  echo "PID: $pid"
  echo "Log: $log_file"
  echo "Open: http://localhost:$PORT_VALUE"
}

status_service() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE")"
    if kill -0 "$pid" >/dev/null 2>&1; then
      echo "prod: running (pid $pid)"
    else
      echo "prod: stale pid file ($pid)"
      cleanup_pid_file
    fi
  else
    echo "prod: not running"
  fi

  local pids
  pids=$(lsof -tiTCP:"$PORT_VALUE" -sTCP:LISTEN -n -P 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    echo "port $PORT_VALUE: listening by $(echo "$pids" | tr '\n' ' ' | xargs)"
  else
    echo "port $PORT_VALUE: free"
  fi
}

COMMAND="${1:-status}"

case "$COMMAND" in
  run) run_foreground ;;
  start) start_service ;;
  stop) stop_service ;;
  restart)
    stop_service
    start_service
    ;;
  status) status_service ;;
  *)
    usage
    exit 1
    ;;
esac
