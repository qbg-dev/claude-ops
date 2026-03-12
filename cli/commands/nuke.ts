import type { Command } from "commander";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, lstatSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import chalk from "chalk";
import { FLEET_DIR, FLEET_DATA, workerDir, resolveProject, resolveProjectRoot } from "../lib/paths";
import { getState, getConfig } from "../lib/config";
import { ok, info, warn, fail } from "../lib/fmt";
import { listPaneIds, killPane } from "../lib/tmux";
import { addGlobalOpts } from "../index";

const HOME = process.env.HOME || "/tmp";

// ============================================================
// Per-worker nuke
// ============================================================

async function nukeWorker(name: string, project: string, opts: { yes?: boolean }): Promise<void> {
  const dir = workerDir(project, name);

  if (!existsSync(dir)) fail(`Worker '${name}' not found in project '${project}'`);

  console.log(chalk.bold.red(`fleet nuke ${name}`) + ` — removing worker from project '${project}'\n`);

  const removed: string[] = [];

  // 1. Kill tmux pane
  const state = getState(project, name);
  const paneId = state?.pane_id;
  if (paneId && listPaneIds().has(paneId)) {
    if (!opts.yes) {
      const yes = await confirm(chalk.yellow(`Kill tmux pane ${paneId} and destroy worker '${name}'?`));
      if (!yes) { info("Aborted."); return; }
      console.log("");
    }
    killPane(paneId);
    ok(`Killed tmux pane ${paneId}`);
    removed.push(`tmux pane ${paneId}`);
  } else {
    if (!opts.yes) {
      const yes = await confirm(chalk.yellow(`Destroy worker '${name}'? (no active pane)`));
      if (!yes) { info("Aborted."); return; }
      console.log("");
    }
    if (paneId) info(`Pane ${paneId} already gone`);
  }

  // 2. Remove git worktree
  const config = getConfig(project, name);
  const worktreeDir = config?.worktree;
  if (worktreeDir && existsSync(worktreeDir)) {
    // Find the main project root (strip worktree suffix)
    const projectRoot = resolveProjectRoot(worktreeDir);
    // Use git worktree remove from the parent repo
    const parentRoot = dirname(worktreeDir);
    // Try finding the actual main repo — worktree dirs sit alongside it
    const projectBasename = basename(worktreeDir).replace(/-w-.*$/, "");
    const mainRoot = join(parentRoot, projectBasename);
    const gitRoot = existsSync(join(mainRoot, ".git")) ? mainRoot : projectRoot;

    const result = Bun.spawnSync(
      ["git", "-C", gitRoot, "worktree", "remove", worktreeDir, "--force"],
      { stderr: "pipe" },
    );
    if (result.exitCode === 0) {
      ok(`Removed worktree ${worktreeDir}`);
      removed.push(`worktree ${worktreeDir}`);
    } else {
      // Fallback: just remove the directory
      warn(`git worktree remove failed — removing directory directly`);
      rmSync(worktreeDir, { recursive: true, force: true });
      ok(`Removed worktree directory ${worktreeDir}`);
      removed.push(`worktree dir ${worktreeDir}`);
    }

    // Clean up the branch too
    const branch = config?.branch || `worker/${name}`;
    Bun.spawnSync(["git", "-C", gitRoot, "branch", "-D", branch], { stderr: "pipe" });
  } else if (worktreeDir) {
    info(`Worktree ${worktreeDir} already gone`);
  }

  // 3. Remove fleet data dir
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    ok(`Removed fleet data ${dir}`);
    removed.push(`fleet data ${dir}`);
  }

  // 4. Remove mission symlink
  const missionLink = join(FLEET_DATA, project, "missions", `${name}.md`);
  if (existsSync(missionLink)) {
    rmSync(missionLink, { force: true });
    ok(`Removed mission symlink ${missionLink}`);
    removed.push(`mission symlink`);
  }

  // Summary
  console.log("");
  if (removed.length > 0) {
    ok(chalk.bold(`Worker '${name}' nuked (${removed.length} artifacts removed)`));
  } else {
    info(`Worker '${name}' — nothing to clean up`);
  }
}

// ============================================================
// Full nuke (--all) — existing behavior
// ============================================================

interface Artifact {
  label: string;
  path: string;
  kind: "symlink" | "dir" | "file" | "launchd" | "process";
  /** If true, only remove when corresponding flag is NOT set */
  flag?: "keep-data" | "keep-mail";
  /** For process artifacts: process name pattern to match */
  processPattern?: string;
  /** For launchd: plist label */
  launchdLabel?: string;
  /** Extra check before removing (e.g. don't remove if env var points elsewhere) */
  guard?: () => boolean;
}

function getArtifacts(): Artifact[] {
  return [
    // Processes
    {
      label: "boring-mail processes",
      path: "",
      kind: "process",
      processPattern: "boring-mail",
    },
    {
      label: "fleet-server processes (legacy)",
      path: "",
      kind: "process",
      processPattern: "fleet-server",
    },

    // LaunchAgents
    {
      label: "Watchdog launchd agent",
      path: join(HOME, "Library/LaunchAgents/com.claude-fleet.harness-watchdog.plist"),
      kind: "launchd",
      launchdLabel: "com.claude-fleet.harness-watchdog",
    },
    {
      label: "Fleet relay launchd agent",
      path: join(HOME, "Library/LaunchAgents/com.claude-fleet.fleet-relay.plist"),
      kind: "launchd",
      launchdLabel: "com.claude-fleet.fleet-relay",
    },

    // Symlinks
    {
      label: "~/.claude-fleet",
      path: join(HOME, ".claude-fleet"),
      kind: "symlink",
    },
    {
      label: "~/.claude-fleet",
      path: join(HOME, ".claude-fleet"),
      kind: "symlink",
    },
    {
      label: "~/.claude/ops",
      path: join(HOME, ".claude/ops"),
      kind: "symlink",
    },
    {
      label: "~/.tmux-agents",
      path: join(HOME, ".tmux-agents"),
      kind: "symlink",
    },
    {
      label: "~/.local/bin/fleet",
      path: join(HOME, ".local/bin/fleet"),
      kind: "symlink",
    },

    // Settings.json (handled specially — not a removal, just edit)
    // Not in this list; handled separately.

    // Data directory
    {
      label: "~/.claude/fleet/ (worker configs & state)",
      path: FLEET_DATA,
      kind: "dir",
      flag: "keep-data",
    },

    // Optional dependency clones
    {
      label: "~/.claude-hooks/ (hooks clone)",
      path: join(HOME, ".claude-hooks"),
      kind: "dir",
    },
    {
      label: "~/.deep-review/ (deep review clone)",
      path: join(HOME, ".deep-review"),
      kind: "dir",
      guard: () => {
        // Don't remove if DEEP_REVIEW_DIR env points elsewhere
        const envDir = process.env.DEEP_REVIEW_DIR;
        if (envDir) {
          try {
            const realEnv = Bun.spawnSync(["realpath", envDir], { stderr: "pipe" }).stdout.toString().trim();
            const realDefault = Bun.spawnSync(["realpath", join(HOME, ".deep-review")], { stderr: "pipe" }).stdout.toString().trim();
            if (realEnv && realDefault && realEnv !== realDefault) {
              return false; // DEEP_REVIEW_DIR points elsewhere, skip
            }
          } catch {}
        }
        return true;
      },
    },
    {
      label: "~/.boring-mail/ (local mail server data)",
      path: join(HOME, ".boring-mail"),
      kind: "dir",
      flag: "keep-mail",
    },
    {
      label: "~/.fleet-server/ (legacy mail data)",
      path: join(HOME, ".fleet-server"),
      kind: "dir",
      flag: "keep-mail",
    },
  ];
}

// --- Helpers ---

function artifactExists(a: Artifact): boolean {
  if (a.kind === "process") return findProcesses(a.processPattern!).length > 0;
  if (a.kind === "launchd") return existsSync(a.path);
  if (a.kind === "symlink") {
    try {
      lstatSync(a.path); // lstat doesn't follow symlinks — detects dangling too
      return true;
    } catch {
      return false;
    }
  }
  return existsSync(a.path);
}

function findProcesses(pattern: string): number[] {
  const result = Bun.spawnSync(["pgrep", "-f", pattern], { stderr: "pipe" });
  if (result.exitCode !== 0) return [];
  return result.stdout
    .toString()
    .trim()
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => parseInt(l.trim(), 10))
    .filter((pid: number) => !isNaN(pid) && pid !== process.pid);
}

function settingsHasFleetEntries(): { hasMcp: boolean; hasHooks: boolean } {
  const settingsFile = join(HOME, ".claude/settings.json");
  if (!existsSync(settingsFile)) return { hasMcp: false, hasHooks: false };
  try {
    const settings = JSON.parse(readFileSync(settingsFile, "utf-8"));
    const hasMcp = !!settings.mcpServers?.["worker-fleet"];

    let hasHooks = false;
    const fleetPatterns = ["/.claude-fleet/", "/.claude-fleet/", "/.claude-hooks/", "/.tmux-agents/"];
    for (const key of Object.keys(settings.hooks || {})) {
      const hookArray = settings.hooks[key];
      if (!Array.isArray(hookArray)) continue;
      for (const entry of hookArray) {
        const cmds: string[] = (entry.hooks || []).map((h: any) => h.command || "");
        if (entry.command) cmds.push(entry.command);
        if (cmds.some((cmd: string) => fleetPatterns.some((p) => cmd.includes(p)))) {
          hasHooks = true;
          break;
        }
      }
      if (hasHooks) break;
    }
    return { hasMcp, hasHooks };
  } catch {
    return { hasMcp: false, hasHooks: false };
  }
}

function backupSettings(): string | null {
  const settingsFile = join(HOME, ".claude/settings.json");
  if (!existsSync(settingsFile)) return null;

  const backupDir = join(HOME, ".claude/settings-backups");
  mkdirSync(backupDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(backupDir, `settings.${timestamp}.json`);
  writeFileSync(backupPath, readFileSync(settingsFile));
  return backupPath;
}

function cleanSettings(dryRun: boolean): void {
  const settingsFile = join(HOME, ".claude/settings.json");
  if (!existsSync(settingsFile)) return;

  let settings: Record<string, any>;
  try {
    settings = JSON.parse(readFileSync(settingsFile, "utf-8"));
  } catch {
    warn("Could not parse settings.json — skipping");
    return;
  }

  let modified = false;
  // Match both tilde and expanded paths
  const fleetPatterns = [
    "/.claude-fleet/", "/.claude-fleet/", "/.claude-hooks/", "/.tmux-agents/",
  ];

  // Remove mcpServers["worker-fleet"]
  if (settings.mcpServers?.["worker-fleet"]) {
    if (dryRun) {
      info(`Would remove mcpServers["worker-fleet"] from settings.json`);
    } else {
      delete settings.mcpServers["worker-fleet"];
      modified = true;
      ok(`Removed mcpServers["worker-fleet"]`);
    }
  }

  // Remove fleet-related hooks
  if (settings.hooks && typeof settings.hooks === "object") {
    for (const key of Object.keys(settings.hooks)) {
      const hookArray = settings.hooks[key];
      if (!Array.isArray(hookArray)) continue;

      const before = hookArray.length;
      const filtered = hookArray.filter((entry: any) => {
        // Hook entries are { hooks: [{ type, command }] } — check nested commands
        const cmds: string[] = (entry.hooks || []).map((h: any) => h.command || "");
        if (entry.command) cmds.push(entry.command); // fallback for flat format
        return !cmds.some((cmd: string) => fleetPatterns.some((p) => cmd.includes(p)));
      });
      const removed = before - filtered.length;

      if (removed > 0) {
        if (dryRun) {
          info(`Would remove ${removed} fleet hook(s) from hooks.${key}`);
        } else {
          settings.hooks[key] = filtered;
          // Remove empty arrays
          if (filtered.length === 0) delete settings.hooks[key];
          modified = true;
          ok(`Removed ${removed} fleet hook(s) from hooks.${key}`);
        }
      }
    }
    // Remove empty hooks object
    if (!dryRun && settings.hooks && Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }
  }

  if (modified && !dryRun) {
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
    ok("Updated settings.json");
  }
}

function removeArtifact(a: Artifact, dryRun: boolean): void {
  if (a.kind === "process") {
    const pids = findProcesses(a.processPattern!);
    if (pids.length === 0) return;
    if (dryRun) {
      info(`Would kill ${a.label} (PIDs: ${pids.join(", ")})`);
      return;
    }
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
    ok(`Killed ${a.label} (PIDs: ${pids.join(", ")})`);
    return;
  }

  if (a.kind === "launchd") {
    if (!existsSync(a.path)) return;
    if (dryRun) {
      info(`Would unload & remove ${a.label}`);
      return;
    }
    // Unload first (ignore errors — may not be loaded)
    Bun.spawnSync(["launchctl", "unload", a.path], { stderr: "pipe" });
    rmSync(a.path, { force: true });
    ok(`Unloaded & removed ${a.label}`);
    return;
  }

  if (a.kind === "symlink") {
    try {
      lstatSync(a.path);
    } catch {
      return; // doesn't exist
    }
    if (dryRun) {
      info(`Would remove symlink ${a.label}`);
      return;
    }
    rmSync(a.path, { force: true });
    ok(`Removed symlink ${a.label}`);
    return;
  }

  if (a.kind === "dir" || a.kind === "file") {
    if (!existsSync(a.path)) return;
    if (dryRun) {
      info(`Would remove ${a.label}`);
      return;
    }
    rmSync(a.path, { recursive: true, force: true });
    ok(`Removed ${a.label}`);
    return;
  }
}

async function confirm(message: string): Promise<boolean> {
  process.stdout.write(`${message} [y/N] `);
  for await (const line of console) {
    const answer = (line as string).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  }
  return false;
}

async function nukeAll(opts: { dryRun?: boolean; yes?: boolean; keepData?: boolean; keepMail?: boolean }): Promise<void> {
  const dryRun = opts.dryRun ?? false;
  const skipConfirm = opts.yes ?? false;
  const keepFlags = new Set<string>();
  if (opts.keepData) keepFlags.add("keep-data");
  if (opts.keepMail) keepFlags.add("keep-mail");

  console.log(chalk.bold.red(dryRun ? "fleet nuke --all (dry run)" : "fleet nuke --all") + " — remove all fleet artifacts\n");

  const artifacts = getArtifacts();
  const settingsInfo = settingsHasFleetEntries();

  // Build list of what will be affected
  const toRemove: Artifact[] = [];
  const skippedByFlag: Artifact[] = [];
  const skippedByGuard: Artifact[] = [];

  for (const a of artifacts) {
    // Check flag exclusion
    if (a.flag && keepFlags.has(a.flag)) {
      if (artifactExists(a)) skippedByFlag.push(a);
      continue;
    }

    // Check guard
    if (a.guard && !a.guard()) {
      if (artifactExists(a)) skippedByGuard.push(a);
      continue;
    }

    if (artifactExists(a)) {
      toRemove.push(a);
    }
  }

  const hasSettingsWork = settingsInfo.hasMcp || settingsInfo.hasHooks;

  // Print summary
  if (toRemove.length === 0 && !hasSettingsWork) {
    info("Nothing to remove — fleet is not installed (or already nuked).");
    if (skippedByFlag.length > 0) {
      console.log("");
      info("Preserved by flags:");
      for (const a of skippedByFlag) console.log(`  ${chalk.dim("-")} ${a.label}`);
    }
    return;
  }

  console.log(chalk.bold("Will remove:"));
  for (const a of toRemove) {
    const kindTag = chalk.dim(`[${a.kind}]`);
    if (a.kind === "process") {
      const pids = findProcesses(a.processPattern!);
      console.log(`  ${chalk.red("-")} ${a.label} (PIDs: ${pids.join(", ")}) ${kindTag}`);
    } else {
      console.log(`  ${chalk.red("-")} ${a.label} ${kindTag}`);
    }
  }
  if (hasSettingsWork) {
    if (settingsInfo.hasMcp) console.log(`  ${chalk.red("-")} mcpServers["worker-fleet"] in settings.json`);
    if (settingsInfo.hasHooks) console.log(`  ${chalk.red("-")} Fleet hook entries in settings.json`);
  }

  if (skippedByFlag.length > 0) {
    console.log("");
    console.log(chalk.bold("Preserved (by flag):"));
    for (const a of skippedByFlag) {
      console.log(`  ${chalk.dim("-")} ${a.label}`);
    }
  }

  if (skippedByGuard.length > 0) {
    console.log("");
    console.log(chalk.bold("Skipped (external reference):"));
    for (const a of skippedByGuard) {
      console.log(`  ${chalk.dim("-")} ${a.label} ${chalk.dim("(DEEP_REVIEW_DIR points elsewhere)")}`);
    }
  }

  console.log("");

  // Confirm
  if (!dryRun && !skipConfirm) {
    const yes = await confirm(chalk.yellow("This is destructive. Proceed?"));
    if (!yes) {
      info("Aborted.");
      return;
    }
    console.log("");
  }

  // Back up settings.json before modification
  if (hasSettingsWork) {
    if (dryRun) {
      info("Would back up settings.json before modification");
    } else {
      const backup = backupSettings();
      if (backup) ok(`Backed up settings.json → ${backup}`);
    }
  }

  // Execute removals in order: processes -> launchd -> symlinks -> settings -> data -> clones
  const order: Artifact["kind"][] = ["process", "launchd", "symlink", "dir", "file"];
  for (const kind of order) {
    for (const a of toRemove.filter((x) => x.kind === kind)) {
      removeArtifact(a, dryRun);
    }

    // Clean settings after symlinks, before data dirs
    if (kind === "symlink" && hasSettingsWork) {
      cleanSettings(dryRun);
    }
  }

  // Summary
  console.log("");
  if (dryRun) {
    info("Dry run complete — no changes made.");
    console.log(`\n  Run ${chalk.cyan("fleet nuke --all")} (without --dry-run) to execute.`);
  } else {
    ok(chalk.bold("Fleet artifacts removed."));
    console.log(`\n  Re-install: ${chalk.cyan("fleet setup")}`);
  }
}

// ============================================================
// Command registration
// ============================================================

export function register(parent: Command): void {
  const sub = parent
    .command("nuke [name]")
    .description("Destroy a worker or all fleet artifacts (--all)")
    .option("-a, --all", "Remove ALL fleet-installed artifacts (clean slate)")
    .option("--dry-run", "Show what would be removed without doing it")
    .option("-y, --yes", "Skip confirmation prompt")
    .option("--keep-data", "Preserve ~/.claude/fleet/ (--all only)")
    .option("--keep-mail", "Preserve Fleet Mail data (--all only)");
  addGlobalOpts(sub)
    .action(async (name: string | undefined, opts: {
      all?: boolean; dryRun?: boolean; yes?: boolean; keepData?: boolean; keepMail?: boolean;
    }, cmd: Command) => {
      if (opts.all) {
        await nukeAll(opts);
        return;
      }

      if (!name) {
        fail("Usage: fleet nuke <name>  or  fleet nuke --all");
      }

      const project = cmd.optsWithGlobals().project as string || resolveProject();
      await nukeWorker(name!, project, { yes: opts.yes });
    });
}
