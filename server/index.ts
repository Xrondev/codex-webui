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

type SessionType = "codex" | "opencode" | "copilot" | "claude";

type CodexSessionSummary = {
  id: string;
  label: string;
  sessionType: SessionType;
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
  opencodeBin?: string;
  copilotBin?: string;
  claudeBin?: string;
  defaultPassword: string;
  defaultWorkspace: string;
  port: number;
};

type SessionTypeOption = {
  id: SessionType;
  label: string;
  command: string;
  available: boolean;
  envVar: string;
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
  sessionTypes: SessionTypeOption[];
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
  let parsedOpencodeBin: string | undefined;
  let parsedCopilotBin: string | undefined;
  let parsedClaudeBin: string | undefined;

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
      continue;
    }

    if (arg.startsWith("--opencode-bin")) {
      const value = readArgValue(argv, index);
      if (value) {
        parsedOpencodeBin = value;
      }
      if (!arg.includes("=") && value) {
        index += 1;
      }
      continue;
    }

    if (arg.startsWith("--copilot-bin")) {
      const value = readArgValue(argv, index);
      if (value) {
        parsedCopilotBin = value;
      }
      if (!arg.includes("=") && value) {
        index += 1;
      }
      continue;
    }

    if (arg.startsWith("--claude-bin")) {
      const value = readArgValue(argv, index);
      if (value) {
        parsedClaudeBin = value;
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
    opencodeBin: parsedOpencodeBin ?? process.env.OPENCODE_BIN,
    copilotBin: parsedCopilotBin ?? process.env.COPILOT_BIN,
    claudeBin: parsedClaudeBin ?? process.env.CLAUDE_BIN,
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
  const filteredEntries = Object.entries(process.env).filter(
    ([key]) =>
      !key.startsWith("CODEX_") && key !== "TMUX" && key !== "TMUX_PANE" && key !== "TMUX_TMPDIR",
  );
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

function findExecutable(candidate: string) {
  if (!candidate) {
    return "";
  }

  if (candidate.includes("/")) {
    return fs.existsSync(candidate) ? candidate : "";
  }

  const pathEntries = String(process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  const match = pathEntries
    .map((segment) => path.join(segment, candidate))
    .find((entry) => fs.existsSync(entry));

  return match ?? "";
}

function resolveCliCommand(explicit: string | undefined, candidateNames: string[], fallbackPaths: string[] = []) {
  if (explicit) {
    return {
      command: explicit,
      available: Boolean(findExecutable(explicit)),
    };
  }

  for (const candidate of candidateNames) {
    const match = findExecutable(candidate);
    if (match) {
      return {
        command: match,
        available: true,
      };
    }
  }

  for (const candidate of fallbackPaths) {
    const match = findExecutable(candidate);
    if (match) {
      return {
        command: match,
        available: true,
      };
    }
  }

  return {
    command: explicit ?? candidateNames[0],
    available: false,
  };
}

function normalizeSessionType(input: string): SessionType {
  switch (input) {
    case "codex":
    case "opencode":
    case "copilot":
    case "claude":
      return input;
    default:
      return "codex";
  }
}

const codexCli = resolveCliCommand(runtimeConfig.codexBin, ["codex"], [
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex",
]);
const opencodeCli = resolveCliCommand(runtimeConfig.opencodeBin, ["opencode"]);
const copilotCli = resolveCliCommand(runtimeConfig.copilotBin, ["copilot", "github-copilot-cli"]);
const claudeCli = resolveCliCommand(runtimeConfig.claudeBin, ["claude"]);

const sessionTypeOptions: SessionTypeOption[] = [
  {
    id: "codex",
    label: "Codex CLI",
    command: codexCli.command,
    available: codexCli.available,
    envVar: "CODEX_BIN",
  },
  {
    id: "opencode",
    label: "OpenCode",
    command: opencodeCli.command,
    available: opencodeCli.available,
    envVar: "OPENCODE_BIN",
  },
  {
    id: "copilot",
    label: "GitHub Copilot CLI",
    command: copilotCli.command,
    available: copilotCli.available,
    envVar: "COPILOT_BIN",
  },
  {
    id: "claude",
    label: "Claude Code",
    command: claudeCli.command,
    available: claudeCli.available,
    envVar: "CLAUDE_BIN",
  },
];

function getSessionTypeOption(sessionType: SessionType) {
  return sessionTypeOptions.find((option) => option.id === sessionType) ?? sessionTypeOptions[0];
}

function buildSessionLaunchCommand(sessionType: SessionType, workspace: string) {
  switch (sessionType) {
    case "codex":
      return `${shellEscape(codexCli.command)} --no-alt-screen -C ${shellEscape(workspace)}`;
    case "opencode":
      return shellEscape(opencodeCli.command);
    case "copilot":
      return shellEscape(copilotCli.command);
    case "claude":
      return shellEscape(claudeCli.command);
  }
}

function assertSessionTypeAvailable(sessionType: SessionType) {
  const option = getSessionTypeOption(sessionType);
  if (option.available) {
    return;
  }

  throw new Error(`${option.label} was not found on PATH. Set ${option.envVar}=/absolute/path/to/the-cli and restart the service.`);
}

function runCommand(command: string, args: string[], env?: NodeJS.ProcessEnv) {
  return spawnSync(command, args, {
    encoding: "utf8",
    env,
  });
}

function runTmux(args: string[], options?: { allowFailure?: boolean; env?: NodeJS.ProcessEnv }) {
  const result = runCommand("tmux", args, options?.env ?? buildCodexChildEnv());
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

  const values = parts.length >= 10
    ? parts
    : [parts[0], parts[1], parts[2], "codex", parts[3], parts[4], parts[5], parts[6], parts[7], parts[8]];
  const [tmuxSession, managedFlag, sessionId, sessionTypeValue, labelValue, storedWorkspace, fallbackWorkspace, createdAt, lastActivity, attachedClients] = values;
  const managed = managedFlag === "1" || tmuxSession.startsWith(`${tmuxSessionPrefix}-`);

  if (!managed || !sessionId) {
    return null;
  }

  const sessionType = normalizeSessionType(sessionTypeValue || "codex");
  const workspace = storedWorkspace || fallbackWorkspace || defaultWorkspace;
  const label = labelValue || path.basename(workspace) || tmuxSession;

  return {
    id: sessionId,
    label,
    sessionType,
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
    `#{${tmuxMetadataPrefix}_type}`,
    `#{${tmuxMetadataPrefix}_label}`,
    `#{${tmuxMetadataPrefix}_workspace}`,
    "#{pane_current_path}",
    "#{session_created}",
    "#{session_activity}",
    "#{session_attached}",
  ].join("\t");

  const result = runCommand("tmux", ["list-sessions", "-F", format], buildCodexChildEnv());
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
      sessionTypes: sessionTypeOptions,
      tmuxAvailable: true,
    };
  } catch (error) {
    return {
      sessions: [],
      sessionTypes: sessionTypeOptions,
      tmuxAvailable: false,
      tmuxError: error instanceof Error ? error.message : "Unable to query tmux sessions",
    };
  }
}

function findCodexSession(sessionId: string) {
  return listCodexSessions().find((session) => session.id === sessionId) ?? null;
}

function buildTmuxSessionName(sessionId: string, sessionType: SessionType, label: string, workspace: string) {
  const baseName = slugify(label || path.basename(workspace) || "session") || "session";
  return `${tmuxSessionPrefix}-${sessionType}-${baseName}-${sessionId.slice(0, 8)}`;
}

function setManagedTmuxOptions(
  tmuxSession: string,
  sessionId: string,
  sessionType: SessionType,
  label: string,
  workspace: string,
) {
  runTmux(["set-option", "-t", tmuxSession, "-q", "status", "off"]);
  runTmux(["set-option", "-t", tmuxSession, "-q", "window-size", "latest"]);
  runTmux(["set-option", "-t", tmuxSession, "-q", "mouse", "on"]);
  runTmux(["set-option", "-t", tmuxSession, "-q", "history-limit", "50000"]);
  runTmux(["set-option", "-t", tmuxSession, "-q", `${tmuxMetadataPrefix}_managed`, "1"]);
  runTmux(["set-option", "-t", tmuxSession, "-q", `${tmuxMetadataPrefix}_id`, sessionId]);
  runTmux(["set-option", "-t", tmuxSession, "-q", `${tmuxMetadataPrefix}_type`, sessionType]);
  runTmux(["set-option", "-t", tmuxSession, "-q", `${tmuxMetadataPrefix}_label`, label]);
  runTmux(["set-option", "-t", tmuxSession, "-q", `${tmuxMetadataPrefix}_workspace`, workspace]);
}

function createCodexSession(workspaceInput: string, labelInput: string, sessionTypeInput: string) {
  if (sandboxRestricted) {
    throw new Error(restrictionMessage);
  }

  const sessionType = normalizeSessionType(sessionTypeInput);
  assertSessionTypeAvailable(sessionType);
  const workspace = normalizeDirectory(workspaceInput);
  const stat = fs.statSync(workspace);
  if (!stat.isDirectory()) {
    throw new Error("Workspace is not a directory");
  }

  const sessionTypeOption = getSessionTypeOption(sessionType);
  const label = sanitizeSessionLabel(labelInput) || path.basename(workspace) || `${sessionTypeOption.label} session`;
  const sessionId = randomUUID();
  const tmuxSession = buildTmuxSessionName(sessionId, sessionType, label, workspace);
  const childEnv = buildCodexChildEnv();
  const command = buildSessionLaunchCommand(sessionType, workspace);
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

  setManagedTmuxOptions(tmuxSession, sessionId, sessionType, label, workspace);
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
    defaultWorkspace,
    passwordConfigured: Boolean(defaultPassword),
    sandboxRestricted,
    restrictionMessage,
    provider,
    tmuxAvailable: lookup.tmuxAvailable,
    tmuxError: lookup.tmuxError,
    sessionTypes: lookup.sessionTypes,
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
    sessionTypes: lookup.sessionTypes,
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
    const sessionType = String(req.body?.sessionType ?? "codex");
    const session = createCodexSession(workspace, label, sessionType);
    res.json({
      ok: true,
      session,
    });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to create session",
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
