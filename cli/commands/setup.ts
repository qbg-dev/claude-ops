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

      // 2. Resolve fleet repo — prefer the repo we're running from
      let fleetDir = FLEET_DIR;
      if (!existsSync(fleetDir)) {
        // We might be running directly from the repo (e.g., bun run cli/index.ts setup)
        // Detect repo root from this script's location
        const scriptDir = import.meta.dir; // cli/commands/
        const repoRoot = join(scriptDir, "../.."); // repo root
        if (existsSync(join(repoRoot, "cli/index.ts")) && existsSync(join(repoRoot, "mcp/worker-fleet/index.ts"))) {
          fleetDir = repoRoot;
        } else {
          fail(`Fleet repo not found at ${fleetDir}. Clone it first:\n  git clone https://github.com/qbg-dev/claude-fleet.git ~/.claude-fleet`);
        }
      }
      ok(`Fleet repo: ${fleetDir}`);

      // 3. Symlinks
      info("Setting up symlinks...");
      const realDir = Bun.spawnSync(["realpath", fleetDir], { stderr: "pipe" })
        .stdout.toString().trim() || fleetDir;

      if (!existsSync(join(HOME, ".claude-fleet"))) {
        Bun.spawnSync(["ln", "-sfn", realDir, join(HOME, ".claude-fleet")]);
        ok(`Created ~/.claude-fleet → ${realDir}`);
      } else {
        ok("~/.claude-fleet exists");
      }

      if (!existsSync(join(HOME, ".claude-fleet"))) {
        Bun.spawnSync(["ln", "-sfn", realDir, join(HOME, ".claude-fleet")]);
        ok("Created ~/.claude-fleet → (compat)");
      } else {
        ok("~/.claude-fleet exists");
      }

      mkdirSync(join(HOME, ".claude"), { recursive: true });
      Bun.spawnSync(["ln", "-sfn", join(HOME, ".claude-fleet"), join(HOME, ".claude/ops")]);
      ok("~/.claude/ops → ~/.claude-fleet");

      if (!existsSync(join(HOME, ".tmux-agents"))) {
        Bun.spawnSync(["ln", "-sfn", realDir, join(HOME, ".tmux-agents")]);
        ok("Created ~/.tmux-agents → (compat)");
      } else {
        ok("~/.tmux-agents exists");
      }

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
      const pkgJson = join(fleetDir, "package.json");
      if (existsSync(pkgJson)) {
        info("Installing dependencies...");
        const install = Bun.spawnSync(["bun", "install"], { cwd: fleetDir, stderr: "pipe" });
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
          fail(`Fleet Mail at ${FLEET_MAIL_URL} is unreachable. Is the server running?\n\n  Check status:  fleet mail-server status\n  Reconnect:     fleet mail-server connect <url>\n  Start local:   fleet mail-server start`);
        }
        if (FLEET_MAIL_TOKEN) {
          ok(`Admin token: ${FLEET_MAIL_TOKEN.slice(0, 8)}...`);
        }
      } else {
        // Not configured — try to auto-start local server
        info("No Fleet Mail configured — attempting to auto-start local server...");
        try {
          const result = await startLocalServer({ quiet: true });
          resolvedMailUrl = result.url;
          ok(`Fleet Mail auto-started: ${result.url}`);
          ok(`Admin token: ${result.token.slice(0, 8)}...`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.log(`  ${chalk.red("✗")} Auto-start failed: ${msg}`);
          console.log("");
          console.log(`  Fleet Mail is required for worker coordination.`);
          console.log("");
          console.log(`  ${chalk.cyan("Connect to a remote server:")}`);
          console.log(`    fleet mail-server connect http://your-server:8026`);
          console.log("");
          fail("Set up Fleet Mail via one of the paths above, then re-run: fleet setup");
        }
      }

      // 8. Register MCP server (after Fleet Mail so FLEET_MAIL_URL is available)
      info("Registering MCP server...");
      const settingsFile = join(HOME, ".claude/settings.json");
      const mcpScript = join(fleetDir, "mcp/worker-fleet/index.ts");
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

        // Register claude-hooks MCP server (standalone hook management)
        const claudeHooksDir = process.env.CLAUDE_HOOKS_DIR || join(HOME, ".claude-hooks");
        const claudeHooksMcp = join(claudeHooksDir, "mcp/index.ts");
        if (existsSync(claudeHooksMcp)) {
          settings.mcpServers["claude-hooks"] = {
            command: bunPath,
            args: ["run", claudeHooksMcp],
            env: {
              HOOKS_DIR: join(HOME, ".claude/hooks"),
              HOOKS_IDENTITY: "operator",
            },
          };
          ok("claude-hooks MCP registered in settings.json");
        } else {
          info("claude-hooks not found — skipping (optional, install at ~/.claude-hooks)");
        }

        writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
        ok("MCP servers registered in settings.json");

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
          console.log(`    Try: cd ${join(fleetDir, "mcp/worker-fleet")} && bun install`);
        } else {
          mcpProc.kill();
          ok("MCP server verified (starts cleanly)");
        }
        console.log(`    ${chalk.dim("Restart Claude Code to pick up MCP server changes")}`);
      }

      // 9. Install hooks into settings.json
      info("Installing hooks...");
      {
        let settings: Record<string, any> = {};
        if (existsSync(settingsFile)) {
          try { settings = JSON.parse(readFileSync(settingsFile, "utf-8")); } catch {}
        }

        // Back up settings before modifying hooks
        const backupDir = join(HOME, ".claude/settings-backups");
        mkdirSync(backupDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        writeFileSync(join(backupDir, `settings.${ts}.json`), JSON.stringify(settings, null, 2) + "\n");

        // Build fleet hooks from bundled scripts
        const fleetBase = join(HOME, ".claude-fleet");
        type HookEntry = { hooks: Array<{ type: string; command: string; timeout?: number }> };

        // Preserve non-fleet hooks (e.g., pii-firewall from project-specific configs)
        const isFleetHook = (entry: HookEntry) =>
          entry.hooks?.some((h: any) =>
            h.command?.includes("/.claude-fleet/") ||
            h.command?.includes("/.claude-hooks/") ||
            h.command?.includes("/.tmux-agents/") ||
            (h.command?.includes("bun run") && h.command?.includes("/engine/")));

        const existingHooks: Record<string, HookEntry[]> = settings.hooks || {};
        const preservedHooks: Record<string, HookEntry[]> = {};
        for (const [event, entries] of Object.entries(existingHooks)) {
          const kept = (entries as HookEntry[]).filter(e => !isFleetHook(e));
          if (kept.length > 0) preservedHooks[event] = kept;
        }

        // Define fleet hooks — individual hooks + engine on every event
        const h = (script: string, timeout?: number) => ({
          hooks: [{ type: "command" as const, command: `bash ${fleetBase}/${script}`, ...(timeout ? { timeout } : {}) }],
        });
        const engine = {
          hooks: [{ type: "command" as const, command: `bun run ${fleetBase}/engine/hook-engine.ts` }],
        };
        const logger = h("engine/session-logger.sh");

        const fleetHooks: Record<string, HookEntry[]> = {
          UserPromptSubmit: [
            h("hooks/publishers/worker-session-register.sh"),
            h("hooks/publishers/prompt-echo-deferred.sh"),
            engine,
            logger,
          ],
          PreToolUse: [
            h("hooks/gates/tool-policy-gate.sh"),
            h("hooks/interceptors/pre-tool-context-injector.sh"),
            engine,
            logger,
          ],
          PreCompact: [
            h("scripts/pre-compact.sh", 5000),
            engine,
            logger,
          ],
          Stop: [
            h("hooks/gates/stop-worker-dispatch.sh"),
            h("hooks/gates/stop-inbox-drain.sh"),
            h("hooks/publishers/stop-echo.sh"),
            engine,
            logger,
          ],
        };

        // Merge: preserved non-fleet hooks first, then fleet hooks
        const merged: Record<string, HookEntry[]> = {};
        const allEvents = new Set([...Object.keys(preservedHooks), ...Object.keys(fleetHooks)]);
        for (const event of allEvents) {
          merged[event] = [
            ...(preservedHooks[event] || []),
            ...(fleetHooks[event] || []),
          ];
        }

        settings.hooks = merged;
        writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");

        // Verify hook scripts exist
        let hookCount = 0;
        let missingCount = 0;
        for (const entries of Object.values(fleetHooks)) {
          for (const entry of entries) {
            hookCount++;
            const script = entry.hooks[0].command.replace(/^(bash|bun run)\s+/, "");
            if (!existsSync(script)) missingCount++;
          }
        }
        if (missingCount > 0) {
          warn(`${hookCount} hooks registered, ${missingCount} scripts missing`);
        } else {
          ok(`${hookCount} hooks installed across ${Object.keys(fleetHooks).length} events`);
        }
        const nonFleetCount = Object.values(preservedHooks).reduce((n, arr) => n + arr.length, 0);
        if (nonFleetCount > 0) {
          ok(`${nonFleetCount} project-specific hooks preserved`);
        }
      }

      // 10. Optional plugins
      info("Detecting optional plugins...");

      // Watchdog plugin — prefer Rust binary over TypeScript
      const rustBinary = join(fleetDir, "extensions/watchdog-rs/target/release/boring-watchdog");
      const watchdogPlugin = join(fleetDir, "extensions/watchdog/src/watchdog.ts");
      const hasRustWatchdog = existsSync(rustBinary);
      const hasTsWatchdog = existsSync(watchdogPlugin);
      if (hasRustWatchdog || hasTsWatchdog) {
        const impl = hasRustWatchdog ? "Rust (boring-watchdog)" : "TypeScript";
        const watchdogPlist = join(HOME, "Library/LaunchAgents/com.tmux-agents.watchdog.plist");
        const legacyPlist = join(HOME, "Library/LaunchAgents/com.claude-fleet.harness-watchdog.plist");
        if (existsSync(watchdogPlist) || existsSync(legacyPlist)) {
          ok(`Watchdog: ${impl} — launchd daemon active`);
        } else {
          warn(`Watchdog: ${impl} found but not installed as daemon`);
          if (hasRustWatchdog) {
            console.log(`    Install: ${rustBinary} install`);
          } else {
            console.log(`    Install: bash ${join(fleetDir, "extensions/watchdog/install.sh")}`);
          }
        }
      } else {
        // Check if Cargo.toml exists but binary not built
        const cargoToml = join(fleetDir, "extensions/watchdog-rs/Cargo.toml");
        if (existsSync(cargoToml)) {
          info("Watchdog: Rust source found but not built");
          console.log(`    Build: cd ${join(fleetDir, "extensions/watchdog-rs")} && cargo build --release`);
        } else {
          info("Watchdog: not found (optional — supervises long-running workers)");
        }
      }

      // Deep review
      const deepReviewDir = process.env.DEEP_REVIEW_DIR || join(HOME, ".deep-review");
      if (existsSync(join(deepReviewDir, "scripts/deep-review.sh"))) {
        ok(`Deep review: ${deepReviewDir}`);
      } else if (existsSync(join(fleetDir, "scripts/deep-review.sh"))) {
        ok("Deep review: bundled (in fleet repo)");
      } else {
        info("Deep review: not found (optional — multi-pass adversarial code review)");
      }

      // Fleet Mail TUI
      {
        const { findTuiBinary } = await import("./tui");
        const tuiBinary = findTuiBinary();
        if (tuiBinary) {
          ok(`Fleet Mail TUI: ${tuiBinary}`);
        } else {
          info("Fleet Mail TUI: not found (optional — build or install separately)");
        }
      }

      console.log("");
      ok("Fleet setup complete!");
      console.log("");
      console.log("  fleet ls                    — list workers");
      console.log(`  fleet create <n> "m"        — create a worker`);
      console.log("  fleet doctor                — verify installation");
      console.log("  fleet help                  — all commands");
    });
}
