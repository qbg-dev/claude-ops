import type { Command } from "commander";
import { existsSync, readFileSync, readdirSync, statSync, accessSync, constants } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { FLEET_DIR, FLEET_DATA, FLEET_MAIL_URL, FLEET_MAIL_TOKEN } from "../lib/paths";
import { addGlobalOpts } from "../index";

const HOME = process.env.HOME || "/tmp";

interface CheckResult {
  name: string;
  status: "pass" | "fail" | "warn" | "skip";
  message: string;
  fix?: string;
  optional?: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function getVersion(bin: string): string | null {
  // tmux uses -V, most others use --version
  const flags = bin === "tmux" ? ["-V"] : ["--version"];
  try {
    const result = Bun.spawnSync([bin, ...flags], { stderr: "pipe" });
    if (result.exitCode === 0) {
      const out = result.stdout.toString().trim();
      // Handle "tmux 3.6a", "1.2.3", "v1.2.3", etc.
      const match = out.match(/(\d[\d.]+\w*)/);
      return match ? match[1] : out;
    }
  } catch {}
  return null;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isSymlink(path: string): boolean {
  try {
    const lstats = require("node:fs").lstatSync(path);
    return lstats.isSymbolicLink();
  } catch {
    return false;
  }
}

function parseJson(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

// ─── Checks ───────────────────────────────────────────────────────────────

function checkPrerequisites(): CheckResult {
  const bins: Array<{ name: string; hint: string }> = [
    { name: "bun", hint: "curl -fsSL https://bun.sh/install | bash" },
    { name: "tmux", hint: "brew install tmux" },
    { name: "claude", hint: "https://docs.anthropic.com/en/docs/claude-code" },
  ];

  const found: string[] = [];
  const missing: string[] = [];

  for (const { name, hint } of bins) {
    const version = getVersion(name);
    if (version) {
      found.push(`${name} ${version}`);
    } else {
      missing.push(`${name} (${hint})`);
    }
  }

  if (missing.length > 0) {
    return {
      name: "Prerequisites",
      status: "fail",
      message: `Missing: ${missing.map(m => m.split(" (")[0]).join(", ")}`,
      fix: `Install: ${missing.join("; ")}`,
    };
  }

  return {
    name: "Prerequisites",
    status: "pass",
    message: found.join(", "),
  };
}

function checkSymlinks(): CheckResult {
  const symlinks: Array<{ path: string; label: string; checkDir?: boolean; checkExec?: boolean }> = [
    { path: join(HOME, ".claude-fleet"), label: "~/.claude-fleet", checkDir: true },
    { path: join(HOME, ".claude-fleet"), label: "~/.claude-fleet" },
    { path: join(HOME, ".claude/ops"), label: "~/.claude/ops" },
    { path: join(HOME, ".tmux-agents"), label: "~/.tmux-agents" },
    { path: join(HOME, ".local/bin/fleet"), label: "~/.local/bin/fleet", checkExec: true },
  ];

  let valid = 0;
  const broken: string[] = [];

  for (const { path, label, checkDir, checkExec } of symlinks) {
    if (!existsSync(path)) {
      broken.push(label);
      continue;
    }
    if (checkDir && !isDirectory(path)) {
      broken.push(`${label} (not a directory)`);
      continue;
    }
    if (checkExec && !isExecutable(path)) {
      broken.push(`${label} (not executable)`);
      continue;
    }
    valid++;
  }

  if (broken.length > 0) {
    return {
      name: "Symlinks",
      status: "fail",
      message: `${valid}/${symlinks.length} valid — missing: ${broken.join(", ")}`,
      fix: "Run: fleet setup",
    };
  }

  return {
    name: "Symlinks",
    status: "pass",
    message: `${valid}/${symlinks.length} valid`,
  };
}

function checkDataDirectory(): CheckResult {
  if (!existsSync(FLEET_DATA)) {
    return {
      name: "Data directory",
      status: "fail",
      message: "~/.claude/fleet/ does not exist",
      fix: "Run: fleet setup",
    };
  }

  // Check defaults.json
  const defaultsFile = join(FLEET_DATA, "defaults.json");
  if (!existsSync(defaultsFile)) {
    return {
      name: "Data directory",
      status: "fail",
      message: "~/.claude/fleet/ exists but defaults.json is missing",
      fix: "Run: fleet setup",
    };
  }

  const defaults = parseJson(defaultsFile);
  if (defaults === null) {
    return {
      name: "Data directory",
      status: "fail",
      message: "defaults.json exists but is not valid JSON",
      fix: "Fix or recreate: fleet setup",
    };
  }

  // Count projects and workers
  let projectCount = 0;
  let workerCount = 0;
  try {
    const entries = readdirSync(FLEET_DATA, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      projectCount++;
      try {
        const workers = readdirSync(join(FLEET_DATA, entry.name), { withFileTypes: true })
          .filter(d => d.isDirectory() && !["missions", "_user", "_config"].includes(d.name));
        workerCount += workers.length;
      } catch {}
    }
  } catch {}

  return {
    name: "Data directory",
    status: "pass",
    message: `~/.claude/fleet/ (${projectCount} project${projectCount !== 1 ? "s" : ""}, ${workerCount} worker${workerCount !== 1 ? "s" : ""})`,
  };
}

function checkBunDeps(): CheckResult {
  const nodeModules = join(FLEET_DIR, "node_modules");
  if (!existsSync(nodeModules)) {
    return {
      name: "Bun dependencies",
      status: "fail",
      message: "node_modules/ not found in fleet dir",
      fix: `Run: cd ${FLEET_DIR} && bun install`,
    };
  }

  // Check @modelcontextprotocol/sdk resolves (it's in the MCP workspace)
  const mcpSdk = join(FLEET_DIR, "mcp/worker-fleet/node_modules/@modelcontextprotocol/sdk");
  // Also check at root level (bun workspaces may hoist)
  const mcpSdkRoot = join(FLEET_DIR, "node_modules/@modelcontextprotocol/sdk");
  if (!existsSync(mcpSdk) && !existsSync(mcpSdkRoot)) {
    return {
      name: "Bun dependencies",
      status: "fail",
      message: "@modelcontextprotocol/sdk not resolved",
      fix: `Run: cd ${FLEET_DIR} && bun install`,
    };
  }

  return {
    name: "Bun dependencies",
    status: "pass",
    message: "installed",
  };
}

function checkMcpServer(): CheckResult {
  const settingsFile = join(HOME, ".claude/settings.json");
  if (!existsSync(settingsFile)) {
    return {
      name: "MCP server",
      status: "fail",
      message: "~/.claude/settings.json not found",
      fix: "Run: fleet mcp register",
    };
  }

  const settings = parseJson(settingsFile);
  if (!settings) {
    return {
      name: "MCP server",
      status: "fail",
      message: "settings.json is not valid JSON",
      fix: "Fix settings.json manually or run: fleet setup",
    };
  }

  const mcpEntry = settings?.mcpServers?.["worker-fleet"];
  if (!mcpEntry) {
    return {
      name: "MCP server",
      status: "fail",
      message: "worker-fleet not registered in mcpServers",
      fix: "Run: fleet mcp register",
    };
  }

  // Verify the command path is valid
  const cmd = mcpEntry.command;
  if (cmd) {
    const cmdResult = Bun.spawnSync(["which", cmd], { stderr: "pipe" });
    if (cmdResult.exitCode !== 0) {
      return {
        name: "MCP server",
        status: "fail",
        message: `registered but command not found: ${cmd}`,
        fix: "Run: fleet mcp register",
      };
    }
  }

  // Verify the script arg exists
  const args: string[] = mcpEntry.args || [];
  const scriptArg = args.find((a: string) => a.endsWith(".ts") || a.endsWith(".js"));
  if (scriptArg && !existsSync(scriptArg)) {
    return {
      name: "MCP server",
      status: "fail",
      message: `registered but script not found: ${scriptArg}`,
      fix: "Run: fleet mcp register",
    };
  }

  return {
    name: "MCP server",
    status: "pass",
    message: "registered and startable",
  };
}

function checkHooks(): CheckResult {
  const settingsFile = join(HOME, ".claude/settings.json");
  const settings = parseJson(settingsFile);
  if (!settings?.hooks) {
    return {
      name: "Hooks",
      status: "fail",
      message: "no hooks configured in settings.json",
      fix: "Run: fleet setup",
    };
  }

  // Count hooks that reference fleet paths
  let totalHooks = 0;
  let validHooks = 0;
  const brokenScripts: string[] = [];
  const fleetPathPattern = /\.claude-fleet|\.claude-fleet|\.tmux-agents/;

  for (const [_event, hookGroups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(hookGroups)) continue;
    for (const group of hookGroups) {
      const hooks: any[] = (group as any).hooks || [];
      for (const hook of hooks) {
        if (hook.type !== "command") continue;
        const cmd: string = hook.command || "";
        if (!fleetPathPattern.test(cmd)) continue;

        totalHooks++;

        // Extract script path from command (handles "bash /path/to/script.sh" and plain paths)
        const parts = cmd.split(/\s+/);
        const scriptPath = parts.length > 1 ? parts[1] : parts[0];

        if (existsSync(scriptPath)) {
          validHooks++;
        } else {
          brokenScripts.push(scriptPath.replace(HOME, "~"));
        }
      }
    }
  }

  if (totalHooks === 0) {
    return {
      name: "Hooks",
      status: "fail",
      message: "no fleet hooks found in settings.json",
      fix: "Run: fleet setup",
    };
  }

  if (brokenScripts.length > 0) {
    return {
      name: "Hooks",
      status: "fail",
      message: `${validHooks}/${totalHooks} hooks valid — broken: ${brokenScripts.slice(0, 3).join(", ")}${brokenScripts.length > 3 ? ` (+${brokenScripts.length - 3} more)` : ""}`,
      fix: "Run: fleet setup",
    };
  }

  return {
    name: "Hooks",
    status: "pass",
    message: `${totalHooks} hooks installed, all scripts valid`,
  };
}

async function checkFleetMail(): Promise<CheckResult> {
  if (!FLEET_MAIL_URL) {
    return {
      name: "Fleet Mail",
      status: "fail",
      message: "not configured",
      fix: "Run: fleet mail-server connect <url>",
    };
  }

  // HTTP health check with timeout
  try {
    const resp = await fetch(`${FLEET_MAIL_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) {
      return {
        name: "Fleet Mail",
        status: "fail",
        message: `${FLEET_MAIL_URL} returned ${resp.status}`,
        fix: "Check that the Fleet Mail server is running",
      };
    }
  } catch {
    return {
      name: "Fleet Mail",
      status: "fail",
      message: `${FLEET_MAIL_URL} unreachable`,
      fix: "Start the Fleet Mail server or run: fleet mail-server connect <url>",
    };
  }

  // Check admin token
  if (!FLEET_MAIL_TOKEN) {
    return {
      name: "Fleet Mail",
      status: "pass",
      message: `${FLEET_MAIL_URL} reachable (no admin token configured)`,
    };
  }

  return {
    name: "Fleet Mail",
    status: "pass",
    message: `${FLEET_MAIL_URL} reachable`,
  };
}

function checkDeepReview(): CheckResult {
  const deepReviewDir = process.env.DEEP_REVIEW_DIR || join(HOME, ".deep-review");
  const bundledDir = FLEET_DIR;

  // Check for dr-context binary
  const drContextPaths = [
    join(bundledDir, "tools/dr-context/target/release/dr-context"),
    join(bundledDir, "tools/dr-context/dr-context"),
  ];
  const drContextFound = drContextPaths.some(p => existsSync(p));

  // Check for deep-review.sh
  const deepReviewPaths = [
    join(deepReviewDir, "scripts/deep-review.sh"),
    join(bundledDir, "scripts/deep-review.sh"),
  ];
  const deepReviewFound = deepReviewPaths.some(p => existsSync(p));

  if (!drContextFound && !deepReviewFound) {
    return {
      name: "Deep Review",
      status: "skip",
      message: "not installed (optional — fleet setup --full to install)",
      optional: true,
    };
  }

  const parts: string[] = [];
  if (drContextFound) parts.push("dr-context binary");
  if (deepReviewFound) parts.push("deep-review.sh");

  if (!drContextFound || !deepReviewFound) {
    const missing = !drContextFound ? "dr-context binary" : "deep-review.sh";
    return {
      name: "Deep Review",
      status: "skip",
      message: `partial — missing ${missing}`,
      optional: true,
    };
  }

  return {
    name: "Deep Review",
    status: "pass",
    message: parts.join(", "),
    optional: true,
  };
}

function checkWatchdog(): CheckResult {
  // Prefer Rust binary (boring-watchdog), fall back to TypeScript
  const rustBinary = join(FLEET_DIR, "extensions/watchdog-rs/target/release/boring-watchdog");
  const tsScript = join(FLEET_DIR, "extensions/watchdog/src/watchdog.ts");
  const hasRust = existsSync(rustBinary);
  const hasTs = existsSync(tsScript);

  if (!hasRust && !hasTs) {
    return {
      name: "Watchdog",
      status: "skip",
      message: "not installed (optional — fleet setup --full to install)",
      optional: true,
    };
  }

  const impl = hasRust ? "Rust" : "TypeScript";

  // Check launchd agent (macOS)
  const plistPath = join(HOME, "Library/LaunchAgents/com.tmux-agents.watchdog.plist");
  const legacyPlist = join(HOME, "Library/LaunchAgents/com.claude-fleet.harness-watchdog.plist");

  if (!existsSync(plistPath) && !existsSync(legacyPlist)) {
    const fix = hasRust
      ? `Run: ${rustBinary} install`
      : `Run: bash ${join(FLEET_DIR, "extensions/watchdog/install.sh")}`;
    return {
      name: "Watchdog",
      status: "skip",
      message: `${impl} binary found but launchd agent not loaded`,
      optional: true,
      fix,
    };
  }

  // Verify it's actually loaded
  const result = Bun.spawnSync(
    ["launchctl", "list", "com.tmux-agents.watchdog"],
    { stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    // Try legacy name
    const legacyResult = Bun.spawnSync(
      ["launchctl", "list", "com.claude-fleet.harness-watchdog"],
      { stderr: "pipe" },
    );
    if (legacyResult.exitCode !== 0) {
      return {
        name: "Watchdog",
        status: "skip",
        message: "plist exists but agent not loaded",
        optional: true,
        fix: `Run: launchctl load ${existsSync(plistPath) ? plistPath : legacyPlist}`,
      };
    }
  }

  // Check if the plist points to the Rust binary (upgrade hint)
  if (hasRust && existsSync(plistPath)) {
    try {
      const plistContent = readFileSync(plistPath, "utf-8");
      if (!plistContent.includes("boring-watchdog")) {
        return {
          name: "Watchdog",
          status: "pass",
          message: `launchd agent loaded (${impl} binary available — run: boring-watchdog install to upgrade)`,
          optional: true,
        };
      }
    } catch {}
  }

  return {
    name: "Watchdog",
    status: "pass",
    message: `launchd agent loaded (${impl})`,
    optional: true,
  };
}

function checkTui(): CheckResult {
  // Check PATH first
  const which = Bun.spawnSync(["which", "boring-mail-tui"], { stderr: "pipe" });
  if (which.exitCode === 0) {
    return {
      name: "Fleet Mail TUI",
      status: "pass",
      message: which.stdout.toString().trim(),
      optional: true,
    };
  }

  // Check known locations
  const paths = [
    join(HOME, ".cargo/bin/boring-mail-tui"),
    join(HOME, "Desktop/zPersonalProjects/boring-mail-server/target/release/boring-mail-tui"),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      return {
        name: "Fleet Mail TUI",
        status: "pass",
        message: p,
        optional: true,
      };
    }
  }

  return {
    name: "Fleet Mail TUI",
    status: "skip",
    message: "not found (optional — cargo install boring-mail-tui)",
    optional: true,
  };
}

// ─── Display ──────────────────────────────────────────────────────────────

function formatCheckResult(r: CheckResult): void {
  let icon: string;
  let line: string;

  switch (r.status) {
    case "pass":
      icon = chalk.green("\u2713");
      line = `${icon} ${chalk.bold(r.name)}: ${r.message}`;
      break;
    case "fail":
      icon = chalk.red("\u2717");
      line = `${icon} ${chalk.bold(r.name)}: ${chalk.red(r.message)}`;
      break;
    case "warn":
      icon = chalk.yellow("\u26A0");
      line = `${icon} ${chalk.bold(r.name)}: ${chalk.yellow(r.message)}`;
      break;
    case "skip":
      icon = chalk.yellow("\u25CB");
      line = `${icon} ${chalk.bold(r.name)}: ${chalk.yellow(r.message)}`;
      break;
  }

  console.log(line!);
  if (r.fix && r.status !== "pass") {
    console.log(`  ${chalk.dim("\u2192")} ${r.fix}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function runDoctor(globalOpts: Record<string, unknown>): Promise<void> {
  const json = globalOpts.json as boolean;
  const fix = globalOpts.fix as boolean;
  const project = (globalOpts.project as string) || null;

  const results: CheckResult[] = [];

  // ── Section 1: Infrastructure ──
  results.push(checkPrerequisites());
  results.push(checkSymlinks());
  results.push(checkDataDirectory());
  results.push(checkBunDeps());
  results.push(checkMcpServer());
  results.push(checkHooks());
  results.push(await checkFleetMail());
  results.push(checkDeepReview());
  results.push(checkWatchdog());
  results.push(checkTui());

  // ── Section 2: Fleet Health ──
  // Resolve project name
  let projectName = project;
  if (!projectName) {
    try {
      const r = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { stderr: "pipe" });
      if (r.exitCode === 0) {
        const root = r.stdout.toString().trim();
        projectName = root.split("/").pop()!.replace(/-w-.*$/, "");
      }
    } catch {}
  }
  if (!projectName) {
    projectName = process.cwd().split("/").pop()!.replace(/-w-.*$/, "");
  }

  const { runHealthChecks } = await import("../lib/health");
  const { results: healthResults, fixes } = runHealthChecks(projectName);

  // Convert health results to CheckResult format
  const allHealthResults: CheckResult[] = healthResults.map(hr => ({
    name: hr.name,
    status: hr.status,
    message: hr.message,
    fix: hr.fix,
  }));

  if (json) {
    console.log(JSON.stringify({
      infrastructure: results,
      fleet_health: allHealthResults,
      fixes_available: fixes.length,
    }, null, 2));
    return;
  }

  // Pretty output
  console.log(chalk.bold("Fleet Doctor"));
  console.log("============");
  console.log("");

  // Infrastructure section
  console.log(chalk.bold.underline("Infrastructure"));
  console.log("");
  for (const r of results) formatCheckResult(r);

  // Fleet Health section
  console.log("");
  console.log(chalk.bold.underline(`Fleet Health (${projectName})`));
  console.log("");
  for (const r of allHealthResults) formatCheckResult(r);

  // Apply fixes
  if (fix && fixes.length > 0) {
    console.log("");
    console.log(chalk.bold.underline("Auto-fixes"));
    for (const f of fixes) {
      try {
        f.fn();
        console.log(`  ${chalk.green("\u2713")} ${f.action}`);
      } catch (err: any) {
        console.log(`  ${chalk.red("\u2717")} ${f.action}: ${err.message}`);
      }
    }
  } else if (fixes.length > 0 && !fix) {
    console.log("");
    console.log(chalk.dim(`${fixes.length} auto-fixable issue(s) found. Run with --fix to apply.`));
  }

  // Summary
  const allResults = [...results, ...allHealthResults];
  const coreResults = allResults.filter(r => !r.optional);
  const corePassed = coreResults.filter(r => r.status === "pass").length;
  const coreTotal = coreResults.length;
  const anyFailed = allResults.some(r => r.status === "fail");

  console.log("");
  if (anyFailed) {
    console.log(chalk.red(`Status: unhealthy (${corePassed}/${coreTotal} checks passed)`));
  } else {
    console.log(chalk.green(`Status: healthy (${corePassed}/${coreTotal} checks passed)`));
  }
}

export function register(parent: Command): void {
  const sub = parent
    .command("doctor")
    .description("Verify health of the fleet ecosystem")
    .option("--fix", "Auto-fix issues that can be repaired automatically");
  addGlobalOpts(sub)
    .action(async (_opts: Record<string, unknown>, cmd: Command) => {
      await runDoctor(cmd.optsWithGlobals());
    });
}
