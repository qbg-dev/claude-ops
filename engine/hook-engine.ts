#!/usr/bin/env bun
/**
 * hook-engine.ts — Unified dynamic hook dispatch with script execution.
 *
 * Reads dynamic hooks from per-worker hooks dir and applies block/inject/script decisions.
 *
 * Hook storage (primary): $HOOKS_DIR/hooks.json (set by claude-hooks or fleet)
 * Hook storage (fleet):   ~/.claude/fleet/{project}/{worker}/hooks/hooks.json
 * Hook storage (legacy):  ~/.claude/ops/hooks/dynamic/{worker}.json
 * Script files:           {hooks_dir}/{script_path}
 *
 * Output protocol:
 *   Block:  {"decision":"block","reason":"..."}
 *   Inject: {"additionalContext":"..."}
 *   Pass:   {}
 *
 * Script exit codes (Claude Code convention):
 *   0 = allow (pass through)
 *   2 = block (stderr shown as reason)
 *   1 = error (logged internally, non-blocking failure)
 *
 * Fail-open: any error → {} (never accidentally block)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import type { DynamicHook } from "../shared/types";

// ── Types ──────────────────────────────────────────────────────────
interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  agent_id?: string;
  agent_type?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

interface HooksFile {
  hooks: DynamicHook[];
}

// ── Environment ────────────────────────────────────────────────────
const HOME = process.env.HOME!;
const WORKER = process.env.HOOKS_IDENTITY || process.env.WORKER_NAME || process.env.USER || "user";
const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();
const HOOKS_DIR_ENV = process.env.HOOKS_DIR;

// ── Hooks file resolution ──────────────────────────────────────────
function resolveHooksFile(): { file: string; dir: string } | null {
  // Primary: HOOKS_DIR env (set by claude-hooks or fleet)
  if (HOOKS_DIR_ENV) {
    const f = join(HOOKS_DIR_ENV, "hooks.json");
    if (existsSync(f)) return { file: f, dir: HOOKS_DIR_ENV };
  }
  // Fleet layout: ~/.claude/fleet/{project}/{worker}/hooks/hooks.json
  const projectName = basename(PROJECT_ROOT).replace(/-w-.*$/, "");
  const fleetDir = join(HOME, ".claude/fleet", projectName, WORKER, "hooks");
  const fleetFile = join(fleetDir, "hooks.json");
  if (existsSync(fleetFile)) return { file: fleetFile, dir: fleetDir };
  // Global standalone: ~/.claude/hooks/hooks.json (works for all Claude Code instances)
  const globalDir = join(HOME, ".claude/hooks");
  const globalFile = join(globalDir, "hooks.json");
  if (existsSync(globalFile)) return { file: globalFile, dir: globalDir };
  // Legacy: ~/.claude/ops/hooks/dynamic/{worker}.json
  const legacyDir = process.env.CLAUDE_HOOKS_DIR || join(HOME, ".claude/ops/hooks/dynamic");
  const legacyFile = join(legacyDir, `${WORKER}.json`);
  if (existsSync(legacyFile)) return { file: legacyFile, dir: legacyDir };
  return null;
}

// ── Condition matching (PreToolUse/PostToolUse) ────────────────────
function matchesCondition(hook: DynamicHook, toolName: string, toolInput: Record<string, unknown>): boolean {
  if (!hook.condition) return true;
  const { tool, file_glob, command_pattern } = hook.condition;

  if (tool && toolName !== tool) return false;

  if (file_glob) {
    const filePath = (toolInput?.file_path || toolInput?.path || toolInput?.command || "") as string;
    if (filePath) {
      const glob = new Bun.Glob(file_glob);
      if (!glob.match(filePath)) return false;
    }
  }

  if (command_pattern) {
    const cmd = (toolInput?.command || "") as string;
    if (cmd && !new RegExp(command_pattern).test(cmd)) return false;
  }

  return true;
}

// ── Permission scanner ─────────────────────────────────────────────
function scanScript(content: string, permsPath: string): string | null {
  try {
    const perms = JSON.parse(readFileSync(permsPath, "utf-8"));
    const denyList: string[] = perms.denyList || [];
    if (denyList.length === 0) return null;

    const lines = content.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
    const normalized = lines.join(" ; ");

    for (const pattern of denyList) {
      const m = pattern.match(/^(\w+)\((.+)\)$/);
      if (!m || m[1] !== "Bash") continue;
      const regex = m[2]
        .replace(/[.[\]^$+{}|\\]/g, "\\$&")
        .replace(/\*\*/g, ".*")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
      try {
        const re = new RegExp(regex);
        if (re.test(normalized) || re.test(content)) {
          return `Script blocked by policy: matches Bash(${m[2]})`;
        }
      } catch {}
    }
  } catch {}
  return null;
}

// ── Session state (set from hook input in main) ──────────────────
let SESSION_ID = "";

// ── Check command execution ────────────────────────────────────────
function runCheckCommand(check: string): { passed: boolean; stderr: string } {
  const result = Bun.spawnSync(["bash", "-c", check], {
    env: { ...process.env, WORKER_NAME: WORKER, SESSION_ID, PROJECT_ROOT },
    stderr: "pipe",
    stdout: "pipe",
  });
  const stderr = result.stderr.toString().slice(0, 500);
  return { passed: result.exitCode === 0, stderr };
}

// ── Script execution ───────────────────────────────────────────────
function runHookScript(
  hook: DynamicHook,
  hooksDir: string,
  event: string,
): { exitCode: number; stderr: string } {
  if (!hook.script_path) return { exitCode: 0, stderr: "" };

  const scriptPath = join(hooksDir, hook.script_path);
  if (!existsSync(scriptPath)) return { exitCode: 0, stderr: "" };

  // Permission scan against denyList
  const permsPath = process.env.HOOKS_PERMISSIONS
    || join(PROJECT_ROOT, ".claude/workers", WORKER, "permissions.json");
  if (existsSync(permsPath)) {
    const blocked = scanScript(readFileSync(scriptPath, "utf-8"), permsPath);
    if (blocked) {
      console.error(`[hook-engine] Script blocked at execution time: ${blocked}`);
      return { exitCode: 1, stderr: blocked };
    }
  }

  const env = {
    ...process.env,
    WORKER_NAME: WORKER,
    SESSION_ID,
    HOOK_EVENT: event,
    HOOK_ID: hook.id,
    PROJECT_ROOT,
  };

  if (hook.blocking) {
    const result = Bun.spawnSync(["bash", scriptPath], { env, stderr: "pipe", stdout: "pipe" });
    return { exitCode: result.exitCode ?? 1, stderr: result.stderr.toString().slice(0, 500) };
  } else {
    // Non-blocking: fire and forget
    Bun.spawn(["bash", scriptPath], { env, stdout: "ignore", stderr: "ignore" });
    return { exitCode: 0, stderr: "" };
  }
}

// ── Main ───────────────────────────────────────────────────────────
try {
  const raw = await Bun.stdin.text();
  const input: HookInput = raw.trim() ? JSON.parse(raw) : {};

  const event = input.hook_event_name || "";
  SESSION_ID = input.session_id || "";
  if (!event) {
    console.log("{}");
    process.exit(0);
  }

  const resolved = resolveHooksFile();
  if (!resolved) {
    console.log("{}");
    process.exit(0);
  }

  const { file: hooksFile, dir: hooksDir } = resolved;
  const hooksData: HooksFile = JSON.parse(readFileSync(hooksFile, "utf-8"));

  const agentId = input.agent_id || "";
  const toolName = input.tool_name || "";
  const toolInput = input.tool_input || {};
  const isSubagent = !!agentId;

  // ── SubagentStop: auto-complete hooks scoped to this agent ──
  if (event === "SubagentStop" && agentId) {
    const now = new Date().toISOString();
    let changed = false;
    for (const hook of hooksData.hooks) {
      if (hook.agent_id === agentId && !hook.completed) {
        hook.completed = true;
        hook.completed_at = now;
        hook.result = "auto-completed: subagent stopped";
        changed = true;
      }
    }
    if (changed) {
      try { writeFileSync(hooksFile, JSON.stringify(hooksData, null, 2) + "\n"); } catch {}
    }
  }

  // ── Filter hooks matching this event ──
  const matching = hooksData.hooks.filter(hook => {
    if (hook.event !== event) return false;
    if (hook.completed) return false;
    if (hook.status === "archived") return false;
    // Subagents see: hooks scoped to their agent_id + unscoped hooks
    // Parent sees: unscoped hooks only
    if (isSubagent) {
      return !hook.agent_id || hook.agent_id === agentId;
    }
    return !hook.agent_id;
  });

  if (matching.length === 0) {
    console.log("{}");
    process.exit(0);
  }

  // ── Process matching hooks ──
  const blockReasons: string[] = [];
  const injectContexts: string[] = [];

  for (const hook of matching) {
    // Condition matching for tool events
    if (event === "PreToolUse" || event === "PostToolUse") {
      if (!matchesCondition(hook, toolName, toolInput)) continue;
    }

    const desc = hook.description || "dynamic hook";
    const content = hook.content || hook.description || "";

    // ── Check command (verification loops) ──
    if (hook.check) {
      const fireCount = hook.fire_count ?? 0;
      const maxFires = hook.max_fires ?? 5;

      // Safety valve: auto-pass after max_fires blocks
      if (fireCount >= maxFires) continue;

      const { passed, stderr } = runCheckCommand(hook.check);
      if (passed) continue;

      // Check failed — block and increment fire_count
      const newFireCount = fireCount + 1;
      const hookInFile = hooksData.hooks.find(h => h.id === hook.id);
      if (hookInFile) hookInFile.fire_count = newFireCount;
      try { writeFileSync(hooksFile, JSON.stringify(hooksData, null, 2) + "\n"); } catch {}

      const reason = stderr || "Check failed";
      blockReasons.push(`  [${hook.id}] ${desc} (attempt ${newFireCount}/${maxFires}): ${reason}`);
      continue;
    }

    // ── Script execution ──
    if (hook.script_path) {
      const { exitCode, stderr } = runHookScript(hook, hooksDir, event);
      if (exitCode === 2) {
        // Script says block
        const reason = stderr || `Script ${hook.script_path} exited with code 2`;
        blockReasons.push(`  [${hook.id}] ${desc} — ${reason}`);
        continue;
      } else if (exitCode === 1) {
        // Script error — non-blocking failure, skip
        continue;
      }
      // Exit 0 = allow — fall through to normal gate/inject logic
    }

    // ── Gate/inject accumulation ──
    if (hook.blocking) {
      blockReasons.push(`  [${hook.id}] ${desc}`);
    } else if (content) {
      injectContexts.push(content);
    }
  }

  // ── Emit decision ──
  // Blocking takes priority (PreToolUse and Stop can block; PostToolUse cannot)
  if (blockReasons.length > 0 && event !== "PostToolUse") {
    // Stop hook infinite loop guard
    if (event === "Stop" && process.env.STOP_HOOK_ACTIVE === "true") {
      console.log("{}");
      process.exit(0);
    }

    const reason = `## ${blockReasons.length} pending blocking hook(s)\n\n${blockReasons.join("\n")}\n\nComplete each with complete_hook(id) before proceeding.`;
    console.log(JSON.stringify({ decision: "block", reason }));
    process.exit(0);
  }

  // Inject context if any non-blocking hooks matched
  if (injectContexts.length > 0) {
    const ctx = injectContexts.join("\n").slice(0, 2000);
    console.log(JSON.stringify({ additionalContext: ctx }));
    process.exit(0);
  }

  console.log("{}");
} catch {
  // Fail-open: never accidentally block
  console.log("{}");
  process.exit(0);
}
