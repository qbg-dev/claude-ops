/**
 * Diagnostics, linting, and the withLint wrapper used by all tool handlers.
 */

import { readFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { PROJECT_ROOT, WORKERS_DIR, FLEET_DIR, WORKER_NAME, LINT_ENABLED, _cachedBranch, getWorktreeDir } from "./config";
import {
  getWorkerEntry, readRegistry,
  type RegistryConfig, type RegistryWorkerEntry, type ProjectRegistry,
  getReportTo,
} from "./registry";
import { isPaneAlive } from "./tmux";
import { refreshFleetMailUnread, getFleetMailUnreadCount } from "./mail-client";

// Re-export DiagnosticIssue from registry for convenience
export type { DiagnosticIssue } from "./registry";
import type { DiagnosticIssue } from "./registry";

// ── Registry Linter ──────────────────────────────────────────────────

/** Run registry linter checks */
export function lintRegistry(registry: ProjectRegistry): DiagnosticIssue[] {
  if (!LINT_ENABLED) return [];
  const issues: DiagnosticIssue[] = [];

  for (const [name, entry] of Object.entries(registry)) {
    if (name === "_config") continue;
    const w = entry as RegistryWorkerEntry;

    // worker dir doesn't exist (check both fleet dir and legacy workers dir)
    const fleetWorkerDir = join(FLEET_DIR, name);
    const legacyWorkerDir = join(WORKERS_DIR, name);
    if (!existsSync(fleetWorkerDir) && !existsSync(legacyWorkerDir)) {
      issues.push({ severity: "error", check: "lint.worker_dir", message: `Worker '${name}' fleet dir doesn't exist: ${fleetWorkerDir}` });
    }

    // Dead pane
    if (w.pane_id && !isPaneAlive(w.pane_id)) {
      issues.push({ severity: "warning", check: "lint.dead_pane", message: `Dead pane ${w.pane_id} (worker: ${name})`, fix: "Auto-pruned on get_worker_state(name='all')" });
    }

    // worktree doesn't exist (only for non-main-branch workers)
    if (w.worktree && w.branch !== "main" && !existsSync(w.worktree)) {
      issues.push({ severity: "warning", check: "lint.worktree", message: `Worker '${name}' worktree doesn't exist: ${w.worktree}` });
    }

    // model empty
    if (!w.model) {
      issues.push({ severity: "warning", check: "lint.model", message: `Worker '${name}' has no model configured` });
    }

    // Missing required fields
    if (!w.status) {
      issues.push({ severity: "warning", check: "lint.missing_status", message: `Worker '${name}' has no status` });
    }
    if (!w.branch) {
      issues.push({ severity: "warning", check: "lint.missing_branch", message: `Worker '${name}' has no branch` });
    }
    if (!w.mission_file) {
      issues.push({ severity: "warning", check: "lint.missing_mission", message: `Worker '${name}' has no mission_file` });
    }
  }

  // Duplicate: two live panes for same worker
  const workerPanes: Record<string, string[]> = {};
  for (const [name, entry] of Object.entries(registry)) {
    if (name === "_config") continue;
    const w = entry as RegistryWorkerEntry;
    if (w.pane_id && isPaneAlive(w.pane_id)) {
      if (!workerPanes[name]) workerPanes[name] = [];
      workerPanes[name].push(w.pane_id);
    }
  }
  for (const [name, panes] of Object.entries(workerPanes)) {
    if (panes.length > 1) {
      issues.push({ severity: "warning", check: "lint.duplicate_pane", message: `Worker '${name}' has ${panes.length} live panes: ${panes.join(", ")}` });
    }
  }

  // Validate assigned_by references exist in registry (flat model — no hierarchy enforcement)
  const allWorkerNames = Object.keys(registry).filter(n => n !== "_config");
  for (const name of allWorkerNames) {
    const w = registry[name] as RegistryWorkerEntry;
    const reportTo = getReportTo(w, registry._config as RegistryConfig);
    if (reportTo && !registry[reportTo]) {
      issues.push({ severity: "warning", check: "lint.report_to_missing", message: `Worker '${name}' report_to '${reportTo}' doesn't exist in registry` });
    }
  }

  return issues;
}

// ── Full Diagnostics ─────────────────────────────────────────────────

export function runDiagnostics(): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];

  // ── Environment ──

  if (WORKER_NAME === "operator") {
    issues.push({ severity: "warning", check: "env.WORKER_NAME", message: "Worker name defaulted to 'operator' — not on a worker/* branch and WORKER_NAME not set", fix: "Set WORKER_NAME env or checkout a worker/* branch" });
  }

  // ── Worker config dir ──
  const workerDir = join(WORKERS_DIR, WORKER_NAME);
  if (!existsSync(workerDir)) {
    issues.push({ severity: "error", check: "worker_dir", message: `Worker dir missing: ${workerDir}`, fix: `mkdir -p ${workerDir}` });
  } else {
    // mission.md
    const missionPath = join(workerDir, "mission.md");
    if (!existsSync(missionPath)) {
      issues.push({ severity: "error", check: "mission.md", message: "mission.md missing — worker has no goals", fix: `Create ${missionPath} with task list and goals` });
    } else {
      try {
        const content = readFileSync(missionPath, "utf-8").trim();
        if (content.length < 10) issues.push({ severity: "warning", check: "mission.md", message: "mission.md is nearly empty", fix: "Add goals and tasks to mission.md" });
      } catch {}
    }

    // Registry entry (replaces state.json + permissions.json checks)
    const regEntry = getWorkerEntry(WORKER_NAME);
    if (!regEntry) {
      issues.push({ severity: "error", check: "registry_entry", message: `Worker '${WORKER_NAME}' not in registry.json`, fix: "Call register() to self-register with auto-detected pane info" });
    } else {
      if (!regEntry.status) {
        issues.push({ severity: "warning", check: "registry.status", message: "registry entry missing 'status' field", fix: `update_state("status", "idle")` });
      }
      if (!regEntry.model) {
        issues.push({ severity: "warning", check: "registry.model", message: "registry entry missing 'model' field — defaulting to opus", fix: `update_state("model", "opus")` });
      }
    }

    // inbox.jsonl (if exists, validate last line)
    const inboxPath = join(workerDir, "inbox.jsonl");
    if (existsSync(inboxPath)) {
      try {
        const content = readFileSync(inboxPath, "utf-8");
        const lines = content.trim().split("\n").filter(Boolean);
        if (lines.length > 0) {
          const lastLine = lines[lines.length - 1];
          try { JSON.parse(lastLine); } catch {
            issues.push({ severity: "warning", check: "inbox.jsonl", message: "inbox.jsonl has corrupt last line — may cause read errors", fix: `read_inbox(clear=true) to reset, or manually fix ${inboxPath}` });
          }
        }
      } catch {}
    }
  }

  // ── Git branch (uses cached value from module load — no subprocess) ──
  if (_cachedBranch && WORKER_NAME !== "operator") {
    const expectedBranch = `worker/${WORKER_NAME}`;
    if (_cachedBranch !== expectedBranch) {
      issues.push({ severity: "warning", check: "git.branch", message: `On branch '${_cachedBranch}' but expected '${expectedBranch}'`, fix: `git checkout ${expectedBranch}` });
    }
  }

  // ── Worktree ──
  if (WORKER_NAME !== "operator") {
    const worktreeDir = getWorktreeDir();
    if (!existsSync(worktreeDir)) {
      issues.push({ severity: "warning", check: "worktree", message: `Worktree dir not found: ${worktreeDir}`, fix: `git -C ${PROJECT_ROOT} worktree add ${worktreeDir} -b worker/${WORKER_NAME}` });
    }
  }

  // ── Registry ──
  if (process.env.TMUX_PANE) {
    const entry = getWorkerEntry(WORKER_NAME);
    if (!entry) {
      issues.push({ severity: "error", check: "registry", message: `Worker '${WORKER_NAME}' not in registry.json — watchdog cannot monitor you.`, fix: "Call register() to self-register" });
    } else if (entry.pane_id !== process.env.TMUX_PANE) {
      issues.push({ severity: "error", check: "registry.pane_id", message: `Pane ${process.env.TMUX_PANE} not registered for '${WORKER_NAME}' in registry.json.`, fix: "Run update_state('pane_id', '" + process.env.TMUX_PANE + "') to fix" });
    }
  } else {
    issues.push({ severity: "error", check: "env.TMUX_PANE", message: "TMUX_PANE not set — not running in tmux. Messaging and watchdog will NOT work.", fix: "Launch via `fleet start <name>`" });
  }

  // ── Registry linter ──
  try {
    const registry = readRegistry();
    const lintIssues = lintRegistry(registry);
    issues.push(...lintIssues);
  } catch {}

  // ── Git hooks ──
  // Verify required hooks are installed in the worktree (or main repo for main-branch workers)
  try {
    const worktreeDir = getWorktreeDir();
    let gitDir: string;
    try {
      gitDir = execSync(`git -C "${worktreeDir}" rev-parse --git-dir 2>/dev/null`, { encoding: "utf-8", timeout: 5000, shell: "/bin/bash" }).trim();
      if (!gitDir.startsWith("/")) gitDir = join(worktreeDir, gitDir);
    } catch {
      gitDir = join(worktreeDir, ".git");
    }
    const hooksDir = join(gitDir, "hooks");

    const requiredHooks: [string, string][] = [
      ["post-commit", "Auto-notify merger/chief-of-staff on commit"],
      ["commit-msg", "Auto-add Worker:/Cycle: trailers to commit messages"],
    ];
    for (const [hookName, desc] of requiredHooks) {
      const hookPath = join(hooksDir, hookName);
      if (!existsSync(hookPath)) {
        issues.push({ severity: "warning", check: `git.hook.${hookName}`, message: `Git ${hookName} hook not installed — ${desc}`, fix: `Relaunch with \`fleet start\` to install hooks, or manually copy from scripts/worker-${hookName}-hook.sh` });
      } else {
        // Check it's executable
        try {
          const stat = statSync(hookPath);
          if (!(stat.mode & 0o111)) {
            issues.push({ severity: "warning", check: `git.hook.${hookName}`, message: `Git ${hookName} hook exists but is not executable`, fix: `chmod +x ${hookPath}` });
          }
        } catch {}
      }
    }
  } catch {
    // Can't resolve git dir — skip hook checks
  }

  return issues;
}

// ── Cached diagnostics — 10s TTL, lazy on first tool call ────────────
let _diagCache: { issues: DiagnosticIssue[]; ts: number } | null = null;
const DIAG_CACHE_TTL_MS = 10_000; // 10 seconds

export function getCachedDiagnostics(): DiagnosticIssue[] {
  if (_diagCache && Date.now() - _diagCache.ts < DIAG_CACHE_TTL_MS) return _diagCache.issues;
  const issues = runDiagnostics();
  _diagCache = { issues, ts: Date.now() };
  return issues;
}

// ── withLint — appended to every tool response ───────────────────────

/** Append lint warnings/errors to every tool response (cached 10s) */
export function withLint(result: { content: { type: "text"; text: string }[] }): typeof result {
  refreshFleetMailUnread(); // fire-and-forget
  let text = result.content[0]?.text || "";

  // 1. Diagnostics lint (errors only — warnings are noise)
  const issues = getCachedDiagnostics();
  const errors = issues.filter(i => i.severity === "error");
  if (errors.length > 0) {
    text += "\n\n⚠ LINT (" + errors.length + " issue" + (errors.length > 1 ? "s" : "") + "):\n" +
      errors.map(i => `  ✘ [${i.check}] ${i.message}${i.fix ? ` → ${i.fix}` : ""}`).join("\n");
  }

  // 2. Fleet Mail unread nudge (cached, non-blocking)
  const unreadCount = getFleetMailUnreadCount();
  if (unreadCount > 0) {
    text += `\n\n📬 ${unreadCount} unread mail — call mail_inbox() to read`;
  }

  return { content: [{ type: "text" as const, text }] };
}
