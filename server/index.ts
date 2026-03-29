import cookieParser from "cookie-parser";
import express, { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { ViteDevServer } from "vite";
import { IPty, spawn as spawnPty } from "node-pty";

type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "ping" };

type ServerMessage =
  | { type: "snapshot"; data: string; workspace: string; running: boolean }
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number; signal?: number }
  | { type: "error"; message: string }
  | { type: "status"; running: boolean; workspace?: string };

type Session = {
  token: string;
  workspace?: string;
  terminal?: {
    kill(signal?: string): void;
    resize(cols: number, rows: number): void;
    write(data: string): void;
  };
  output: string;
  running: boolean;
  clients: Set<WebSocket>;
};

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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const distDir = path.resolve(rootDir, "dist");
const ptyBridgePath = path.resolve(rootDir, "server", "pty_bridge.py");
const homeDir = os.homedir();
const sessionCookieName = "codex_webui_session";
const maxBufferSize = 2_000_000;
const sandboxRestricted = Boolean(process.env.CODEX_SANDBOX);
const restrictionMessage = sandboxRestricted
  ? "This Web UI server was started inside a Codex sandbox, so it cannot launch nested Codex sessions. Start the server from your own terminal instead."
  : undefined;
const codexConfigPath = path.join(homeDir, ".codex", "config.toml");

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

const sessions = new Map<string, Session>();

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

function getOrCreateSession(token: string): Session {
  const existing = sessions.get(token);
  if (existing) {
    return existing;
  }

  const session: Session = {
    token,
    workspace: defaultWorkspace,
    output: "",
    running: false,
    clients: new Set(),
  };
  sessions.set(token, session);
  return session;
}

function appendOutput(session: Session, chunk: string) {
  session.output += chunk;
  if (session.output.length > maxBufferSize) {
    session.output = session.output.slice(session.output.length - maxBufferSize);
  }
}

function sendJson(socket: WebSocket, payload: ServerMessage) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function broadcast(session: Session, payload: ServerMessage) {
  for (const client of session.clients) {
    sendJson(client, payload);
  }
}

function killSession(session: Session) {
  if (session.terminal) {
    session.terminal.kill("SIGTERM");
    session.terminal = undefined;
  }
  session.running = false;
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
  if (!token || !sessions.has(token)) {
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
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: path.join(resolved, entry.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    current: resolved,
    parent: resolved === path.parse(resolved).root ? null : path.dirname(resolved),
    children: entries,
  };
}

function buildCodexChildEnv() {
  const filteredEntries = Object.entries(process.env).filter(([key]) => {
    if (key.startsWith("CODEX_")) {
      return false;
    }

    return true;
  });

  const env = Object.fromEntries(filteredEntries);
  const pathEntries = String(env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .filter((entry) => !entry.includes("/.codex/tmp/arg0/"));

  return {
    ...env,
    PATH: pathEntries.join(path.delimiter),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    COLUMNS: "120",
    LINES: "30",
  };
}

function attachChildProcess(session: Session, terminal: ChildProcessWithoutNullStreams, fallbackMessage?: string) {
  session.terminal = {
    kill(signal?: string) {
      terminal.kill((signal as NodeJS.Signals | number | undefined) ?? "SIGTERM");
    },
    resize() {},
    write(data: string) {
      terminal.stdin.write(data);
    },
  };
  session.running = true;

  if (fallbackMessage) {
    appendOutput(session, fallbackMessage);
  }

  terminal.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    appendOutput(session, text);
    broadcast(session, { type: "output", data: text });
  });

  terminal.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    appendOutput(session, text);
    broadcast(session, { type: "output", data: text });
  });

  terminal.on("exit", (exitCode, signal) => {
    session.running = false;
    session.terminal = undefined;
    broadcast(session, {
      type: "exit",
      exitCode: exitCode ?? 0,
      signal: typeof signal === "number" ? signal : undefined,
    });
    broadcast(session, {
      type: "status",
      running: false,
      workspace: session.workspace,
    });
  });

  terminal.on("error", (error) => {
    const text = `Failed to start terminal process: ${error.message}\n`;
    appendOutput(session, text);
    broadcast(session, { type: "output", data: text });
    session.running = false;
    session.terminal = undefined;
  });
}

function attachNodePty(session: Session, terminal: IPty) {
  session.terminal = {
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
  session.running = true;

  terminal.onData((text: string) => {
    appendOutput(session, text);
    broadcast(session, { type: "output", data: text });
  });

  terminal.onExit(({ exitCode, signal }) => {
    session.running = false;
    session.terminal = undefined;
    broadcast(session, {
      type: "exit",
      exitCode: exitCode ?? 0,
      signal: typeof signal === "number" ? signal : undefined,
    });
    broadcast(session, {
      type: "status",
      running: false,
      workspace: session.workspace,
    });
  });
}

function startCodex(session: Session, workspace: string) {
  if (sandboxRestricted) {
    throw new Error(restrictionMessage);
  }

  killSession(session);

  const resolvedWorkspace = normalizeDirectory(workspace);
  const stat = fs.statSync(resolvedWorkspace);
  if (!stat.isDirectory()) {
    throw new Error("Workspace is not a directory");
  }

  session.output = "";
  session.workspace = resolvedWorkspace;
  const childEnv = buildCodexChildEnv();

  try {
    const terminal = spawnPty(codexCommand, ["--no-alt-screen", "-C", resolvedWorkspace], {
      cwd: resolvedWorkspace,
      env: childEnv,
      name: "xterm-256color",
      cols: 120,
      rows: 30,
    });
    attachNodePty(session, terminal);
    return;
  } catch (error) {
    const fallbackMessage = `node-pty unavailable, falling back to python bridge: ${error instanceof Error ? error.message : "unknown error"}\n`;
    const terminal = spawn(
      "python3",
      [ptyBridgePath, codexCommand, "--no-alt-screen", "-C", resolvedWorkspace],
      {
        cwd: resolvedWorkspace,
        env: childEnv,
      },
    );
    attachChildProcess(session, terminal, fallbackMessage);
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
  res.json({
    ok: true,
    codexCommand,
    defaultWorkspace,
    passwordConfigured: Boolean(defaultPassword),
    sandboxRestricted,
    restrictionMessage,
    provider,
  });
});

app.post("/api/auth/login", (req, res) => {
  const password = String(req.body?.password ?? "");
  if (password !== defaultPassword) {
    res.status(401).json({ error: "Invalid password" });
    return;
  }

  const token = randomUUID();
  getOrCreateSession(token);
  res.cookie(sessionCookieName, token, createCookieOptions());
  res.json({ ok: true, token });
});

app.post("/api/auth/logout", authRequired, (req, res) => {
  const token = parseSessionToken(req);
  if (token) {
    const session = sessions.get(token);
    if (session) {
      killSession(session);
      sessions.delete(token);
    }
  }

  res.clearCookie(sessionCookieName, createCookieOptions());
  res.json({ ok: true });
});

app.get("/api/auth/session", (req, res) => {
  const token = parseSessionToken(req);
  if (!token || !sessions.has(token)) {
    res.status(401).json({ authenticated: false });
    return;
  }

  const session = getOrCreateSession(token);
  const provider = readProviderSummary();
  res.json({
    authenticated: true,
    token,
    running: session.running,
    workspace: session.workspace,
    homeDir,
    sandboxRestricted,
    restrictionMessage,
    provider,
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

app.post("/api/codex/start", authRequired, (req, res) => {
  const token = parseSessionToken(req);
  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const workspace = String(req.body?.workspace ?? "");
  if (!workspace) {
    res.status(400).json({ error: "Workspace is required" });
    return;
  }

  try {
    const session = getOrCreateSession(token);
    startCodex(session, workspace);
    res.json({
      ok: true,
      workspace: session.workspace,
      running: true,
    });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to start Codex",
    });
  }
});

app.post("/api/codex/stop", authRequired, (req, res) => {
  const token = parseSessionToken(req);
  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const session = getOrCreateSession(token);
  killSession(session);
  res.json({ ok: true });
});

app.get("/api/codex/status", authRequired, (req, res) => {
  const token = parseSessionToken(req);
  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const session = getOrCreateSession(token);
  res.json({
    running: session.running,
    workspace: session.workspace,
  });
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
  if (!token || !sessions.has(token)) {
    socket.destroy();
    return;
  }

  wsServer.handleUpgrade(request, socket, head, (ws) => {
    wsServer.emit("connection", ws, request, token);
  });
});

wsServer.on("connection", (socket: WebSocket, _request: http.IncomingMessage, token: string) => {
  const session = getOrCreateSession(token);
  session.clients.add(socket);

  sendJson(socket, {
    type: "snapshot",
    data: session.output,
    workspace: session.workspace ?? "",
    running: session.running,
  });

  socket.on("message", (raw: Buffer) => {
    try {
      const message = JSON.parse(String(raw)) as ClientMessage;
      if (message.type === "input" && session.terminal) {
        session.terminal.write(message.data);
        return;
      }

      if (message.type === "resize" && session.terminal) {
        session.terminal.resize(message.cols, message.rows);
        return;
      }

      if (message.type === "ping") {
        sendJson(socket, {
          type: "status",
          running: session.running,
          workspace: session.workspace,
        });
      }
    } catch (error) {
      sendJson(socket, {
        type: "error",
        message: error instanceof Error ? error.message : "Invalid websocket payload",
      });
    }
  });

  socket.on("close", () => {
    session.clients.delete(socket);
  });
});

async function startServer() {
  await configureFrontend();
  server.listen(port, () => {
    console.log(`Codex Web UI server listening on http://localhost:${port}`);
  });
}

void startServer();
