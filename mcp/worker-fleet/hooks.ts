/**
 * Dynamic hooks — unified gate + inject system with script support.
 * Agents register hooks at runtime. Each hook can block (gate), inject context,
 * or run a script file on event fire.
 *
 * Storage: ~/.claude/fleet/{project}/{worker}/hooks/
 *   - hooks.json — hook metadata array
 *   - dh-N-description-slug.sh — script files (one per hook with script_path)
 *
 * Hook scripts read the persisted hooks.json and apply matching hooks per event.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, copyFileSync } from "fs";
import { join, resolve } from "path";
import { HOME, WORKER_NAME, FLEET_DIR, PROJECT_ROOT } from "./config";
import type { DynamicHook } from "../../shared/types";

// ── Types ────────────────────────────────────────────────────────────

// Re-export from shared types
export type { DynamicHook } from "../../shared/types";

// All 18 Claude Code hook events
export type HookEvent =
  | "SessionStart" | "SessionEnd" | "InstructionsLoaded"
  | "UserPromptSubmit"
  | "PreToolUse" | "PermissionRequest" | "PostToolUse" | "PostToolUseFailure"
  | "Notification" | "Stop"
  | "SubagentStart" | "SubagentStop" | "TeammateIdle" | "TaskCompleted"
  | "ConfigChange" | "PreCompact"
  | "WorktreeCreate" | "WorktreeRemove";

// ── State ────────────────────────────────────────────────────────────

export const dynamicHooks: Map<string, DynamicHook> = new Map();
export let _hookCounter = 0;
export function _incrementHookCounter(): number { return ++_hookCounter; }

// ── Hook Directory Resolution ────────────────────────────────────────

/** Resolve hook storage dir for a worker: ~/.claude/fleet/{project}/{worker}/hooks/ */
function resolveHooksDir(): string {
  // New path: fleet dir per-worker hooks/ subdirectory
  const fleetHooksDir = join(FLEET_DIR, WORKER_NAME, "hooks");
  if (existsSync(join(FLEET_DIR, WORKER_NAME))) {
    return fleetHooksDir;
  }

  // Legacy fallback: ~/.claude/ops/hooks/dynamic/
  const legacyDir = process.env.CLAUDE_HOOKS_DIR || join(HOME, ".claude/ops/hooks/dynamic");
  return legacyDir;
}

const HOOKS_DIR = resolveHooksDir();
try { mkdirSync(HOOKS_DIR, { recursive: true }); } catch {}

/** Get hooks.json path (new layout) or {worker}.json path (legacy) */
function getHooksFile(): string {
  // New layout: hooks/hooks.json
  if (HOOKS_DIR.endsWith("/hooks")) {
    return join(HOOKS_DIR, "hooks.json");
  }
  // Legacy: {worker}.json
  return join(HOOKS_DIR, `${WORKER_NAME}.json`);
}

const HOOKS_FILE = getHooksFile();

/** Check if using new per-worker-dir layout */
function isNewLayout(): boolean {
  return HOOKS_DIR.endsWith("/hooks");
}

// ── Script Management ────────────────────────────────────────────────

/** Slugify a description for use in script filenames */
export function slugify(desc: string): string {
  return desc
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

/** Generate script filename from hook id + description */
export function scriptFileName(id: string, description: string): string {
  const slug = slugify(description);
  return slug ? `${id}-${slug}.sh` : `${id}.sh`;
}

/**
 * Write a script file for a hook.
 * @param id - Hook ID (e.g. "dh-1")
 * @param description - Hook description (used for filename)
 * @param script - Script content (inline) or @filepath (copy from file)
 * @returns Relative filename of the written script
 */
export function writeScriptFile(id: string, description: string, script: string): string {
  const filename = scriptFileName(id, description);
  const destPath = join(HOOKS_DIR, filename);

  if (script.startsWith("@")) {
    // Copy from file
    const srcPath = script.slice(1);
    const resolvedSrc = resolve(srcPath);
    const projectRootResolved = resolve(PROJECT_ROOT);
    const fleetDirResolved = resolve(FLEET_DIR);
    if (!resolvedSrc.startsWith(projectRootResolved) && !resolvedSrc.startsWith(fleetDirResolved)) {
      throw new Error(`Script source path must be within project or fleet directory: ${srcPath}`);
    }
    if (!existsSync(srcPath)) {
      throw new Error(`Script source file not found: ${srcPath}`);
    }
    copyFileSync(srcPath, destPath);
  } else {
    // Write inline script
    const content = script.startsWith("#!/") ? script : `#!/usr/bin/env bash\nset -uo pipefail\n${script}\n`;
    writeFileSync(destPath, content);
  }

  // Make executable
  try { Bun.spawnSync(["chmod", "+x", destPath]); } catch {}
  return filename;
}

/** Remove a script file for a hook */
export function removeScriptFile(hook: DynamicHook): void {
  if (!hook.script_path) return;
  const scriptPath = join(HOOKS_DIR, hook.script_path);
  try { rmSync(scriptPath); } catch {}
}

// ── Persistence ──────────────────────────────────────────────────────

/** Persist hooks to file for hook scripts to read.
 *  Writes ALL hooks (active + archived). Never deletes the file. */
export function _persistHooks(): void {
  try {
    const activeHooks = [...dynamicHooks.values()];

    // Load existing archived hooks from file to preserve them
    let archivedHooks: DynamicHook[] = [];
    try {
      if (existsSync(HOOKS_FILE)) {
        const data = JSON.parse(readFileSync(HOOKS_FILE, "utf-8"));
        if (Array.isArray(data.hooks)) {
          archivedHooks = data.hooks.filter((h: DynamicHook) => h.status === "archived");
        }
      }
    } catch {}

    // Merge: active hooks from Map + archived hooks from file (dedup by id)
    const activeIds = new Set(activeHooks.map(h => h.id));
    const mergedArchived = archivedHooks.filter(h => !activeIds.has(h.id));
    const allHooks = [...activeHooks, ...mergedArchived];

    if (isNewLayout()) {
      writeFileSync(HOOKS_FILE, JSON.stringify({ hooks: allHooks }, null, 2));
    } else {
      writeFileSync(HOOKS_FILE, JSON.stringify({ worker: WORKER_NAME, hooks: allHooks }, null, 2));
    }
  } catch (e) {
    console.error(`[_persistHooks] Failed to write ${HOOKS_FILE}: ${e}`);
  }
}

// On startup, restore from file (survives MCP restart via recycle resume)
// Only loads active hooks into the Map. Archived hooks stay in the file.
function _restoreHooks(): void {
  const files = [HOOKS_FILE];
  // Also check legacy path if we're on new layout
  if (isNewLayout()) {
    const legacyDir = process.env.CLAUDE_HOOKS_DIR || join(HOME, ".claude/ops/hooks/dynamic");
    const legacyFile = join(legacyDir, `${WORKER_NAME}.json`);
    if (existsSync(legacyFile) && !existsSync(HOOKS_FILE)) {
      files.push(legacyFile);
    }
  }

  for (const file of files) {
    try {
      if (!existsSync(file)) continue;
      const data = JSON.parse(readFileSync(file, "utf-8"));
      const hooks = data.hooks;
      if (!Array.isArray(hooks)) continue;

      // Legacy files have worker field — validate
      if (data.worker && data.worker !== WORKER_NAME) continue;

      for (const h of hooks) {
        // Only load active hooks into the Map (archived stay in file only)
        if (h.status === "archived") continue;
        // Backfill status for hooks without it
        if (!h.status) h.status = "active";
        dynamicHooks.set(h.id, h);
        const num = parseInt(h.id.replace("dh-", ""), 10);
        if (!isNaN(num) && num > _hookCounter) _hookCounter = num;
      }

      // If restored from legacy, migrate to new location
      if (file !== HOOKS_FILE && dynamicHooks.size > 0) {
        _persistHooks();
        // Remove legacy file after successful migration
        try { rmSync(file); } catch {}
      }
      break;
    } catch {}
  }
}

_restoreHooks();

/** Register the default sys-recycle-gate Stop hook if not already present */
function _ensureRecycleGate(): void {
  // Clean up stale sentinel from previous hard recycle (prevents auto-pass)
  try { rmSync(`/tmp/claude-fleet-recycle-${WORKER_NAME}`); } catch {}

  if (dynamicHooks.has("sys-recycle-gate")) return;
  // Also check if it's archived in the file — don't re-register if explicitly archived
  try {
    if (existsSync(HOOKS_FILE)) {
      const data = JSON.parse(readFileSync(HOOKS_FILE, "utf-8"));
      if (Array.isArray(data.hooks) && data.hooks.some((h: DynamicHook) => h.id === "sys-recycle-gate" && h.status !== "archived")) return;
    }
  } catch {}

  const gate: DynamicHook = {
    id: "sys-recycle-gate",
    event: "Stop",
    description: "Call recycle() to save state before stopping",
    status: "active",
    lifetime: "persistent",
    blocking: true,
    completed: false,
    check: `test -f /tmp/claude-fleet-recycle-${WORKER_NAME}`,
    max_fires: 3,
    fire_count: 0,
    added_at: new Date().toISOString(),
  };
  dynamicHooks.set(gate.id, gate);
  _persistHooks();
}

_ensureRecycleGate();

// ── Helpers ──────────────────────────────────────────────────────────

/** Capture dynamic hooks snapshot for checkpoint */
export function _captureHooksSnapshot(): Array<{ id: string; event: string; description: string; blocking: boolean; completed: boolean; script_path?: string; status?: string; lifetime?: string; check?: string }> {
  return [...dynamicHooks.values()].map(h => ({
    id: h.id, event: h.event, description: h.description,
    blocking: h.blocking, completed: h.completed,
    ...(h.script_path ? { script_path: h.script_path } : {}),
    ...(h.status ? { status: h.status } : {}),
    ...(h.lifetime ? { lifetime: h.lifetime } : {}),
    ...(h.check ? { check: h.check } : {}),
  }));
}

/** Summary of pending hooks for display */
export function _pendingHooksSummary(event?: string): string {
  const hooks = [...dynamicHooks.values()];
  const pending = hooks.filter(h => h.blocking && !h.completed && (!event || h.event === event));
  const injects = hooks.filter(h => !h.blocking && (!event || h.event === event));
  const scripts = hooks.filter(h => h.script_path && (!event || h.event === event));
  const parts: string[] = [];
  if (pending.length > 0) parts.push(`${pending.length} blocking`);
  if (injects.length > 0) parts.push(`${injects.length} inject`);
  if (scripts.length > 0) parts.push(`${scripts.length} with scripts`);
  return parts.join(", ") || "none";
}

/** Get the hooks directory path (for external use) */
export function getHooksDir(): string {
  return HOOKS_DIR;
}

/** Archive a hook — move from active Map to archived in file */
export function _archiveHook(id: string, reason: string): DynamicHook | null {
  const hook = dynamicHooks.get(id);
  if (!hook) return null;
  hook.status = "archived";
  hook.archived_at = new Date().toISOString();
  hook.archive_reason = reason;
  dynamicHooks.delete(id);
  _persistHooks();
  return hook;
}

/** Resolve the main repo root from a worktree's .git file.
 *  Worktrees have a `.git` file (not dir) pointing to the main repo's `.git/worktrees/`. */
function resolveMainRepoRoot(): string {
  const gitPath = join(PROJECT_ROOT, ".git");
  try {
    if (existsSync(gitPath)) {
      const stat = Bun.file(gitPath);
      // If .git is a file (worktree), resolve to main repo
      if (stat.size < 1000) {
        const content = readFileSync(gitPath, "utf-8").trim();
        if (content.startsWith("gitdir:")) {
          const gitdir = content.replace("gitdir:", "").trim();
          // gitdir is like /path/to/main/.git/worktrees/worker-name
          const mainGit = gitdir.replace(/\/\.git\/worktrees\/[^/]+$/, "");
          if (existsSync(mainGit)) return mainGit;
        }
      }
    }
  } catch {}
  return PROJECT_ROOT;
}

/** Read hooks for another worker (cross-worker discovery).
 *  Resolves to the main repo's .claude/workers/{name}/hooks.json if in a worktree. */
export function readOtherWorkerHooks(workerName: string, includeArchived = false): DynamicHook[] {
  const mainRepo = resolveMainRepoRoot();
  const candidates = [
    join(FLEET_DIR, workerName, "hooks", "hooks.json"),
    join(mainRepo, ".claude/workers", workerName, "hooks.json"),
  ];

  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue;
      const data = JSON.parse(readFileSync(file, "utf-8"));
      if (!Array.isArray(data.hooks)) continue;
      return includeArchived
        ? data.hooks
        : data.hooks.filter((h: DynamicHook) => h.status !== "archived");
    } catch {}
  }
  return [];
}
