/**
 * lock-utils.ts — Shared mkdir-based spinlock for MCP servers.
 *
 * Uses mkdir atomicity (EEXIST on collision) matching the convention
 * in fleet-jq.sh's _lock/_unlock. 10s timeout with forced takeover.
 */
import { mkdirSync, rmSync } from "fs";

/** Acquire an exclusive lock via mkdir. Returns true on success. */
export function acquireLock(lockPath: string, maxWaitMs = 10_000): boolean {
  const start = Date.now();
  while (true) {
    try {
      mkdirSync(lockPath, { recursive: false });
      return true;
    } catch {
      if (Date.now() - start > maxWaitMs) {
        // Force-take stale lock
        try { rmSync(lockPath, { recursive: true, force: true }); } catch {}
        try { mkdirSync(lockPath, { recursive: false }); return true; } catch {}
        return false;
      }
      (globalThis as any).Bun.sleepSync(100);
    }
  }
}

/** Release lock by removing the directory. */
export function releaseLock(lockPath: string): void {
  try { rmSync(lockPath, { recursive: true, force: true }); } catch {}
}

/** Execute fn under lock, releasing on completion or error. */
export function withLocked<T>(lockPath: string, fn: () => T): T {
  if (!acquireLock(lockPath)) {
    throw new Error(`Could not acquire lock at ${lockPath} after 10s — stale lock?`);
  }
  try {
    return fn();
  } finally {
    releaseLock(lockPath);
  }
}
