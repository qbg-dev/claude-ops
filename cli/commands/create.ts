import type { Command } from "commander";
import { mkdirSync, writeFileSync, existsSync, readFileSync, copyFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import {
  FLEET_DATA, FLEET_DIR, FLEET_MAIL_URL, FLEET_MAIL_TOKEN, DEFAULT_SESSION,
  workerDir, resolveProjectRoot, resolveProject,
} from "../lib/paths";
import {
  getDefaults, getFleetConfig, getSystemHooks, generateLaunchSh, writeJsonLocked,
} from "../lib/config";
import { info, ok, warn, fail, hintOnboard } from "../lib/fmt";
import { launchInTmux } from "../lib/launch";
import { syncWorktree } from "../lib/worktree";
import { addGlobalOpts } from "../index";

const NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export interface CreateOpts {
  model?: string;
  effort?: string;
  permissionMode?: string;
  window?: string;
  windowIndex?: string;
  type?: string;
  noLaunch?: boolean;
}

export async function runCreate(
  name: string,
  mission: string,
  opts: CreateOpts,
  globalOpts: Record<string, unknown>,
): Promise<void> {
  if (!NAME_RE.test(name)) fail(`Name must be kebab-case: ${name}`);

  // Hint: suggest onboarding if fleet.json doesn't exist yet
  const projectForHint = (globalOpts.project as string) || resolveProject();
  hintOnboard(projectForHint);

  // Support @filename syntax: read mission from file
  if (mission.startsWith("@")) {
    const missionPath = mission.slice(1);
    if (!existsSync(missionPath)) fail(`Mission file not found: ${missionPath}`);
    mission = readFileSync(missionPath, "utf-8").trim();
    if (!mission) fail(`Mission file is empty: ${missionPath}`);
  }

  const projectRoot = resolveProjectRoot();
  const project = (globalOpts.project as string) || resolveProject(projectRoot);
  const dir = workerDir(project, name);

  if (existsSync(dir)) fail(`Worker '${name}' already exists in project '${project}'`);

  // Resolve config: CLI > type template > defaults > hardcoded
  const defaults = getDefaults();
  const model = opts.model || String(defaults.model || "opus[1m]");
  const runtime = (opts.runtime || String(defaults.runtime || "claude")) as "claude" | "codex";
  const effort = opts.effort || String(defaults.effort || "high");
  const perm = opts.permissionMode || String(defaults.permission_mode || "bypassPermissions");
  let sleepDuration: number | null = null;

  // Apply type template
  if (opts.type) {
    const typeFile = join(FLEET_DIR, "templates/flat-worker/types", opts.type, "defaults.json");
    if (existsSync(typeFile)) {
      try {
        const tmpl = JSON.parse(readFileSync(typeFile, "utf-8"));
        if ("sleep_duration" in tmpl) sleepDuration = tmpl.sleep_duration;
      } catch { /* ignore */ }
    } else {
      warn(`Unknown type: ${opts.type} (using defaults)`);
    }
  }

  const window = opts.window || name;
  const projectBasename = basename(projectRoot).replace(/-w-.*$/, "");
  const worktreeDir = join(dirname(projectRoot), `${projectBasename}-w-${name}`);
  const branch = `worker/${name}`;

  // Read tmux session from fleet.json
  const fleetConfig = getFleetConfig(project);
  const tmuxSession = fleetConfig?.tmux_session || DEFAULT_SESSION;

  info(`Creating worker '${name}' in project '${project}'`);

  // 1. Create directory
  mkdirSync(dir, { recursive: true });

  // 2. Write config.json
  // Merge system hooks + per-type hooks from fleet.json
  const allHooks = [...getSystemHooks()];
  if (opts.type && fleetConfig?.hooks_by_type?.[opts.type]) {
    const typeHooks = fleetConfig.hooks_by_type[opts.type];
    for (let i = 0; i < typeHooks.length; i++) {
      allHooks.push({
        ...typeHooks[i],
        id: `type-${i + 1}`,
        owner: "creator" as const,
      });
    }
  }

  const config = {
    model,
    reasoning_effort: effort,
    permission_mode: perm,
    sleep_duration: sleepDuration ?? null,
    window,
    worktree: worktreeDir,
    branch,
    mcp: {},
    hooks: allHooks,
    meta: {
      created_at: new Date().toISOString(),
      created_by: "fleet-cli",
      forked_from: null,
      project,
    },
  };
  writeJsonLocked(join(dir, "config.json"), config);

  // 3. Write state.json
  writeJsonLocked(join(dir, "state.json"), { status: "idle" });

  // 4. Write mission.md
  writeFileSync(join(dir, "mission.md"), mission + "\n");

  // Symlink mission to legacy missions/ dir
  const missionsDir = join(FLEET_DATA, project, "missions");
  mkdirSync(missionsDir, { recursive: true });
  try {
    const target = `../${name}/mission.md`;
    const link = join(missionsDir, `${name}.md`);
    if (existsSync(link)) Bun.spawnSync(["rm", "-f", link]);
    Bun.spawnSync(["ln", "-sf", target, link]);
  } catch { /* non-fatal */ }

  ok("Config written");

  // 5. Create git worktree
  if (!existsSync(worktreeDir)) {
    info(`Creating worktree at ${worktreeDir} (branch: ${branch})`);
    let result = Bun.spawnSync(["git", "-C", projectRoot, "worktree", "add", worktreeDir, branch], { stderr: "pipe" });
    if (result.exitCode !== 0) {
      result = Bun.spawnSync(["git", "-C", projectRoot, "worktree", "add", worktreeDir, "-b", branch], { stderr: "pipe" });
    }
    if (result.exitCode !== 0) fail("Failed to create worktree");
    ok("Worktree created");
  } else {
    info(`Worktree already exists: ${worktreeDir}`);
  }

  // 6. Ensure parent repo .mcp.json includes claude-hooks, then symlink to worktree
  // NOTE: worker-fleet MCP is deprecated — workers use fleet CLI for communication.
  const mcpSrc = join(projectRoot, ".mcp.json");
  const bunPath = process.execPath || join(process.env.HOME || "", ".bun/bin/bun");

  let mcpConfig: Record<string, any> = { mcpServers: {} };
  if (existsSync(mcpSrc)) {
    try {
      mcpConfig = JSON.parse(readFileSync(mcpSrc, "utf-8"));
      if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
    } catch {
      mcpConfig = { mcpServers: {} };
    }
  }

  // Remove legacy worker-fleet MCP if present
  let needsUpdate = false;
  if (mcpConfig.mcpServers["worker-fleet"]) {
    delete mcpConfig.mcpServers["worker-fleet"];
    needsUpdate = true;
  }

  // Add claude-hooks MCP for standalone hook management per worker
  const claudeHooksDir = process.env.CLAUDE_HOOKS_DIR || join(process.env.HOME || "", ".claude-hooks");
  const claudeHooksMcp = join(claudeHooksDir, "mcp/index.ts");
  if (existsSync(claudeHooksMcp)) {
    const hooksDir = join(FLEET_DATA, project, name, "hooks");
    const permsPath = join(projectRoot, ".claude/workers", name, "permissions.json");
    const existingHooks = mcpConfig.mcpServers["claude-hooks"];
    const hooksEntry = {
      command: bunPath,
      args: ["run", claudeHooksMcp],
      env: {
        HOOKS_DIR: hooksDir,
        HOOKS_IDENTITY: name,
        HOOKS_PERMISSIONS: permsPath,
      },
    };
    if (!existingHooks || JSON.stringify(existingHooks) !== JSON.stringify(hooksEntry)) {
      mcpConfig.mcpServers["claude-hooks"] = hooksEntry;
      needsUpdate = true;
    }
  }

  if (needsUpdate) {
    writeFileSync(mcpSrc, JSON.stringify(mcpConfig, null, 2) + "\n");
    info("Updated MCP servers in .mcp.json");
  }

  if (projectRoot !== worktreeDir) {
    Bun.spawnSync(["rm", "-f", join(worktreeDir, ".mcp.json")]);
    Bun.spawnSync(["ln", "-sf", mcpSrc, join(worktreeDir, ".mcp.json")]);
  }

  // 7. Sync all worktree files (mission, .mcp.json, .env, scripts, permissions)
  syncWorktree({ name, project, projectRoot, worktreeDir });

  // 8. Install git hooks in worktree
  try {
    const gitDirResult = Bun.spawnSync(
      ["git", "-C", worktreeDir, "rev-parse", "--absolute-git-dir"],
      { stderr: "pipe" },
    );
    if (gitDirResult.exitCode === 0) {
      const gitDir = gitDirResult.stdout.toString().trim();
      const hooksDir = join(gitDir, "hooks");
      mkdirSync(hooksDir, { recursive: true });

      for (const hookName of ["post-commit", "commit-msg"]) {
        let hookSrc = join(projectRoot, `.claude/scripts/worker-${hookName}-hook.sh`);
        if (!existsSync(hookSrc)) hookSrc = join(FLEET_DIR, `scripts/worker-${hookName}-hook.sh`);
        if (existsSync(hookSrc)) {
          copyFileSync(hookSrc, join(hooksDir, hookName));
          Bun.spawnSync(["chmod", "+x", join(hooksDir, hookName)]);
        }
      }
    }
  } catch { /* non-fatal */ }

  ok("Worktree configured");

  // 9. Provision Fleet Mail
  let mailToken = "";
  if (FLEET_MAIL_URL) {
    // Auto-start local boring-mail if URL is localhost and server isn't responding
    if (FLEET_MAIL_URL.includes("localhost") || FLEET_MAIL_URL.includes("127.0.0.1")) {
      try {
        await fetch(`${FLEET_MAIL_URL}/health`, { signal: AbortSignal.timeout(1000) });
      } catch {
        const bmPath = join(process.env.HOME || "", ".cargo/bin/boring-mail");
        if (existsSync(bmPath)) {
          info("Starting local boring-mail...");
          Bun.spawn([bmPath, "serve"], { stdio: ["ignore", "ignore", "ignore"] });
          // Wait up to 3s for it to be ready
          for (let i = 0; i < 6; i++) {
            await new Promise(r => setTimeout(r, 500));
            try { await fetch(`${FLEET_MAIL_URL}/health`, { signal: AbortSignal.timeout(500) }); break; } catch {}
          }
        }
      }
    }

    const accountName = `${name}@${project}`;
    const mailHeaders: Record<string, string> = { "Content-Type": "application/json" };
    if (FLEET_MAIL_TOKEN) mailHeaders["Authorization"] = `Bearer ${FLEET_MAIL_TOKEN}`;

    try {
      // Try creating the account
      const resp = await fetch(`${FLEET_MAIL_URL}/api/accounts`, {
        method: "POST",
        headers: mailHeaders,
        body: JSON.stringify({ name: accountName }),
      });

      if (resp.ok) {
        const data = await resp.json() as { bearerToken?: string; token?: string };
        mailToken = data.bearerToken || data.token || "";
      } else if (resp.status === 409 && FLEET_MAIL_TOKEN) {
        // Account exists — reset its token via admin endpoint
        const resetResp = await fetch(
          `${FLEET_MAIL_URL}/api/admin/accounts/${encodeURIComponent(accountName)}/reset-token`,
          { method: "POST", headers: { "Authorization": `Bearer ${FLEET_MAIL_TOKEN}` } },
        );
        if (resetResp.ok) {
          const data = await resetResp.json() as { bearerToken?: string; token?: string };
          mailToken = data.bearerToken || data.token || "";
        }
      }
    } catch { /* non-fatal */ }

    if (mailToken) {
      writeFileSync(join(dir, "token"), mailToken);
      ok("Fleet Mail provisioned");
    } else {
      warn("Fleet Mail provisioning failed — mail_send/mail_inbox won't work until fixed");
      writeFileSync(join(dir, "token"), "");
    }
  } else {
    info("Fleet Mail not configured — run: fleet mail-server connect <url>");
    writeFileSync(join(dir, "token"), "");
  }

  // 10. Generate launch.sh
  generateLaunchSh(project, name);
  ok("launch.sh generated");

  if (opts.noLaunch) {
    ok(`Worker '${name}' created (--no-launch: skipping tmux launch)`);
    console.log(`\n  Directory: ${dir}\n  Worktree:  ${worktreeDir}\n  Branch:    ${branch}\n`);
    console.log(`  To launch: fleet start ${name}`);
    return;
  }

  // 11. Launch in tmux
  const windowIndex = opts.windowIndex ? parseInt(opts.windowIndex, 10) : undefined;
  await launchInTmux(name, project, tmuxSession, window, windowIndex);
}

export function register(parent: Command): void {
  const sub = parent
    .command("create <name> <mission>")
    .description("Create and launch a worker")
    .option("--model <model>", "Override model")
    .option("--effort <effort>", "Override effort")
    .option("--permission-mode <mode>", "Override permission mode")
    .option("--window <name>", "tmux window group")
    .option("--window-index <index>", "Explicit window position")
    .option("--type <type>", "Worker archetype template")
    .option("--no-launch", "Create only, don't launch");
  addGlobalOpts(sub)
    .action(async (name: string, mission: string, opts: {
      model?: string; effort?: string; permissionMode?: string;
      window?: string; windowIndex?: string; type?: string; launch?: boolean;
    }, cmd: Command) => {
      await runCreate(name, mission, {
        model: opts.model,
        effort: opts.effort,
        permissionMode: opts.permissionMode,
        window: opts.window,
        windowIndex: opts.windowIndex,
        type: opts.type,
        noLaunch: opts.launch === false,
      }, cmd.optsWithGlobals());
    });
}
