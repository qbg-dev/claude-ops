/**
 * Tmux layout management — creates sessions, windows, and panes from CompiledPlan.
 *
 * Reuses tmux helpers from the existing codebase pattern (Bun.spawnSync).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FLEET_DATA } from "../../cli/lib/paths";
import type { CompiledWindow, CompiledWorker, ProgramPipelineState } from "./types";

// ── Tmux helpers (matches existing deep-review/tmux.ts pattern) ──

function tmux(...args: string[]): { ok: boolean; stdout: string } {
  const result = (Bun.spawnSync as any)(["tmux", ...args], { stderr: "pipe" });
  return { ok: result.exitCode === 0, stdout: result.stdout.toString().trim() };
}

function getPaneId(target: string, index: number): string {
  const { stdout } = tmux("list-panes", "-t", target, "-F", "#{pane_id}");
  const panes = stdout.split("\n").filter(Boolean);
  return panes[index] || "";
}

// ── Session creation ─────────────────────────────────────────────

/**
 * Create the tmux session with all windows defined in the compiled plan.
 * Returns the session name.
 */
export function createTmuxSession(
  state: ProgramPipelineState,
  windows: CompiledWindow[],
): string {
  const session = state.tmuxSession;
  const sessionExists = tmux("has-session", "-t", session).ok;

  if (sessionExists) {
    console.log(`Killing existing session: ${session}`);
    tmux("kill-session", "-t", session);
  }

  // Create session with manifest window
  console.log(`Creating tmux session: ${session}`);
  tmux("new-session", "-d", "-s", session, "-n", "manifest", "-c", state.projectRoot);
  Bun.sleepSync(300);

  // Create agent windows (no bridge windows needed — hooks launch bridge directly)
  // Deduplicate by name — multiple phases may share a window name (e.g. "planning")
  const created = new Set<string>();
  for (const win of windows) {
    if (created.has(win.name)) {
      // Window already exists — add panes to it instead of creating a duplicate
      for (let p = 0; p < win.paneCount; p++) {
        tmux("split-window", "-d", "-t", `${session}:${win.name}`, "-c", state.projectRoot);
      }
      tmux("select-layout", "-t", `${session}:${win.name}`, win.layout || "tiled");
      continue;
    }
    created.add(win.name);
    tmux("new-window", "-d", "-t", session, "-n", win.name, "-c", state.projectRoot);
    // Create extra panes
    for (let p = 1; p < win.paneCount; p++) {
      tmux("split-window", "-d", "-t", `${session}:${win.name}`, "-c", state.projectRoot);
    }
    if (win.paneCount > 1) {
      tmux("select-layout", "-t", `${session}:${win.name}`, win.layout || "tiled");
    }
  }

  Bun.sleepSync(500);
  return session;
}

/**
 * Add windows to an existing tmux session (for deferred phase compilation).
 */
export function addWindowsToSession(
  session: string,
  windows: CompiledWindow[],
  projectRoot: string,
): void {
  for (const win of windows) {
    // Check if window already exists
    const exists = tmux("list-windows", "-t", session, "-F", "#{window_name}");
    if (exists.stdout.split("\n").includes(win.name)) {
      continue; // Window already pre-created
    }

    tmux("new-window", "-d", "-t", session, "-n", win.name, "-c", projectRoot);
    for (let p = 1; p < win.paneCount; p++) {
      tmux("split-window", "-d", "-t", `${session}:${win.name}`, "-c", projectRoot);
    }
    if (win.paneCount > 1) {
      tmux("select-layout", "-t", `${session}:${win.name}`, win.layout || "tiled");
    }
  }
  Bun.sleepSync(300);
}

// ── Pane appending (back-edge cycles) ─────────────────────────────

const DEFAULT_MAX_PANES = 9;

/**
 * Check if a tmux pane has active child processes (i.e. not just an idle shell).
 */
function paneHasChildren(paneId: string): boolean {
  // Get the pane's shell PID, then check for children
  const { stdout } = tmux("display-message", "-t", paneId, "-p", "#{pane_pid}");
  const panePid = stdout.trim();
  if (!panePid) return false;
  const result = (Bun.spawnSync as any)(["pgrep", "-P", panePid], { stderr: "pipe" });
  return result.exitCode === 0;
}

/**
 * Append new panes to an existing window for back-edge cycle agents.
 * Recycles old idle panes (no child processes) to stay within maxPanes limit.
 * Returns the starting pane index for the new panes.
 */
export function appendPanesToWindow(
  session: string,
  windowName: string,
  newPaneCount: number,
  projectRoot: string,
  maxPanes: number = DEFAULT_MAX_PANES,
): number {
  const target = `${session}:${windowName}`;
  const { stdout } = tmux("list-panes", "-t", target, "-F", "#{pane_id}");
  let paneIds = stdout.split("\n").filter(Boolean);

  // Kill old idle panes (oldest first) to make room within maxPanes limit.
  // Panes are listed oldest-first by tmux, so iterate forward.
  const desiredTotal = Math.min(paneIds.length + newPaneCount, maxPanes);
  const toKill = paneIds.length + newPaneCount - desiredTotal;
  if (toKill > 0) {
    let killed = 0;
    for (const paneId of paneIds) {
      if (killed >= toKill) break;
      if (!paneHasChildren(paneId)) {
        tmux("kill-pane", "-t", paneId);
        killed++;
      }
    }
    if (killed > 0) {
      console.log(`  Recycled ${killed} idle panes in ${windowName}`);
    }
    // Re-read pane list after kills
    const refreshed = tmux("list-panes", "-t", target, "-F", "#{pane_id}");
    paneIds = refreshed.stdout.split("\n").filter(Boolean);
  }

  const existingCount = paneIds.length;

  for (let i = 0; i < newPaneCount; i++) {
    tmux("split-window", "-d", "-t", target, "-c", projectRoot);
  }

  if (existingCount + newPaneCount > 1) {
    tmux("select-layout", "-t", target, "tiled");
  }

  Bun.sleepSync(300);
  console.log(`  Appended ${newPaneCount} panes to ${windowName} (${existingCount} existing → ${existingCount + newPaneCount} total, max ${maxPanes})`);
  return existingCount;
}

// ── Agent launching ──────────────────────────────────────────────

/**
 * Launch a single agent in its assigned pane.
 */
export function launchAgent(
  worker: CompiledWorker,
  session: string,
  state: ProgramPipelineState,
): void {
  const pane = getPaneId(`${session}:${worker.window}`, worker.paneIndex);
  if (!pane) {
    console.log(`  WARN: No pane at ${session}:${worker.window}[${worker.paneIndex}]`);
    return;
  }

  tmux("send-keys", "-t", pane, `bash '${worker.wrapperPath}'`, "Enter");
  console.log(`  ${worker.name} → ${pane} (${worker.window}[${worker.paneIndex}])`);

  // Track pane ID in fleet state
  if (state.fleetProject) {
    const stateFile = join(FLEET_DATA, state.fleetProject, worker.name, "state.json");
    try {
      const s = JSON.parse(readFileSync(stateFile, "utf-8"));
      s.pane_id = pane;
      s.pane_target = `${session}:${worker.window}`;
      writeFileSync(stateFile, JSON.stringify(s, null, 2));
    } catch {}
  }
}

/**
 * Launch multiple agents with staggered starts (300ms apart).
 */
export function launchAgents(
  workers: CompiledWorker[],
  session: string,
  state: ProgramPipelineState,
): void {
  console.log(`Launching ${workers.length} agents...`);

  for (let i = 0; i < workers.length; i++) {
    launchAgent(workers[i], session, state);
    if (i < workers.length - 1) {
      Bun.sleepSync(300);
    }
  }
}

/**
 * Launch an agent in the planning window (split pane).
 * Used for Phase 0 agents that run in the initial planning window.
 */
export function launchInPlanningWindow(
  worker: CompiledWorker,
  session: string,
  state: ProgramPipelineState,
  paneIndex?: number,
): void {
  const target = `${session}:${worker.window || "planning"}`;
  const hasWindow = tmux("has-session", "-t", target);

  let pane: string;
  if (hasWindow.ok) {
    if (paneIndex && paneIndex > 0) {
      // Split a new pane
      tmux("split-window", "-d", "-t", target, "-c", state.workDir);
      Bun.sleepSync(300);
    }
    pane = getPaneId(target, paneIndex || 0);
  } else {
    // Create the planning window
    tmux("new-window", "-d", "-t", session, "-n", worker.window || "planning", "-c", state.workDir);
    Bun.sleepSync(300);
    pane = getPaneId(`${session}:${worker.window || "planning"}`, 0);
  }

  if (pane) {
    tmux("send-keys", "-t", pane, `bash '${worker.wrapperPath}'`, "Enter");
    console.log(`  ${worker.name} → ${pane} (${worker.window || "planning"})`);

    // Track pane ID
    if (state.fleetProject) {
      const stateFile = join(FLEET_DATA, state.fleetProject, worker.name, "state.json");
      try {
        const s = JSON.parse(readFileSync(stateFile, "utf-8"));
        s.pane_id = pane;
        s.pane_target = target;
        writeFileSync(stateFile, JSON.stringify(s, null, 2));
      } catch {}
    }
  }
}

/**
 * Display manifest in the manifest window (window 0).
 */
export function showManifest(session: string, manifestPath: string): void {
  if (!existsSync(manifestPath)) return;

  const pane = getPaneId(`${session}:manifest`, 0);
  if (pane) {
    tmux("send-keys", "-t", pane, `cat '${manifestPath}'`, "Enter");
  }
}
