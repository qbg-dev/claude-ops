/**
 * Tmux pane operations — liveness checks, message delivery, pane discovery.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { execSync, spawnSync } from "child_process";
import { HOME, WORKER_NAME } from "./config";
import {
  getWorkerEntry, readRegistry,
  type RegistryConfig, type RegistryWorkerEntry,
  getMissionAuthorityLabel, getReportTo,
} from "./registry";

// ── Pane Liveness ────────────────────────────────────────────────────

/** Check if a tmux pane is alive (single tmux call — display-message fails if pane/session gone) */
export function isPaneAlive(paneId: string): boolean {
  try {
    const check = spawnSync("tmux", ["display-message", "-t", paneId, "-p", "#{pane_id}"], {
      encoding: "utf-8", timeout: 3000,
    });
    return check.status === 0 && check.stdout.trim() === paneId;
  } catch {
    return false;
  }
}

/** Check if a tmux pane belongs to the expected worker by matching its window name.
 *  Prevents misrouting when tmux recycles pane IDs after worker restarts. */
export function isPaneOwnedBy(paneId: string, workerName: string): boolean {
  if (!isPaneAlive(paneId)) return false;
  try {
    const result = spawnSync("tmux", ["display-message", "-t", paneId, "-p", "#{window_name}"], {
      encoding: "utf-8", timeout: 3000,
    });
    const windowName = result.stdout?.trim() || "";
    // Worker panes use the worker name as window name, or "infra" for merger/chief-of-staff
    return windowName === workerName || windowName === "infra";
  } catch {
    return false;
  }
}

/** Patterns indicating the Claude TUI is waiting for input (safe to paste). */
const IDLE_PATTERNS = [
  "bypass permissions",  // standard idle
  "plan mode on",        // plan mode (accepts input)
  "ctrl-g to edit",      // plan file editor prompt
  "Context left",        // compact / low-context warning
];

/** Patterns indicating the Claude TUI is actively running (do NOT paste). */
const BUSY_PATTERNS = [
  "(running)",           // tool execution in progress
];

/** Check if a tmux pane is idle (at the Claude REPL prompt, not running tools). */
export function isPaneIdle(paneId: string): boolean {
  try {
    const capture = spawnSync("tmux", ["capture-pane", "-t", paneId, "-p"], {
      encoding: "utf-8", timeout: 3000,
    });
    const lines = (capture.stdout || "").trim().split("\n");
    const lastLine = lines.filter(l => l.trim()).pop() || "";
    if (BUSY_PATTERNS.some(p => lastLine.includes(p))) return false;
    return IDLE_PATTERNS.some(p => lastLine.includes(p));
  } catch {
    return true; // assume idle on error — better to deliver than silently drop
  }
}

// ── Message Delivery ─────────────────────────────────────────────────

/** Send text + Enter to a tmux pane. Uses -H 0d for Enter (not literal \n which tmux ignores).
 *  Uses spawnSync (no shell) to avoid backtick/dollar-sign interpretation that was
 *  silently truncating messages containing code references like `--service web`.
 *
 *  Always fires a tmux overlay banner (visible in any TUI state). If the pane is busy,
 *  writes the message to a tmpfile and spawns deliver-tmux-msg.sh which force-delivers
 *  after 15s. The inbox.jsonl write already happened before this — no message is ever
 *  lost, this only controls when the tmux paste+Enter fires. */
export function tmuxSendMessage(paneId: string, text: string): void {
  // Always fire overlay notification (works in ANY pane state)
  try {
    const preview = text.length > 80 ? text.slice(0, 77) + "..." : text;
    spawnSync("tmux", ["display-message", "-t", paneId, "-d", "5000", `📬 ${preview}`], {
      timeout: 3000,
    });
  } catch {}

  if (!isPaneIdle(paneId)) {
    // Pane is busy — force-deliver after 15s (MCP server is long-running, setTimeout is fine)
    setTimeout(() => {
      try {
        const bufName = `force-${Date.now()}-${process.pid}`;
        const tmpDir = join(HOME, ".claude-fleet/tmp");
        if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
        const tmpFile = join(tmpDir, `${bufName}.txt`);
        writeFileSync(tmpFile, text);
        try {
          spawnSync("tmux", ["load-buffer", "-b", bufName, tmpFile], { timeout: 5000 });
          spawnSync("tmux", ["paste-buffer", "-b", bufName, "-t", paneId, "-d"], { timeout: 5000 });
          (globalThis as any).Bun.sleepSync(500);
          spawnSync("tmux", ["send-keys", "-t", paneId, "-H", "0d"], { timeout: 5000 });
        } finally {
          try { rmSync(tmpFile); } catch {}
          try { spawnSync("tmux", ["delete-buffer", "-b", bufName], { timeout: 2000 }); } catch {}
        }
      } catch {} // best-effort — message is already in Fleet Mail inbox
    }, 15_000);
    return;
  }

  // Pane is idle — deliver immediately via paste-buffer
  const bufName = `msg-${paneId.replace("%", "")}-${Date.now()}`;
  const tmpFile = join(HOME, `.claude-fleet/tmp/${bufName}.txt`);
  try {
    const tmpDir = join(HOME, ".claude-fleet/tmp");
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
    writeFileSync(tmpFile, text);
    spawnSync("tmux", ["load-buffer", "-b", bufName, tmpFile], { timeout: 5000 });
    spawnSync("tmux", ["paste-buffer", "-b", bufName, "-t", paneId, "-d"], { timeout: 5000 });
  } finally {
    try { rmSync(tmpFile); } catch {}
    try { spawnSync("tmux", ["delete-buffer", "-b", bufName], { timeout: 2000 }); } catch {}
  }
  // Wait for paste to register in the pane's input, then submit
  (globalThis as any).Bun.sleepSync(500);
  spawnSync("tmux", ["send-keys", "-t", paneId, "-H", "0d"], { timeout: 5000 });
}

// ── Pane & Session Discovery ─────────────────────────────────────────

/** Find this worker's pane. Priority: TMUX_PANE env → session_id pane-map → registry. */
export function findOwnPane(): { paneId: string; paneTarget: string } | null {
  const tmuxPane = process.env.TMUX_PANE;
  if (tmuxPane) {
    // Check if registry has matching pane_id for our worker
    const entry = getWorkerEntry(WORKER_NAME);
    if (entry?.pane_id === tmuxPane) {
      return { paneId: tmuxPane, paneTarget: entry.pane_target || "" };
    }
    // Resolve from tmux directly
    try {
      const target = execSync(
        `tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' | awk -v id="${tmuxPane}" '$1 == id {print $2}'`,
        { encoding: "utf-8", timeout: 5000 }
      ).trim();
      if (target) return { paneId: tmuxPane, paneTarget: target };
    } catch {}
    return { paneId: tmuxPane, paneTarget: "" };
  }

  // Session-based fallback: if we have a session_id in registry, look up its pane from pane-map
  const entry = getWorkerEntry(WORKER_NAME);
  if (entry?.session_id) {
    const paneMapPath = join(HOME, ".claude/pane-map", entry.session_id);
    try {
      const mappedPane = readFileSync(paneMapPath, "utf-8").trim();
      if (mappedPane && isPaneAlive(mappedPane)) {
        // Resolve target
        try {
          const target = execSync(
            `tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' | awk -v id="${mappedPane}" '$1 == id {print $2}'`,
            { encoding: "utf-8", timeout: 5000 }
          ).trim();
          return { paneId: mappedPane, paneTarget: target };
        } catch {}
        return { paneId: mappedPane, paneTarget: "" };
      }
    } catch {}
  }

  // Final fallback: registry pane_id
  if (entry?.pane_id) {
    return { paneId: entry.pane_id, paneTarget: entry.pane_target || "" };
  }
  return null;
}

/** Read Claude session ID from the pane-map (written by statusline-command.sh) */
export function getSessionId(paneId: string): string | null {
  const paneMapPath = join(HOME, ".claude/pane-map/by-pane", paneId);
  try { return readFileSync(paneMapPath, "utf-8").trim(); } catch { return null; }
}

// ── Recipient Resolution ─────────────────────────────────────────────

/** Resolve recipient — worker name, "report", "direct_reports", or raw pane ID */
export function resolveRecipient(to: string): {
  type: "worker" | "pane" | "multi_pane" | "multi_worker";
  workerName?: string;
  workerNames?: string[];
  paneId?: string;
  paneIds?: string[];
  error?: string;
} {
  // Raw pane ID
  if (to.startsWith("%")) {
    return { type: "pane", paneId: to };
  }

  // "report" — find who this worker reports to
  if (to === "report") {
    try {
      const registry = readRegistry();
      const config = registry._config as RegistryConfig;
      const myEntry = registry[WORKER_NAME] as RegistryWorkerEntry | undefined;
      const reportToName = myEntry ? getReportTo(myEntry, config) : getMissionAuthorityLabel(config);
      if (reportToName && reportToName !== WORKER_NAME) {
        return { type: "worker", workerName: reportToName };
      }
      return { type: "worker", error: `No report_to found for worker '${WORKER_NAME}'` };
    } catch {
      return { type: "worker", error: "Failed to read registry" };
    }
  }

  // "direct_reports" — find all workers who report_to this worker
  if (to === "direct_reports") {
    try {
      const registry = readRegistry();
      const config = registry._config as RegistryConfig;
      const workerNames: string[] = [];
      const paneIds: string[] = [];
      for (const [name, entry] of Object.entries(registry)) {
        if (name === "_config") continue;
        const w = entry as RegistryWorkerEntry;
        const reportTo = getReportTo(w, config);
        if (reportTo === WORKER_NAME) {
          workerNames.push(name);
          if (w.pane_id && isPaneAlive(w.pane_id)) {
            paneIds.push(w.pane_id);
          }
        }
      }
      if (workerNames.length === 0) {
        return { type: "multi_worker", workerNames: [], paneIds: [], error: "No workers reporting to you" };
      }
      return { type: "multi_worker", workerNames, paneIds };
    } catch {
      return { type: "multi_worker", error: "Failed to read registry" };
    }
  }

  // Worker name
  return { type: "worker", workerName: to };
}
