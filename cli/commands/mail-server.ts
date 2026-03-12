import type { Command } from "commander";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { FLEET_DATA, FLEET_DIR, FLEET_MAIL_URL, FLEET_MAIL_TOKEN } from "../lib/paths";
import { ok, info, warn, fail } from "../lib/fmt";
import { readJson, writeJson } from "../../shared/io";

const MAIL_SERVER_PATHS = [
  join(process.env.HOME || "", ".cargo/bin/boring-mail"),
  join(process.env.HOME || "", ".cargo/bin/fleet-server"), // legacy compat
];

function findMailServerBinary(): string | null {
  // 1. Vendored binary (platform-specific)
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x86_64";
  const vendored = join(FLEET_DIR, `vendor/boring-mail-${platform}-${arch}`);
  if (existsSync(vendored)) return vendored;

  // 2. PATH (boring-mail is the canonical name)
  const which = Bun.spawnSync(["which", "boring-mail"], { stderr: "pipe" });
  if (which.exitCode === 0) return which.stdout.toString().trim();

  // 3. Legacy name fallback
  const whichLegacy = Bun.spawnSync(["which", "fleet-server"], { stderr: "pipe" });
  if (whichLegacy.exitCode === 0) return whichLegacy.stdout.toString().trim();

  // 4. Known cargo locations
  for (const p of MAIL_SERVER_PATHS) {
    if (existsSync(p)) return p;
  }
  return null;
}

function msDefaultsPath(): string {
  return join(FLEET_DATA, "defaults.json");
}

function updateMailConfig(url: string | null, token: string | null): void {
  const dp = msDefaultsPath();
  const defaults = readJson<Record<string, unknown>>(dp) || {};
  if (url !== undefined) defaults.fleet_mail_url = url;
  if (token !== undefined) defaults.fleet_mail_token = token;
  writeJson(dp, defaults);
}

async function connectAction(args: { url?: string; token?: string }) {
  const url = args.url;
  if (!url) return fail("URL is required: fleet mail-server connect <url> [--token <token>]");

  // Normalize URL — strip trailing slash
  const normalizedUrl = url.replace(/\/+$/, "");

  info(`Connecting to Fleet Mail at ${normalizedUrl}...`);

  // Health check
  try {
    const resp = await fetch(`${normalizedUrl}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) fail(`Server returned ${resp.status}`);
    ok("Server is reachable");
  } catch (e) {
    fail(`Cannot reach ${normalizedUrl} — is the server running?`);
  }

  // Save admin token if provided
  const adminToken = args.token || null;
  if (adminToken) {
    ok("Admin token saved (used for account management)");
  } else {
    info("No admin token provided (worker accounts use per-worker tokens)");
    info("Provide with: fleet mail-server connect <url> --token <token>");
  }

  // Save to defaults.json
  updateMailConfig(normalizedUrl, adminToken);
  ok(`Fleet Mail configured: ${normalizedUrl}`);

  if (adminToken) {
    console.log(`\n  URL:   ${normalizedUrl}`);
    console.log(`  Token: ${adminToken.slice(0, 8)}...${adminToken.slice(-4)}`);
  } else {
    console.log(`\n  URL:   ${normalizedUrl}`);
    console.log(`  Token: ${chalk.dim("not set")}`);
  }

  console.log(`\n  Workers will auto-provision mail accounts on ${chalk.cyan("fleet create")}.`);
}

async function disconnectAction() {
  updateMailConfig(null, null);
  ok("Fleet Mail disconnected — workers will not have mail.");
}

async function statusAction() {
  console.log(chalk.bold("Fleet Mail Status\n"));

  const url = FLEET_MAIL_URL;
  const token = FLEET_MAIL_TOKEN;

  // Config
  if (url) {
    console.log(`  ${chalk.cyan("URL:")}    ${url}`);
  } else {
    console.log(`  ${chalk.cyan("URL:")}    ${chalk.dim("not configured")}`);
    console.log(`\n  Run ${chalk.cyan("fleet mail-server connect <url>")} to configure.`);
    return;
  }

  if (token) {
    console.log(`  ${chalk.cyan("Token:")}  ${token.slice(0, 8)}...${token.slice(-4)}`);
  } else {
    console.log(`  ${chalk.cyan("Token:")}  ${chalk.dim("not set")}`);
  }

  // Source
  if (process.env.FLEET_MAIL_URL) {
    console.log(`  ${chalk.cyan("Source:")} ${chalk.dim("$FLEET_MAIL_URL env var")}`);
  } else {
    console.log(`  ${chalk.cyan("Source:")} ${chalk.dim("defaults.json")}`);
  }

  // Health check
  try {
    const resp = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      console.log(`  ${chalk.cyan("Health:")} ${chalk.green("reachable")}`);
    } else {
      console.log(`  ${chalk.cyan("Health:")} ${chalk.red(`error (${resp.status})`)}`);
    }
  } catch {
    console.log(`  ${chalk.cyan("Health:")} ${chalk.red("unreachable")}`);
  }

}

const BORING_MAIL_DATA = join(process.env.HOME || "", ".boring-mail");
const LEGACY_MAIL_DATA = join(process.env.HOME || "", ".fleet-server");

function readLocalAdminToken(): string | null {
  // Check boring-mail path first, then legacy
  for (const dir of [BORING_MAIL_DATA, LEGACY_MAIL_DATA]) {
    const p = join(dir, "admin-token");
    if (existsSync(p)) {
      const t = readFileSync(p, "utf-8").trim();
      if (t) return t;
    }
  }
  return null;
}

/**
 * Start a local boring-mail server. Reusable by setup.ts.
 * Returns { url, token } on success, throws on failure.
 */
export async function startLocalServer(opts?: {
  port?: string;
  token?: string;
  quiet?: boolean;
}): Promise<{ url: string; token: string }> {
  const port = opts?.port || "8025";
  const log = opts?.quiet ? (() => {}) : info;
  let binary = findMailServerBinary();

  if (!binary) {
    const platform = process.platform === "darwin" ? "darwin" : "linux";
    const arch = process.arch === "arm64" ? "arm64" : "x86_64";
    throw new Error(
      "boring-mail binary not found.\n\n" +
      `  Expected: ${FLEET_DIR}/vendor/boring-mail-${platform}-${arch}\n\n` +
      "  Or connect to a remote server:\n" +
      "    fleet mail-server connect http://your-server:8025"
    );
  }

  log(`Found boring-mail at ${binary}`);

  // Check if already running on this port
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (resp.ok) {
      if (!opts?.quiet) warn(`Server already running on port ${port}`);
      const url = `http://127.0.0.1:${port}`;
      const localToken = readLocalAdminToken();
      if (localToken) {
        updateMailConfig(url, localToken);
        return { url, token: localToken };
      }
      // Running but no token found — still save URL
      updateMailConfig(url, null);
      throw new Error(`Server running on port ${port} but no admin token found in ~/.boring-mail/admin-token`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes("admin token")) throw e;
    // Not running — continue to start
  }

  // Resolve admin token: explicit > existing file > generate new
  let adminToken = opts?.token || null;
  const adminTokenPath = join(BORING_MAIL_DATA, "admin-token");

  if (!adminToken) {
    adminToken = readLocalAdminToken();
    if (adminToken) log(`Using existing admin token from ~/.boring-mail/admin-token`);
  }

  if (!adminToken) {
    adminToken = crypto.randomUUID();
    mkdirSync(BORING_MAIL_DATA, { recursive: true });
    writeFileSync(adminTokenPath, adminToken + "\n");
    log(`Generated admin token → ~/.boring-mail/admin-token`);
  } else if (!existsSync(adminTokenPath)) {
    // Migrate: write token to boring-mail path if only legacy exists
    mkdirSync(BORING_MAIL_DATA, { recursive: true });
    writeFileSync(adminTokenPath, adminToken + "\n");
  }

  // Start the server
  log(`Starting Fleet Mail on port ${port}...`);
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    BORING_MAIL_BIND: `0.0.0.0:${port}`,
    BORING_MAIL_ADMIN_TOKEN: adminToken,
  };

  const proc = Bun.spawn([binary, "serve"], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  // Wait for server to be ready (poll health endpoint)
  let ready = false;
  for (let i = 0; i < 20; i++) {
    await Bun.sleep(500);
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (resp.ok) {
        ready = true;
        break;
      }
    } catch {}
  }

  if (!ready) {
    proc.kill();
    throw new Error("Server failed to start within 10s");
  }

  const url = `http://127.0.0.1:${port}`;
  updateMailConfig(url, adminToken);

  // Detach — don't wait for the process
  proc.unref();

  if (!opts?.quiet) {
    ok(`Fleet Mail running at ${url} (PID: ${proc.pid})`);
    console.log(`\n  URL:   ${url}`);
    console.log(`  Token: ${adminToken.slice(0, 8)}...${adminToken.slice(-4)}`);
    console.log(`  PID:   ${proc.pid}`);
    console.log(`\n  Stop:  kill ${proc.pid}`);
    console.log(`  The server runs in the background.`);
  }

  return { url, token: adminToken };
}

async function startAction(args: { port?: string; token?: string }) {
  try {
    await startLocalServer({ port: args.port, token: args.token });
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

export function register(parent: Command): void {
  parent
    .command("mail-server [action] [url]")
    .description("Fleet Mail server management")
    .option("-t, --token <token>", "Admin token")
    .option("--port <port>", "Port for local server", "8025")
    .action(async (action: string | undefined, url: string | undefined, opts: { token?: string; port?: string }) => {
      const act = action || "status";

      switch (act) {
        case "connect":
          return connectAction({ url, token: opts.token });
        case "disconnect":
          return disconnectAction();
        case "status":
          return statusAction();
        case "start":
          return startAction({ port: opts.port, token: opts.token });
        default:
          fail(`Unknown action: ${act}\n\nUsage:\n  fleet mail-server connect <url> [--token <token>]\n  fleet mail-server disconnect\n  fleet mail-server status\n  fleet mail-server start [--port 8025]`);
      }
    });
}
