/**
 * Worktree file sync — ensures untracked/gitignored files are symlinked
 * from fleet data or project root into a worker's worktree.
 *
 * Git worktrees share tracked files but NOT untracked ones (.claude/,
 * .mcp.json, .env, etc.). This module provides a single function to
 * reconcile all expected files.
 */

import { mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { FLEET_DATA } from "./paths";

export interface SyncWorktreeOpts {
  /** Worker name (kebab-case) */
  name: string;
  /** Fleet project name */
  project: string;
  /** Absolute path to the project root (main repo) */
  projectRoot: string;
  /** Absolute path to the worker's worktree */
  worktreeDir: string;
}

/**
 * Sync all expected untracked files into a worktree.
 * Safe to call multiple times (idempotent — skips existing files).
 * Returns list of files that were synced.
 */
export function syncWorktree(opts: SyncWorktreeOpts): string[] {
  const { name, project, projectRoot, worktreeDir } = opts;
  const fleetWorkerDir = join(FLEET_DATA, project, name);
  const synced: string[] = [];

  // Skip if worktree is the project root (no symlinks needed)
  if (projectRoot === worktreeDir) return synced;

  // ── 1. mission.md → .claude/workers/{name}/mission.md ──
  const missionSrc = join(fleetWorkerDir, "mission.md");
  const missionDst = join(worktreeDir, ".claude/workers", name, "mission.md");
  if (existsSync(missionSrc) && !existsSync(missionDst)) {
    mkdirSync(dirname(missionDst), { recursive: true });
    try {
      Bun.spawnSync(["ln", "-sf", missionSrc, missionDst]);
      synced.push(missionDst);
    } catch { /* non-fatal */ }
  }

  // ── 2. .mcp.json (project root → worktree) ──
  const mcpSrc = join(projectRoot, ".mcp.json");
  const mcpDst = join(worktreeDir, ".mcp.json");
  if (existsSync(mcpSrc) && !existsSync(mcpDst)) {
    try {
      Bun.spawnSync(["ln", "-sf", mcpSrc, mcpDst]);
      synced.push(mcpDst);
    } catch { /* non-fatal */ }
  }

  // ── 3. Untracked data files (.env, data/users.json) ──
  for (const f of [".env", "data/users.json"]) {
    const src = join(projectRoot, f);
    const dst = join(worktreeDir, f);
    if (existsSync(src) && !existsSync(dst)) {
      mkdirSync(dirname(dst), { recursive: true });
      try {
        Bun.spawnSync(["ln", "-sf", src, dst]);
        synced.push(dst);
      } catch { /* non-fatal */ }
    }
  }

  // ── 4. Per-worker script directory ──
  const scriptDir = join(worktreeDir, ".claude/scripts", name);
  if (!existsSync(scriptDir)) {
    mkdirSync(scriptDir, { recursive: true });
  }

  // ── 5. permissions.json (create default if missing) ──
  const permsDir = join(worktreeDir, ".claude/workers", name);
  const permsDst = join(permsDir, "permissions.json");
  if (!existsSync(permsDst)) {
    mkdirSync(permsDir, { recursive: true });
    // Check if there's a type-specific permissions template
    const fleetPerms = join(fleetWorkerDir, "permissions.json");
    if (existsSync(fleetPerms)) {
      try {
        Bun.spawnSync(["ln", "-sf", fleetPerms, permsDst]);
        synced.push(permsDst);
      } catch { /* non-fatal */ }
    }
    // If no template exists, hooks will gracefully handle absence
  }

  return synced;
}
