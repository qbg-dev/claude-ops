/**
 * fleet mail — Fleet Mail communication commands.
 *
 * Subcommands:
 *   fleet mail send <to> <subject> [body]   — Send a message
 *   fleet mail inbox [--label UNREAD]        — Read inbox
 *   fleet mail read <id>                     — Read a message by ID
 *   fleet mail help                          — Print API reference
 *
 * Also supports legacy: fleet mail <name> (read a worker's inbox)
 */

import type { Command } from "commander";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { FLEET_MAIL_URL, workerDir, resolveProject } from "../lib/paths";
import { fail, ok, info } from "../lib/fmt";
import { addGlobalOpts } from "../index";
import { mailRequest, resolveRecipient, cleanDisplayName } from "../lib/mail-client";
import { sanitizeName } from "../../shared/identity";

export function register(parent: Command): void {
  const mail = parent
    .command("mail")
    .description("Fleet Mail communication");

  // ── fleet mail send ─────────────────────────────────────────────
  const send = mail
    .command("send <to> <subject> [body]")
    .description("Send a message via Fleet Mail");
  addGlobalOpts(send)
    .action(async (to: string, subject: string, body: string | undefined) => {
      if (!FLEET_MAIL_URL) fail("Fleet Mail not configured — run: fleet mail-server connect <url>");

      // Read body from stdin if not provided
      let messageBody = body || "";
      if (!messageBody && !process.stdin.isTTY) {
        messageBody = await readStdin();
      }
      if (!messageBody) messageBody = "(no body)";

      const recipient = await resolveRecipient(to);

      const data = await mailRequest("POST", "/api/messages/send", {
        to: [recipient],
        subject,
        body: messageBody,
      }) as { id: string };

      ok(`Sent to ${cleanDisplayName(recipient)}: "${subject}" (id: ${data.id})`);
    });

  // ── fleet mail inbox ────────────────────────────────────────────
  const inbox = mail
    .command("inbox")
    .description("Read your Fleet Mail inbox")
    .option("-l, --label <label>", "Filter by label", "UNREAD")
    .option("-n, --max <count>", "Max messages", "20");
  addGlobalOpts(inbox)
    .action(async (opts: { label: string; max: string }) => {
      if (!FLEET_MAIL_URL) fail("Fleet Mail not configured — run: fleet mail-server connect <url>");

      const data = await mailRequest("GET", `/api/messages?label=${encodeURIComponent(opts.label)}&maxResults=${encodeURIComponent(opts.max)}`) as {
        messages?: Array<{ id: string; from: any; subject: string; date: string; snippet?: string }>;
      };

      if (!data.messages?.length) {
        info(`No messages with label '${opts.label}'`);
        return;
      }

      for (const msg of data.messages) {
        const from = typeof msg.from === "string" ? msg.from : msg.from?.name || "unknown";
        console.log(JSON.stringify({
          id: msg.id,
          from: cleanDisplayName(from),
          subject: msg.subject,
          date: msg.date,
          ...(msg.snippet ? { snippet: msg.snippet } : {}),
        }, null, 2));
      }
    });

  // ── fleet mail read ─────────────────────────────────────────────
  const read = mail
    .command("read <id>")
    .description("Read a message by ID (auto-marks as read)");
  addGlobalOpts(read)
    .action(async (id: string) => {
      if (!FLEET_MAIL_URL) fail("Fleet Mail not configured — run: fleet mail-server connect <url>");

      const msg = await mailRequest("GET", `/api/messages/${encodeURIComponent(id)}`) as {
        id: string; from: any; to: any[]; subject: string; body: string; date: string;
        labels?: string[]; thread_id?: string;
      };

      const from = typeof msg.from === "string" ? msg.from : msg.from?.name || "unknown";
      console.log(JSON.stringify({
        id: msg.id,
        from: cleanDisplayName(from),
        to: Array.isArray(msg.to) ? msg.to.map((t: any) =>
          cleanDisplayName(typeof t === "string" ? t : t?.name || "unknown")
        ) : msg.to,
        subject: msg.subject,
        date: msg.date,
        labels: msg.labels,
        thread_id: msg.thread_id,
        body: msg.body,
      }, null, 2));
    });

  // ── fleet mail help ─────────────────────────────────────────────
  mail
    .command("help")
    .description("Fleet Mail API reference")
    .action(() => {
      console.log(`Fleet Mail CLI Reference
========================

Send:    fleet mail send <to> "<subject>" "<body>"
         fleet mail send <to> "<subject>" < body.txt
Inbox:   fleet mail inbox [--label UNREAD|INBOX|TASK]
Read:    fleet mail read <id>

Recipient resolution:
  - Full mail name: merger-zPersonalProjects-abc123...
  - Substring match: merger (matches first account containing "merger")
  - Legacy: worker@project format still works

Labels:
  UNREAD, INBOX, SENT, TASK, P1, P2, PENDING, IN_PROGRESS, COMPLETED, BLOCKED

curl examples:
  Search:     curl -H "Authorization: Bearer $TOKEN" "$FLEET_MAIL_URL/api/search?q=from:merger+subject:done"
  Thread:     curl -H "Authorization: Bearer $TOKEN" "$FLEET_MAIL_URL/api/threads/<thread_id>"
  Labels:     curl -H "Authorization: Bearer $TOKEN" -X POST "$FLEET_MAIL_URL/api/messages/<id>/modify" -d '{"addLabelIds":["TASK"]}'
  Directory:  curl -H "Authorization: Bearer $TOKEN" "$FLEET_MAIL_URL/api/directory"
`);
    });

  // ── Legacy: fleet mail <name> (read worker inbox) ───────────────
  // Keep backward compatibility: if first arg doesn't match a subcommand, treat as worker name
  mail
    .argument("[name]", "Worker name (legacy — reads worker inbox)")
    .option("-l, --label <label>", "Filter by label", "UNREAD")
    .action(async (name: string | undefined, opts: { label: string }, cmd: Command) => {
      if (!name) return; // Handled by subcommands
      // Skip if it's a subcommand name
      if (["send", "inbox", "read", "help"].includes(name)) return;

      // Legacy path: read a worker's inbox by name
      const project = cmd.optsWithGlobals().project as string || resolveProject();
      const safeName = sanitizeName(name);
      const tokenPath = join(workerDir(project, safeName), "token");

      if (!existsSync(tokenPath)) fail(`No token for '${name}'`);
      const token = readFileSync(tokenPath, "utf-8").trim();
      if (!token) fail(`Empty token for '${name}'`);
      if (!FLEET_MAIL_URL) fail("Fleet Mail not configured — run: fleet mail-server connect <url>");

      try {
        const resp = await fetch(
          `${FLEET_MAIL_URL}/api/messages?label=${encodeURIComponent(opts.label)}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!resp.ok) fail(`Fleet Mail error: ${resp.status}`);
        const data = await resp.json() as { messages?: Array<{ id: string; from: string; subject: string; date: string }> };
        if (!data.messages?.length) {
          console.log(`No messages with label '${opts.label}'`);
          return;
        }
        for (const msg of data.messages) {
          console.log(JSON.stringify(msg, null, 2));
        }
      } catch {
        fail("Fleet Mail unreachable");
      }
    });
}

/** Read all of stdin as a string. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}
