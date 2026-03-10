/**
 * tmux operations: pane creation, send-keys, capture, liveness checks.
 */

function run(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["tmux", ...args], { stderr: "pipe" });
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

/** Check if a tmux session exists */
export function sessionExists(session: string): boolean {
  return run(["has-session", "-t", session]).ok;
}

/** Create a new tmux session */
export function createSession(session: string, window: string, cwd: string): string {
  run(["new-session", "-d", "-s", session, "-n", window, "-c", cwd]);
  const { stdout } = run(["list-panes", "-t", session, "-F", "#{pane_id}"]);
  return stdout.split("\n")[0];
}

/** List all pane IDs (for liveness checks) */
export function listPaneIds(): Set<string> {
  const { ok, stdout } = run(["list-panes", "-a", "-F", "#{pane_id}"]);
  if (!ok) return new Set();
  return new Set(stdout.split("\n").filter(Boolean));
}

/** Get pane target (e.g. "w:2.3") for a pane ID */
export function getPaneTarget(paneId: string): string {
  const { stdout } = run([
    "list-panes", "-a", "-F", "#{pane_id} #{session_name}:#{window_index}.#{pane_index}",
  ]);
  for (const line of stdout.split("\n")) {
    const [id, target] = line.split(" ");
    if (id === paneId) return target || "";
  }
  return "";
}

/** Check if a window exists in a session */
export function windowExists(session: string, window: string): boolean {
  const { ok, stdout } = run(["list-windows", "-t", session, "-F", "#{window_name}"]);
  if (!ok) return false;
  return stdout.split("\n").includes(window);
}

/** Split into existing window, re-tile */
export function splitIntoWindow(session: string, window: string, cwd: string): string {
  const { stdout } = run([
    "split-window", "-t", `${session}:${window}`, "-c", cwd, "-d", "-P", "-F", "#{pane_id}",
  ]);
  run(["select-layout", "-t", `${session}:${window}`, "tiled"]);
  return stdout;
}

/** Create a new window */
export function createWindow(session: string, window: string, cwd: string, index?: number): string {
  const target = index !== undefined ? `${session}:${index}` : session;
  const { stdout } = run([
    "new-window", "-t", target, "-n", window, "-c", cwd, "-d", "-P", "-F", "#{pane_id}",
  ]);
  return stdout;
}

/** Set pane title */
export function setPaneTitle(paneId: string, title: string): void {
  run(["select-pane", "-T", title, "-t", paneId]);
}

/** Send keys to a pane */
export function sendKeys(paneId: string, text: string): void {
  run(["send-keys", "-t", paneId, text]);
}

/** Send Enter to a pane */
export function sendEnter(paneId: string): void {
  run(["send-keys", "-t", paneId, "-H", "0d"]);
}

/** Capture pane output (last N lines) */
export function capturePane(paneId: string, lines = 100): string {
  const { ok, stdout } = run(["capture-pane", "-t", paneId, "-p", "-S", `-${lines}`]);
  return ok ? stdout : "";
}

/** Wait for Claude TUI prompt (❯ or > $), polling up to timeoutMs */
export async function waitForPrompt(paneId: string, timeoutMs = 60_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const output = capturePane(paneId, 5);
    if (/❯|> $/.test(output)) return true;
    await Bun.sleep(2000);
  }
  return false;
}

/** Inject text via tmux buffer (safer for large content) */
export function pasteBuffer(paneId: string, content: string): boolean {
  const tmpFile = `/tmp/fleet-paste-${process.pid}.txt`;
  Bun.write(tmpFile, content);

  const bufName = `fleet-${process.pid}`;
  run(["delete-buffer", "-b", bufName]); // ignore error
  const load = run(["load-buffer", "-b", bufName, tmpFile]);
  if (!load.ok) return false;

  run(["paste-buffer", "-b", bufName, "-t", paneId, "-d"]);
  return true;
}

/** Send /stop to a pane and wait for exit */
export async function gracefulStop(paneId: string, timeoutMs = 30_000): Promise<boolean> {
  sendKeys(paneId, "/stop");
  sendEnter(paneId);

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // Check if pane still exists
    if (!listPaneIds().has(paneId)) return true;
    // Check if shell prompt appeared (claude exited)
    const output = capturePane(paneId, 3);
    if (/^\$|^➜|zsh/.test(output)) return true;
    await Bun.sleep(2000);
  }

  // Timeout — force kill
  run(["kill-pane", "-t", paneId]);
  return false;
}
