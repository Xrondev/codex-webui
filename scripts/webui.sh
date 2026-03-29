#!/bin/zsh

set -euo pipefail
setopt typeset_silent

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUN_DIR="$ROOT_DIR/.run"
LOG_DIR="$RUN_DIR/logs"
DEV_PID_FILE="$RUN_DIR/dev.pid"
PROD_PID_FILE="$RUN_DIR/prod.pid"
DEFAULT_PASSWORD="${WEBUI_PASSWORD:-password01}"
DEV_PORTS=(3001)
PROD_PORTS=(3001)

mkdir -p "$LOG_DIR"

cleanup_pid_file() {
  local pid_file="$1"
  if [[ -f "$pid_file" ]]; then
    rm -f "$pid_file"
  fi
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
    echo "LITELLM_API_KEY is missing, but ~/.codex/config.toml is configured with model_provider = \"litellm\"." >&2
    echo "Run: export LITELLM_API_KEY=your_key" >&2
    exit 1
  fi
}

usage() {
  cat <<'EOF'
Usage:
  ./scripts/webui.sh start [dev|prod]
  ./scripts/webui.sh stop [dev|prod|all]
  ./scripts/webui.sh restart [dev|prod]
  ./scripts/webui.sh status

Environment:
  WEBUI_PASSWORD   Password used when starting the service. Default: password01
  WEBUI_WORKSPACE  Default workspace path used when the UI opens
  PORT             HTTP port to bind. Default: 3001
  CODEX_BIN        Explicit path to codex executable
EOF
}

pid_file_for_mode() {
  case "${1:-dev}" in
    dev) echo "$DEV_PID_FILE" ;;
    prod) echo "$PROD_PID_FILE" ;;
    *)
      echo "Unsupported mode: $1" >&2
      exit 1
      ;;
  esac
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

kill_ports() {
  local mode="${1:-all}"
  local -a ports

  case "$mode" in
    dev) ports=("${DEV_PORTS[@]}") ;;
    prod) ports=("${PROD_PORTS[@]}") ;;
    all) ports=("${DEV_PORTS[@]}") ;;
    *)
      echo "Unsupported mode: $mode" >&2
      exit 1
      ;;
  esac

  for port in "${ports[@]}"; do
    local pids
    pids=$(lsof -tiTCP:"$port" -sTCP:LISTEN -n -P 2>/dev/null || true)
    if [[ -n "$pids" ]]; then
      echo "$pids" | while read -r pid; do
        [[ -z "$pid" ]] && continue
        kill_pid_if_running "$pid"
      done
    fi
  done
}

stop_mode() {
  local mode="${1:-all}"

  if [[ "$mode" == "all" ]]; then
    stop_mode dev
    stop_mode prod
    return
  fi

  local pid_file
  pid_file="$(pid_file_for_mode "$mode")"
  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file")"
    kill_pid_if_running "$pid"
  fi

  cleanup_pid_file "$pid_file"

  kill_ports "$mode"
  echo "Stopped $mode service."
}

start_mode() {
  local mode="${1:-dev}"
  local pid_file
  pid_file="$(pid_file_for_mode "$mode")"

  stop_mode "$mode" >/dev/null 2>&1 || true

  cd "$ROOT_DIR"
  ensure_provider_env

  local log_file
  log_file="$LOG_DIR/$mode-$(date +%Y%m%d-%H%M%S).log"

  if [[ "$mode" == "dev" ]]; then
    nohup env WEBUI_PASSWORD="$DEFAULT_PASSWORD" WEBUI_WORKSPACE="${WEBUI_WORKSPACE:-}" PORT="${PORT:-3001}" CODEX_BIN="${CODEX_BIN:-}" npm_config_cache="$ROOT_DIR/.npm-cache" npm run dev \
      >"$log_file" 2>&1 &
  else
    nohup env WEBUI_PASSWORD="$DEFAULT_PASSWORD" WEBUI_WORKSPACE="${WEBUI_WORKSPACE:-}" PORT="${PORT:-3001}" CODEX_BIN="${CODEX_BIN:-}" npm start \
      >"$log_file" 2>&1 &
  fi

  local pid=$!
  echo "$pid" >"$pid_file"

  sleep 2

  if kill -0 "$pid" >/dev/null 2>&1; then
    local -a expected_ports
    case "$mode" in
      dev) expected_ports=("${DEV_PORTS[@]}") ;;
      prod) expected_ports=("${PROD_PORTS[@]}") ;;
      *) expected_ports=() ;;
    esac

    for expected_port in "${expected_ports[@]}"; do
      if ! lsof -tiTCP:"$expected_port" -sTCP:LISTEN -n -P >/dev/null 2>&1; then
        echo "Service failed to bind port $expected_port. See log: $log_file" >&2
        stop_mode "$mode" >/dev/null 2>&1 || true
        exit 1
      fi
    done

    echo "Started $mode service."
    echo "PID: $pid"
    echo "Log: $log_file"
    if [[ "$mode" == "dev" ]]; then
      echo "Open: http://localhost:3001"
    else
      echo "Open: http://localhost:3001"
    fi
  else
    echo "Failed to start $mode service. See log: $log_file" >&2
    exit 1
  fi
}

status_mode() {
  for mode in dev prod; do
    local pid_file
    pid_file="$(pid_file_for_mode "$mode")"
    if [[ -f "$pid_file" ]]; then
      local pid
      pid="$(cat "$pid_file")"
      if kill -0 "$pid" >/dev/null 2>&1; then
        echo "$mode: running (pid $pid)"
      else
        echo "$mode: stale pid file ($pid)"
        cleanup_pid_file "$pid_file"
      fi
    else
      echo "$mode: not running"
    fi
  done

  for port in "${DEV_PORTS[@]}"; do
    local pids
    pids=$(lsof -tiTCP:"$port" -sTCP:LISTEN -n -P 2>/dev/null || true)
    if [[ -n "$pids" ]]; then
      echo "port $port: listening by $(echo "$pids" | tr '\n' ' ' | xargs)"
    else
      echo "port $port: free"
    fi
  done
}

COMMAND="${1:-status}"

default_mode_for_command() {
  case "${1:-status}" in
    start|restart) echo "dev" ;;
    stop) echo "all" ;;
    status) echo "" ;;
    *) echo "dev" ;;
  esac
}

MODE="${2:-$(default_mode_for_command "$COMMAND")}"

case "$COMMAND" in
  start) start_mode "$MODE" ;;
  stop) stop_mode "${MODE:-all}" ;;
  restart)
    stop_mode "$MODE"
    start_mode "$MODE"
    ;;
  status) status_mode ;;
  *) usage ;;
esac
