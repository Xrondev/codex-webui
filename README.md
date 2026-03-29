# Codex Web UI

A minimal web wrapper around the locally installed `codex` CLI.

## Features

- Password-only auth with a single local user model.
- Pick a server-side working directory before launching Codex.
- Reuse the real `codex` terminal flow, including slash commands, thinking output, and tool logs.
- Responsive layout for desktop and mobile browsers.
- Mobile-friendly command bar in addition to direct terminal keyboard input.

## Quick Start

```bash
git clone <your-repo-url>
cd codex-webui
./scripts/install.sh --start dev
```

App: `http://localhost:3001`

What this does:

- Installs npm dependencies into the local project.
- Reuses `.npm-cache` inside the repo to avoid polluting the global cache.
- Starts the development server through the existing service wrapper.

Requirements:

- Node.js 20+
- npm
- Local `codex` CLI on `PATH`, or set `CODEX_BIN=/path/to/codex`

Default password used by the service scripts is `password01`, unless you override `WEBUI_PASSWORD`.

## Install Only

```bash
./scripts/install.sh
```

For a production build:

```bash
./scripts/install.sh --prod
```

This installs dependencies and, in `--prod` mode, also runs the frontend/server build.

## Quick Service Script

```bash
./scripts/webui.sh start dev
./scripts/webui.sh stop all
./scripts/webui.sh restart dev
./scripts/webui.sh status
```

## Production build

```bash
npm run build
WEBUI_PASSWORD=change-me npm start
```

Production app: `http://localhost:3001`

## CLI Options

The server supports direct startup arguments:

```bash
npm start -- --port 3001 --password change-me --workspace ~/project
```

Supported flags:

- `--port` HTTP listen port.
- `--password` Login password for the UI.
- `--workspace` Default workspace shown when the UI opens.
- `--codex-bin` Explicit path to the `codex` binary.

## Notes

- The app shells out to `codex --no-alt-screen -C <workspace>`.
- The server tries `node-pty` first and falls back to the bundled Python PTY bridge when needed.
- Set `CODEX_BIN` if `codex` is not on `PATH`.
- Set `WEBUI_WORKSPACE` to preload a default working directory.
- Default password is `codex-webui` if `WEBUI_PASSWORD` is unset. Change it before exposing the UI beyond a trusted network.
