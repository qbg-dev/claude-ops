import type { Command } from "commander";
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { FLEET_DIR, FLEET_DATA, FLEET_MAIL_URL, FLEET_MAIL_TOKEN } from "../lib/paths";
import { ok, info, warn, fail } from "../lib/fmt";
import { startLocalServer } from "./mail-server";

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
        const shell = process.env.SHELL || "";
        let rcFile: string | null = null;
        if (shell.endsWith("/zsh")) rcFile = join(HOME, ".zshrc");
        else if (shell.endsWith("/bash")) rcFile = join(HOME, ".bashrc");

        if (rcFile) {
          const rcContent = existsSync(rcFile) ? readFileSync(rcFile, "utf-8") : "";
          if (rcContent.includes(".local/bin") && rcContent.includes("PATH")) {
            ok(`PATH entry already in ${rcFile} (restart shell to pick up)`);
          } else {
            appendFileSync(rcFile, '\n# Added by fleet setup\nexport PATH="$HOME/.local/bin:$PATH"\n');
            ok(`Added ~/.local/bin to PATH in ${rcFile}`);
            console.log(`    Restart shell or: source ${rcFile}`);
          }
        } else {
          warn(`${HOME}/.local/bin is not in PATH (${shell || "unknown"} shell — add manually)`);
          console.log(`    Add to your shell rc: export PATH="$HOME/.local/bin:$PATH"`);
        }
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

      // 6. Install dependencies
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

      // 7. Fleet Mail (required — auto-start if not configured)
      info("Fleet Mail...");
      let resolvedMailUrl: string | null = FLEET_MAIL_URL;

      if (FLEET_MAIL_URL) {
        // Already configured — verify reachable
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
          fail("Fleet Mail is configured but unreachable. Check the server and re-run: fleet setup");
        }
        if (FLEET_MAIL_TOKEN) {
          ok(`Admin token: ${FLEET_MAIL_TOKEN.slice(0, 8)}...`);
        }
      } else {
        // Not configured — auto-start local server
        info("No Fleet Mail configured — starting local server...");
        try {
          const result = await startLocalServer({ quiet: true });
          resolvedMailUrl = result.url;
          ok(`Fleet Mail auto-started: ${result.url}`);
          ok(`Admin token: ${result.token.slice(0, 8)}...`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.log(`  ${chalk.red("✗")} ${msg}`);
          console.log("");
          console.log(`  Fleet Mail is required for worker coordination.`);
          console.log(`  ${chalk.cyan("Install boring-mail:")}  cargo install --git https://github.com/qbg-dev/boring-mail-server boring-mail`);
          console.log(`  ${chalk.cyan("Or connect remote:")}    fleet mail-server connect http://your-server:8025`);
          console.log("");
          fail("Install boring-mail or connect to a remote server, then re-run: fleet setup");
        }
      }

      // 8. Register MCP server (after Fleet Mail so FLEET_MAIL_URL is available)
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
        if (resolvedMailUrl) mcpEnv.FLEET_MAIL_URL = resolvedMailUrl;
        settings.mcpServers["worker-fleet"] = {
          command: bunPath,
          args: ["run", mcpScript],
          env: mcpEnv,
        };
        writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
        ok("MCP server registered in settings.json");

        // Verify MCP server can start (catch missing deps / syntax errors)
        info("Verifying MCP server...");
        const mcpEnvForVerify: Record<string, string> = {
          ...process.env as Record<string, string>,
        };
        if (resolvedMailUrl) mcpEnvForVerify.FLEET_MAIL_URL = resolvedMailUrl;
        const mcpProc = Bun.spawn([bunPath, "run", mcpScript], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: mcpEnvForVerify,
        });
        await Bun.sleep(2000);
        if (mcpProc.exitCode !== null && mcpProc.exitCode !== 0) {
          const stderrText = await new Response(mcpProc.stderr).text();
          const firstLine = stderrText.split("\n").filter(l => l.trim())[0] || "unknown error";
          warn(`MCP server exited with code ${mcpProc.exitCode}: ${firstLine}`);
          console.log(`    Try: cd ${join(FLEET_DIR, "mcp/worker-fleet")} && bun install`);
        } else {
          mcpProc.kill();
          ok("MCP server verified (starts cleanly)");
        }
        console.log(`    ${chalk.dim("Restart Claude Code to pick up MCP server changes")}`);
      }

      // 9. Plugins
      info("Detecting plugins...");

      // Watchdog plugin
      const watchdogPlugin = join(FLEET_DIR, "extensions/watchdog/watchdog.sh");
      if (existsSync(watchdogPlugin)) {
        const watchdogPlist = join(HOME, "Library/LaunchAgents/com.tmux-agents.watchdog.plist");
        const legacyPlist = join(HOME, "Library/LaunchAgents/com.claude-ops.harness-watchdog.plist");
        if (existsSync(watchdogPlist) || existsSync(legacyPlist)) {
          ok("Watchdog plugin: installed (launchd daemon active)");
        } else {
          warn("Watchdog plugin: found but not installed as daemon");
          console.log(`    Install: bash ${join(FLEET_DIR, "extensions/watchdog/install.sh")}`);
        }
      } else {
        info("Watchdog plugin: not found (optional — supervises long-running workers)");
      }

      // Deep review
      const deepReviewDir = process.env.DEEP_REVIEW_DIR || join(HOME, ".deep-review");
      if (existsSync(join(deepReviewDir, "scripts/deep-review.sh"))) {
        ok(`Deep review: ${deepReviewDir}`);
      } else if (existsSync(join(FLEET_DIR, "scripts/deep-review.sh"))) {
        ok("Deep review: bundled (in fleet repo)");
      } else {
        info("Deep review: not found (optional — multi-pass adversarial code review)");
      }

      // Claude hooks
      const hooksDir = process.env.CLAUDE_HOOKS_DIR || join(HOME, ".claude-hooks");
      if (existsSync(join(hooksDir, "hooks/manifest.json"))) {
        ok(`Claude hooks: ${hooksDir}`);
      } else if (existsSync(join(FLEET_DIR, "hooks/manifest.json"))) {
        ok("Claude hooks: bundled (in fleet repo)");
      } else {
        info("Claude hooks: not found (optional — runtime hook injection)");
      }

      console.log("");
      ok("Fleet setup complete!");
      console.log("");
      console.log("  fleet ls                    — list workers");
      console.log(`  fleet create <n> "m"        — create a worker`);
      console.log("  fleet help                  — all commands");
    });
}
