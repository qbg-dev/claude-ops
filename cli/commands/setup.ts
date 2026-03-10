import type { Command } from "commander";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { FLEET_DIR, FLEET_DATA, FLEET_MAIL_URL, FLEET_MAIL_TOKEN } from "../lib/paths";
import { ok, info, warn, fail } from "../lib/fmt";

export function register(parent: Command): void {
  parent
    .command("setup")
    .description("Bootstrap fleet infrastructure")
    .action(async () => {
      console.log(`${chalk.bold("fleet setup")} — bootstrapping fleet infrastructure\n`);

      let errors = 0;
      const HOME = process.env.HOME || "/tmp";

      // 1. Check dependencies
      info("Checking dependencies...");
      const deps: Array<{ name: string; hint: string }> = [
        { name: "bun", hint: "curl -fsSL https://bun.sh/install | bash" },
        { name: "tmux", hint: "brew install tmux" },
        { name: "claude", hint: "https://docs.anthropic.com/en/docs/claude-code" },
      ];
      for (const { name, hint } of deps) {
        const result = Bun.spawnSync(["which", name], { stderr: "pipe" });
        if (result.exitCode === 0) {
          ok(`${name} → ${result.stdout.toString().trim()}`);
        } else {
          console.log(`  ${chalk.red("✗")} ${name} not found`);
          console.log(`    Install: ${hint}`);
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
        const mcpEnv: Record<string, string> = {};
        if (FLEET_MAIL_URL) mcpEnv.FLEET_MAIL_URL = FLEET_MAIL_URL;
        settings.mcpServers["worker-fleet"] = {
          command: bunPath,
          args: ["run", mcpScript],
          env: mcpEnv,
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

      // 8. Fleet Mail (required)
      info("Fleet Mail...");
      if (FLEET_MAIL_URL) {
        let mailOk = false;
        try {
          const resp = await fetch(`${FLEET_MAIL_URL}/health`, { signal: AbortSignal.timeout(3000) });
          if (resp.ok) {
            ok(`Fleet Mail: ${FLEET_MAIL_URL} ${chalk.green("(reachable)")}`);
            mailOk = true;
          } else {
            console.log(`  ${chalk.red("✗")} Fleet Mail: ${FLEET_MAIL_URL} (returned ${resp.status})`);
          }
        } catch {
          console.log(`  ${chalk.red("✗")} Fleet Mail: ${FLEET_MAIL_URL} (unreachable)`);
        }
        if (!mailOk) {
          fail("Fleet Mail is required but unreachable. Check the server and re-run: fleet setup");
        }
        if (FLEET_MAIL_TOKEN) {
          ok(`Admin token: ${FLEET_MAIL_TOKEN.slice(0, 8)}...`);
        }
      } else {
        console.log(`  ${chalk.red("✗")} Fleet Mail not configured`);
        console.log("");
        console.log(`  Fleet Mail is required for worker coordination.`);
        console.log(`  ${chalk.cyan("fleet mail-server start")}       — start a local server`);
        console.log(`  ${chalk.cyan("fleet mail-server connect <url>")} — connect to a remote server`);
        console.log("");
        fail("Configure Fleet Mail, then re-run: fleet setup");
      }

      console.log("");
      ok("Fleet setup complete!");
      console.log("");
      console.log("  fleet ls                    — list workers");
      console.log(`  fleet create <n> "m"        — create a worker`);
      console.log("  fleet help                  — all commands");
    });
}
