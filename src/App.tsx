import { FormEvent, useEffect, useRef, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "@xterm/addon-fit";

type SessionType = "codex" | "opencode" | "copilot" | "claude";

type DirectoryList = {
  current: string;
  parent: string | null;
  children: Array<{
    name: string;
    path: string;
    isSymlink?: boolean;
    targetPath?: string;
  }>;
};

type DirectoryCandidate = {
  name: string;
  path: string;
  isSymlink?: boolean;
  targetPath?: string;
};

type RecentDirectory = DirectoryCandidate & {
  lastUsed: number;
};

type ProviderSummary = {
  modelProvider: string;
  baseUrl?: string;
  envKey?: string;
  envKeyPresent: boolean;
};

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

type SessionTypeOption = {
  id: SessionType;
  label: string;
  command: string;
  available: boolean;
  envVar: string;
};

type AuthState = {
  authenticated: boolean;
  token?: string;
  homeDir?: string;
  sandboxRestricted?: boolean;
  restrictionMessage?: string;
  provider?: ProviderSummary;
  tmuxAvailable?: boolean;
  tmuxError?: string;
  sessionTypes?: SessionTypeOption[];
  sessions: CodexSessionSummary[];
};

type SessionLookup = {
  sessions: CodexSessionSummary[];
  sessionTypes: SessionTypeOption[];
  tmuxAvailable: boolean;
  tmuxError?: string;
};

type CreateSessionResponse = {
  ok: true;
  session: CodexSessionSummary;
};

type ServerMessage =
  | { type: "snapshot"; data: string; session: CodexSessionSummary }
  | { type: "output"; data: string; sessionId: string }
  | { type: "exit"; exitCode: number; signal?: number; sessionId: string }
  | { type: "status"; sessionId: string; session: CodexSessionSummary | null }
  | { type: "error"; message: string; sessionId?: string };

const initialDirectory: DirectoryList = {
  current: "",
  parent: null,
  children: [],
};

const recentDirectoriesStorageKey = "codex-webui-recent-directories";
const maxRecentDirectories = 6;
const compactLayoutBreakpoint = 900;
const fallbackSessionTypes: SessionTypeOption[] = [
  { id: "codex", label: "Codex CLI", command: "codex", available: true, envVar: "CODEX_BIN" },
  { id: "opencode", label: "OpenCode", command: "opencode", available: false, envVar: "OPENCODE_BIN" },
  { id: "copilot", label: "GitHub Copilot CLI", command: "copilot", available: false, envVar: "COPILOT_BIN" },
  { id: "claude", label: "Claude Code", command: "claude", available: false, envVar: "CLAUDE_BIN" },
];

function isHiddenDirectory(name: string) {
  return name.startsWith(".");
}

function sortSessions(entries: CodexSessionSummary[]) {
  return [...entries].sort((left, right) => right.lastActivity - left.lastActivity);
}

function pickNextSessionId(
  entries: CodexSessionSummary[],
  currentId: string | null,
  preferredId?: string | null,
) {
  if (preferredId && entries.some((entry) => entry.id === preferredId)) {
    return preferredId;
  }

  if (currentId && entries.some((entry) => entry.id === currentId)) {
    return currentId;
  }

  return entries[0]?.id ?? null;
}

async function api<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: "Request failed" }));
    throw new Error(payload.error ?? "Request failed");
  }

  return response.json() as Promise<T>;
}

function createWebSocketUrl(token?: string, sessionId?: string) {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const search = new URLSearchParams();

  if (token) {
    search.set("token", token);
  }

  if (sessionId) {
    search.set("sessionId", sessionId);
  }

  const suffix = search.toString();
  return `${protocol}://${window.location.host}/ws${suffix ? `?${suffix}` : ""}`;
}

function expandHomePath(inputPath: string, homeDir?: string) {
  if (!homeDir) {
    return inputPath;
  }

  if (inputPath === "~") {
    return homeDir;
  }

  if (inputPath.startsWith("~/")) {
    return `${homeDir}/${inputPath.slice(2)}`;
  }

  return inputPath;
}

function resolveSuggestionTarget(rawInput: string, currentBrowsePath: string, homeDir?: string) {
  const trimmed = rawInput.trim();
  const fallbackPath = currentBrowsePath || homeDir || "";

  if (!trimmed) {
    return {
      basePath: fallbackPath,
      query: "",
    };
  }

  const expandedInput = expandHomePath(trimmed, homeDir);
  if (!expandedInput.startsWith("/")) {
    return {
      basePath: fallbackPath,
      query: trimmed,
    };
  }

  const normalizedAbsolute = expandedInput.replace(/\/+$/, "") || "/";
  if (trimmed.endsWith("/")) {
    return {
      basePath: normalizedAbsolute,
      query: "",
    };
  }

  const lastSlashIndex = normalizedAbsolute.lastIndexOf("/");
  if (lastSlashIndex <= 0) {
    return {
      basePath: "/",
      query: normalizedAbsolute.slice(1),
    };
  }

  return {
    basePath: normalizedAbsolute.slice(0, lastSlashIndex) || "/",
    query: normalizedAbsolute.slice(lastSlashIndex + 1),
  };
}

function sortCandidates(entries: DirectoryCandidate[], rawQuery: string) {
  const query = rawQuery.trim().toLowerCase();
  if (!query) {
    return [...entries]
      .sort((left, right) => {
        const leftHidden = isHiddenDirectory(left.name) ? 1 : 0;
        const rightHidden = isHiddenDirectory(right.name) ? 1 : 0;
        if (leftHidden !== rightHidden) {
          return leftHidden - rightHidden;
        }
        return left.name.localeCompare(right.name);
      })
      .slice(0, 8);
  }

  return [...entries]
    .filter((entry) => {
      const name = entry.name.toLowerCase();
      const fullPath = entry.path.toLowerCase();
      return name.includes(query) || fullPath.includes(query);
    })
    .sort((left, right) => {
      const leftHidden = isHiddenDirectory(left.name) ? 1 : 0;
      const rightHidden = isHiddenDirectory(right.name) ? 1 : 0;
      if (leftHidden !== rightHidden) {
        return leftHidden - rightHidden;
      }

      const leftName = left.name.toLowerCase();
      const rightName = right.name.toLowerCase();
      const leftStarts = leftName.startsWith(query) ? 0 : 1;
      const rightStarts = rightName.startsWith(query) ? 0 : 1;
      if (leftStarts !== rightStarts) {
        return leftStarts - rightStarts;
      }
      return leftName.localeCompare(rightName);
    })
    .slice(0, 8);
}

function formatTime(value: number) {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatCompactStatus(value: string) {
  switch (value) {
    case "Connected":
      return "Online";
    case "Connecting...":
      return "Linking";
    case "Disconnected":
      return "Offline";
    case "Connection failed":
      return "Error";
    case "Session exited":
      return "Exited";
    case "Select a session":
      return "Idle";
    default:
      return value;
  }
}

function getSessionTypeLabel(options: SessionTypeOption[], sessionType: SessionType) {
  return options.find((option) => option.id === sessionType)?.label ?? sessionType;
}

function normalizeDirectoryPath(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") {
    return "/";
  }

  return trimmed.replace(/\/+$/, "") || "/";
}

function normalizeDirectoryName(value: string) {
  const trimmed = normalizeDirectoryPath(value);
  if (!trimmed) {
    return "/";
  }

  const slashIndex = trimmed.lastIndexOf("/");
  return slashIndex >= 0 ? trimmed.slice(slashIndex + 1) || "/" : trimmed;
}

function loadRecentDirectories() {
  if (typeof window === "undefined") {
    return [] as RecentDirectory[];
  }

  try {
    const raw = window.localStorage.getItem(recentDirectoriesStorageKey);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as RecentDirectory[];
    if (!Array.isArray(parsed)) {
      return [];
    }

    const dedupedEntries = new Map<string, RecentDirectory>();

    for (const entry of parsed) {
      if (typeof entry?.path !== "string" || !entry.path) {
        continue;
      }

      const normalizedPath = normalizeDirectoryPath(entry.path);
      const normalizedEntry: RecentDirectory = {
        name: entry.name || normalizeDirectoryName(normalizedPath),
        path: normalizedPath,
        isSymlink: Boolean(entry.isSymlink),
        targetPath: entry.targetPath,
        lastUsed: Number(entry.lastUsed) || Date.now(),
      };

      const existing = dedupedEntries.get(normalizedPath);
      if (!existing || normalizedEntry.lastUsed > existing.lastUsed) {
        dedupedEntries.set(normalizedPath, normalizedEntry);
      }
    }

    return [...dedupedEntries.values()]
      .sort((left, right) => right.lastUsed - left.lastUsed)
      .slice(0, maxRecentDirectories);
  } catch {
    return [];
  }
}

function persistRecentDirectories(entries: RecentDirectory[]) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(recentDirectoriesStorageKey, JSON.stringify(entries.slice(0, maxRecentDirectories)));
}

function formatDirectoryLine(entry: DirectoryCandidate) {
  if (entry.isSymlink && entry.targetPath) {
    return `${entry.path} -> ${entry.targetPath}`;
  }

  return entry.path;
}

function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [password, setPassword] = useState("");
  const [draftWorkspace, setDraftWorkspace] = useState("");
  const [sessionLabel, setSessionLabel] = useState("");
  const [sessionType, setSessionType] = useState<SessionType>("codex");
  const [directoryList, setDirectoryList] = useState<DirectoryList>(initialDirectory);
  const [loadingDirs, setLoadingDirs] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [suggestionPool, setSuggestionPool] = useState<DirectoryCandidate[]>([]);
  const [suggestionBasePath, setSuggestionBasePath] = useState("");
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
  const [suggestionLoading, setSuggestionLoading] = useState(false);
  const [terminalReady, setTerminalReady] = useState(false);
  const [liveStatus, setLiveStatus] = useState("Select a session");
  const [isBusy, setIsBusy] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [commandInput, setCommandInput] = useState("");
  const [mobileView, setMobileView] = useState<"sessions" | "terminal">("sessions");
  const [recentDirectories, setRecentDirectories] = useState<RecentDirectory[]>(() => loadRecentDirectories());
  const [isCompactLayout, setIsCompactLayout] = useState(
    () => typeof window !== "undefined" && window.innerWidth <= compactLayoutBreakpoint,
  );
  const [isHeaderExpanded, setIsHeaderExpanded] = useState(false);
  const [mobileLauncherOpen, setMobileLauncherOpen] = useState(true);
  const [mobileDirectoriesOpen, setMobileDirectoriesOpen] = useState(false);
  const [isMobileKeyboardVisible, setIsMobileKeyboardVisible] = useState(false);

  const terminalRef = useRef<HTMLDivElement | null>(null);
  const terminalInstanceRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const focusScrollTimerRef = useRef<number | null>(null);

  const sessions = auth?.sessions ?? [];
  const sessionTypeOptions = auth?.sessionTypes?.length ? auth.sessionTypes : fallbackSessionTypes;
  const selectedSessionTypeOption =
    sessionTypeOptions.find((option) => option.id === sessionType) ?? sessionTypeOptions[0];
  const selectedSession = sessions.find((entry) => entry.id === selectedSessionId) ?? null;
  const sandboxRestricted = Boolean(auth?.sandboxRestricted);
  const tmuxUnavailable = auth?.tmuxAvailable === false;
  const currentBrowsePath = directoryList.current || auth?.homeDir || "";
  const resolvedWorkspace = draftWorkspace.trim() || currentBrowsePath;
  const normalizedCurrentPath = currentBrowsePath.replace(/\/+$/, "") || "/";
  const normalizedResolvedPath = resolvedWorkspace.replace(/\/+$/, "") || "/";
  const showTargetMeta = Boolean(resolvedWorkspace) && normalizedResolvedPath !== normalizedCurrentPath;
  const suggestionTarget = resolveSuggestionTarget(draftWorkspace, currentBrowsePath, auth?.homeDir);
  const launcherMatchPath = suggestionBasePath || currentBrowsePath || auth?.homeDir || "";
  const recentDirectoryPathSet = new Set(recentDirectories.map((entry) => normalizeDirectoryPath(entry.path)));
  const directorySuggestions = sortCandidates(suggestionPool, suggestionTarget.query).filter(
    (entry) => !recentDirectoryPathSet.has(normalizeDirectoryPath(entry.path)),
  );
  const recentDirectoryMatches = recentDirectories.filter((entry) => {
    const query = suggestionTarget.query.trim().toLowerCase();
    if (!query) {
      return true;
    }

    return entry.name.toLowerCase().includes(query) || entry.path.toLowerCase().includes(query);
  });
  const selectedStatusLabel = tmuxUnavailable
    ? "tmux unavailable"
    : selectedSession
      ? liveStatus
      : sessions.length
        ? "Pick a session"
        : "No active session";
  const compactStatusLabel = tmuxUnavailable
    ? "tmux off"
    : selectedSession
      ? formatCompactStatus(liveStatus)
      : sessions.length
        ? "Pick"
        : "Idle";
  const terminalKeyboardMode = isCompactLayout && isMobileKeyboardVisible && mobileView === "terminal";
  const sessionTypeUnavailable = selectedSessionTypeOption?.available === false;

  const renderTerminalTools = () => (
    <>
      <form className="command-bar" onSubmit={handleSendCommand}>
        <label className="field command-field">
          <span>Mobile quick input</span>
          <input
            type="text"
            value={commandInput}
            onChange={(event) => setCommandInput(event.target.value)}
            placeholder="Type a command and send it into the active tmux client"
          />
        </label>
        <div className="command-actions">
          <button className="primary-button" disabled={!commandInput || liveStatus !== "Connected"} type="submit">
            Send line
          </button>
          <button className="ghost-button" disabled={liveStatus !== "Connected"} onClick={() => handleControlKey("\r")} type="button">
            Enter
          </button>
          <button className="ghost-button" disabled={liveStatus !== "Connected"} onClick={() => handleControlKey("\u0003")} type="button">
            Ctrl+C
          </button>
          <button className="ghost-button" disabled={liveStatus !== "Connected"} onClick={() => handleControlKey("\u001b")} type="button">
            Esc
          </button>
        </div>
      </form>

      <div className="terminal-footer">
        <div className="terminal-footer-item terminal-footer-item-wide">
          <span className="terminal-footer-label">Workspace</span>
          <code>{selectedSession?.workspace}</code>
        </div>
        <div className="terminal-footer-item terminal-footer-item-wide">
          <span className="terminal-footer-label">tmux</span>
          <code>{selectedSession?.tmuxSession}</code>
        </div>
        <div className="terminal-footer-item">
          <span className="terminal-footer-label">Type</span>
          <span>
            {selectedSession ? getSessionTypeLabel(sessionTypeOptions, selectedSession.sessionType) : "-"}
          </span>
        </div>
        <div className="terminal-footer-item">
          <span className="terminal-footer-label">Transport</span>
          <span>{liveStatus}</span>
        </div>
        <div className="terminal-footer-item">
          <span className="terminal-footer-label">Provider</span>
          <span>{auth?.provider?.modelProvider ?? "unknown"}</span>
        </div>
      </div>
    </>
  );

  function syncSessionSelection(entries: CodexSessionSummary[], preferredId?: string | null) {
    setSelectedSessionId((currentId) => pickNextSessionId(entries, currentId, preferredId));
  }

  function upsertSession(entry: CodexSessionSummary) {
    setAuth((current) => {
      if (!current) {
        return current;
      }

      const existingIndex = current.sessions.findIndex((session) => session.id === entry.id);
      const nextSessions = existingIndex >= 0
        ? current.sessions.map((session) => (session.id === entry.id ? entry : session))
        : [entry, ...current.sessions];

      return {
        ...current,
        sessions: sortSessions(nextSessions),
      };
    });
  }

  function removeSession(sessionId: string) {
    setAuth((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        sessions: current.sessions.filter((entry) => entry.id !== sessionId),
      };
    });
    setSelectedSessionId((currentId) => (currentId === sessionId ? null : currentId));
  }

  function rememberDirectory(entry: DirectoryCandidate | string) {
    const normalizedEntry: RecentDirectory =
      typeof entry === "string"
        ? {
            name: normalizeDirectoryName(entry),
            path: normalizeDirectoryPath(entry),
            lastUsed: Date.now(),
          }
        : {
            ...entry,
            name: entry.name || normalizeDirectoryName(entry.path),
            path: normalizeDirectoryPath(entry.path),
            lastUsed: Date.now(),
          };

    setRecentDirectories((current) => {
      const nextEntries = [
        normalizedEntry,
        ...current.filter((item) => normalizeDirectoryPath(item.path) !== normalizedEntry.path),
      ]
        .sort((left, right) => right.lastUsed - left.lastUsed)
        .slice(0, maxRecentDirectories);
      persistRecentDirectories(nextEntries);
      return nextEntries;
    });
  }

  function toggleCompactPanel(panel: "launcher" | "directories", open: boolean) {
    if (!isCompactLayout) {
      return;
    }

    setMobileLauncherOpen(panel === "launcher" ? open : false);
    setMobileDirectoriesOpen(panel === "directories" ? open : false);
  }

  async function refreshSession() {
    try {
      const session = await api<AuthState>("/api/auth/session");
      setAuth({
        ...session,
        sessions: sortSessions(session.sessions),
      });
      setDraftWorkspace((current) => current || session.homeDir || "");
      syncSessionSelection(session.sessions);
      setAuthError(null);
      return session;
    } catch {
      setAuth({ authenticated: false, sessions: [] });
      setSelectedSessionId(null);
      return null;
    }
  }

  async function loadSessions(preferredId?: string | null) {
    const payload = await api<SessionLookup>("/api/codex/sessions", {
      method: "GET",
    });
    setAuth((current) =>
      current
        ? {
            ...current,
            sessionTypes: payload.sessionTypes,
            tmuxAvailable: payload.tmuxAvailable,
            tmuxError: payload.tmuxError,
            sessions: sortSessions(payload.sessions),
          }
        : current,
    );
    syncSessionSelection(payload.sessions, preferredId);
    return payload;
  }

  async function loadDirectories(targetPath?: string, syncDraftWorkspace = false) {
    setLoadingDirs(true);
    try {
      const query = targetPath ? `?path=${encodeURIComponent(targetPath)}` : "";
      const payload = await api<DirectoryList>(`/api/fs/list${query}`, {
        method: "GET",
      });
      setDirectoryList(payload);
      if (syncDraftWorkspace || !draftWorkspace.trim()) {
        setDraftWorkspace(payload.current);
      }
      setSessionError(null);
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : "Unable to load folders");
    } finally {
      setLoadingDirs(false);
    }
  }

  async function openDirectory(targetPath: string) {
    await loadDirectories(targetPath, true);
  }

  function sendResizeMessage() {
    const terminal = terminalInstanceRef.current;
    const socket = socketRef.current;
    if (!terminal || socket?.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(
      JSON.stringify({
        type: "resize",
        cols: terminal.cols,
        rows: terminal.rows,
      }),
    );
  }

  function scheduleFit() {
    if (resizeFrameRef.current !== null) {
      cancelAnimationFrame(resizeFrameRef.current);
    }

    resizeFrameRef.current = requestAnimationFrame(() => {
      fitAddonRef.current?.fit();
      sendResizeMessage();
      resizeFrameRef.current = null;
    });
  }

  function sendSocketInput(data: string) {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) {
      setSessionError("Terminal is not connected to the selected session");
      return false;
    }

    socket.send(JSON.stringify({ type: "input", data }));
    return true;
  }

  useEffect(() => {
    void refreshSession().then((session) => {
      if (session?.authenticated) {
        void loadDirectories(session.homeDir, true);
      }
    });
  }, []);

  useEffect(() => {
    if (!auth?.authenticated || !selectedSessionId || !terminalRef.current || terminalInstanceRef.current) {
      return;
    }

    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: '"IBM Plex Mono", "SFMono-Regular", Consolas, monospace',
      fontSize: terminalKeyboardMode ? 11 : isCompactLayout ? 12 : 14,
      lineHeight: terminalKeyboardMode ? 1.08 : isCompactLayout ? 1.16 : 1.25,
      theme: {
        background: "#04191d",
        foreground: "#d7efe5",
        cursor: "#ffb347",
        black: "#102328",
        brightBlack: "#35565f",
        red: "#f66b6b",
        brightRed: "#ff8f8f",
        green: "#8bda8b",
        brightGreen: "#b7f2ab",
        yellow: "#ffd06e",
        brightYellow: "#ffe4a3",
        blue: "#7bc8d6",
        brightBlue: "#8eddf2",
        magenta: "#f0a0ba",
        brightMagenta: "#ffc0d3",
        cyan: "#73ddc7",
        brightCyan: "#b4f5e6",
        white: "#d7efe5",
        brightWhite: "#f5fff8",
      },
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalRef.current);

    terminalInstanceRef.current = terminal;
    fitAddonRef.current = fitAddon;
    setTerminalReady(true);
    scheduleFit();

    const handleResize = () => scheduleFit();
    window.addEventListener("resize", handleResize);

    if (typeof ResizeObserver !== "undefined" && terminalRef.current) {
      const resizeObserver = new ResizeObserver(() => {
        scheduleFit();
      });
      resizeObserver.observe(terminalRef.current);
      resizeObserverRef.current = resizeObserver;
    }

    terminal.onData((data) => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data }));
      }
    });

    return () => {
      window.removeEventListener("resize", handleResize);
      if (resizeFrameRef.current !== null) {
        cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      terminal.dispose();
      terminalInstanceRef.current = null;
      fitAddonRef.current = null;
      setTerminalReady(false);
    };
  }, [auth?.authenticated, selectedSessionId]);

  useEffect(() => {
    if (!sessionTypeOptions.some((option) => option.id === sessionType)) {
      setSessionType(sessionTypeOptions[0]?.id ?? "codex");
      return;
    }

    if (selectedSessionTypeOption?.available === false) {
      const nextAvailable = sessionTypeOptions.find((option) => option.available);
      if (nextAvailable && nextAvailable.id !== sessionType) {
        setSessionType(nextAvailable.id);
      }
    }
  }, [selectedSessionTypeOption?.available, sessionType, sessionTypeOptions]);

  useEffect(() => {
    const terminal = terminalInstanceRef.current;
    if (!terminalReady || !terminal) {
      return;
    }

    terminal.options.fontSize = terminalKeyboardMode ? 11 : isCompactLayout ? 12 : 14;
    terminal.options.lineHeight = terminalKeyboardMode ? 1.08 : isCompactLayout ? 1.16 : 1.25;
    scheduleFit();
  }, [isCompactLayout, terminalKeyboardMode, terminalReady]);

  useEffect(() => {
    if (!auth?.authenticated || !auth.token || !terminalReady || !selectedSessionId) {
      if (socketRef.current) {
        socketRef.current.close();
        socketRef.current = null;
      }

      if (!selectedSessionId) {
        terminalInstanceRef.current?.reset();
        setLiveStatus(tmuxUnavailable ? "tmux unavailable" : "Select a session");
      }
      return;
    }

    terminalInstanceRef.current?.reset();
    setLiveStatus("Connecting...");
    const socket = new WebSocket(createWebSocketUrl(auth.token, selectedSessionId));
    socketRef.current = socket;

    socket.onopen = () => {
      setLiveStatus("Connected");
      scheduleFit();
      socket.send(JSON.stringify({ type: "ping" }));
    };

    socket.onmessage = (event) => {
      const message = JSON.parse(event.data) as ServerMessage;
      const terminal = terminalInstanceRef.current;
      if (!terminal) {
        return;
      }

      if (message.type === "snapshot") {
        upsertSession(message.session);
        if (message.data) {
          terminal.write(message.data);
        }
        setSessionError(null);
        return;
      }

      if (message.type === "output") {
        terminal.write(message.data);
        return;
      }

      if (message.type === "exit") {
        terminal.writeln(`\r\n[Session exited with code ${message.exitCode}]`);
        setLiveStatus("Session exited");
        void loadSessions();
        return;
      }

      if (message.type === "status") {
        if (message.session) {
          upsertSession(message.session);
        } else {
          removeSession(message.sessionId);
        }
        return;
      }

      if (message.type === "error") {
        terminal.writeln(`\r\n[WebSocket error] ${message.message}`);
        setSessionError(message.message);
      }
    };

    socket.onclose = () => {
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
      setLiveStatus(selectedSessionId ? "Disconnected" : "Select a session");
    };

    socket.onerror = () => {
      setLiveStatus("Connection failed");
    };

    return () => {
      socket.close();
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
    };
  }, [auth?.authenticated, auth?.token, selectedSessionId, terminalReady, tmuxUnavailable]);

  useEffect(() => {
    if (auth?.authenticated && terminalReady && selectedSession) {
      scheduleFit();
    }
  }, [auth?.authenticated, terminalReady, selectedSessionId]);

  useEffect(() => {
    if (!auth?.authenticated) {
      setSuggestionPool([]);
      setSuggestionBasePath("");
      setSuggestionLoading(false);
      return;
    }

    if (!suggestionTarget.basePath) {
      setSuggestionPool([]);
      setSuggestionBasePath("");
      setSuggestionLoading(false);
      return;
    }

    if (suggestionTarget.basePath === directoryList.current) {
      setSuggestionPool(directoryList.children);
      setSuggestionBasePath(directoryList.current);
      setSuggestionLoading(false);
      return;
    }

    let cancelled = false;
    setSuggestionLoading(true);
    const timeoutId = window.setTimeout(() => {
      void api<DirectoryList>(`/api/fs/list?path=${encodeURIComponent(suggestionTarget.basePath)}`, {
        method: "GET",
      })
        .then((payload) => {
          if (cancelled) {
            return;
          }

          setSuggestionPool(payload.children);
          setSuggestionBasePath(payload.current);
          setSuggestionLoading(false);
        })
        .catch(() => {
          if (cancelled) {
            return;
          }

          setSuggestionPool([]);
          setSuggestionBasePath(suggestionTarget.basePath);
          setSuggestionLoading(false);
        });
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [auth?.authenticated, directoryList.children, directoryList.current, suggestionTarget.basePath]);

  useEffect(() => {
    setActiveSuggestionIndex(0);
  }, [draftWorkspace, suggestionBasePath]);

  useEffect(() => {
    if (!selectedSessionId && mobileView === "terminal") {
      setMobileView("sessions");
    }
  }, [selectedSessionId, mobileView]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleResize = () => {
      setIsCompactLayout(window.innerWidth <= compactLayoutBreakpoint);
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const root = document.documentElement;
    const viewport = window.visualViewport;

    const syncViewport = () => {
      const viewportHeight = Math.round(viewport?.height ?? window.innerHeight);
      const keyboardOffset = viewport
        ? Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop))
        : 0;
      const activeElement = document.activeElement;
      const textInputFocused = activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement;
      const keyboardVisible = window.innerWidth <= compactLayoutBreakpoint && textInputFocused && keyboardOffset > 120;

      root.style.setProperty("--app-height", `${viewportHeight}px`);
      root.style.setProperty("--keyboard-offset", `${keyboardOffset}px`);
      setIsMobileKeyboardVisible(keyboardVisible);

      if (terminalReady) {
        scheduleFit();
      }
    };

    syncViewport();
    window.addEventListener("resize", syncViewport);
    viewport?.addEventListener("resize", syncViewport);
    viewport?.addEventListener("scroll", syncViewport);

    return () => {
      window.removeEventListener("resize", syncViewport);
      viewport?.removeEventListener("resize", syncViewport);
      viewport?.removeEventListener("scroll", syncViewport);
      root.style.removeProperty("--app-height");
      root.style.removeProperty("--keyboard-offset");
      setIsMobileKeyboardVisible(false);
    };
  }, [terminalReady]);

  useEffect(() => {
    if (typeof window === "undefined" || !isCompactLayout) {
      return;
    }

    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
        return;
      }

      if (focusScrollTimerRef.current !== null) {
        window.clearTimeout(focusScrollTimerRef.current);
      }

      focusScrollTimerRef.current = window.setTimeout(() => {
        target.scrollIntoView({ behavior: "auto", block: "nearest" });
        focusScrollTimerRef.current = null;
      }, 160);
    };

    document.addEventListener("focusin", handleFocusIn);

    return () => {
      document.removeEventListener("focusin", handleFocusIn);
      if (focusScrollTimerRef.current !== null) {
        window.clearTimeout(focusScrollTimerRef.current);
        focusScrollTimerRef.current = null;
      }
    };
  }, [isCompactLayout]);

  useEffect(() => {
    if (selectedSessionId && isCompactLayout) {
      setMobileView("terminal");
    }
  }, [selectedSessionId, isCompactLayout]);

  useEffect(() => {
    if (terminalKeyboardMode && selectedSessionId) {
      setMobileView("terminal");
    }
  }, [selectedSessionId, terminalKeyboardMode]);

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    setIsBusy(true);
    try {
      await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      const session = await refreshSession();
      if (session?.authenticated) {
        await loadDirectories(session.homeDir, true);
      }
      setPassword("");
      setAuthError(null);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Unable to login");
    } finally {
      setIsBusy(false);
    }
  }

  async function handleLogout() {
    setIsBusy(true);
    try {
      await api("/api/auth/logout", { method: "POST" });
      socketRef.current?.close();
      terminalInstanceRef.current?.reset();
      setAuth({ authenticated: false, sessions: [] });
      setDirectoryList(initialDirectory);
      setDraftWorkspace("");
      setSelectedSessionId(null);
      setSessionLabel("");
      setCommandInput("");
      setSessionError(null);
      setAuthError(null);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Unable to logout");
    } finally {
      setIsBusy(false);
    }
  }

  async function handleCreateSession() {
    if (!resolvedWorkspace) {
      setSessionError("Workspace is required");
      return;
    }

    setIsBusy(true);
    try {
      const response = await api<CreateSessionResponse>("/api/codex/sessions", {
        method: "POST",
        body: JSON.stringify({
          workspace: resolvedWorkspace,
          label: sessionLabel.trim(),
          sessionType,
        }),
      });
      await loadSessions(response.session.id);
      setSelectedSessionId(response.session.id);
      setDraftWorkspace(response.session.workspace);
      setSessionLabel("");
      setCommandInput("");
      setSessionError(null);
      setMobileView("terminal");
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : "Unable to create session");
    } finally {
      setIsBusy(false);
    }
  }

  async function handleStopSession() {
    if (!selectedSessionId) {
      return;
    }

    setIsBusy(true);
    try {
      await api(`/api/codex/sessions/${encodeURIComponent(selectedSessionId)}`, {
        method: "DELETE",
      });
      terminalInstanceRef.current?.reset();
      await loadSessions();
      setSessionError(null);
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : "Unable to stop Codex session");
    } finally {
      setIsBusy(false);
    }
  }

  async function handleRefreshSessions() {
    setIsBusy(true);
    try {
      await loadSessions(selectedSessionId);
      setSessionError(null);
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : "Unable to refresh sessions");
    } finally {
      setIsBusy(false);
    }
  }

  async function handleOpenPath() {
    if (!draftWorkspace.trim()) {
      return;
    }

    await openDirectory(draftWorkspace.trim());
    rememberDirectory(draftWorkspace.trim());
  }

  async function handleSuggestionSelect(candidate: DirectoryCandidate) {
    setDraftWorkspace(candidate.path);
    await openDirectory(candidate.path);
    rememberDirectory(candidate);
  }

  function handleSelectSession(sessionId: string) {
    setSelectedSessionId(sessionId);
    setCommandInput("");
    setSessionError(null);
    setMobileView("terminal");
  }

  function handleSendCommand(event: FormEvent) {
    event.preventDefault();
    if (!commandInput) {
      return;
    }

    const wroteCommand = sendSocketInput(commandInput);
    const wroteEnter = wroteCommand ? sendSocketInput("\r") : false;
    if (wroteCommand && wroteEnter) {
      setCommandInput("");
      setSessionError(null);
    }
  }

  function handleControlKey(sequence: string) {
    if (sendSocketInput(sequence)) {
      setSessionError(null);
    }
  }

  if (!auth?.authenticated) {
    return (
      <main className="shell shell-login">
        <section className="panel login-panel">
          <div className="eyebrow">Session Deck</div>
          <h1>Log in and manage multiple AI CLI terminals from one place.</h1>
          <p className="panel-copy">
            This UI launches supported AI CLIs inside tmux sessions, so you can reopen the page or
            restart the service and still recover the live session list.
          </p>
          <form className="stack" onSubmit={handleLogin}>
            <label className="field">
              <span>Password</span>
              <input
                autoComplete="current-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Enter WEBUI_PASSWORD"
              />
            </label>
            {authError ? <div className="error-banner">{authError}</div> : null}
            <button className="primary-button" disabled={isBusy || !password.trim()} type="submit">
              {isBusy ? "Logging in..." : "Login"}
            </button>
          </form>
          <div className="hint">tmux is required for multi-session recovery. Default password is codex-webui unless WEBUI_PASSWORD is set.</div>
        </section>
      </main>
    );
  }

  return (
    <main className={`shell shell-app${terminalKeyboardMode ? " keyboard-active" : ""}`}>
      <section className="control-dock panel" aria-label="Control dock">
        <div className={`control-dock-main${isCompactLayout ? " compact" : ""}`}>
          {!isCompactLayout ? (
            <div className="control-dock-title">
              <div className="eyebrow">Session Fleet</div>
              <strong>{selectedSession ? selectedSession.label : `${sessions.length} live sessions`}</strong>
              <div className="topbar-subtle control-dock-subtle">
                {selectedSession?.workspace || resolvedWorkspace || auth.homeDir || "No target selected"}
              </div>
            </div>
          ) : null}
          <label className={`session-picker${isCompactLayout ? " compact" : ""}`} aria-label="Active session picker">
            {!isCompactLayout ? <span className="meta-label">Session</span> : null}
            <select
              value={selectedSessionId ?? ""}
              onChange={(event) => {
                const nextId = event.target.value;
                if (!nextId) {
                  setSelectedSessionId(null);
                  return;
                }

                handleSelectSession(nextId);
              }}
            >
              <option value="">No active session</option>
              {sessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {getSessionTypeLabel(sessionTypeOptions, session.sessionType)} · {session.label} · {session.workspace}
                </option>
              ))}
            </select>
          </label>
          <div className="control-dock-actions">
            <span className={`status-pill ${selectedSession ? "active" : ""}`}>{isCompactLayout ? compactStatusLabel : selectedStatusLabel}</span>
            <button className="ghost-button" disabled={isBusy} onClick={() => void handleRefreshSessions()} type="button">
              {isCompactLayout ? "Sync" : "Refresh"}
            </button>
            <button className="ghost-button" onClick={handleLogout} type="button">
              {isCompactLayout ? "Exit" : "Logout"}
            </button>
            <button
              className="ghost-button"
              onClick={() => setIsHeaderExpanded((current) => !current)}
              type="button"
            >
              {isHeaderExpanded ? "Less" : "More"}
            </button>
          </div>
        </div>

        {isHeaderExpanded ? (
          <div className="control-dock-details">
            <div className="control-chip">
              <span className="meta-label">Sessions</span>
              <strong>{sessions.length}</strong>
            </div>
            <div className="control-chip">
              <span className="meta-label">Provider</span>
              <strong>{auth.provider?.modelProvider ?? "unknown"}</strong>
            </div>
            <div className="control-chip">
              <span className="meta-label">tmux</span>
              <strong>{tmuxUnavailable ? "Unavailable" : "Ready"}</strong>
            </div>
            {selectedSession ? (
              <div className="control-chip">
                <span className="meta-label">Type</span>
                <strong>{getSessionTypeLabel(sessionTypeOptions, selectedSession.sessionType)}</strong>
              </div>
            ) : null}
            {showTargetMeta ? (
              <div className="control-chip control-chip-wide">
                <span className="meta-label">Next launch target</span>
                <strong>{resolvedWorkspace}</strong>
              </div>
            ) : null}
            {selectedSession ? (
              <div className="control-chip control-chip-wide">
                <span className="meta-label">Active tmux</span>
                <strong>{selectedSession.tmuxSession}</strong>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="mobile-switcher control-switcher">
          <button
            className={`mobile-switcher-button ${mobileView === "sessions" ? "active" : ""}`}
            onClick={() => setMobileView("sessions")}
            type="button"
          >
            Sessions
          </button>
          <button
            className={`mobile-switcher-button ${mobileView === "terminal" ? "active" : ""}`}
            disabled={!selectedSession}
            onClick={() => setMobileView("terminal")}
            type="button"
          >
            Terminal
          </button>
        </div>
      </section>

      <section className={`workspace-grid mobile-view-${mobileView}`}>
        <aside className="panel session-panel">
          <details
            className="mobile-fold"
            open={!isCompactLayout || mobileLauncherOpen}
            onToggle={(event) =>
              toggleCompactPanel("launcher", (event.currentTarget as HTMLDetailsElement).open)
            }
          >
            <summary className="mobile-fold-summary">
              <div>
                <div className="eyebrow">Launcher</div>
                <strong>Open a session</strong>
              </div>
              <span className="mobile-fold-meta">{isCompactLayout ? launcherMatchPath : resolvedWorkspace || auth.homeDir || "Select path"}</span>
            </summary>
            <div className={`mobile-fold-body ${isCompactLayout ? "mobile-fold-body-flat" : ""}`}>
              {!isCompactLayout ? (
                <div className="panel-header compact-panel-header">
                  <div>
                    <div className="eyebrow">Launcher</div>
                    <h2>Start another CLI session</h2>
                  </div>
                  <button
                    className="ghost-button"
                    disabled={loadingDirs}
                    onClick={() => void loadDirectories(directoryList.current || auth.homeDir, true)}
                    type="button"
                  >
                    Browse
                  </button>
                </div>
              ) : null}

              {tmuxUnavailable && auth.tmuxError ? <div className="error-banner">{auth.tmuxError}</div> : null}
              {sandboxRestricted ? <div className="error-banner">{auth.restrictionMessage}</div> : null}

              <section className="composer-card">
                {!isCompactLayout ? (
                  <div className="launcher-match-row">
                    <span className="launcher-match-label">Directory matches</span>
                    <code>{launcherMatchPath}</code>
                  </div>
                ) : null}

                <label className="field">
                  <span>Session type</span>
                  <select value={sessionType} onChange={(event) => setSessionType(event.target.value as SessionType)}>
                    {sessionTypeOptions.map((option) => (
                      <option disabled={!option.available} key={option.id} value={option.id}>
                        {option.label}
                        {!option.available ? " (not found)" : ""}
                      </option>
                    ))}
                  </select>
                </label>

                {sessionTypeUnavailable ? (
                  <div className="error-banner">
                    {selectedSessionTypeOption.label} is not available on this server. Set {selectedSessionTypeOption.envVar} and restart the service.
                  </div>
                ) : null}

                <label className="field">
                  <span>Session label</span>
                  <input
                    type="text"
                    value={sessionLabel}
                    onChange={(event) => setSessionLabel(event.target.value)}
                    placeholder="Optional. For example: billing-api"
                  />
                </label>

                <label className="field">
                  <span>Working directory</span>
                  <input
                    type="text"
                    value={draftWorkspace}
                    onChange={(event) => setDraftWorkspace(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown") {
                        if (!directorySuggestions.length) {
                          return;
                        }

                        event.preventDefault();
                        setActiveSuggestionIndex((current) =>
                          current >= directorySuggestions.length - 1 ? 0 : current + 1,
                        );
                        return;
                      }

                      if (event.key === "ArrowUp") {
                        if (!directorySuggestions.length) {
                          return;
                        }

                        event.preventDefault();
                        setActiveSuggestionIndex((current) =>
                          current <= 0 ? directorySuggestions.length - 1 : current - 1,
                        );
                        return;
                      }

                      if (event.key === "Enter") {
                        event.preventDefault();
                        const candidate = directorySuggestions[activeSuggestionIndex];
                        if (candidate) {
                          void handleSuggestionSelect(candidate);
                          return;
                        }

                        void handleOpenPath();
                      }

                      if (event.key === "Tab") {
                        const candidate = directorySuggestions[activeSuggestionIndex];
                        if (!candidate) {
                          return;
                        }

                        event.preventDefault();
                        setDraftWorkspace(candidate.path);
                      }
                    }}
                    placeholder={auth.homeDir || "/home/you/project"}
                  />
                </label>

                <div className="action-row">
                  <button
                    className="primary-button"
                    disabled={isBusy || !resolvedWorkspace || sandboxRestricted || tmuxUnavailable || sessionTypeUnavailable}
                    onClick={() => void handleCreateSession()}
                    type="button"
                  >
                    Open session
                  </button>
                  <button className="ghost-button" disabled={isBusy || !draftWorkspace.trim()} onClick={() => void handleOpenPath()} type="button">
                    Open path
                  </button>
                </div>

                {isCompactLayout ? (
                  <div className="suggestion-panel inline-suggestion-panel">
                    {!suggestionLoading && recentDirectoryMatches.length ? (
                      <div className="recent-directory-group">
                        <div className="recent-directory-header">Recent</div>
                        <div className="suggestion-list">
                          {recentDirectoryMatches.map((entry) => (
                            <button
                              className={`suggestion-item recent-directory-item ${draftWorkspace === entry.path ? "selected" : ""}`}
                              key={`compact-recent-${entry.path}`}
                              onClick={() => void handleSuggestionSelect(entry)}
                              type="button"
                            >
                              <div className="directory-item-head">
                                <span>{entry.name}</span>
                                {entry.isSymlink ? <span className="directory-badge">Symlink</span> : null}
                              </div>
                              <code>{formatDirectoryLine(entry)}</code>
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    {suggestionLoading ? <div className="suggestion-empty">Loading directories...</div> : null}
                    {!suggestionLoading && directorySuggestions.length ? (
                      <div className="suggestion-list">
                        {directorySuggestions.map((entry, index) => (
                          <button
                            className={`suggestion-item ${index === activeSuggestionIndex ? "selected" : ""}`}
                            key={`compact-${entry.path}`}
                            onClick={() => void handleSuggestionSelect(entry)}
                            onMouseEnter={() => setActiveSuggestionIndex(index)}
                            type="button"
                          >
                            <div className="directory-item-head">
                              <span>{entry.name}</span>
                              {entry.isSymlink ? <span className="directory-badge">Symlink</span> : null}
                            </div>
                            <code>{formatDirectoryLine(entry)}</code>
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {!suggestionLoading && !recentDirectoryMatches.length && !directorySuggestions.length ? (
                      <div className="suggestion-empty">No matching directories</div>
                    ) : null}
                  </div>
                ) : null}
              </section>
            </div>
          </details>

          <details
            className="mobile-fold"
            open={!isCompactLayout || mobileDirectoriesOpen}
            onToggle={(event) =>
              toggleCompactPanel("directories", (event.currentTarget as HTMLDetailsElement).open)
            }
          >
            <summary className="mobile-fold-summary">
              <div>
                <div className="eyebrow">Directories</div>
                <strong>Pick a folder</strong>
              </div>
              <span className="mobile-fold-meta">{directoryList.current || auth.homeDir || "Browse"}</span>
            </summary>
            <div className="mobile-fold-body compact-stack">
              {!isCompactLayout ? (
                <div className="suggestion-panel">
                <div className="suggestion-header">
                  <span>Directory matches</span>
                  <code>{suggestionBasePath || currentBrowsePath || auth.homeDir}</code>
                </div>
                  {!suggestionLoading && recentDirectoryMatches.length ? (
                    <div className="recent-directory-group">
                      <div className="recent-directory-header">Recent</div>
                      <div className="suggestion-list">
                        {recentDirectoryMatches.map((entry) => (
                          <button
                            className={`suggestion-item recent-directory-item ${draftWorkspace === entry.path ? "selected" : ""}`}
                            key={`recent-${entry.path}`}
                            onClick={() => void handleSuggestionSelect(entry)}
                            type="button"
                          >
                            <div className="directory-item-head">
                              <span>{entry.name}</span>
                              {entry.isSymlink ? <span className="directory-badge">Symlink</span> : null}
                            </div>
                            <code>{formatDirectoryLine(entry)}</code>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {suggestionLoading ? <div className="suggestion-empty">Loading directories...</div> : null}
                  {!suggestionLoading && directorySuggestions.length ? (
                    <div className="suggestion-list">
                      {directorySuggestions.map((entry, index) => (
                        <button
                          className={`suggestion-item ${index === activeSuggestionIndex ? "selected" : ""}`}
                          key={entry.path}
                          onClick={() => void handleSuggestionSelect(entry)}
                          onMouseEnter={() => setActiveSuggestionIndex(index)}
                          type="button"
                        >
                          <div className="directory-item-head">
                            <span>{entry.name}</span>
                            {entry.isSymlink ? <span className="directory-badge">Symlink</span> : null}
                          </div>
                          <code>{formatDirectoryLine(entry)}</code>
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {!suggestionLoading && !directorySuggestions.length ? (
                    <div className="suggestion-empty">No matching directories</div>
                  ) : null}
                </div>
              ) : null}

              <div className="directory-browser">
                <div className="browser-toolbar">
                  <button
                    className="ghost-button"
                    disabled={!directoryList.parent || loadingDirs}
                    onClick={() => directoryList.parent && void openDirectory(directoryList.parent)}
                    type="button"
                  >
                    Up
                  </button>
                  <div className="browser-path">{directoryList.current || auth.homeDir}</div>
                </div>
                <div className="browser-list">
                  {loadingDirs ? <div className="empty-state">Loading folders...</div> : null}
                  {!loadingDirs && directoryList.children.length ? (
                    directoryList.children.map((entry) => (
                      <button
                        className={`browser-item ${draftWorkspace === entry.path ? "selected" : ""}`}
                        key={entry.path}
                        onClick={() => void handleSuggestionSelect(entry)}
                        type="button"
                      >
                        <div className="directory-item-head">
                          <span>{entry.name}</span>
                          {entry.isSymlink ? <span className="directory-badge">Symlink</span> : null}
                        </div>
                        <code>{formatDirectoryLine(entry)}</code>
                      </button>
                    ))
                  ) : null}
                  {!loadingDirs && !directoryList.children.length ? (
                    <div className="empty-state">No folders found in this directory.</div>
                  ) : null}
                </div>
              </div>

              <div className="hint mobile-hint">The launcher uses tmux sessions, so service restarts can rediscover existing supported CLI terminals.</div>
            </div>
          </details>

        </aside>

        <section className={`panel terminal-panel${terminalKeyboardMode ? " terminal-panel-keyboard" : ""}`}>
          {selectedSession ? (
            <>
              <div className="panel-header terminal-header">
                <div className="terminal-heading">
                  <div className="eyebrow">Active Session</div>
                  <h2>{selectedSession.label}</h2>
                  <div className="terminal-subtitle">
                    {getSessionTypeLabel(sessionTypeOptions, selectedSession.sessionType)} · {selectedSession.workspace}
                  </div>
                  {isCompactLayout ? (
                    <div className="terminal-summary-line">
                      <span className={`status-dot terminal-status-badge ${liveStatus === "Connected" ? "connected" : ""}`}>
                        {formatCompactStatus(liveStatus)}
                      </span>
                      <span className="terminal-summary-item">{formatTime(selectedSession.createdAt)}</span>
                      <span className="terminal-summary-item">{selectedSession.attachedClients} attached</span>
                      <div className="terminal-summary-actions">
                        <button className="ghost-button" disabled={isBusy} onClick={() => void handleRefreshSessions()} type="button">
                          Sync
                        </button>
                        <button className="ghost-button" disabled={isBusy} onClick={() => void handleStopSession()} type="button">
                          Stop
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
                <div className="topbar-actions terminal-actions">
                  {!isCompactLayout ? <span className={`status-dot ${liveStatus === "Connected" ? "connected" : ""}`}>{liveStatus}</span> : null}
                  {!isCompactLayout ? (
                    <>
                      <button className="ghost-button" disabled={isBusy} onClick={() => void handleRefreshSessions()} type="button">
                        Sync
                      </button>
                      <button className="ghost-button" disabled={isBusy} onClick={() => void handleStopSession()} type="button">
                        Stop
                      </button>
                    </>
                  ) : null}
                </div>
              </div>

              {!isCompactLayout ? (
                <div className="terminal-chip-row">
                  <div className="terminal-chip">type: {getSessionTypeLabel(sessionTypeOptions, selectedSession.sessionType)}</div>
                  <div className="terminal-chip">tmux: {selectedSession.tmuxSession}</div>
                  <div className="terminal-chip">started: {formatTime(selectedSession.createdAt)}</div>
                  <div className="terminal-chip">attached: {selectedSession.attachedClients}</div>
                </div>
              ) : null}

              <div className="terminal-host" ref={terminalRef} />

              {isCompactLayout ? (
                <details className="terminal-tools-fold">
                  <summary className="terminal-tools-summary">
                    <span>Quick tools</span>
                    <span>{compactStatusLabel}</span>
                  </summary>
                  <div className="terminal-tools-body">{renderTerminalTools()}</div>
                </details>
              ) : (
                renderTerminalTools()
              )}
            </>
          ) : (
            <div className="terminal-empty-state">
              <div className="eyebrow">Terminal</div>
              <h2>Select a running session</h2>
              <p className="panel-copy">
                Use the session picker in the top bar to attach to a tmux client. On phones, the quick input
                bar below the terminal is the fastest way to send short commands.
              </p>
              <button className="primary-button" onClick={() => setMobileView("sessions")} type="button">
                Open launcher
              </button>
            </div>
          )}
        </section>
      </section>

      {sessionError ? <div className="error-banner floating-error">{sessionError}</div> : null}
    </main>
  );
}

export default App;