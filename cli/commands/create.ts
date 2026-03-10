import { defineCommand } from "citty";
import { mkdirSync, writeFileSync, existsSync, readFileSync, copyFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import {
  FLEET_DATA, FLEET_DIR, FLEET_MAIL_URL, DEFAULT_SESSION,
  workerDir, resolveProjectRoot, resolveProject,
} from "../lib/paths";
import {
  getDefaults, getFleetConfig, getSystemHooks, generateLaunchSh, writeJson,
} from "../lib/config";
import { info, ok, warn, fail } from "../lib/fmt";
import { launchInTmux } from "../lib/launch";

const NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export default defineCommand({
  meta: { name: "create", description: "Create + launch worker" },
  args: {
    name:         { type: "positional", description: "Worker name (kebab-case)", required: true },
    mission:      { type: "positional", description: "Worker mission", required: true },
    model:        { type: "string", description: "Override model" },
    effort:       { type: "string", description: "Override effort" },
    "permission-mode": { type: "string", description: "Override permission mode" },
    window:       { type: "string", description: "tmux window group" },
    "window-index": { type: "string", description: "Explicit window position" },
    project:      { type: "string", description: "Override project detection" },
    type:         { type: "string", description: "Worker archetype template" },
    "no-launch":  { type: "boolean", description: "Create only, don't launch", default: false },
    json:         { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    const name = args.name;
    if (!NAME_RE.test(name)) fail(`Name must be kebab-case: ${name}`);

    const projectRoot = resolveProjectRoot();
    const project = args.project || resolveProject(projectRoot);
    const dir = workerDir(project, name);

    if (existsSync(dir)) fail(`Worker '${name}' already exists in project '${project}'`);

    // Resolve config: CLI > type template > defaults > hardcoded
    const defaults = getDefaults();
    const model = args.model || String(defaults.model || "opus");
    const effort = args.effort || String(defaults.effort || "high");
    const perm = args["permission-mode"] || String(defaults.permission_mode || "bypassPermissions");
    let sleepDuration: number | null = null;

    // Apply type template
    if (args.type) {
      const typeFile = join(FLEET_DIR, "templates/flat-worker/types", args.type, "defaults.json");
      if (existsSync(typeFile)) {
        try {
          const tmpl = JSON.parse(readFileSync(typeFile, "utf-8"));
          if (tmpl.sleep_duration != null) sleepDuration = tmpl.sleep_duration;
        } catch { /* ignore */ }
      } else {
        warn(`Unknown type: ${args.type} (using defaults)`);
      }
    }

    const window = args.window || name;
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
    const config = {
      model,
      reasoning_effort: effort,
      permission_mode: perm,
      sleep_duration: sleepDuration,
      window,
      worktree: worktreeDir,
      branch,
      mcp: {},
      hooks: getSystemHooks(),
      meta: {
        created_at: new Date().toISOString(),
        created_by: "fleet-cli",
        forked_from: null,
        project,
      },
    };
    writeJson(join(dir, "config.json"), config);

    // 3. Write state.json
    writeJson(join(dir, "state.json"), { status: "idle" });

    // 4. Write mission.md
    writeFileSync(join(dir, "mission.md"), args.mission + "\n");

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

    // 6. Symlink .mcp.json
    const mcpSrc = join(projectRoot, ".mcp.json");
    if (existsSync(mcpSrc) && projectRoot !== worktreeDir) {
      Bun.spawnSync(["rm", "-f", join(worktreeDir, ".mcp.json")]);
      Bun.spawnSync(["ln", "-sf", mcpSrc, join(worktreeDir, ".mcp.json")]);
    }

    // 7. Symlink untracked files (.env, users.json)
    for (const f of [".env", "data/users.json"]) {
      const src = join(projectRoot, f);
      const dst = join(worktreeDir, f);
      if (existsSync(src) && !existsSync(dst)) {
        mkdirSync(dirname(dst), { recursive: true });
        Bun.spawnSync(["ln", "-sf", src, dst]);
      }
    }

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
    try {
      const resp = await fetch(`${FLEET_MAIL_URL}/api/accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `${name}@${project}` }),
      });
      if (resp.ok) {
        const data = await resp.json() as { token?: string };
        mailToken = data.token || "";
      }
    } catch { /* non-fatal */ }

    if (mailToken) {
      writeFileSync(join(dir, "token"), mailToken);
      ok("Fleet Mail provisioned");
    } else {
      warn("Fleet Mail provisioning failed (worker will use MCP fallback)");
      writeFileSync(join(dir, "token"), "");
    }

    // 10. Generate launch.sh
    generateLaunchSh(project, name);
    ok("launch.sh generated");

    if (args["no-launch"]) {
      ok(`Worker '${name}' created (--no-launch: skipping tmux launch)`);
      console.log(`\n  Directory: ${dir}\n  Worktree:  ${worktreeDir}\n  Branch:    ${branch}\n`);
      console.log(`  To launch: fleet start ${name}`);
      return;
    }

    // 11. Launch in tmux
    const windowIndex = args["window-index"] ? parseInt(args["window-index"], 10) : undefined;
    await launchInTmux(name, project, tmuxSession, window, windowIndex);
  },
});
