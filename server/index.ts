import cookieParser from "cookie-parser";
import express, { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { ViteDevServer } from "vite";
import { spawn as spawnPty } from "node-pty";

type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "ping" };

type CodexSessionSummary = {
  id: string;
  label: string;
  workspace: string;
  tmuxSession: string;
  running: boolean;
  createdAt: number;
  lastActivity: number;
  attachedClients: number;
  preview: string;
};

type ServerMessage =
  | { type: "snapshot"; data: string; session: CodexSessionSummary }
  | { type: "output"; data: string; sessionId: string }
  | { type: "exit"; exitCode: number; signal?: number; sessionId: string }
  | { type: "status"; sessionId: string; session: CodexSessionSummary | null }
  | { type: "error"; message: string; sessionId?: string };

type ProviderConfigSummary = {
  modelProvider: string;
  baseUrl?: string;
  envKey?: string;
  envKeyPresent: boolean;
};

type RuntimeConfig = {
  codexBin?: string;
  defaultPassword: string;
  defaultWorkspace: string;
  port: number;
};

type AuthSession = {
  token: string;
  createdAt: number;
};

type TerminalBridge = {
  kill(signal?: string): void;
  resize(cols: number, rows: number): void;
  write(data: string): void;
};

type SessionLookup = {
  sessions: CodexSessionSummary[];
  tmuxAvailable: boolean;
  tmuxError?: string;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const distDir = path.resolve(rootDir, "dist");
const ptyBridgePath = path.resolve(rootDir, "server", "pty_bridge.py");
const homeDir = os.homedir();
const sessionCookieName = "codex_webui_session";
const sandboxRestricted = Boolean(process.env.CODEX_SANDBOX);
const restrictionMessage = sandboxRestricted
  ? "This Web UI server was started inside a Codex sandbox, so it cannot launch nested Codex sessions. Start the server from your own terminal instead."
  : undefined;
const codexConfigPath = path.join(homeDir, ".codex", "config.toml");
const tmuxSessionPrefix = "codex-webui";
const tmuxMetadataPrefix = "@codex_webui";

function readArgValue(argv: string[], index: number) {
  const current = argv[index] ?? "";
  const equalIndex = current.indexOf("=");
  if (equalIndex >= 0) {
    return current.slice(equalIndex + 1);
  }

  const next = argv[index + 1];
  if (!next || next.startsWith("--")) {
    return "";
  }

  return next;
}

function parseRuntimeConfig(argv: string[]): RuntimeConfig {
  let parsedPort: number | undefined;
  let parsedPassword: string | undefined;
  let parsedWorkspace: string | undefined;
  let parsedCodexBin: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg.startsWith("--port")) {
      const value = readArgValue(argv, index);
      if (value) {
        parsedPort = Number(value);
      }
      if (!arg.includes("=") && value) {
        index += 1;
      }
      continue;
    }

    if (arg.startsWith("--password")) {
      const value = readArgValue(argv, index);
      if (value) {
        parsedPassword = value;
      }
      if (!arg.includes("=") && value) {
        index += 1;
      }
      continue;
    }

    if (arg.startsWith("--workspace")) {
      const value = readArgValue(argv, index);
      if (value) {
        parsedWorkspace = value;
      }
      if (!arg.includes("=") && value) {
        index += 1;
      }
      continue;
    }

    if (arg.startsWith("--codex-bin")) {
      const value = readArgValue(argv, index);
      if (value) {
        parsedCodexBin = value;
      }
      if (!arg.includes("=") && value) {
        index += 1;
      }
    }
  }

  const port = parsedPort ?? Number(process.env.PORT ?? 3001);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid --port value: ${String(parsedPort ?? process.env.PORT ?? "")}`);
  }

  const defaultWorkspace = path.resolve(parsedWorkspace ?? process.env.WEBUI_WORKSPACE ?? homeDir);
  if (!fs.existsSync(defaultWorkspace) || !fs.statSync(defaultWorkspace).isDirectory()) {
    throw new Error(`Invalid --workspace value: ${defaultWorkspace}`);
  }

  return {
    codexBin: parsedCodexBin ?? process.env.CODEX_BIN,
    defaultPassword: parsedPassword ?? process.env.WEBUI_PASSWORD ?? "codex-webui",
    defaultWorkspace,
    port,
  };
}

const runtimeConfig = parseRuntimeConfig(process.argv.slice(2));
const defaultPassword = runtimeConfig.defaultPassword;
const port = runtimeConfig.port;
const defaultWorkspace = runtimeConfig.defaultWorkspace;
const authSessions = new Map<string, AuthSession>();

const app = express();
const server = http.createServer(app);
const wsServer = new WebSocketServer({ noServer: true });
const isDevelopment = process.env.NODE_ENV !== "production";

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

function resolveCodexCommand(explicit?: string) {
  if (explicit) {
    return explicit;
  }

  const candidates = [
    ...String(process.env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((segment) => path.join(segment, "codex")),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ];

  const match = candidates.find((candidate) => fs.existsSync(candidate));
  return match ?? "codex";
}

const codexCommand = resolveCodexCommand(runtimeConfig.codexBin);

function readProviderSummary(): ProviderConfigSummary {
  let text = "";
  try {
    text = fs.readFileSync(codexConfigPath, "utf8");
  } catch {
    return {
      modelProvider: "openai",
      envKeyPresent: Boolean(process.env.OPENAI_API_KEY),
    };
  }

  const providerMatch = text.match(/^\s*model_provider\s*=\s*"([^"]+)"/m);
  const modelProvider = providerMatch?.[1] ?? "openai";
  const sectionPattern = new RegExp(
    String.raw`^\[model_providers\.${modelProvider.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\]([\s\S]*?)(?=^\[|\Z)`,
    "m",
  );
  const section = text.match(sectionPattern)?.[1] ?? "";
  const baseUrl = section.match(/^\s*base_url\s*=\s*"([^"]+)"/m)?.[1];
  const envKey = section.match(/^\s*env_key\s*=\s*"([^"]+)"/m)?.[1];

  return {
    modelProvider,
    baseUrl,
    envKey,
    envKeyPresent: envKey ? Boolean(process.env[envKey]) : false,
  };
}

function createCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: false,
    path: "/",
  };
}

function parseSessionToken(req: Request): string | undefined {
  return req.cookies?.[sessionCookieName];
}

function authRequired(req: Request, res: Response, next: () => void) {
  const token = parseSessionToken(req);
  if (!token || !authSessions.has(token)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}

function normalizeDirectory(inputPath?: string): string {
  if (!inputPath) {
    return defaultWorkspace;
  }

  const trimmed = inputPath.trim();
  if (!trimmed) {
    return defaultWorkspace;
  }

  if (trimmed === "~") {
    return homeDir;
  }

  if (trimmed.startsWith("~/")) {
    return path.resolve(homeDir, trimmed.slice(2));
  }

  return path.resolve(trimmed);
}

function listDirectories(targetPath?: string) {
  const resolved = normalizeDirectory(targetPath);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error("Not a directory");
  }

  const entries = fs
    .readdirSync(resolved, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(resolved, entry.name);

      if (entry.isDirectory()) {
        return [
          {
            name: entry.name,
            path: entryPath,
            isSymlink: false,
          },
        ];
      }

      if (!entry.isSymbolicLink()) {
        return [];
      }

      try {
        const targetStat = fs.statSync(entryPath);
        if (!targetStat.isDirectory()) {
          return [];
        }

        return [
          {
            name: entry.name,
            path: entryPath,
            isSymlink: true,
            targetPath: fs.realpathSync(entryPath),
          },
        ];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    current: resolved,
    parent: resolved === path.parse(resolved).root ? null : path.dirname(resolved),
    children: entries,
  };
}

function buildCodexChildEnv() {
  const filteredEntries = Object.entries(process.env).filter(([key]) => !key.startsWith("CODEX_"));
  const env = Object.fromEntries(filteredEntries) as NodeJS.ProcessEnv;
  const pathEntries = String(env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .filter((entry) => !entry.includes("/.codex/tmp/arg0/"));

  return {
    ...env,
    PATH: pathEntries.join(path.delimiter),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TMUX: "",
  };
}

function sanitizeSessionLabel(input: string) {
  return input.trim().replace(/\s+/g, " ").slice(0, 64);
}

function slugify(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
}

function shellEscape(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function runCommand(command: string, args: string[], env?: NodeJS.ProcessEnv) {
  return spawnSync(command, args, {
    encoding: "utf8",
    env,
  });
}

function runTmux(args: string[], options?: { allowFailure?: boolean; env?: NodeJS.ProcessEnv }) {
  const result = runCommand("tmux", args, options?.env);
  const stderr = result.stderr?.trim() ?? "";

  if (result.error) {
    const error = result.error as NodeJS.ErrnoException;
    if (options?.allowFailure) {
      return "";
    }

    if (error.code === "ENOENT") {
      throw new Error("tmux is required but was not found on PATH");
    }

    throw error;
  }

  if (result.status !== 0) {
    if (options?.allowFailure) {
      return "";
    }

    throw new Error(stderr || `tmux ${args[0]} failed`);
  }

  return result.stdout?.trimEnd() ?? "";
}

function isTmuxUnavailable(error: unknown) {
  return error instanceof Error && error.message.includes("tmux is required");
}

function coerceTmuxTimestamp(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Date.now();
  }

  return parsed < 1_000_000_000_000 ? parsed * 1000 : parsed;
}

function buildSessionPreview(tmuxSession: string) {
  try {
    const output = runTmux(["capture-pane", "-p", "-J", "-S", "-12", "-t", tmuxSession], {
      allowFailure: true,
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-3)
      .join(" ")
      .slice(0, 240);
  } catch {
    return "";
  }
}

function parseCodexSessionLine(line: string): CodexSessionSummary | null {
  const parts = line.split("\t");
  if (parts.length < 9) {
    return null;
  }

  const [tmuxSession, managedFlag, sessionId, labelValue, storedWorkspace, fallbackWorkspace, createdAt, lastActivity, attachedClients] = parts;
  const managed = managedFlag === "1" || tmuxSession.startsWith(`${tmuxSessionPrefix}-`);

  if (!managed || !sessionId) {
    return null;
  }

  const workspace = storedWorkspace || fallbackWorkspace || defaultWorkspace;
  const label = labelValue || path.basename(workspace) || tmuxSession;

  return {
    id: sessionId,
    label,
    workspace,
    tmuxSession,
    running: true,
    createdAt: coerceTmuxTimestamp(createdAt),
    lastActivity: coerceTmuxTimestamp(lastActivity),
    attachedClients: Number(attachedClients || "0") || 0,
    preview: buildSessionPreview(tmuxSession),
  };
}

function listCodexSessions(): CodexSessionSummary[] {
  const format = [
    "#{session_name}",
    `#{${tmuxMetadataPrefix}_managed}`,
    `#{${tmuxMetadataPrefix}_id}`,
    `#{${tmuxMetadataPrefix}_label}`,
    `#{${tmuxMetadataPrefix}_workspace}`,
    "#{pane_current_path}",
    "#{session_created}",
    "#{session_activity}",
    "#{session_attached}",
  ].join("\t");

  const result = runCommand("tmux", ["list-sessions", "-F", format]);
  const stderr = result.stderr?.trim() ?? "";

  if (result.error) {
    const error = result.error as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      throw new Error("tmux is required but was not found on PATH");
    }
    throw error;
  }

  if (result.status !== 0) {
    if (stderr.includes("failed to connect to server") || stderr.includes("no server running")) {
      return [];
    }
    throw new Error(stderr || "Unable to list tmux sessions");
  }

  return (result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseCodexSessionLine)
    .filter((session): session is CodexSessionSummary => Boolean(session))
    .sort((left, right) => right.lastActivity - left.lastActivity);
}

function getSessionLookup(): SessionLookup {
  try {
    return {
      sessions: listCodexSessions(),
      tmuxAvailable: true,
    };
  } catch (error) {
    return {
      sessions: [],
      tmuxAvailable: false,
      tmuxError: error instanceof Error ? error.message : "Unable to query tmux sessions",
    };
  }
}

function findCodexSession(sessionId: string) {
  return listCodexSessions().find((session) => session.id === sessionId) ?? null;
}

function buildTmuxSessionName(sessionId: string, label: string, workspace: string) {
  const baseName = slugify(label || path.basename(workspace) || "session") || "session";
  return `${tmuxSessionPrefix}-${baseName}-${sessionId.slice(0, 8)}`;
}

function setManagedTmuxOptions(tmuxSession: string, sessionId: string, label: string, workspace: string) {
  runTmux(["set-option", "-t", tmuxSession, "-q", "status", "off"]);
  runTmux(["set-option", "-t", tmuxSession, "-q", "window-size", "latest"]);
  runTmux(["set-option", "-t", tmuxSession, "-q", "mouse", "on"]);
  runTmux(["set-option", "-t", tmuxSession, "-q", "history-limit", "50000"]);
  runTmux(["set-option", "-t", tmuxSession, "-q", `${tmuxMetadataPrefix}_managed`, "1"]);
  runTmux(["set-option", "-t", tmuxSession, "-q", `${tmuxMetadataPrefix}_id`, sessionId]);
  runTmux(["set-option", "-t", tmuxSession, "-q", `${tmuxMetadataPrefix}_label`, label]);
  runTmux(["set-option", "-t", tmuxSession, "-q", `${tmuxMetadataPrefix}_workspace`, workspace]);
}

function buildCodexLaunchCommand(workspace: string) {
  return `${shellEscape(codexCommand)} --no-alt-screen -C ${shellEscape(workspace)}`;
}

function createCodexSession(workspaceInput: string, labelInput: string) {
  if (sandboxRestricted) {
    throw new Error(restrictionMessage);
  }

  const workspace = normalizeDirectory(workspaceInput);
  const stat = fs.statSync(workspace);
  if (!stat.isDirectory()) {
    throw new Error("Workspace is not a directory");
  }

  const label = sanitizeSessionLabel(labelInput) || path.basename(workspace) || "Codex session";
  const sessionId = randomUUID();
  const tmuxSession = buildTmuxSessionName(sessionId, label, workspace);
  const childEnv = buildCodexChildEnv();
  const command = buildCodexLaunchCommand(workspace);
  const result = runCommand("tmux", ["new-session", "-d", "-s", tmuxSession, "-c", workspace, command], childEnv);

  if (result.error) {
    const error = result.error as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      throw new Error("tmux is required but was not found on PATH");
    }
    throw error;
  }

  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || "Unable to create tmux session");
  }

  setManagedTmuxOptions(tmuxSession, sessionId, label, workspace);
  const session = findCodexSession(sessionId);
  if (!session) {
    throw new Error("Session started but could not be discovered in tmux");
  }

  return session;
}

function killCodexSession(sessionId: string) {
  const session = findCodexSession(sessionId);
  if (!session) {
    throw new Error("Session not found");
  }

  runTmux(["kill-session", "-t", session.tmuxSession]);
}

function sendJson(socket: WebSocket, payload: ServerMessage) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function createNodePtyAttachment(socket: WebSocket, session: CodexSessionSummary): TerminalBridge {
  const terminal = spawnPty("tmux", ["attach-session", "-t", session.tmuxSession], {
    cwd: session.workspace,
    env: buildCodexChildEnv(),
    name: "xterm-256color",
    cols: 120,
    rows: 30,
  });

  terminal.onData((text: string) => {
    sendJson(socket, { type: "output", data: text, sessionId: session.id });
  });

  terminal.onExit(({ exitCode, signal }) => {
    const latest = findCodexSession(session.id);
    sendJson(socket, {
      type: "exit",
      exitCode: exitCode ?? 0,
      signal: typeof signal === "number" ? signal : undefined,
      sessionId: session.id,
    });
    sendJson(socket, {
      type: "status",
      sessionId: session.id,
      session: latest,
    });
  });

  return {
    kill(signal?: string) {
      terminal.kill(signal);
    },
    resize(cols: number, rows: number) {
      terminal.resize(cols, rows);
    },
    write(data: string) {
      terminal.write(data);
    },
  };
}

function createBridgeAttachment(socket: WebSocket, session: CodexSessionSummary): TerminalBridge {
  const terminal = spawn("python3", [ptyBridgePath, "tmux", "attach-session", "-t", session.tmuxSession], {
    cwd: session.workspace,
    env: buildCodexChildEnv(),
  });

  terminal.stdout.on("data", (chunk: Buffer) => {
    sendJson(socket, { type: "output", data: chunk.toString("utf8"), sessionId: session.id });
  });

  terminal.stderr.on("data", (chunk: Buffer) => {
    sendJson(socket, { type: "output", data: chunk.toString("utf8"), sessionId: session.id });
  });

  terminal.on("exit", (exitCode, signal) => {
    const latest = findCodexSession(session.id);
    sendJson(socket, {
      type: "exit",
      exitCode: exitCode ?? 0,
      signal: typeof signal === "number" ? signal : undefined,
      sessionId: session.id,
    });
    sendJson(socket, {
      type: "status",
      sessionId: session.id,
      session: latest,
    });
  });

  terminal.on("error", (error) => {
    sendJson(socket, {
      type: "error",
      message: error.message,
      sessionId: session.id,
    });
  });

  return {
    kill(signal?: string) {
      terminal.kill((signal as NodeJS.Signals | number | undefined) ?? "SIGTERM");
    },
    resize() {},
    write(data: string) {
      terminal.stdin.write(data);
    },
  };
}

function createTmuxAttachment(socket: WebSocket, session: CodexSessionSummary) {
  try {
    return createNodePtyAttachment(socket, session);
  } catch (error) {
    if (isTmuxUnavailable(error)) {
      throw error;
    }
    return createBridgeAttachment(socket, session);
  }
}

function parseCookies(header?: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) {
    return result;
  }

  for (const pair of header.split(";")) {
    const [rawKey, ...rawValue] = pair.trim().split("=");
    if (!rawKey) {
      continue;
    }
    result[rawKey] = decodeURIComponent(rawValue.join("="));
  }

  return result;
}

app.get("/api/health", (_req, res) => {
  const provider = readProviderSummary();
  const lookup = getSessionLookup();
  res.json({
    ok: true,
    codexCommand,
    defaultWorkspace,
    passwordConfigured: Boolean(defaultPassword),
    sandboxRestricted,
    restrictionMessage,
    provider,
    tmuxAvailable: lookup.tmuxAvailable,
    tmuxError: lookup.tmuxError,
    sessions: lookup.sessions,
  });
});

app.post("/api/auth/login", (req, res) => {
  const password = String(req.body?.password ?? "");
  if (password !== defaultPassword) {
    res.status(401).json({ error: "Invalid password" });
    return;
  }

  const token = randomUUID();
  authSessions.set(token, {
    token,
    createdAt: Date.now(),
  });
  res.cookie(sessionCookieName, token, createCookieOptions());
  res.json({ ok: true, token });
});

app.post("/api/auth/logout", authRequired, (req, res) => {
  const token = parseSessionToken(req);
  if (token) {
    authSessions.delete(token);
  }

  res.clearCookie(sessionCookieName, createCookieOptions());
  res.json({ ok: true });
});

app.get("/api/auth/session", (req, res) => {
  const token = parseSessionToken(req);
  if (!token || !authSessions.has(token)) {
    res.status(401).json({ authenticated: false, sessions: [] });
    return;
  }

  const provider = readProviderSummary();
  const lookup = getSessionLookup();
  res.json({
    authenticated: true,
    token,
    homeDir,
    sandboxRestricted,
    restrictionMessage,
    provider,
    tmuxAvailable: lookup.tmuxAvailable,
    tmuxError: lookup.tmuxError,
    sessions: lookup.sessions,
  });
});

app.get("/api/fs/list", authRequired, (req, res) => {
  try {
    const targetPath = typeof req.query.path === "string" ? req.query.path : undefined;
    res.json(listDirectories(targetPath));
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to list directory",
    });
  }
});

app.get("/api/codex/sessions", authRequired, (_req, res) => {
  const lookup = getSessionLookup();
  res.json(lookup);
});

app.post("/api/codex/sessions", authRequired, (req, res) => {
  try {
    const workspace = String(req.body?.workspace ?? "");
    if (!workspace.trim()) {
      res.status(400).json({ error: "Workspace is required" });
      return;
    }

    const label = String(req.body?.label ?? "");
    const session = createCodexSession(workspace, label);
    res.json({
      ok: true,
      session,
    });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to create Codex session",
    });
  }
});

app.delete("/api/codex/sessions/:sessionId", authRequired, (req, res) => {
  try {
    killCodexSession(String(req.params.sessionId ?? ""));
    res.json({ ok: true });
  } catch (error) {
    res.status(404).json({
      error: error instanceof Error ? error.message : "Unable to stop Codex session",
    });
  }
});

async function configureFrontend() {
  if (isDevelopment) {
    const { createServer } = await import("vite");
    const vite = (await createServer({
      server: {
        middlewareMode: true,
        hmr: {
          server,
          overlay: false,
        },
      },
      appType: "spa",
    })) as ViteDevServer;

    app.use(vite.middlewares);
    app.get(/^(?!\/api).*/, async (req, res, next) => {
      try {
        const indexHtml = await fs.promises.readFile(path.join(rootDir, "index.html"), "utf8");
        const html = await vite.transformIndexHtml(req.originalUrl, indexHtml);
        res.status(200).set({ "Content-Type": "text/html" }).end(html);
      } catch (error) {
        vite.ssrFixStacktrace(error as Error);
        next(error);
      }
    });
    return;
  }

  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.sendFile(path.join(distDir, "index.html"));
    });
  }
}

server.on("upgrade", (request, socket, head) => {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  if (requestUrl.pathname !== "/ws") {
    return;
  }

  const cookies = parseCookies(request.headers.cookie);
  const token = requestUrl.searchParams.get("token") ?? cookies[sessionCookieName];
  const sessionId = requestUrl.searchParams.get("sessionId");

  if (!token || !authSessions.has(token) || !sessionId) {
    socket.destroy();
    return;
  }

  const session = findCodexSession(sessionId);
  if (!session) {
    socket.destroy();
    return;
  }

  wsServer.handleUpgrade(request, socket, head, (ws) => {
    wsServer.emit("connection", ws, request, session);
  });
});

wsServer.on("connection", (socket: WebSocket, _request: http.IncomingMessage, session: CodexSessionSummary) => {
  sendJson(socket, {
    type: "snapshot",
    data: "",
    session,
  });

  let attachment: TerminalBridge;

  try {
    attachment = createTmuxAttachment(socket, session);
  } catch (error) {
    sendJson(socket, {
      type: "error",
      message: error instanceof Error ? error.message : "Unable to attach to tmux session",
      sessionId: session.id,
    });
    socket.close();
    return;
  }

  socket.on("message", (raw: Buffer) => {
    try {
      const message = JSON.parse(String(raw)) as ClientMessage;
      if (message.type === "input") {
        attachment.write(message.data);
        return;
      }

      if (message.type === "resize") {
        attachment.resize(message.cols, message.rows);
        return;
      }

      if (message.type === "ping") {
        sendJson(socket, {
          type: "status",
          sessionId: session.id,
          session: findCodexSession(session.id),
        });
      }
    } catch (error) {
      sendJson(socket, {
        type: "error",
        message: error instanceof Error ? error.message : "Invalid websocket payload",
        sessionId: session.id,
      });
    }
  });

  socket.on("close", () => {
    attachment.kill("SIGTERM");
  });
});

async function startServer() {
  await configureFrontend();
  server.listen(port, () => {
    console.log(`Codex Web UI server listening on http://localhost:${port}`);
  });
}

void startServer();
