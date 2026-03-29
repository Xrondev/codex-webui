import { FormEvent, useEffect, useRef, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "@xterm/addon-fit";

type DirectoryList = {
  current: string;
  parent: string | null;
  children: Array<{ name: string; path: string }>;
};

type ProviderSummary = {
  modelProvider: string;
  baseUrl?: string;
  envKey?: string;
  envKeyPresent: boolean;
};

type AuthState = {
  authenticated: boolean;
  token?: string;
  running: boolean;
  workspace?: string;
  homeDir?: string;
  sandboxRestricted?: boolean;
  restrictionMessage?: string;
  provider?: ProviderSummary;
};

type ServerMessage =
  | { type: "snapshot"; data: string; workspace: string; running: boolean }
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number; signal?: number }
  | { type: "status"; running: boolean; workspace?: string }
  | { type: "error"; message: string };

const initialDirectory: DirectoryList = {
  current: "",
  parent: null,
  children: [],
};

type DirectoryCandidate = {
  name: string;
  path: string;
};

function isHiddenDirectory(name: string) {
  return name.startsWith(".");
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

function createWebSocketUrl(token?: string) {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const search = token ? `?token=${encodeURIComponent(token)}` : "";
  return `${protocol}://${window.location.host}/ws${search}`;
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

function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [password, setPassword] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [directoryList, setDirectoryList] = useState<DirectoryList>(initialDirectory);
  const [loadingDirs, setLoadingDirs] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [suggestionPool, setSuggestionPool] = useState<DirectoryCandidate[]>([]);
  const [suggestionBasePath, setSuggestionBasePath] = useState("");
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
  const [suggestionLoading, setSuggestionLoading] = useState(false);
  const [terminalReady, setTerminalReady] = useState(false);
  const [liveStatus, setLiveStatus] = useState("Connecting...");
  const [isBusy, setIsBusy] = useState(false);

  const terminalRef = useRef<HTMLDivElement | null>(null);
  const terminalInstanceRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const resizeFrameRef = useRef<number | null>(null);

  const running = Boolean(auth?.running);
  const sandboxRestricted = Boolean(auth?.sandboxRestricted);
  const selectedWorkspace = auth?.workspace ?? workspace;
  const currentBrowsePath = directoryList.current || auth?.homeDir || "";
  const resolvedWorkspace = workspace.trim() || currentBrowsePath;
  const normalizedCurrentPath = currentBrowsePath.replace(/\/+$/, "") || "/";
  const normalizedResolvedPath = resolvedWorkspace.replace(/\/+$/, "") || "/";
  const showTargetMeta = Boolean(resolvedWorkspace) && normalizedResolvedPath !== normalizedCurrentPath;
  const suggestionTarget = resolveSuggestionTarget(workspace, currentBrowsePath, auth?.homeDir);
  const directorySuggestions = sortCandidates(suggestionPool, suggestionTarget.query);
  const terminalFooterWorkspace = auth?.workspace ?? resolvedWorkspace;
  const statusLabel = running
    ? "Codex running"
    : auth?.authenticated
      ? "Ready to start"
      : "Login required";

  async function refreshSession() {
    try {
      const session = await api<AuthState>("/api/auth/session");
      setAuth(session);
      setWorkspace(session.workspace ?? session.homeDir ?? "");
      setAuthError(null);
      return session;
    } catch {
      setAuth({ authenticated: false, running: false });
      return null;
    }
  }

  async function loadDirectories(targetPath?: string, syncWorkspace = false) {
    setLoadingDirs(true);
    try {
      const query = targetPath ? `?path=${encodeURIComponent(targetPath)}` : "";
      const payload = await api<DirectoryList>(`/api/fs/list${query}`, {
        method: "GET",
      });
      setDirectoryList(payload);
      if (syncWorkspace || !workspace.trim()) {
        setWorkspace(payload.current);
      }
      setWorkspaceError(null);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "Unable to load folders");
    } finally {
      setLoadingDirs(false);
    }
  }

  async function openDirectory(targetPath: string) {
    await loadDirectories(targetPath, true);
  }

  function scheduleFit() {
    if (resizeFrameRef.current !== null) {
      cancelAnimationFrame(resizeFrameRef.current);
    }

    resizeFrameRef.current = requestAnimationFrame(() => {
      fitAddonRef.current?.fit();
      resizeFrameRef.current = null;
    });
  }

  useEffect(() => {
    void refreshSession().then((session) => {
      if (session?.authenticated) {
        void loadDirectories(session.workspace ?? session.homeDir, true);
      }
    });
  }, []);

  useEffect(() => {
    if (!auth?.authenticated || !terminalRef.current || terminalInstanceRef.current) {
      return;
    }

    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: '"IBM Plex Mono", "SFMono-Regular", Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.25,
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
      terminal.dispose();
      terminalInstanceRef.current = null;
      fitAddonRef.current = null;
      setTerminalReady(false);
    };
  }, [auth?.authenticated]);

  useEffect(() => {
    if (!auth?.authenticated || !auth.token || !terminalReady) {
      return;
    }

    const socket = new WebSocket(createWebSocketUrl(auth.token));
    socketRef.current = socket;

    socket.onopen = () => {
      setLiveStatus("Connected");
      scheduleFit();
    };

    socket.onmessage = (event) => {
      const message = JSON.parse(event.data) as ServerMessage;
      const terminal = terminalInstanceRef.current;
      if (!terminal) {
        return;
      }

      if (message.type === "snapshot") {
        terminal.reset();
        if (message.data) {
          terminal.write(message.data);
        }
        setAuth((current) =>
          current
            ? {
                ...current,
                running: message.running,
                workspace: message.workspace || current.workspace,
              }
            : current,
        );
        return;
      }

      if (message.type === "output") {
        terminal.write(message.data);
        return;
      }

      if (message.type === "exit") {
        terminal.writeln(`\r\n[Codex exited with code ${message.exitCode}]`);
        setAuth((current) => (current ? { ...current, running: false } : current));
        return;
      }

      if (message.type === "status") {
        setAuth((current) =>
          current
            ? {
                ...current,
                running: message.running,
                workspace: message.workspace ?? current.workspace,
              }
            : current,
        );
        return;
      }

      if (message.type === "error") {
        terminal.writeln(`\r\n[WebSocket error] ${message.message}`);
      }
    };

    socket.onclose = () => {
      setLiveStatus("Disconnected");
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
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
  }, [auth?.authenticated, auth?.token, terminalReady]);

  useEffect(() => {
    if (auth?.authenticated && terminalReady) {
      scheduleFit();
    }
  }, [auth?.authenticated, terminalReady, running]);

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
  }, [workspace, suggestionBasePath]);

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
        await loadDirectories(session.workspace ?? session.homeDir, true);
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
      setAuth({ authenticated: false, running: false });
      setDirectoryList(initialDirectory);
      setWorkspace("");
      setWorkspaceError(null);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Unable to logout");
    } finally {
      setIsBusy(false);
    }
  }

  async function handleStartSession() {
    if (!resolvedWorkspace) {
      setWorkspaceError("Workspace is required");
      return;
    }

    setIsBusy(true);
    try {
      const response = await api<{ ok: true; workspace: string; running: boolean }>("/api/codex/start", {
        method: "POST",
        body: JSON.stringify({ workspace: resolvedWorkspace }),
      });
      setAuth((current) =>
        current
          ? {
              ...current,
              running: response.running,
              workspace: response.workspace,
            }
          : current,
      );
      setWorkspace(response.workspace);
      terminalInstanceRef.current?.reset();
      setWorkspaceError(null);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "Unable to start Codex");
    } finally {
      setIsBusy(false);
    }
  }

  async function handleStopSession() {
    setIsBusy(true);
    try {
      await api("/api/codex/stop", {
        method: "POST",
        body: JSON.stringify({}),
      });
      setAuth((current) => (current ? { ...current, running: false } : current));
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "Unable to stop Codex");
    } finally {
      setIsBusy(false);
    }
  }

  async function handleOpenPath() {
    if (!workspace.trim()) {
      return;
    }

    await openDirectory(workspace.trim());
  }

  async function handleSuggestionSelect(candidate: DirectoryCandidate) {
    setWorkspace(candidate.path);
    await openDirectory(candidate.path);
  }

  if (!auth?.authenticated) {
    return (
      <main className="shell shell-login">
        <section className="panel login-panel">
          <div className="eyebrow">Codex Web UI</div>
          <h1>Login and launch your local Codex workspace.</h1>
          <p className="panel-copy">
            This UI wraps the installed <code>codex</code> CLI, so slash commands, thinking output,
            and tool logs stay aligned with the terminal experience.
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
          <div className="hint">Default password is <code>codex-webui</code> unless you set <code>WEBUI_PASSWORD</code>.</div>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="topbar panel">
        <div>
          <div className="eyebrow">Workspace</div>
          <strong>{selectedWorkspace || "Not selected"}</strong>
        </div>
        <div className="topbar-actions">
          <span className={`status-pill ${running ? "active" : ""}`}>{statusLabel}</span>
          <button className="ghost-button" onClick={handleLogout} type="button">
            Logout
          </button>
        </div>
      </header>

      <section className="meta-strip panel" aria-label="Workspace details">
        {showTargetMeta ? (
          <div className="meta-item meta-item-wide">
            <span className="meta-label">Target</span>
            <code>{resolvedWorkspace}</code>
          </div>
        ) : null}
        {!suggestionLoading && directorySuggestions.length ? (
          <div className="meta-item meta-item-wide">
            <span className="meta-label">Shortcuts</span>
            <span>Up/Down, Tab, Enter</span>
          </div>
        ) : null}
        <div className="meta-item">
          <span className="meta-label">Provider</span>
          <code>{auth.provider?.modelProvider ?? "unknown"}</code>
        </div>
        {auth.provider?.baseUrl ? (
          <div className="meta-item meta-item-wide">
            <span className="meta-label">Base URL</span>
            <code>{auth.provider.baseUrl}</code>
          </div>
        ) : null}
        {auth.provider?.envKey ? (
          <div className="meta-item">
            <span className="meta-label">Credential</span>
            <span>{auth.provider.envKeyPresent ? `${auth.provider.envKey} detected` : `${auth.provider.envKey} missing`}</span>
          </div>
        ) : null}
      </section>

      <section className="workspace-grid">
        <aside className="panel workspace-panel">
          <div className="panel-header">
            <div>
              <div className="eyebrow">Launcher</div>
              <h2>Pick a working directory</h2>
            </div>
            <button
              className="ghost-button"
              disabled={loadingDirs}
              onClick={() => void loadDirectories(directoryList.current || auth.homeDir, true)}
              type="button"
            >
              Refresh
            </button>
          </div>

          <label className="field">
            <span>Working directory</span>
            <input
              type="text"
              value={workspace}
              onChange={(event) => setWorkspace(event.target.value)}
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
                  setWorkspace(candidate.path);
                }
              }}
              placeholder={auth.homeDir || "/Users/you/project"}
            />
          </label>

          <div className="suggestion-panel">
            <div className="suggestion-header">
              <span>Directory matches</span>
              <code>{suggestionBasePath || currentBrowsePath || auth.homeDir}</code>
            </div>
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
                    <span>{entry.name}</span>
                    <code>{entry.path}</code>
                  </button>
                ))}
              </div>
            ) : null}
            {!suggestionLoading && !directorySuggestions.length ? (
              <div className="suggestion-empty">No matching directories</div>
            ) : null}
          </div>

          <div className="directory-browser">
            <div className="browser-toolbar">
              <button
                className="ghost-button"
                disabled={!directoryList.parent || loadingDirs}
                onClick={() => {
                  if (directoryList.parent) {
                    void openDirectory(directoryList.parent);
                  }
                }}
                type="button"
              >
                Up
              </button>
              <div className="browser-path">{directoryList.current || auth.homeDir}</div>
            </div>

            <div className="browser-list">
              {directoryList.children.map((entry) => (
                <button
                  className={`browser-item ${resolvedWorkspace === entry.path ? "selected" : ""}`}
                  key={entry.path}
                  onClick={() => void openDirectory(entry.path)}
                  type="button"
                >
                  <span>{entry.name}</span>
                  <code>{entry.path}</code>
                </button>
              ))}
              {!directoryList.children.length ? (
                <div className="empty-state">
                  {loadingDirs ? "Loading folders..." : "No child directories"}
                </div>
              ) : null}
            </div>
          </div>

          <div className="action-row">
            <button
              className="ghost-button"
              disabled={loadingDirs || !workspace.trim()}
              onClick={() => void handleOpenPath()}
              type="button"
            >
              Open path
            </button>
          </div>

          {auth.restrictionMessage ? <div className="error-banner">{auth.restrictionMessage}</div> : null}
          {workspaceError ? <div className="error-banner">{workspaceError}</div> : null}

          <div className="action-row">
            <button
              className="primary-button"
              disabled={isBusy || !resolvedWorkspace || sandboxRestricted}
              onClick={() => void handleStartSession()}
              type="button"
            >
              {running ? "Restart in this folder" : "Start Codex"}
            </button>
            <button
              className="ghost-button"
              disabled={isBusy || !running}
              onClick={() => void handleStopSession()}
              type="button"
            >
              Stop session
            </button>
          </div>

          <div className="hint">
            The browser is driving the installed <code>codex</code> binary directly, so existing slash
            commands still work.
          </div>
        </aside>

        <section className="panel terminal-panel">
          <div className="panel-header">
            <div>
              <div className="eyebrow">Live Session</div>
              <h2>CLI output, thinking, and tool logs</h2>
            </div>
            <span className={`status-dot ${liveStatus === "Connected" ? "connected" : ""}`}>
              {liveStatus}
            </span>
          </div>

          <div className="terminal-host" ref={terminalRef} />

          <div className="terminal-footer" aria-label="Session status">
            <span className="terminal-footer-item">
              <span className="terminal-footer-label">Input</span>
              <span>Type directly in the terminal above</span>
            </span>
            <span className="terminal-footer-item">
              <span className="terminal-footer-label">Session</span>
              <span>{running ? "Running" : "Idle"}</span>
            </span>
            <span className="terminal-footer-item terminal-footer-item-wide">
              <span className="terminal-footer-label">Directory</span>
              <code>{terminalFooterWorkspace || auth.homeDir}</code>
            </span>
          </div>
        </section>
      </section>
    </main>
  );
}

export default App;