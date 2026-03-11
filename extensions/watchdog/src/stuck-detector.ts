/**
 * Scrollback-based stuck detection via MD5 hashing.
 * Compares pane content hash across watchdog checks.
 */

import type { WatchdogEffects } from "./types";

/** Known blocking patterns in Claude Code TUI */
const BLOCKING_PATTERNS = /Waiting for task|hook error[\s\S]*hook error|No output[\s\S]*No output/;

/** Claude TUI idle indicator (status bar — matches the bypass permissions status line) */
const IDLE_INDICATOR = /bypass permissions/;

/**
 * Check if a worker is stuck based on scrollback content.
 * Returns 0 if active, or seconds since content stopped changing.
 */
export function checkScrollbackStuck(
  paneId: string,
  worker: string,
  nowEpoch: number,
  effects: WatchdogEffects,
): number {
  // Capture visible pane content (last 30 non-empty lines)
  const rawContent = effects.capturePane(paneId, 30);
  const lines = rawContent.split("\n").filter(l => l.trim().length > 0);
  const content = lines.join("\n");

  // Known blocking patterns — always treat as stuck
  if (BLOCKING_PATTERNS.test(content)) {
    const candidate = effects.readStuckCandidate(worker);
    if (candidate === null) {
      effects.writeStuckCandidate(worker, nowEpoch);
      return 0; // just started
    }
    return nowEpoch - candidate;
  }

  // Hash scrollback content
  const hasher = new Bun.CryptoHasher("md5");
  hasher.update(content);
  const currentHash = hasher.digest("hex");
  const prevHash = effects.readScrollbackHash(worker);
  effects.writeScrollbackHash(worker, currentHash);

  // Check for idle TUI
  const lastLine = lines[lines.length - 1] || "";
  if (IDLE_INDICATOR.test(lastLine)) {
    // Scrollback diff: if content changed since last check, worker is active
    if (prevHash !== null && currentHash !== prevHash) {
      effects.clearStuckCandidate(worker);
      return 0;
    }

    // Content unchanged — genuinely idle
    const candidate = effects.readStuckCandidate(worker);
    if (candidate === null) {
      effects.writeStuckCandidate(worker, nowEpoch);
      return 0; // just detected idle
    }
    return nowEpoch - candidate;
  }

  // Not matching any stuck pattern — clear marker
  effects.clearStuckCandidate(worker);
  return 0;
}

/**
 * Compute MD5 hash of a string using Bun.CryptoHasher.
 * Exported for testing.
 */
export function md5Hash(input: string): string {
  const hasher = new Bun.CryptoHasher("md5");
  hasher.update(input);
  return hasher.digest("hex");
}
