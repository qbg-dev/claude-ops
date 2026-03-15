import type { Command } from "commander";
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { FLEET_DIR, FLEET_DATA, FLEET_MAIL_URL, FLEET_MAIL_TOKEN } from "../lib/paths";
import { ok, info, warn, fail } from "../lib/fmt";
import { startLocalServer } from "./mail-server";

export function register(parent: Command): void {
  parent
    .command("setup")
    .description("Bootstrap fleet infrastructure")
    .option("--extensions", "Build and install all extensions (watchdog, review, etc.)")
    .option("--no-global-hooks", "Skip installing hooks MCP + engine globally (default: install)")
    .action(async (opts: { extensions?: boolean; globalHooks?: boolean }) => {
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
          model: "opus[1m]",
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

      // 8. Register MCP servers + settings (after Fleet Mail so FLEET_MAIL_URL is available)
      // NOTE: worker-fleet MCP is deprecated — all fleet communication now uses fleet CLI.
      // Only claude-hooks MCP is registered (globally, user scope).
      const settingsFile = join(HOME, ".claude/settings.json");
      const bunPath = Bun.spawnSync(["which", "bun"]).stdout.toString().trim();

      {
        let settings: Record<string, any> = {};
        if (existsSync(settingsFile)) {
          try { settings = JSON.parse(readFileSync(settingsFile, "utf-8")); } catch {}
        }
        if (!settings.mcpServers) settings.mcpServers = {};

        // Remove legacy worker-fleet MCP if present
        if (settings.mcpServers["worker-fleet"]) {
          delete settings.mcpServers["worker-fleet"];
          info("Removed legacy worker-fleet MCP (now using fleet CLI)");
        }

        // Register claude-hooks MCP server (standalone hook management)
        // Must use `claude mcp add -s user` — settings.json mcpServers are NOT loaded by Claude Code.
        // User-scope MCPs go in ~/.claude.json and work for ALL Claude Code instances.
        if (opts.globalHooks !== false) {
          const claudeHooksDir = process.env.CLAUDE_HOOKS_DIR || join(HOME, ".claude-hooks");
          const claudeHooksMcp = join(claudeHooksDir, "mcp/index.ts");
          const claudeHooksMcpResolved = existsSync(claudeHooksMcp)
            ? Bun.spawnSync(["realpath", claudeHooksMcp]).stdout.toString().trim() || claudeHooksMcp
            : null;
          if (claudeHooksMcpResolved) {
            const hooksDir = join(HOME, ".claude/hooks");
            const result = Bun.spawnSync([
              "claude", "mcp", "add", "-s", "user",
              "claude-hooks",
              "-e", `HOOKS_DIR=${hooksDir}`,
              "-e", "HOOKS_IDENTITY=operator",
              "--", bunPath, "run", claudeHooksMcpResolved,
            ], { stdout: "pipe", stderr: "pipe" });
            if (result.exitCode === 0) {
              ok("claude-hooks MCP registered globally (user scope, works for all Claude Code instances)");
            } else {
              const stderr = result.stderr.toString().trim();
              warn(`claude-hooks MCP registration failed: ${stderr}`);
              console.log(`    Try manually: claude mcp add -s user claude-hooks -e HOOKS_DIR=${hooksDir} -e HOOKS_IDENTITY=operator -- ${bunPath} run ${claudeHooksMcpResolved}`);
            }
          } else {
            info("claude-hooks not found — skipping (optional, install at ~/.claude-hooks)");
          }
        } else {
          info("Global hooks MCP skipped (--no-global-hooks)");
        }

        // Configure statusline via extension installer
        const statuslineInstaller = join(fleetDir, "extensions/statusline/install.sh");
        if (existsSync(statuslineInstaller)) {
          if (settings.statusLine) {
            // Existing statusline — don't overwrite. Onboarding agent will interview
            // the user and help merge fleet v2 worker detection into their script.
            info("Existing statusline detected — skipping (onboarding agent will help merge)");
          } else {
            const slInstall = Bun.spawnSync(
              ["bash", statuslineInstaller, "--link"],
              { stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME } },
            );
            if (slInstall.exitCode === 0) {
              // Re-read settings.json after install script modified it
              try { settings = JSON.parse(readFileSync(settingsFile, "utf-8")); } catch {}
              ok("Statusline: installed via extension (worker identity via worktree)");
            } else {
              warn("Statusline install failed — try: bash extensions/statusline/install.sh");
            }
          }
        }

        writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
        ok("Settings updated");
      }

      // 9. Ensure global hooks directory exists
      const globalHooksDir = join(HOME, ".claude/hooks");
      mkdirSync(globalHooksDir, { recursive: true });
      ok(`Global hooks dir: ${globalHooksDir}`);

      // 10. Install hooks into settings.json
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
        const hooksDir = join(HOME, ".claude/hooks");
        const engine = {
          hooks: [{ type: "command" as const, command: `HOOKS_DIR=${hooksDir} bun run ${fleetBase}/engine/hook-engine.ts` }],
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

      // 10. Extensions — detect or install
      info(opts.extensions ? "Installing extensions..." : "Detecting extensions...");

      // Watchdog — prefer Rust binary over TypeScript
      const rustBinary = join(fleetDir, "extensions/watchdog-rs/target/release/boring-watchdog");
      const watchdogPlugin = join(fleetDir, "extensions/watchdog/src/watchdog.ts");
      const cargoToml = join(fleetDir, "extensions/watchdog-rs/Cargo.toml");
      const watchdogPlist = join(HOME, "Library/LaunchAgents/com.tmux-agents.watchdog.plist");
      const legacyPlist = join(HOME, "Library/LaunchAgents/com.claude-fleet.harness-watchdog.plist");
      const watchdogInstalled = existsSync(watchdogPlist) || existsSync(legacyPlist);
      let hasRustWatchdog = existsSync(rustBinary);
      const hasTsWatchdog = existsSync(watchdogPlugin);

      if (opts.extensions && !watchdogInstalled) {
        // Try to build + install Rust watchdog first, fall back to TS
        if (existsSync(cargoToml)) {
          const hasCargo = Bun.spawnSync(["which", "cargo"], { stderr: "pipe" }).exitCode === 0;
          if (hasCargo) {
            info("Building Rust watchdog...");
            const build = Bun.spawnSync(
              ["cargo", "build", "--release"],
              { cwd: join(fleetDir, "extensions/watchdog-rs"), stdout: "inherit", stderr: "inherit" },
            );
            if (build.exitCode === 0) {
              hasRustWatchdog = true;
              ok("Rust watchdog built");
              info("Installing watchdog daemon...");
              const install = Bun.spawnSync(
                [rustBinary, "install"],
                { stdout: "inherit", stderr: "inherit" },
              );
              if (install.exitCode === 0) {
                ok("Watchdog: Rust — launchd daemon installed");
              } else {
                warn("Watchdog install failed (try manually)");
              }
            } else {
              warn("Rust watchdog build failed — trying TypeScript fallback");
            }
          } else {
            info("cargo not found — using TypeScript watchdog");
          }
        }
        // Fall back to TS watchdog if Rust didn't work
        if (!hasRustWatchdog && hasTsWatchdog) {
          info("Installing TypeScript watchdog...");
          const install = Bun.spawnSync(
            ["bash", join(fleetDir, "extensions/watchdog/install.sh")],
            { stdout: "inherit", stderr: "inherit", env: { ...process.env, CLAUDE_FLEET_DIR: fleetDir } },
          );
          if (install.exitCode === 0) {
            ok("Watchdog: TypeScript — launchd daemon installed");
          } else {
            warn("TypeScript watchdog install failed");
          }
        }
      } else if (hasRustWatchdog || hasTsWatchdog) {
        const impl = hasRustWatchdog ? "Rust (boring-watchdog)" : "TypeScript";
        if (watchdogInstalled) {
          ok(`Watchdog: ${impl} — launchd daemon active`);
        } else {
          warn(`Watchdog: ${impl} found but not installed as daemon`);
          if (hasRustWatchdog) {
            console.log(`    Install: ${rustBinary} install`);
          } else {
            console.log(`    Install: bash ${join(fleetDir, "extensions/watchdog/install.sh")}`);
          }
          if (!opts.extensions) {
            console.log(`    Or run: fleet setup --extensions`);
          }
        }
      } else if (existsSync(cargoToml)) {
        info("Watchdog: Rust source found but not built");
        console.log(`    Build + install: fleet setup --extensions`);
      } else {
        info("Watchdog: not found (optional — supervises long-running workers)");
      }

      // Restart watchdog if installed (picks up code changes)
      if (watchdogInstalled) {
        const plistPath = existsSync(watchdogPlist) ? watchdogPlist : legacyPlist;
        const unload = Bun.spawnSync(["launchctl", "unload", plistPath], { stderr: "pipe" });
        const load = Bun.spawnSync(["launchctl", "load", plistPath], { stderr: "pipe" });
        if (load.exitCode === 0) {
          ok("Watchdog: restarted (picks up code changes)");
        } else {
          warn("Watchdog: restart failed — may need manual `launchctl unload/load`");
        }
      }

      // Deep review extension
      const reviewInstallScript = join(fleetDir, "extensions/review/install.sh");
      const deepReviewDir = process.env.DEEP_REVIEW_DIR || join(HOME, ".deep-review");
      if (opts.extensions && existsSync(reviewInstallScript)) {
        info("Installing review extension...");
        const install = Bun.spawnSync(
          ["bash", reviewInstallScript],
          { stdout: "inherit", stderr: "inherit" },
        );
        if (install.exitCode === 0) {
          ok("Deep review: installed (REVIEW.md, pre-commit hook, scripts)");
        } else {
          warn("Review extension install failed");
        }
      } else if (existsSync(join(deepReviewDir, "scripts/deep-review.sh"))) {
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

      // 11. Tmux prefix key (optional — recommend prefix Y for fleet operations)
      info("Tmux prefix key...");
      const tmuxConf = join(HOME, ".tmux.conf");
      const tmuxConfContent = existsSync(tmuxConf) ? readFileSync(tmuxConf, "utf-8") : "";
      const hasCustomPrefix = /set\s+(-g\s+)?prefix\b/.test(tmuxConfContent);
      const hasPrefixY = /set\s+(-g\s+)?prefix2?\s+C-y/i.test(tmuxConfContent);

      if (hasPrefixY) {
        ok("Tmux prefix Y already configured");
      } else if (hasCustomPrefix) {
        // User has a custom prefix — suggest adding prefix2 (secondary prefix)
        info("Custom tmux prefix detected — skipping prefix Y (add manually if desired)");
        console.log(`    Add to ~/.tmux.conf: set -g prefix2 C-y`);
      } else {
        // No custom prefix — offer to add prefix Y as secondary
        info("Recommend: Ctrl-Y as secondary tmux prefix (convenient for fleet ops)");
        console.log(`    Fleet uses tmux heavily — a second prefix key avoids conflicts with Ctrl-B.`);
        console.log(`    Adding prefix2 C-y to ~/.tmux.conf (your existing prefix is preserved)...`);
        const prefixLine = '\n# Added by fleet setup — secondary prefix for fleet operations\nset -g prefix2 C-y\nbind C-y send-prefix -2\n';
        appendFileSync(tmuxConf, prefixLine);
        ok("Added prefix2 C-y to ~/.tmux.conf");
        console.log(`    Reload: tmux source-file ~/.tmux.conf`);
      }

      // 12. Tmux config (optional — agent-friendly defaults)
      info("Tmux config...");
      const fleetTmuxConf = join(fleetDir, "config/tmux.conf");
      if (existsSync(fleetTmuxConf)) {
        const hasHighScrollback = /history-limit\s+[3-9]\d{4,}/.test(tmuxConfContent);
        const hasPaneBorders = /pane-border-status/.test(tmuxConfContent);

        if (hasHighScrollback && hasPaneBorders) {
          ok("Tmux config: agent-friendly settings detected");
        } else if (tmuxConfContent.trim()) {
          info("Existing tmux.conf found — may need agent-friendly settings (50k scrollback, pane labels)");
          console.log(`    Reference:  ${fleetTmuxConf}`);
          console.log("    Or run:     fleet onboard   (architect will help merge)");
        } else {
          // Empty or missing — install fleet config
          copyFileSync(fleetTmuxConf, tmuxConf);
          Bun.spawnSync(["tmux", "source-file", tmuxConf], { stderr: "pipe" });
          ok("Installed fleet tmux.conf (50k scrollback, pane labels, broadcast menu)");
        }
      }

      // 13. Shell completions
      info("Shell completions...");
      const completionSrc = join(fleetDir, "completions/_fleet");
      const completionDst = join(fleetDir, "completions"); // fpath target dir
      if (existsSync(completionSrc)) {
        const shell = process.env.SHELL || "";
        if (shell.endsWith("/zsh")) {
          const rcFile = join(HOME, ".zshrc");
          const rcContent = existsSync(rcFile) ? readFileSync(rcFile, "utf-8") : "";
          if (rcContent.includes("completions/_fleet") || rcContent.includes(`fpath=(${completionDst}`)) {
            ok("Zsh completions already in ~/.zshrc");
          } else {
            appendFileSync(rcFile, `\n# Fleet CLI completions (added by fleet setup)\nfpath=(${completionDst} $fpath)\nautoload -Uz compinit && compinit\n`);
            ok("Added fleet completions to ~/.zshrc");
            console.log("    Reload: exec zsh");
          }
        } else {
          info(`Completions available at ${completionSrc} (zsh only — add fpath manually for other shells)`);
        }
      } else {
        warn("Completion file not found — skipping");
      }

      console.log("");
      ok("Fleet setup complete!");
      console.log("");
      console.log(`  ${chalk.bold("fleet onboard")}                — guided setup + fleet design (recommended next step)`);
      console.log("  fleet ls                    — list workers");
      console.log("  fleet doctor                — verify installation");
      console.log("");
      info("Run 'fleet onboard' to design your fleet with the architect agent.");
    });
}
