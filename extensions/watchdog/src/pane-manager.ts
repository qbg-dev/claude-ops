/**
 * Pane lifecycle: window enforcement, move-to-inactive, pane validation.
 */

import type { PaneInfo } from "./types";

/** Tmux helper: run a tmux command and return stdout */
function tmux(...args: string[]): { ok: boolean; stdout: string } {
  const result = Bun.spawnSync(["tmux", ...args], { stderr: "pipe" });
  return { ok: result.exitCode === 0, stdout: result.stdout.toString().trim() };
}

/** List all pane IDs currently alive in tmux */
export function listAlivePanes(): Set<string> {
  const { ok, stdout } = tmux("list-panes", "-a", "-F", "#{pane_id}");
  if (!ok) return new Set();
  return new Set(stdout.split("\n").filter(Boolean));
}

/** Get all pane info in a single tmux call */
export function listPaneInfo(): Map<string, PaneInfo> {
  const { ok, stdout } = tmux(
    "list-panes", "-a", "-F",
    "#{pane_id}\t#{session_name}\t#{window_name}\t#{pane_index}",
  );
  if (!ok) return new Map();

  const result = new Map<string, PaneInfo>();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [paneId, session, window, indexStr] = line.split("\t");
    if (paneId) {
      result.set(paneId, { paneId, session, window, index: parseInt(indexStr, 10) || 0 });
    }
  }
  return result;
}

/** Check if a pane ID is valid (starts with %) */
export function isValidPaneId(paneId: string | null | undefined): boolean {
  return typeof paneId === "string" && paneId.startsWith("%") && paneId.length > 1;
}

/** Check if a tmux session exists */
export function sessionExists(session: string): boolean {
  return tmux("has-session", "-t", session).ok;
}

/** Check if a window exists in a session */
export function windowExists(session: string, window: string): boolean {
  const { ok, stdout } = tmux("list-windows", "-t", session, "-F", "#{window_name}");
  if (!ok) return false;
  return stdout.split("\n").includes(window);
}

/** Move a pane to the "inactive" window */
export function moveToInactive(paneId: string, session: string): void {
  const inactive = "inactive";
  if (!windowExists(session, inactive)) {
    tmux("new-window", "-t", session, "-n", inactive, "-d");
  }
  tmux("join-pane", "-t", `${session}:${inactive}`, "-s", paneId, "-d");
  tmux("select-layout", "-t", `${session}:${inactive}`, "tiled");
}

/** Enforce window placement — move pane to its registered window if misplaced */
export function enforceWindow(paneId: string, targetWindow: string, session: string, paneInfo: Map<string, PaneInfo>): boolean {
  if (!targetWindow) return false;

  const info = paneInfo.get(paneId);
  if (!info) return false;
  if (info.window === targetWindow) return false; // already correct

  // Create target window if needed
  if (!windowExists(session, targetWindow)) {
    tmux("new-window", "-t", session, "-n", targetWindow, "-d");
  }

  // Move the pane
  const { ok } = tmux("join-pane", "-s", paneId, "-t", `${session}:${targetWindow}`, "-d");
  if (ok) {
    tmux("select-layout", "-t", `${session}:${targetWindow}`, "tiled");
    return true;
  }
  return false;
}

/** Split a new pane into an existing window */
export function splitIntoWindow(session: string, window: string, cwd: string): string | null {
  const { ok, stdout } = tmux(
    "split-window", "-t", `${session}:${window}`, "-c", cwd, "-d", "-P", "-F", "#{pane_id}",
  );
  if (!ok) return null;
  tmux("select-layout", "-t", `${session}:${window}`, "tiled");
  return stdout.trim();
}

/** Check if any pane in a window is running a Claude process (by command name) */
export function windowHasClaudeProcess(session: string, window: string): string | null {
  const { ok, stdout } = tmux(
    "list-panes", "-t", `${session}:${window}`, "-F", "#{pane_id}\t#{pane_current_command}",
  );
  if (!ok) return null;
  for (const line of stdout.split("\n")) {
    const [paneId, cmd] = line.split("\t");
    // Claude shows as version number (e.g. "2.1.74") or "claude" in pane_current_command
    if (paneId && cmd && (/^\d+\.\d+/.test(cmd) || cmd.includes("claude"))) {
      return paneId;
    }
  }
  return null;
}

/** List ALL panes in a window running a Claude process */
export function windowAllClaudeProcesses(session: string, window: string): string[] {
  const { ok, stdout } = tmux(
    "list-panes", "-t", `${session}:${window}`, "-F", "#{pane_id}\t#{pane_current_command}",
  );
  if (!ok) return [];
  const panes: string[] = [];
  for (const line of stdout.split("\n")) {
    const [paneId, cmd] = line.split("\t");
    if (paneId && cmd && (/^\d+\.\d+/.test(cmd) || cmd.includes("claude"))) {
      panes.push(paneId);
    }
  }
  return panes;
}

/** Set pane title */
export function setPaneTitle(paneId: string, title: string): void {
  tmux("select-pane", "-T", title, "-t", paneId);
}
