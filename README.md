# Codex Web UI

Codex Web UI is a production-focused web wrapper around terminal AI CLIs. It can launch Codex CLI, OpenCode, GitHub Copilot CLI, or Claude Code inside tmux sessions, supports multiple concurrent sessions, and is tuned for both desktop and phone usage.

## Features

- Multiple AI CLI sessions in one UI
- Session type picker for Codex CLI, OpenCode, GitHub Copilot CLI, and Claude Code
- tmux-backed session persistence across service restarts
- Browser reattach to existing tmux sessions
- Working-directory picker before launch
- Responsive desktop and mobile layout
- Touch-friendly quick terminal actions for phones

## Requirements

- Linux
- Node.js 20+
- npm
- tmux 3.x+
- At least one supported CLI on PATH, or an explicit CODEX_BIN, OPENCODE_BIN, COPILOT_BIN, or CLAUDE_BIN

## Scope

This repository now targets production usage only.

- There is no separate dev runtime workflow anymore.
- npm run build produces both client and server bundles.
- scripts/webui.sh manages only the production process.
- Build-time devDependencies are still needed because Vite and TypeScript compile the app.
- No default password or provider API key is stored in this repository.

## Deployment Architecture

The deployed stack is intentionally simple:

- Vite builds the React frontend into dist
- TypeScript builds the Node server into dist-server
- The Node server serves the frontend and exposes REST plus WebSocket endpoints
- Browser terminals attach over WebSocket to a tmux-backed CLI session
- Each managed session runs inside tmux, so service restarts do not kill active work
- A user systemd service starts scripts/webui.sh run on boot
- Secrets live only in ~/.config/codex-webui/codex-webui.env, outside the repository

## Quick Start

```bash
git clone <your-repo-url>
cd codex-webui
./scripts/install.sh --start
```

Default URL: http://localhost:3001

Override the password before exposing the UI beyond a trusted network:

```bash
export WEBUI_PASSWORD='change-me'
export LITELLM_API_KEY='your-litellm-key'   # only if ~/.codex/config.toml uses model_provider = "litellm"
./scripts/install.sh --start
```

## Install

Install dependencies and build the production bundle:

```bash
./scripts/install.sh
```

Install, build, and start immediately:

```bash
./scripts/install.sh --start
```

The installer uses .npm-cache inside the repo to avoid polluting the global npm cache.

## Manual Runtime Commands

Foreground run:

```bash
./scripts/webui.sh run
```

Background process management:

```bash
./scripts/webui.sh start
./scripts/webui.sh stop
./scripts/webui.sh restart
./scripts/webui.sh status
```

## systemd User Service

Install the user service:

```bash
./scripts/install-service.sh
```

What the script does:

- Runs ./scripts/install.sh by default to make sure dependencies and build output are ready
- Prompts interactively for the login password
- Prompts interactively for the current provider API key when required, for example LITELLM_API_KEY
- Creates ~/.config/codex-webui/codex-webui.env if it does not already exist
- Creates ~/.config/systemd/user/codex-webui.service
- Runs systemctl --user daemon-reload and enables the service
- Starts the service immediately unless you pass --no-start
- Tries to enable user lingering so the service can start without an interactive login

Useful options:

```bash
./scripts/install-service.sh --no-start
./scripts/install-service.sh --skip-build
./scripts/install-service.sh --no-linger
```

Uninstall the user service:

```bash
./scripts/uninstall-service.sh
```

Useful uninstall options:

```bash
./scripts/uninstall-service.sh --remove-env
./scripts/uninstall-service.sh --disable-linger
```

If lingering was not enabled automatically, run:

```bash
sudo loginctl enable-linger "$USER"
```

systemd commands:

```bash
systemctl --user status codex-webui
systemctl --user start codex-webui
systemctl --user restart codex-webui
systemctl --user stop codex-webui
journalctl --user -u codex-webui -f
```

Matching npm shortcuts:

```bash
npm run service:install
npm run service:uninstall
npm run service:start
npm run service:stop
npm run service:restart
npm run service:status
npm run service:logs
```

## Service Environment File

The generated environment file is:

```bash
~/.config/codex-webui/codex-webui.env
```

Example contents:

```bash
WEBUI_PASSWORD=change-me
WEBUI_WORKSPACE=/home/you/workspace
PORT=3001
CODEX_BIN=/home/linuxbrew/.linuxbrew/bin/codex
OPENCODE_BIN=/home/you/.local/bin/opencode
COPILOT_BIN=/home/you/bin/copilot
CLAUDE_BIN=/home/you/bin/claude
LITELLM_API_KEY=your_key_here
```

If your Codex provider requires an API key, make sure the matching env key is present in this file. For example, LiteLLM setups usually need LITELLM_API_KEY.

The repository does not store your password or provider key. They are written only to ~/.config/codex-webui/codex-webui.env on the target machine.

After editing the env file, reload the service:

```bash
systemctl --user restart codex-webui
```

## Manual Production Run

```bash
npm run build
export LITELLM_API_KEY='your-litellm-key'   # only if ~/.codex/config.toml uses model_provider = "litellm"
WEBUI_PASSWORD=change-me npm start
```

## Server CLI Flags

The production server also supports direct flags:

```bash
npm start -- --port 3001 --password change-me --workspace ~/project
```

Supported flags:

- --port: HTTP listen port
- --password: login password for the UI
- --workspace: default workspace shown when the UI opens
- --codex-bin: explicit path to the codex binary
- --opencode-bin: explicit path to the OpenCode binary
- --copilot-bin: explicit path to the GitHub Copilot CLI binary
- --claude-bin: explicit path to the Claude Code binary

## Multi-session Workflow

1. Log in to the web UI.
2. Choose a session type, working directory, and optional session label.
3. Click Open session.
4. Switch between running sessions without losing terminal state.
5. Restart the web service if needed; tmux-backed sessions will be rediscovered.

Each app-created session is stored in tmux and tracked by session type, session label, workspace, and tmux session name.

## Notes

- The app can start Codex CLI, OpenCode, GitHub Copilot CLI, or Claude Code inside tmux
- Browser terminals attach to the selected tmux session and use node-pty first, with the bundled Python bridge as fallback
- Existing tmux sessions created by the app are rediscovered through tmux metadata after service restart
- Set CODEX_BIN if codex is not on PATH
- Set OPENCODE_BIN, COPILOT_BIN, or CLAUDE_BIN if those CLIs are not on PATH
- Set WEBUI_WORKSPACE to preload a default working directory
- Do not commit your local ~/.config/codex-webui/codex-webui.env file or any copied secrets into the repository
