/**
 * fleet register — Auto-register the current session with Fleet Mail.
 *
 * Creates a mail account with name: {custom-name}-{dir-slug}-{session-id}
 * Stores identity + token in ~/.claude/fleet/.sessions/{session-id}/
 */

import type { Command } from "commander";
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { addGlobalOpts } from "../index";
import { FLEET_MAIL_URL } from "../lib/paths";
import { ok, fail, info, warn } from "../lib/fmt";
import {
  resolveSessionId,
  resolveDirSlug,
  buildMailName,
  sanitizeName,
  sessionDir,
  sessionsDir,
  loadSessionIdentity,
  type SessionIdentity,
} from "../../shared/identity";

export function register(parent: Command): void {
  const sub = parent
    .command("register")
    .description("Register current session with Fleet Mail")
    .option("-n, --name <name>", "Custom name (default: auto-detect from worktree or 'session')")
    .option("--session-id <id>", "Session ID (default: detect from TMUX_PANE)")
    .option("--quiet", "Suppress output (for hook scripts)");
  addGlobalOpts(sub)
    .action(async (opts: { name?: string; sessionId?: string; quiet?: boolean }) => {
      const sessionId = resolveSessionId({ sessionId: opts.sessionId });
      if (!sessionId) {
        if (!opts.quiet) fail("Cannot detect session ID. Pass --session-id or run inside tmux.");
        process.exit(1);
      }

      // Check if already registered
      const existing = loadSessionIdentity(sessionId);
      if (existing) {
        if (!opts.quiet) {
          ok(`Already registered: ${existing.mailName}`);
        } else {
          process.stdout.write(existing.mailName);
        }
        return;
      }

      if (!FLEET_MAIL_URL) {
        if (!opts.quiet) fail("Fleet Mail not configured — run: fleet mail-server connect <url>");
        process.exit(1);
      }

      const dirSlug = resolveDirSlug();
      const customName = sanitizeName(opts.name || detectCustomName());
      const mailName = buildMailName(customName, dirSlug, sessionId);

      // Check for other sessions in the same directory
      const siblings = findSiblingSessions(dirSlug, sessionId);

      // Create Fleet Mail account
      const resp = await fetch(`${FLEET_MAIL_URL}/api/accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: mailName,
          bio: `Fleet session: ${customName} in ${dirSlug} (session ${sessionId.slice(0, 8)}...)`,
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        if (resp.status === 409) {
          if (!opts.quiet) warn(`Account '${mailName}' already exists on server (re-registration)`);
          // Still save identity locally
        } else {
          if (!opts.quiet) fail(`Fleet Mail register failed (${resp.status}): ${errText}`);
          process.exit(1);
        }
      }

      const data = resp.ok ? await resp.json() as { bearerToken: string } : null;
      const token = data?.bearerToken;

      // Persist session identity
      const dir = sessionDir(sessionId);
      mkdirSync(dir, { recursive: true });

      const paneId = process.env.TMUX_PANE || null;

      const identity: SessionIdentity = {
        mailName,
        sessionId,
        dirSlug,
        customName,
        cwd: process.cwd(),
        paneId,
        registeredAt: new Date().toISOString(),
      };

      writeFileSync(join(dir, "identity.json"), JSON.stringify(identity, null, 2) + "\n");
      if (token) writeFileSync(join(dir, "token"), token);
      writeFileSync(join(dir, "state.json"), JSON.stringify({}, null, 2) + "\n");

      // Create empty mission.md
      const missionPath = join(dir, "mission.md");
      try { readFileSync(missionPath); } catch {
        writeFileSync(missionPath, "# Mission\n\n<!-- Fill in your mission as you understand your task -->\n");
      }

      if (!opts.quiet) {
        ok(`Registered: ${mailName}`);
        info(`  Session: ${sessionId}`);
        info(`  Dir: ${dirSlug}`);
        if (paneId) info(`  Pane: ${paneId}`);
        if (siblings.length > 0) {
          warn(`Other sessions in ${dirSlug}: ${siblings.map(s => s.mailName).join(", ")}`);
          info("  Consider running: fleet register --name <unique-name>");
        }
      } else {
        process.stdout.write(mailName);
      }
    });
}

/** Auto-detect a custom name from worktree or WORKER_NAME env. */
function detectCustomName(): string {
  // WORKER_NAME env (set by fleet create)
  if (process.env.WORKER_NAME) return process.env.WORKER_NAME;

  // Git branch: worker/merger → merger
  try {
    const { execSync } = require("child_process");
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf-8", timeout: 5000,
    }).trim();
    if (branch.startsWith("worker/")) return branch.slice("worker/".length);
  } catch {}

  // Worktree dir: Project-w-merger → merger
  const dirName = require("path").basename(process.cwd());
  const match = dirName.match(/-w-(.+)$/);
  if (match) return match[1];

  return "session";
}

/** Find other live sessions in the same directory (checks tmux pane liveness). */
function findSiblingSessions(dirSlug: string, excludeSessionId: string): SessionIdentity[] {
  try {
    const dirs = readdirSync(sessionsDir());
    return dirs
      .filter(d => d !== excludeSessionId)
      .map(d => {
        try {
          const id = JSON.parse(readFileSync(join(sessionsDir(), d, "identity.json"), "utf-8")) as SessionIdentity;
          if (id.dirSlug !== dirSlug) return null;
          // Check if pane is alive
          if (id.paneId) {
            try {
              const { spawnSync } = require("child_process");
              const r = spawnSync("tmux", ["display-message", "-t", id.paneId, "-p", ""], {
                encoding: "utf-8", timeout: 2000, stdio: "pipe",
              });
              if (r.status !== 0) return null;
            } catch {
              return null; // Pane dead — skip
            }
          }
          return id;
        } catch { return null; }
      })
      .filter((id): id is SessionIdentity => id !== null);
  } catch {
    return [];
  }
}
