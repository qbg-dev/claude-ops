import type { Command } from "commander";
import { readFileSync, readdirSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_SESSION, FLEET_DATA, workerDir, resolveProject,
} from "../lib/paths";
import {
  getConfig, getFleetConfig, getState, generateLaunchSh, writeJsonLocked,
} from "../lib/config";
import { info, ok, warn, fail } from "../lib/fmt";
import { launchInTmux } from "../lib/launch";
import { listPaneIds } from "../lib/tmux";
import { syncWorktree } from "../lib/worktree";
import { addGlobalOpts } from "../index";

/** Start a single worker with optional overrides */
async function startOne(
  name: string, project: string,
  opts: { model?: string; runtime?: string; effort?: string; permissionMode?: string; window?: string; windowIndex?: string; save?: boolean; force?: boolean },
): Promise<boolean> {
  const dir = workerDir(project, name);
  const configPath = join(dir, "config.json");

  if (!existsSync(dir)) { warn(`Worker '${name}' not found`); return false; }
  if (!existsSync(configPath)) { warn(`No config.json for '${name}'`); return false; }

  // Safety: skip if worker already has a live pane (prevents seed injection into active sessions)
  if (!opts.force) {
    const state = getState(project, name);
    if (state?.pane_id && listPaneIds().has(state.pane_id)) {
      info(`Worker '${name}' already running in pane ${state.pane_id} (use --force to restart)`);
      return true;
    }
  }

  const overrides: Record<string, string> = {};
  if (opts.model) overrides.model = opts.model;
  if (opts.runtime) overrides.runtime = opts.runtime;
  if (opts.effort) overrides.reasoning_effort = opts.effort;
  if (opts.permissionMode) overrides.permission_mode = opts.permissionMode;
  if (opts.window) overrides.window = opts.window;

  const hasOverrides = Object.keys(overrides).length > 0;
  const backupPath = `${configPath}.start-bak`;

  if (hasOverrides) {
    if (opts.save) {
      info("Saving overrides to config");
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      Object.assign(config, overrides);
      writeJsonLocked(configPath, config);
      generateLaunchSh(project, name);
      ok("Config updated + launch.sh regenerated");
    } else {
      copyFileSync(configPath, backupPath);
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      Object.assign(config, overrides);
      writeJsonLocked(configPath, config);
    }
  }

  const config = getConfig(project, name);
  const window = config?.window || name;
  const fleetConfig = getFleetConfig(project);
  const session = fleetConfig?.tmux_session || DEFAULT_SESSION;
  const windowIndex = opts.windowIndex ? parseInt(opts.windowIndex, 10) : undefined;

  // Re-sync worktree files (mission symlink, .mcp.json, etc.)
  if (config?.worktree) {
    // Derive project root from worktree path: /path/boring-w-name → /path/boring
    const projectRoot = config.worktree.replace(/-w-[^/]+$/, "");
    syncWorktree({ name, project, projectRoot, worktreeDir: config.worktree });
  }

  try {
    const runtime = (config?.runtime || "claude") as "claude" | "codex";
    await launchInTmux(name, project, session, window, windowIndex, { runtime });
    return true;
  } catch (e) {
    warn(`Failed to start ${name}: ${e}`);
    return false;
  } finally {
    if (hasOverrides && !opts.save && existsSync(backupPath)) {
      copyFileSync(backupPath, configPath);
      Bun.spawnSync(["rm", "-f", backupPath]);
      generateLaunchSh(project, name);
    }
  }
}

/** Get list of all worker names for a project */
function listWorkerNames(project: string): string[] {
  const projectDir = join(FLEET_DATA, project);
  try {
    return readdirSync(projectDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !["missions", "_user", "_config"].includes(d.name))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/** Launch workers in rate-limited batches */
async function startAllWorkers(
  project: string,
  concurrency: number,
  opts: { model?: string; effort?: string; permissionMode?: string; save?: boolean },
): Promise<void> {
  const panes = listPaneIds();
  const workers = listWorkerNames(project);

  // Filter to workers that need launching (not already alive)
  const needLaunch: string[] = [];
  const alreadyRunning: string[] = [];

  for (const name of workers) {
    const state = getState(project, name);
    if (state?.pane_id && panes.has(state.pane_id)) {
      alreadyRunning.push(name);
    } else {
      needLaunch.push(name);
    }
  }

  if (alreadyRunning.length > 0) {
    info(`Already running (${alreadyRunning.length}): ${alreadyRunning.join(", ")}`);
  }

  if (needLaunch.length === 0) {
    ok("All workers already running");
    return;
  }

  info(`Launching ${needLaunch.length} workers (max ${concurrency} concurrent, ${Math.ceil(needLaunch.length / concurrency)} batches)`);

  let launched = 0;
  let failed = 0;

  // Process in batches of `concurrency`
  for (let i = 0; i < needLaunch.length; i += concurrency) {
    const batch = needLaunch.slice(i, i + concurrency);
    const batchNum = Math.floor(i / concurrency) + 1;
    info(`Batch ${batchNum}: ${batch.join(", ")}`);

    // Launch batch sequentially with stagger delay to prevent Fleet Mail thundering herd
    for (const name of batch) {
      const success = await startOne(name, project, opts);
      if (success) launched++;
      else failed++;

      // 2s stagger between every worker launch to avoid all hitting Fleet Mail at once
      if (batch.indexOf(name) < batch.length - 1) {
        await Bun.sleep(2000);
      }
    }

    // Inter-batch delay: give Fleet Mail breathing room between batches
    if (i + concurrency < needLaunch.length) {
      info("Waiting 5s before next batch...");
      await Bun.sleep(5000);
    }
  }

  ok(`Done: ${launched} launched, ${failed} failed, ${alreadyRunning.length} already running`);
}

export function register(parent: Command): void {
  const sub = parent
    .command("start [name]")
    .alias("restart")
    .description("Start or restart a worker (use --all for all workers)")
    .option("-a, --all", "Start all workers that aren't running")
    .option("-c, --concurrency <n>", "Max concurrent launches for --all (default: 4)", "4")
    .option("--model <model>", "Override model")
    .option("--runtime <runtime>", "Runtime: claude (default) or codex")
    .option("--effort <effort>", "Override effort")
    .option("--permission-mode <mode>", "Override permission mode")
    .option("--window <name>", "tmux window group")
    .option("--window-index <index>", "Explicit window position")
    .option("--save", "Persist flag overrides to config")
    .option("-f, --force", "Force restart even if worker is already running");
  addGlobalOpts(sub)
    .action(async (name: string | undefined, opts: {
      all?: boolean; concurrency?: string;
      model?: string; runtime?: string; effort?: string; permissionMode?: string;
      window?: string; windowIndex?: string; save?: boolean; force?: boolean;
    }, cmd: Command) => {
      const project = cmd.optsWithGlobals().project as string || resolveProject();

      if (opts.all) {
        const concurrency = Math.max(1, Math.min(8, parseInt(opts.concurrency || "4", 10)));
        await startAllWorkers(project, concurrency, opts);
        return;
      }

      if (!name) fail("Usage: fleet start <name> or fleet start --all");
      await startOne(name!, project, opts);
    });
}
