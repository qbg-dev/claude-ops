import type { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FLEET_DATA, FLEET_MAIL_URL } from "../lib/paths";
import { ok, info, fail } from "../lib/fmt";
import { addGlobalOpts } from "../index";
import { readJson } from "../../shared/io";

const HOME = process.env.HOME || "/tmp";

const TUI_BINARY_PATHS = [
  join(HOME, ".cargo/bin/boring-mail-tui"),
  join(HOME, "Desktop/zPersonalProjects/boring-mail-server/target/release/boring-mail-tui"),
];

export function findTuiBinary(): string | null {
  // Check PATH first
  const which = Bun.spawnSync(["which", "boring-mail-tui"], { stderr: "pipe" });
  if (which.exitCode === 0) return which.stdout.toString().trim();

  // Check known locations
  for (const p of TUI_BINARY_PATHS) {
    if (existsSync(p)) return p;
  }
  return null;
}

function resolveProject(override?: string): string {
  if (override) return override;
  if (process.env.FLEET_PROJECT) return process.env.FLEET_PROJECT;

  // Auto-detect from cwd
  try {
    const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { stderr: "pipe" });
    if (result.exitCode === 0) {
      const root = result.stdout.toString().trim();
      const name = root.split("/").pop()!.replace(/-w-.*$/, "");
      if (existsSync(join(FLEET_DATA, name))) return name;
    }
  } catch {}

  // First project dir
  try {
    const entries = require("node:fs").readdirSync(FLEET_DATA, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".")) return e.name;
    }
  } catch {}

  return "unknown";
}

function resolveToken(project: string, account?: string): string | null {
  // 1. Account-specific token
  if (account) {
    const tokenPath = join(FLEET_DATA, project, account, "token");
    if (existsSync(tokenPath)) return readFileSync(tokenPath, "utf-8").trim();
  }

  // 2. BMS_TOKEN env
  if (process.env.BMS_TOKEN) return process.env.BMS_TOKEN;

  // 3. _user token
  const userToken = join(FLEET_DATA, project, "_user", "token");
  if (existsSync(userToken)) return readFileSync(userToken, "utf-8").trim();

  // 4. _user/account.json
  const accountJson = join(FLEET_DATA, project, "_user", "account.json");
  if (existsSync(accountJson)) {
    try {
      const data = JSON.parse(readFileSync(accountJson, "utf-8"));
      if (data.bms_token) return data.bms_token;
    } catch {}
  }

  // 5. FLEET_MAIL_TOKEN env
  if (process.env.FLEET_MAIL_TOKEN) return process.env.FLEET_MAIL_TOKEN;

  return null;
}

function resolveUrl(): string {
  if (process.env.BMS_URL) return process.env.BMS_URL;
  if (FLEET_MAIL_URL) return FLEET_MAIL_URL;

  // Read defaults.json
  const dp = join(FLEET_DATA, "defaults.json");
  if (existsSync(dp)) {
    try {
      const d = JSON.parse(readFileSync(dp, "utf-8"));
      if (d.fleet_mail_url) return d.fleet_mail_url;
    } catch {}
  }

  return "http://5.161.107.142:8026";
}

export function register(parent: Command): void {
  const sub = parent
    .command("tui")
    .description("Launch Fleet Mail TUI client")
    .option("-a, --account <name>", "Account name (reads token from fleet dirs)")
    .option("--control", "Open in control window tmux pane");

  addGlobalOpts(sub)
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals();
      const binary = findTuiBinary();
      if (!binary) {
        fail("boring-mail-tui not found. Install with:\n  cargo install --git https://github.com/qbg-dev/boring-mail-server boring-mail-tui");
      }

      const project = resolveProject(globalOpts.project as string | undefined);
      const account = opts.account as string | undefined;
      const token = resolveToken(project, account);
      const url = resolveUrl();

      if (!token) {
        fail(`No token found for project '${project}'. Set BMS_TOKEN or create ~/.claude/fleet/${project}/_user/token`);
      }

      const env: Record<string, string> = {
        ...process.env as Record<string, string>,
        BMS_URL: url,
        BMS_TOKEN: token!,
      };
      if (account) env.BMS_ACCOUNT = account;

      if (opts.control) {
        // Launch in control window tmux pane
        const fleetJson = readJson<Record<string, unknown>>(join(FLEET_DATA, project, "fleet.json"));
        const session = (fleetJson as any)?.tmux_session || "w";

        const tmuxCmd = `BMS_URL=${url} BMS_TOKEN=${token} ${binary}`;
        const result = Bun.spawnSync(
          ["tmux", "split-window", "-t", `${session}:control`, "-h", tmuxCmd],
          { stderr: "pipe" }
        );

        if (result.exitCode !== 0) {
          // Try creating the control window first
          Bun.spawnSync(["tmux", "new-window", "-t", session, "-n", "control"], { stderr: "pipe" });
          const retry = Bun.spawnSync(
            ["tmux", "split-window", "-t", `${session}:control`, "-h", tmuxCmd],
            { stderr: "pipe" }
          );
          if (retry.exitCode !== 0) {
            fail(`Failed to open TUI in control window (session: ${session})`);
          }
        }

        // Auto-restore layout if saved
        const layouts = (fleetJson as any)?.layouts;
        if (layouts?.control) {
          Bun.spawnSync(
            ["tmux", "select-layout", "-t", `${session}:control`, layouts.control],
            { stderr: "pipe" }
          );
        }

        ok(`TUI opened in ${session}:control`);
      } else {
        // Interactive launch
        info(`Connecting to ${url}...`);
        const proc = Bun.spawnSync([binary!], {
          env,
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });
        process.exit(proc.exitCode || 0);
      }
    });
}
