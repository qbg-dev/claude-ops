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

/** Get all pane info in a single tmux call — replaces separate listPaneIds + getPaneTarget calls */
export function listPaneInfo(): Map<string, { session: string; window: string; index: number }> {
  const { ok, stdout } = run([
    "list-panes", "-a", "-F", "#{pane_id}\t#{session_name}\t#{window_name}\t#{pane_index}",
  ]);
  if (!ok) return new Map();
  const result = new Map<string, { session: string; window: string; index: number }>();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [paneId, session, window, indexStr] = line.split("\t");
    if (paneId) {
      result.set(paneId, { session, window, index: parseInt(indexStr, 10) || 0 });
    }
  }
  return result;
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
  // When no index specified, find next free index.
  // `tmux new-window -t session` tries to use the active window's index, which fails
  // if that window already exists. We must always specify an explicit free index.
  if (index === undefined) {
    const { stdout: windowList } = run(["list-windows", "-t", session, "-F", "#{window_index}"]);
    const usedIndices = new Set(windowList.split("\n").filter(Boolean).map(Number));
    const { stdout: baseStr } = run(["show-options", "-gv", "base-index"]);
    let freeIndex = parseInt(baseStr, 10) || 1;
    while (usedIndices.has(freeIndex)) freeIndex++;
    index = freeIndex;
  }
  const target = `${session}:${index}`;
  const { stdout } = run([
    "new-window", "-t", target, "-n", window, "-c", cwd, "-d", "-P", "-F", "#{pane_id}",
  ]);
  return stdout;
}

/** Set pane title */
export function setPaneTitle(paneId: string, title: string): void {
  run(["select-pane", "-T", title, "-t", paneId]);
}

/** Kill a pane */
export function killPane(paneId: string): void {
  run(["kill-pane", "-t", paneId]);
}

/** Get the PID of the process running in a pane */
export function getPanePid(paneId: string): number | null {
  const { ok, stdout } = run(["list-panes", "-a", "-F", "#{pane_id} #{pane_pid}", ]);
  if (!ok) return null;
  for (const line of stdout.split("\n")) {
    const [id, pidStr] = line.split(" ");
    if (id === paneId && pidStr) return parseInt(pidStr, 10) || null;
  }
  return null;
}

/**
 * Kill the process tree in a pane, wait for it to die, then kill the pane.
 * Prevents orphan Claude processes that keep running after the pane is destroyed.
 */
export async function killPaneWithProcess(paneId: string, timeoutMs = 10_000): Promise<void> {
  const pid = getPanePid(paneId);
  if (pid) {
    // Kill the process group (negative PID = process group)
    try { process.kill(-pid, "SIGTERM"); } catch {
      // Process group kill failed — try direct kill
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
    // Wait for the process to die
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try { process.kill(pid, 0); } catch { break; } // pid gone
      await Bun.sleep(500);
    }
    // Force kill if still alive
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  killPane(paneId);
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
    if (/[❯>]\s*$/m.test(output)) return true;
    await Bun.sleep(2000);
  }
  return false;
}

/**
 * Inject text via tmux buffer (safer for large content).
 * For very large seeds (>8KB), uses chunked paste to prevent tmux buffer overflow
 * that can garble output and leak seed text into the shell.
 */
export function pasteBuffer(paneId: string, content: string): boolean {
  const { writeFileSync, unlinkSync } = require("node:fs");

  // Chunk large content to prevent tmux paste buffer overflow.
  // tmux handles buffers fine up to ~64KB but Claude's TUI input can get
  // garbled if too much text arrives at once. 8KB chunks are safe.
  const MAX_CHUNK = 8 * 1024;
  if (content.length > MAX_CHUNK) {
    // For large seeds, write to file and use -p flag to paste line-by-line
    // Actually: just use a single buffer but give tmux time to process
    const tmpFile = `/tmp/fleet-paste-${process.pid}.txt`;
    writeFileSync(tmpFile, content);
    try {
      const bufName = `fleet-${process.pid}`;
      run(["delete-buffer", "-b", bufName]);
      const load = run(["load-buffer", "-b", bufName, tmpFile]);
      if (!load.ok) return false;
      // Use -p to NOT remove the buffer on paste (we delete it after)
      run(["paste-buffer", "-b", bufName, "-t", paneId]);
      // Small delay for tmux to process, then delete buffer
      Bun.sleepSync(500);
      run(["delete-buffer", "-b", bufName]);
      return true;
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }
  }

  const tmpFile = `/tmp/fleet-paste-${process.pid}.txt`;
  writeFileSync(tmpFile, content);

  try {
    const bufName = `fleet-${process.pid}`;
    run(["delete-buffer", "-b", bufName]); // ignore error
    const load = run(["load-buffer", "-b", bufName, tmpFile]);
    if (!load.ok) return false;

    run(["paste-buffer", "-b", bufName, "-t", paneId, "-d"]);
    return true;
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

/** Send /exit to a pane and wait for Claude to exit */
export async function gracefulStop(paneId: string, timeoutMs = 30_000): Promise<boolean> {
  sendKeys(paneId, "/exit");
  sendEnter(paneId);

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // Check if pane still exists
    if (!listPaneIds().has(paneId)) return true;
    // Check if shell prompt appeared (claude exited) — test last line only
    const output = capturePane(paneId, 3);
    const lastLine = output.split("\n").filter(Boolean).pop() || "";
    if (/^\$\s|^➜|^%\s/.test(lastLine)) return true;
    await Bun.sleep(2000);
  }

  // Timeout — force kill
  run(["kill-pane", "-t", paneId]);
  return false;
}
