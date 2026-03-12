/**
 * Watchdog type definitions — effects interface, actions, logging.
 * All watchdog modules depend on these types.
 */

// ── Worker Action (discriminated union — every check_worker path is explicit) ──

export type WorkerAction =
  | { type: "skip"; reason: string }
  | { type: "relaunch"; reason: string; stagger: boolean }
  | { type: "fleet-start"; reason: string; stagger: boolean }
  | { type: "resume"; reason: string; stagger: boolean }
  | { type: "move-inactive"; reason: string }
  | { type: "crash-loop"; count: number }
  | { type: "bare-shell-restart"; reason: string; stagger: boolean }
  | { type: "ok" };

// ── Watchdog Effects (dependency injection for testability) ──

export interface WatchdogEffects {
  /** Check if a tmux pane is alive */
  isPaneAlive(paneId: string): boolean;

  /** Capture pane scrollback (last N visible non-empty lines) */
  capturePane(paneId: string, lines?: number): string;

  /** Get the tmux window name for a pane */
  getPaneWindow(paneId: string): string | null;

  /** Read liveness heartbeat epoch (null = no file) */
  readLiveness(worker: string): number | null;

  /** Write liveness heartbeat epoch */
  writeLiveness(worker: string, ts: number): void;

  /** Read scrollback MD5 hash from previous check */
  readScrollbackHash(worker: string): string | null;

  /** Write scrollback MD5 hash for next check */
  writeScrollbackHash(worker: string, hash: string): void;

  /** Read stuck-candidate timestamp (null = not a candidate) */
  readStuckCandidate(worker: string): number | null;

  /** Write stuck-candidate timestamp */
  writeStuckCandidate(worker: string, ts: number): void;

  /** Clear stuck-candidate marker */
  clearStuckCandidate(worker: string): void;

  /** Check if worker has unread Fleet Mail */
  workerHasUnreadMail(worker: string): Promise<boolean>;

  /** Get number of unread Fleet Mail messages for a worker */
  getWorkerUnreadCount(worker: string): Promise<number>;

  /** Get current epoch seconds */
  nowEpoch(): number;
}

// ── Worker Snapshot (batch-read from config+state) ──

export interface WorkerSnapshot {
  name: string;
  paneId: string | null;
  status: string;
  sleepDuration: number | null;
  window: string | null;
  tmuxSession: string;
  worktree: string | null;
  branch: string;

  /** Derived: sleepDuration !== null && sleepDuration > 0 */
  perpetual: boolean;

  /** custom.sleep_until (ISO string or null) */
  sleepUntil: string | null;

  /** last_relaunch.at (ISO string or null) */
  lastRelaunchAt: string | null;

  /** meta.created_at (ISO string or null) */
  createdAt: string | null;

  /** Fleet Mail token for this worker */
  bmsToken: string | null;

  /** model (for building agent commands) */
  model: string;
  /** permission_mode */
  permissionMode: string;
  /** reasoning_effort */
  reasoningEffort: string;
  /** custom.runtime */
  runtime: string;
  /** Ephemeral workers (deep-review) — skip watchdog entirely */
  ephemeral: boolean;
  /** Workers that receive DOWN notifications when this worker dies (Erlang-style monitors) */
  monitors: string[];
}

// ── Watchdog Config ──

export interface WatchdogConfig {
  checkInterval: number;
  stuckThresholdSec: number;
  maxCrashesPerHr: number;
  maxCycleSec: number;
  memoryLimitMb: number;
}

// ── Log Entry ──

export interface LogEntry {
  ts: string;
  level: "info" | "warn" | "error";
  event: string;
  worker?: string;
  message: string;
  data?: Record<string, unknown>;
}

// ── Pane Info (from listPaneInfo) ──

export interface PaneInfo {
  session: string;
  window: string;
  index: number;
  paneId: string;
}
