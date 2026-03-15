/**
 * fleet hook — CLI for managing dynamic hooks.
 *
 * Subcommands:
 *   fleet hook add --event <event> --desc <description> [--blocking] [--script <cmd>] [--condition <json>]
 *   fleet hook rm <id>
 *   fleet hook ls [--event <event>]
 *   fleet hook complete <id> [--result <text>]
 *
 * Mirrors MCP tool params exactly — same JSON file, same logic.
 * Workers without MCP can manage hooks via CLI.
 */

import type { Command } from "commander";
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, copyFileSync,
} from "node:fs";
import { join, basename } from "node:path";
import { FLEET_DATA, resolveProject, resolveProjectRoot } from "../lib/paths";
import { info, ok, fail, table } from "../lib/fmt";
import { addGlobalOpts } from "../index";
import type { DynamicHook } from "../../shared/types";

// ── Path Resolution ─────────────────────────────────────────────

function resolveWorkerName(): string {
  if (process.env.WORKER_NAME) return process.env.WORKER_NAME;
  try {
    const result = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { stderr: "pipe" });
    if (result.exitCode === 0) {
      const branch = result.stdout.toString().trim();
      if (branch.startsWith("worker/")) return branch.slice("worker/".length);
    }
    // Worktree suffix detection
    const dirName = basename(process.cwd());
    const match = dirName.match(/-w-(.+)$/);
    if (match) return match[1];
  } catch {}
  return "operator";
}

function getHooksDir(project: string, workerName: string): string {
  return join(FLEET_DATA, project, workerName, "hooks");
}

function getHooksFile(project: string, workerName: string): string {
  return join(getHooksDir(project, workerName), "hooks.json");
}

// ── Helpers ─────────────────────────────────────────────────────

function slugify(desc: string): string {
  return desc
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

function readHooks(hooksFile: string): { hooks: DynamicHook[]; counter: number } {
  if (!existsSync(hooksFile)) return { hooks: [], counter: 0 };
  try {
    const data = JSON.parse(readFileSync(hooksFile, "utf-8"));
    const hooks: DynamicHook[] = data.hooks || [];
    let counter = 0;
    for (const h of hooks) {
      const num = parseInt(h.id.replace("dh-", ""), 10);
      if (!isNaN(num) && num > counter) counter = num;
    }
    return { hooks, counter };
  } catch { return { hooks: [], counter: 0 }; }
}

function writeHooks(hooksFile: string, hooks: DynamicHook[]): void {
  const dir = join(hooksFile, "..");
  mkdirSync(dir, { recursive: true });
  if (hooks.length === 0) {
    try { rmSync(hooksFile); } catch {}
    return;
  }
  writeFileSync(hooksFile, JSON.stringify({ hooks }, null, 2));
}

/** Scan script against worker denyList. Returns null if OK, reason if blocked. */
function scanScript(scriptContent: string, _project: string, workerName: string): string | null {
  const projectRoot = resolveProjectRoot();
  const permsPath = join(projectRoot, ".claude/workers", workerName, "permissions.json");
  if (!existsSync(permsPath)) return null;

  let denyList: string[];
  try {
    const perms = JSON.parse(readFileSync(permsPath, "utf-8"));
    denyList = perms.denyList || [];
  } catch { return null; }

  if (denyList.length === 0) return null;

  const lines = scriptContent.split("\n")
    .map(l => l.trim())
    .filter(l => l && !l.startsWith("#"));
  const normalized = lines.join(" ; ");

  for (const pattern of denyList) {
    const m = pattern.match(/^(\w+)\((.+)\)$/);
    if (!m || m[1] !== "Bash") continue;
    const argPattern = m[2];
    const regex = argPattern
      .replace(/[.[\]^$+{}|\\]/g, "\\$&")
      .replace(/\*\*/g, ".*")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    try {
      const re = new RegExp(regex);
      if (re.test(normalized) || re.test(scriptContent)) {
        return `Script blocked by policy: matches Bash(${argPattern}) in denyList`;
      }
    } catch {}
  }
  return null;
}

// ── Subcommands ─────────────────────────────────────────────────

async function hookAdd(opts: {
  event: string; desc: string; blocking?: boolean; script?: string;
  content?: string; condition?: string; agentId?: string;
}, globalOpts: Record<string, unknown>): Promise<void> {
  const projectRoot = resolveProjectRoot();
  const project = (globalOpts.project as string) || resolveProject(projectRoot);
  const workerName = (globalOpts.worker as string) || resolveWorkerName();
  const hooksFile = getHooksFile(project, workerName);
  const hooksDir = getHooksDir(project, workerName);
  mkdirSync(hooksDir, { recursive: true });

  const { hooks, counter } = readHooks(hooksFile);
  const id = `dh-${counter + 1}`;
  const isBlocking = opts.blocking ?? (opts.event === "Stop");

  // Handle script
  let scriptPath: string | undefined;
  if (opts.script) {
    let scriptContent: string;
    if (opts.script.startsWith("@")) {
      const srcPath = opts.script.slice(1);
      if (!existsSync(srcPath)) fail(`Script source file not found: ${srcPath}`);
      scriptContent = readFileSync(srcPath, "utf-8");
    } else {
      scriptContent = opts.script;
    }

    // Permission scan
    const blocked = scanScript(scriptContent, project, workerName);
    if (blocked) fail(`Hook rejected: ${blocked}`);

    // Write script file
    const slug = slugify(opts.desc);
    const filename = slug ? `${id}-${slug}.sh` : `${id}.sh`;
    const destPath = join(hooksDir, filename);

    if (opts.script.startsWith("@")) {
      copyFileSync(opts.script.slice(1), destPath);
    } else {
      const content = opts.script.startsWith("#!/")
        ? opts.script
        : `#!/usr/bin/env bash\nset -uo pipefail\n${opts.script}\n`;
      writeFileSync(destPath, content);
    }
    Bun.spawnSync(["chmod", "+x", destPath]);
    scriptPath = filename;
  }

  // Parse condition JSON
  let condition: DynamicHook["condition"];
  if (opts.condition) {
    try {
      condition = JSON.parse(opts.condition);
    } catch { fail(`Invalid condition JSON: ${opts.condition}`); }
  }

  const hook: DynamicHook = {
    id,
    event: opts.event,
    description: opts.desc,
    blocking: isBlocking,
    completed: false,
    added_at: new Date().toISOString(),
  };
  if (opts.content) hook.content = opts.content;
  if (condition) hook.condition = condition;
  if (opts.agentId) hook.agent_id = opts.agentId;
  if (scriptPath) hook.script_path = scriptPath;

  hooks.push(hook);
  writeHooks(hooksFile, hooks);

  const typeLabel = isBlocking ? "blocking" : "inject";
  const scriptNote = scriptPath ? ` [script: ${scriptPath}]` : "";
  ok(`Hook [${id}] ${opts.event}/${typeLabel} — ${opts.desc}${scriptNote}`);
}

async function hookRm(id: string, globalOpts: Record<string, unknown>): Promise<void> {
  const projectRoot = resolveProjectRoot();
  const project = (globalOpts.project as string) || resolveProject(projectRoot);
  const workerName = (globalOpts.worker as string) || resolveWorkerName();
  const hooksFile = getHooksFile(project, workerName);
  const hooksDir = getHooksDir(project, workerName);

  const { hooks } = readHooks(hooksFile);

  if (id === "all") {
    // Remove all script files
    for (const h of hooks) {
      if (h.script_path) {
        try { rmSync(join(hooksDir, h.script_path)); } catch {}
      }
    }
    writeHooks(hooksFile, []);
    ok(`Removed all ${hooks.length} hook(s)`);
    return;
  }

  const idx = hooks.findIndex(h => h.id === id);
  if (idx === -1) fail(`No hook with ID '${id}'`);

  const hook = hooks[idx];
  if (hook.script_path) {
    try { rmSync(join(hooksDir, hook.script_path)); } catch {}
  }
  hooks.splice(idx, 1);
  writeHooks(hooksFile, hooks);
  ok(`Removed: [${id}] ${hook.description}`);
}

async function hookLs(opts: { event?: string }, globalOpts: Record<string, unknown>): Promise<void> {
  const projectRoot = resolveProjectRoot();
  const project = (globalOpts.project as string) || resolveProject(projectRoot);
  const workerName = (globalOpts.worker as string) || resolveWorkerName();
  const hooksFile = getHooksFile(project, workerName);

  const { hooks } = readHooks(hooksFile);
  const filtered = opts.event
    ? hooks.filter(h => h.event === opts.event)
    : hooks;

  if (filtered.length === 0) {
    info(`No hooks${opts.event ? ` for event '${opts.event}'` : ""} (worker: ${workerName})`);
    return;
  }

  if ((globalOpts as any).json) {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }

  const rows = filtered.map(h => {
    const type = h.blocking ? "GATE" : "INJECT";
    const status = h.blocking
      ? (h.completed ? "DONE" : "PENDING")
      : "active";
    const script = h.script_path || "";
    return [h.id, h.event, type, status, h.description, script];
  });

  table(["ID", "Event", "Type", "Status", "Description", "Script"], rows);
  const pending = hooks.filter(h => h.blocking && !h.completed);
  console.log(`\n${hooks.length} total, ${pending.length} blocking pending`);
}

async function hookComplete(id: string, opts: { result?: string }, globalOpts: Record<string, unknown>): Promise<void> {
  const projectRoot = resolveProjectRoot();
  const project = (globalOpts.project as string) || resolveProject(projectRoot);
  const workerName = (globalOpts.worker as string) || resolveWorkerName();
  const hooksFile = getHooksFile(project, workerName);

  const { hooks } = readHooks(hooksFile);
  const now = new Date().toISOString();

  if (id === "all") {
    let count = 0;
    for (const h of hooks) {
      if (h.blocking && !h.completed) {
        h.completed = true;
        h.completed_at = now;
        if (opts.result) h.result = opts.result;
        count++;
      }
    }
    if (count === 0) { info("No pending blocking hooks to complete."); return; }
    writeHooks(hooksFile, hooks);
    ok(`Completed ${count} hook(s). All blocking hooks cleared.`);
    return;
  }

  const hook = hooks.find(h => h.id === id);
  if (!hook) fail(`No hook with ID '${id}'`);
  // fail() calls process.exit, so hook is defined below

  hook!.completed = true;
  hook!.completed_at = now;
  if (opts.result) hook!.result = opts.result;
  writeHooks(hooksFile, hooks);

  const remaining = hooks.filter(h => h.blocking && !h.completed).length;
  ok(`Completed: [${id}] ${hook!.description}${opts.result ? ` (${opts.result})` : ""}`);
  if (remaining > 0) info(`${remaining} blocking hook(s) remaining`);
}

// ── Registration ────────────────────────────────────────────────

export function register(parent: Command): void {
  const hook = parent
    .command("hook")
    .description("Manage dynamic hooks (add/rm/ls/complete)")
    .option("--worker <name>", "Operate on another worker's hooks (default: auto-detect from branch/worktree)");

  // fleet hook add
  const add = hook
    .command("add")
    .description("Register a dynamic hook")
    .requiredOption("--event <event>", "Hook event (Stop, PreToolUse, PreCompact, etc.)")
    .requiredOption("--desc <description>", "Human-readable purpose")
    .option("--blocking", "Block event until completed (default for Stop)")
    .option("--no-blocking", "Don't block (inject mode)")
    .option("--script <cmd>", "Shell script to run (inline or @filepath)")
    .option("--content <text>", "Content to inject or block reason")
    .option("--condition <json>", 'Condition JSON (e.g. \'{"tool":"Edit","file_glob":"src/**"}\')')
    .option("--agent-id <id>", "Scope to subagent");
  addGlobalOpts(add)
    .action(async (opts: {
      event: string; desc: string; blocking?: boolean; script?: string;
      content?: string; condition?: string; agentId?: string;
    }, cmd: Command) => {
      await hookAdd(opts, cmd.optsWithGlobals());
    });

  // fleet hook rm <id>
  const rm = hook
    .command("rm <id>")
    .description("Remove a hook (or 'all')");
  addGlobalOpts(rm)
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      await hookRm(id, cmd.optsWithGlobals());
    });

  // fleet hook ls
  const ls = hook
    .command("ls")
    .description("List active hooks")
    .option("--event <event>", "Filter by event");
  addGlobalOpts(ls)
    .action(async (opts: { event?: string }, cmd: Command) => {
      await hookLs(opts, cmd.optsWithGlobals());
    });

  // fleet hook complete <id>
  const complete = hook
    .command("complete <id>")
    .description("Mark a blocking hook as completed (or 'all')")
    .option("--result <text>", "Brief outcome (e.g. 'PASS')");
  addGlobalOpts(complete)
    .action(async (id: string, opts: { result?: string }, cmd: Command) => {
      await hookComplete(id, opts, cmd.optsWithGlobals());
    });
}
