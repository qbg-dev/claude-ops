import { defineCommand } from "citty";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { FLEET_DIR, FLEET_DATA, FLEET_MAIL_URL } from "../lib/paths";
import { ok, info, warn, fail } from "../lib/fmt";

export default defineCommand({
  meta: { name: "setup", description: "Bootstrap fleet infrastructure" },
  args: {},
  async run() {
    console.log(`${chalk.bold("fleet setup")} — bootstrapping fleet infrastructure\n`);

    let errors = 0;
    const HOME = process.env.HOME || "/tmp";

    // 1. Check dependencies
    info("Checking dependencies...");
    for (const tool of ["bun", "tmux"]) {
      const result = Bun.spawnSync(["which", tool], { stderr: "pipe" });
      if (result.exitCode === 0) {
        ok(`${tool} → ${result.stdout.toString().trim()}`);
      } else {
        console.log(`  ${chalk.red("✗")} ${tool} not found`);
        if (tool === "bun") console.log("    Install: curl -fsSL https://bun.sh/install | bash");
        if (tool === "tmux") console.log("    Install: brew install tmux");
        errors++;
      }
    }

    if (errors > 0) fail("Install missing tools above, then re-run: fleet setup");

    // 2. Resolve fleet repo
    if (!existsSync(FLEET_DIR)) {
      fail(`Fleet repo not found at ${FLEET_DIR}. Clone it first:\n  git clone <repo-url> ~/.claude-fleet`);
    }
    ok(`Fleet repo: ${FLEET_DIR}`);

    // 3. Symlinks
    info("Setting up symlinks...");
    const realDir = Bun.spawnSync(["realpath", FLEET_DIR], { stderr: "pipe" })
      .stdout.toString().trim() || FLEET_DIR;

    if (!existsSync(join(HOME, ".claude-fleet"))) {
      Bun.spawnSync(["ln", "-sfn", realDir, join(HOME, ".claude-fleet")]);
      ok(`Created ~/.claude-fleet → ${realDir}`);
    } else {
      ok("~/.claude-fleet exists");
    }

    if (!existsSync(join(HOME, ".claude-ops"))) {
      Bun.spawnSync(["ln", "-sfn", realDir, join(HOME, ".claude-ops")]);
      ok("Created ~/.claude-ops → (compat)");
    } else {
      ok("~/.claude-ops exists");
    }

    mkdirSync(join(HOME, ".claude"), { recursive: true });
    Bun.spawnSync(["ln", "-sfn", join(HOME, ".claude-fleet"), join(HOME, ".claude/ops")]);
    ok("~/.claude/ops → ~/.claude-fleet");

    mkdirSync(join(HOME, ".local/bin"), { recursive: true });
    Bun.spawnSync(["ln", "-sf", join(HOME, ".claude-fleet/bin/fleet"), join(HOME, ".local/bin/fleet")]);
    ok("Symlinked ~/.local/bin/fleet");

    if (!process.env.PATH?.includes(`${HOME}/.local/bin`)) {
      warn(`${HOME}/.local/bin is not in PATH`);
      console.log(`    Add to your shell rc: export PATH="$HOME/.local/bin:$PATH"`);
    }

    // 4. Data directory
    mkdirSync(FLEET_DATA, { recursive: true });
    ok(`Fleet data dir: ${FLEET_DATA}`);

    // 5. defaults.json
    const defaultsFile = join(FLEET_DATA, "defaults.json");
    if (!existsSync(defaultsFile)) {
      writeFileSync(defaultsFile, JSON.stringify({
        model: "opus",
        effort: "high",
        permission_mode: "bypassPermissions",
        sleep_duration: null,
      }, null, 2) + "\n");
      ok("Created defaults.json");
    } else {
      ok("defaults.json exists");
    }

    // 6. Register MCP server
    info("Registering MCP server...");
    const settingsFile = join(HOME, ".claude/settings.json");
    const mcpScript = join(FLEET_DIR, "mcp/worker-fleet/index.ts");
    const bunPath = Bun.spawnSync(["which", "bun"]).stdout.toString().trim();

    if (!existsSync(mcpScript)) {
      warn("MCP server script not found — skipping registration");
    } else {
      let settings: Record<string, any> = {};
      if (existsSync(settingsFile)) {
        try { settings = JSON.parse(readFileSync(settingsFile, "utf-8")); } catch {}
      }
      if (!settings.mcpServers) settings.mcpServers = {};
      settings.mcpServers["worker-fleet"] = {
        command: bunPath,
        args: ["run", mcpScript],
        env: { FLEET_MAIL_URL },
      };
      writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
      ok("MCP server registered in settings.json");
    }

    // 7. Install dependencies
    const pkgJson = join(FLEET_DIR, "package.json");
    if (existsSync(pkgJson)) {
      info("Installing dependencies...");
      const install = Bun.spawnSync(["bun", "install"], { cwd: FLEET_DIR, stderr: "pipe" });
      if (install.exitCode === 0) {
        ok("Dependencies installed");
      } else {
        warn("bun install failed (non-fatal)");
      }
    }

    console.log("");
    ok("Fleet setup complete!");
    console.log("");
    console.log("  fleet ls              — list workers");
    console.log(`  fleet create <n> "m" — create a worker`);
    console.log("  fleet help            — all commands");
  },
});
