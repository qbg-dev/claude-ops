/**
 * fleet session — Session lifecycle management.
 *
 *   fleet session ls                         — List all registered sessions
 *   fleet session info [--session-id <id>]   — Show session identity + state
 *   fleet session sync [--session-id <id>]   — Upload session file to Fleet Mail
 */

import type { Command } from "commander";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { addGlobalOpts } from "../index";
import { fail, ok, info, table } from "../lib/fmt";
import { FLEET_MAIL_URL } from "../lib/paths";
import {
  resolveSessionId,
  sessionDir,
  loadSessionIdentity,
  listSessionIdentities,
  type SessionIdentity,
} from "../../shared/identity";

export function register(parent: Command): void {
  const session = parent
    .command("session")
    .description("Session lifecycle management");

  // ── fleet session ls ────────────────────────────────────────────
  const ls = session
    .command("ls")
    .description("List all registered sessions");
  addGlobalOpts(ls)
    .action(async () => {
      const sessions = listSessionIdentities();
      if (!sessions.length) {
        info("No sessions registered. Sessions auto-register on first prompt.");
        return;
      }

      const rows = sessions.map(s => {
        const alive = isSessionAlive(s);
        return [
          s.customName,
          s.dirSlug,
          s.sessionId.slice(0, 8) + "...",
          s.paneId || "-",
          alive ? "alive" : "dead",
          s.registeredAt.slice(0, 19),
        ];
      });

      table(
        ["Name", "Dir", "Session", "Pane", "Status", "Registered"],
        rows,
      );
    });

  // ── fleet session info ──────────────────────────────────────────
  const infoCmd = session
    .command("info")
    .description("Show session identity and state")
    .option("--session-id <id>", "Session ID");
  addGlobalOpts(infoCmd)
    .action(async (opts: { sessionId?: string }) => {
      const sessionId = resolveSessionId({ sessionId: opts.sessionId });
      if (!sessionId) return fail("Cannot detect session ID");

      const identity = loadSessionIdentity(sessionId);
      if (!identity) return fail(`No identity found for session ${sessionId}`);

      console.log(JSON.stringify({
        ...identity,
        alive: isSessionAlive(identity),
        state: loadState(sessionId),
      }, null, 2));
    });

  // ── fleet session sync ──────────────────────────────────────────
  const sync = session
    .command("sync")
    .description("Upload session file to Fleet Mail server")
    .option("--session-id <id>", "Session ID");
  addGlobalOpts(sync)
    .action(async (opts: { sessionId?: string }) => {
      if (!FLEET_MAIL_URL) return fail("Fleet Mail not configured");

      const sessionId = resolveSessionId({ sessionId: opts.sessionId });
      if (!sessionId) return fail("Cannot detect session ID");

      const identity = loadSessionIdentity(sessionId);
      if (!identity) return fail(`No identity found for session ${sessionId}`);

      // Find the session transcript file
      const transcriptPath = findTranscriptPath(sessionId);
      if (!transcriptPath) {
        info("No transcript file found — nothing to sync");
        return;
      }

      const fileSize = statSync(transcriptPath).size;
      if (fileSize === 0) {
        info("Transcript file is empty — nothing to sync");
        return;
      }

      // Read token
      const tokenPath = join(sessionDir(sessionId), "token");
      if (!existsSync(tokenPath)) return fail("No Fleet Mail token — run: fleet register");
      const token = readFileSync(tokenPath, "utf-8").trim();

      // Upload as blob
      const fileData = readFileSync(transcriptPath);
      const resp = await fetch(`${FLEET_MAIL_URL}/api/blobs`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
        },
        body: fileData,
      });

      if (!resp.ok) {
        const err = await resp.text().catch(() => "");
        return fail(`Upload failed (${resp.status}): ${err}`);
      }

      const data = await resp.json() as { hash: string };

      // Update account bio with sync metadata
      await fetch(`${FLEET_MAIL_URL}/api/accounts/me`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          bio: `session_blob:${data.hash},synced_at:${new Date().toISOString()},size:${fileSize}`,
        }),
      });

      ok(`Synced ${(fileSize / 1024).toFixed(1)}KB → blob:${data.hash.slice(0, 12)}...`);
    });
}

/** Check if a session's tmux pane is still alive. */
function isSessionAlive(identity: SessionIdentity): boolean {
  if (!identity.paneId) return false;
  try {
    const { execSync } = require("child_process");
    execSync(`tmux display-message -t '${identity.paneId}' -p ''`, {
      encoding: "utf-8", timeout: 3000, stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/** Load state.json for a session. */
function loadState(sessionId: string): Record<string, unknown> {
  const statePath = join(sessionDir(sessionId), "state.json");
  try { return JSON.parse(readFileSync(statePath, "utf-8")); } catch { return {}; }
}

/** Find the JSONL transcript file for a session.
 *  Claude Code stores transcripts in ~/.claude/projects/{slug}/{session_id}.jsonl */
function findTranscriptPath(sessionId: string): string | null {
  const HOME = process.env.HOME || "/tmp";
  const projectsDir = join(HOME, ".claude/projects");
  try {
    const { readdirSync } = require("fs");
    for (const slug of readdirSync(projectsDir)) {
      const candidate = join(projectsDir, slug, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  } catch {}
  return null;
}
