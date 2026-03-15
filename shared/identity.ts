/**
 * Session-first identity resolution.
 *
 * Mail name format: {custom-name}-{dir-slug}-{session-id}
 * e.g. "merger-zPersonalProjects-a3f1b2c8-9d4e-4b1a-8c2d-1234567890ab"
 *
 * The session file (JSONL transcript) is the primary identity object.
 * Three-part identity: mail-name + session + tmux-pane.
 */

import { execSync } from "child_process";
import { basename, join } from "path";
import { readFileSync, readdirSync } from "fs";

const HOME = process.env.HOME || process.env.USERPROFILE || "/tmp";
const PANE_MAP_DIR = join(HOME, ".claude/pane-map");
const SESSIONS_DIR = join(HOME, ".claude/fleet/.sessions");

// ── Session ID Resolution ───────────────────────────────────────────

/** Resolve the Claude Code session ID.
 *  Priority: explicit arg > TMUX_PANE via pane-map > CLAUDE_SESSION_ID env */
export function resolveSessionId(opts?: { sessionId?: string; tmuxPane?: string }): string | null {
  if (opts?.sessionId) return opts.sessionId;

  // Try TMUX_PANE → pane-map lookup
  const pane = opts?.tmuxPane || process.env.TMUX_PANE;
  if (pane) {
    const byPanePath = join(PANE_MAP_DIR, "by-pane", pane.replace("%", ""));
    try {
      const sid = readFileSync(byPanePath, "utf-8").trim();
      if (sid) return sid;
    } catch {}
  }

  // Try CLAUDE_SESSION_ID env var (if Claude Code ever sets it)
  if (process.env.CLAUDE_SESSION_ID) return process.env.CLAUDE_SESSION_ID;

  return null;
}

// ── Directory Slug ──────────────────────────────────────────────────

/** Derive a directory slug from the current working directory.
 *  Uses git toplevel basename, falling back to CWD basename.
 *  Strips worktree suffixes (-w-*). */
export function resolveDirSlug(cwd?: string): string {
  const dir = cwd || process.cwd();
  let base: string;
  try {
    const toplevel = execSync("git rev-parse --show-toplevel", {
      cwd: dir, encoding: "utf-8", timeout: 5000,
    }).trim();
    base = basename(toplevel);
  } catch {
    base = basename(dir);
  }
  // Strip worktree suffix
  return base.replace(/-w-.*$/, "");
}

// ── Mail Name Construction ──────────────────────────────────────────

/** Build a Fleet Mail name: {custom-name}-{dir-slug}-{session-id} */
export function buildMailName(customName: string | null, dirSlug: string, sessionId: string): string {
  const name = customName || "session";
  return `${name}-${dirSlug}-${sessionId}`;
}

/** Parse a Fleet Mail name into components.
 *  Format: {custom-name}-{dir-slug}-{uuid}
 *  The UUID is the last 5 hyphen-separated segments (standard UUID format). */
export function parseMailName(mailName: string): {
  customName: string;
  dirSlug: string;
  sessionId: string;
} | null {
  // UUID pattern: 8-4-4-4-12 hex chars
  const uuidRegex = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
  const match = mailName.match(uuidRegex);
  if (!match) return null;

  const sessionId = match[1];
  const prefix = mailName.slice(0, -(sessionId.length + 1)); // strip "-{uuid}"

  // The prefix is "{custom-name}-{dir-slug}" — split on last hyphen
  const lastDash = prefix.lastIndexOf("-");
  if (lastDash === -1) {
    return { customName: "session", dirSlug: prefix, sessionId };
  }

  return {
    customName: prefix.slice(0, lastDash),
    dirSlug: prefix.slice(lastDash + 1),
    sessionId,
  };
}

// ── Name Sanitization ───────────────────────────────────────────────

/** Sanitize a user-provided name for safe use in file paths and mail names.
 *  Strips path traversal, null bytes, control chars. Limits to 128 chars.
 *  Returns "session" if empty after sanitization. */
export function sanitizeName(name: string): string {
  let s = name;
  // Strip null bytes
  s = s.replace(/\0/g, "");
  // Strip control characters (U+0000–U+001F, U+007F)
  s = s.replace(/[\x00-\x1f\x7f]/g, "");
  // Strip path separators and traversal
  s = s.replace(/\.\./g, "");
  s = s.replace(/[/\\]/g, "");
  // Trim leading/trailing dots and whitespace
  s = s.replace(/^[.\s]+|[.\s]+$/g, "");
  // Limit to 128 chars
  s = s.slice(0, 128);
  // Default if empty
  return s || "session";
}

// ── Legacy Worker Name Detection ────────────────────────────────────

/** Detect a legacy worker name from WORKER_NAME env or git branch/worktree. */
export function detectLegacyWorkerName(): string | null {
  if (process.env.WORKER_NAME) return process.env.WORKER_NAME;
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: process.cwd(), encoding: "utf-8", timeout: 5000,
    }).trim();
    if (branch.startsWith("worker/")) return branch.slice("worker/".length);
    const dirName = basename(process.cwd());
    const match = dirName.match(/-w-(.+)$/);
    if (match) return match[1];
  } catch {}
  return null;
}

// ── Unified Identity ────────────────────────────────────────────────

export interface SessionIdentity {
  mailName: string;
  sessionId: string;
  dirSlug: string;
  customName: string;
  cwd: string;
  paneId: string | null;
  registeredAt: string;
}

/** Load a saved session identity from disk. */
export function loadSessionIdentity(sessionId: string): SessionIdentity | null {
  const idPath = join(SESSIONS_DIR, sessionId, "identity.json");
  try {
    return JSON.parse(readFileSync(idPath, "utf-8"));
  } catch {
    return null;
  }
}

/** Find all session identities on disk. */
export function listSessionIdentities(): SessionIdentity[] {
  try {
    const dirs = readdirSync(SESSIONS_DIR);
    return dirs
      .map((d) => loadSessionIdentity(d))
      .filter((id): id is SessionIdentity => id !== null);
  } catch {
    return [];
  }
}

/** Resolve identity for the current session.
 *  Tries session-based identity first, falls back to legacy WORKER_NAME. */
export function resolveIdentity(opts?: { sessionId?: string }): {
  type: "session";
  identity: SessionIdentity;
} | {
  type: "legacy";
  workerName: string;
} | null {
  // Try session-based identity
  const sessionId = resolveSessionId(opts);
  if (sessionId) {
    const identity = loadSessionIdentity(sessionId);
    if (identity) return { type: "session", identity };
  }

  // Fall back to legacy worker name
  const legacyName = detectLegacyWorkerName();
  if (legacyName) return { type: "legacy", workerName: legacyName };

  return null;
}

/** Get the sessions directory path. */
export function sessionsDir(): string {
  return SESSIONS_DIR;
}

/** Get a specific session's directory path. */
export function sessionDir(sessionId: string): string {
  return join(SESSIONS_DIR, sessionId);
}
