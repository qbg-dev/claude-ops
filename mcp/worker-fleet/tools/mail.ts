/**
 * Mail tools — mail_send, mail_inbox, mail_read, mail_help
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readdirSync } from "fs";
import { execSync } from "child_process";
import { WORKERS_DIR, WORKER_NAME } from "../config";
import { readRegistry, type RegistryWorkerEntry } from "../registry";
import { isPaneAlive, isPaneOwnedBy, tmuxSendMessage, resolveRecipient } from "../tmux";
import { withLint } from "../diagnostics";
import { readFileSync } from "fs";
import { join } from "path";
import { FLEET_DIR, FLEET_MAIL_URL as MAIL_URL_CONFIG } from "../config";
import { fleetMailRequest, resolveFleetMailRecipients, getFleetMailToken, fleetMailTextResult, mailAccountName, FLEET_MAIL_URL } from "../mail-client";

const BACKPRESSURE_THRESHOLD = 10;

/** Get unread count for a specific worker (best-effort, returns 0 on failure) */
async function getRecipientUnreadCount(workerName: string): Promise<number> {
  const tokenPath = join(FLEET_DIR, workerName, "token");
  let token: string;
  try { token = readFileSync(tokenPath, "utf-8").trim(); } catch { return 0; }
  if (!token) return 0;
  try {
    const resp = await fetch(
      `${MAIL_URL_CONFIG}/api/messages?label=UNREAD&maxResults=1`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) },
    );
    if (!resp.ok) return 0;
    const data = await resp.json() as any;
    return data?._diagnostics?.unread_count ?? data?.messages?.length ?? 0;
  } catch { return 0; }
}

export function registerMailTools(server: McpServer): void {

// ── mail_send — unified messaging (Fleet Mail durable + tmux instant) ──────

// @ts-ignore — MCP SDK deep type instantiation with Zod
server.registerTool(
  "mail_send",
  {
    description: `Send a message to another worker, the human operator, or the entire fleet. Messages are durably stored in Fleet Mail (persist across restarts, searchable, threaded) and delivered instantly via tmux overlay if the recipient's pane is live.

Routing:
- Worker name (e.g. "merger"): direct message via Fleet Mail + tmux push.
- "report": message whoever you report_to (resolved from registry).
- "direct_reports": fan-out to all workers who report_to you.
- "all": broadcast to every registered worker (expensive — use sparingly).
- "user": escalate to the human operator (triage queue + desktop notification, NOT via Fleet Mail).
- Raw pane ID (e.g. "%42"): tmux-only delivery, no durable storage.

Escalate to operator when: (1) design/architecture decisions need human judgment, (2) security or auth changes arise, (3) business logic changes affect end users, (4) new product surface area, (5) removing functionality, (6) external coordination needed, (7) blocked and need product direction. When in doubt, escalate.`,
    inputSchema: {
      to: z.string().describe('Recipient: worker name, "report", "direct_reports", "all", "user", or raw pane ID "%NN"'),
      subject: z.string().describe("Email subject line (5-15 words)"),
      body: z.string().describe("Message body"),
      cc: z.array(z.string()).optional().describe("CC recipients (worker names)"),
      thread_id: z.string().optional().describe("Thread ID to reply in (continues a conversation)"),
      in_reply_to: z.string().optional().describe("Message ID being replied to (marks it acknowledged)"),
      reply_by: z.string().optional().describe("ISO timestamp deadline for reply"),
      labels: z.array(z.string()).optional().describe("Additional labels (e.g. URGENT, MERGE-REQUEST)"),
    },
  },
  async ({ to, subject, body, cc, thread_id, in_reply_to, reply_by, labels }: {
    to: string; subject: string; body: string; cc?: string[]; thread_id?: string;
    in_reply_to?: string; reply_by?: string; labels?: string[];
  }) => {
    // Validate recipient
    if (!to || !to.trim()) {
      return { content: [{ type: "text" as const, text: `Error: 'to' field is empty. Provide a worker name, "user", "all", or pane ID.` }], isError: true };
    }

    // Operator escalation path: send via Fleet Mail to "user" account + desktop notification
    if (to === "user") {
      let msgId = "";
      try {
        const toIds = await resolveFleetMailRecipients(["user"], subject);
        const ccIds = cc ? await resolveFleetMailRecipients(cc, subject) : [];
        const result = await fleetMailRequest("POST", "/api/messages/send", {
          to: toIds, subject, body,
          cc: ccIds, thread_id: thread_id || null, in_reply_to: in_reply_to || null,
          reply_by: reply_by || null, labels: [...(labels || []), "ESCALATION"], attachments: [],
        });
        msgId = result?.id || "";
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error sending to operator via Fleet Mail: ${e.message}` }], isError: true };
      }
      // Desktop notification (best-effort)
      try {
        execSync(
          `terminal-notifier -title "Worker Escalation" -message ${JSON.stringify(`[${WORKER_NAME}] ${subject}`)} -sound default 2>/dev/null || osascript -e 'display notification ${JSON.stringify(`[${WORKER_NAME}] ${subject}`)} with title "Worker Escalation" sound name "default"'`,
          { timeout: 5000, shell: "/bin/bash" }
        );
      } catch {}
      return withLint({ content: [{ type: "text" as const, text: `Sent to operator via Fleet Mail [${msgId}] + desktop notification` }] });
    }

    // Raw pane ID — tmux-only, no Fleet Mail
    if (to.startsWith("%")) {
      if (!isPaneAlive(to)) {
        return { content: [{ type: "text" as const, text: `Error: Pane ${to} is dead` }], isError: true };
      }
      try {
        tmuxSendMessage(to, `[msg from ${WORKER_NAME}] ${body}`);
        return { content: [{ type: "text" as const, text: `Sent to pane ${to} (tmux-only, no Fleet Mail)` }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    }

    // Resolve fleet routing → list of worker names
    let recipientNames: string[] = [];
    if (to === "all") {
      try {
        recipientNames = readdirSync(WORKERS_DIR, { withFileTypes: true })
          .filter(d => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"))
          .map(d => d.name)
          .filter(name => name !== WORKER_NAME);
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error listing workers: ${e.message}` }], isError: true };
      }
    } else if (to === "report" || to === "direct_reports") {
      const resolved = resolveRecipient(to);
      if (resolved.error) {
        return { content: [{ type: "text" as const, text: `Error: ${resolved.error}` }], isError: true };
      }
      if (resolved.type === "multi_worker") {
        recipientNames = resolved.workerNames || [];
      } else if (resolved.workerName) {
        recipientNames = [resolved.workerName];
      }
    } else {
      recipientNames = [to];
    }

    if (recipientNames.length === 0) {
      return { content: [{ type: "text" as const, text: "No recipients resolved" }], isError: true };
    }

    // Resolve CC once (not per-recipient)
    const ccIds = cc ? await resolveFleetMailRecipients(cc, subject) : [];

    // Send via Fleet Mail (durable delivery) — parallel fan-out
    const mailSuccesses: string[] = [];
    const mailFailures: string[] = [];
    const tmuxDelivered: string[] = [];
    let lastMsgId = "";

    const sendResults = await Promise.allSettled(
      recipientNames.map(async (name) => {
        const toIds = await resolveFleetMailRecipients([name], subject);
        const result = await fleetMailRequest("POST", "/api/messages/send", {
          to: toIds, subject, body,
          cc: ccIds, thread_id: thread_id || null, in_reply_to: in_reply_to || null,
          reply_by: reply_by || null, labels: labels || [], attachments: [],
        });
        return { name, id: result?.id || "" };
      })
    );

    for (const r of sendResults) {
      if (r.status === "fulfilled") {
        mailSuccesses.push(r.value.name);
        lastMsgId = r.value.id;
      } else {
        const reason = (r.reason as Error)?.message?.slice(0, 80) || "unknown";
        // Extract worker name from the promise index
        const idx = sendResults.indexOf(r);
        mailFailures.push(`${recipientNames[idx]}: ${reason}`);
      }
    }

    // Tmux instant delivery (best-effort overlay)
    const registry = (() => { try { return readRegistry(); } catch { return {} as any; } })();
    for (const name of mailSuccesses) {
      try {
        const entry = registry[name] as RegistryWorkerEntry | undefined;
        const paneId = entry?.pane_id;
        if (paneId && isPaneOwnedBy(paneId, name)) {
          const prefix = recipientNames.length > 1 ? `[broadcast from ${WORKER_NAME}]` : `[mail from ${WORKER_NAME}]`;
          tmuxSendMessage(paneId, `${prefix} ${subject}: ${body}`);
          tmuxDelivered.push(name);
        }
      } catch {}
    }

    // Build result
    if (mailSuccesses.length === 0) {
      return { content: [{ type: "text" as const, text: `Failed to send to all recipients:\n${mailFailures.join("\n")}` }], isError: true };
    }

    const parts: string[] = [];
    if (recipientNames.length === 1) {
      let paneWarning = "";
      const entry = registry[recipientNames[0]] as RegistryWorkerEntry | undefined;
      if (entry && (!entry.pane_id || !isPaneAlive(entry.pane_id))) {
        paneWarning = ` (WARNING: no active pane — queued in Fleet Mail inbox)`;
      }
      // Backpressure warning: check recipient's unread count
      let backpressureWarning = "";
      try {
        const unreadCount = await getRecipientUnreadCount(recipientNames[0]);
        if (unreadCount > BACKPRESSURE_THRESHOLD) {
          backpressureWarning = ` (⚠ recipient has ${unreadCount} unread messages — may be slow to respond)`;
        }
      } catch {}
      parts.push(`Sent to ${recipientNames[0]} [${lastMsgId}]${paneWarning}${backpressureWarning}`);
    } else {
      parts.push(`Sent to ${mailSuccesses.length}/${recipientNames.length} workers`);
      if (tmuxDelivered.length > 0) parts.push(`Tmux overlay: ${tmuxDelivered.join(", ")}`);
      if (mailFailures.length > 0) parts.push(`Failed: ${mailFailures.join(", ")}`);
    }

    return withLint({ content: [{ type: "text" as const, text: parts.join("\n") }] });
  }
);

// ── mail_inbox — read from Fleet Mail ──────────────────────────────────────

// @ts-ignore — MCP SDK deep type instantiation with Zod
server.registerTool(
  "mail_inbox",
  {
    description: "Read messages from your Fleet Mail inbox. Call at the start of every cycle — messages may contain instructions, merge notifications, or approval requests that should be acted on before starting new work. Returns messages with sender, subject, labels, and timestamps. Use label='UNREAD' for unread-only.",
    inputSchema: {
      label: z.string().optional().describe("Label filter (default: UNREAD). Common: INBOX, UNREAD, SENT, STARRED, TRASH"),
      maxResults: z.number().optional().describe("Max messages to return (default: 20)"),
      pageToken: z.string().optional().describe("Pagination token from previous response"),
    },
  },
  async ({ label, maxResults, pageToken }: { label?: string; maxResults?: number; pageToken?: string }) => {
    try {
      let path = `/api/messages?label=${label || "UNREAD"}&maxResults=${maxResults || 20}`;
      if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;
      const result = await fleetMailRequest("GET", path);
      return withLint(fleetMailTextResult(result));
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: e.message }], isError: true };
    }
  }
);

// ── mail_read — get full message by ID ──────────────────────────────

// @ts-ignore — MCP SDK deep type instantiation with Zod
server.registerTool(
  "mail_read",
  {
    description: "Get full email details by ID. Auto-removes UNREAD label.",
    inputSchema: {
      id: z.string().describe("Message ID"),
    },
  },
  async ({ id }: { id: string }) => {
    try {
      const result = await fleetMailRequest("GET", `/api/messages/${encodeURIComponent(id)}`);
      return fleetMailTextResult(result);
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: e.message }], isError: true };
    }
  }
);

// mail_search + mail_thread — REMOVED (documented in mail_help with curl examples)

// ── Management reference (1) — on-demand CLI docs ───────────────────

// @ts-ignore — MCP SDK deep type instantiation with Zod
server.registerTool(
  "mail_help",
  {
    description: "Get Fleet Mail CLI docs for search, threads, labels, trash, directory, mailing lists, and raw curl. Call this for any mail operation beyond send/inbox/read.",
    inputSchema: {},
  },
  async () => {
    const token = await getFleetMailToken().catch(() => "<your-token>");
    return fleetMailTextResult(`# Fleet Mail — Management CLI

Server: ${FLEET_MAIL_URL}
Your account: ${mailAccountName(WORKER_NAME)}
Your token: ${token}

## Search (replaces mail_search tool)

  # Gmail-style query syntax: from:, to:, subject:, has:attachment, label:, date ranges
  curl -sf "${FLEET_MAIL_URL}/api/search?q=from:merger&maxResults=20" \\
    -H "Authorization: Bearer $TOKEN"

## Threads (replaces mail_thread tool)

  # Get full conversation thread
  curl -sf "${FLEET_MAIL_URL}/api/threads/<thread-id>" \\
    -H "Authorization: Bearer $TOKEN"

  # List threads by label
  curl -sf "${FLEET_MAIL_URL}/api/threads?label=INBOX&maxResults=20" \\
    -H "Authorization: Bearer $TOKEN"

## Token Management

  # Reset your bearer token (invalidates old one, returns new)
  curl -sf -X POST "${FLEET_MAIL_URL}/api/accounts/me/reset-token" \\
    -H "Authorization: Bearer $TOKEN"
  # Response: {"bearerToken":"<new-uuid>","id":"...","name":"..."}
  # After reset, update registry.json: bms_token field for your worker

## Label Operations

  # List labels with counts
  curl -sf "${FLEET_MAIL_URL}/api/labels" -H "Authorization: Bearer $TOKEN"

  # Add/remove labels on a message
  curl -sf -X POST "${FLEET_MAIL_URL}/api/messages/<msg-id>/modify" \\
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
    -d '{"addLabelIds":["STARRED"],"removeLabelIds":["UNREAD"]}'

  # Create custom label
  curl -sf -X POST "${FLEET_MAIL_URL}/api/labels" \\
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
    -d '{"name":"MY-LABEL"}'

  # Delete custom label
  curl -sf -X DELETE "${FLEET_MAIL_URL}/api/labels/MY-LABEL" \\
    -H "Authorization: Bearer $TOKEN"

## Message Management

  # Trash a message
  curl -sf -X POST "${FLEET_MAIL_URL}/api/messages/<msg-id>/trash" \\
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}'

  # Permanently delete
  curl -sf -X DELETE "${FLEET_MAIL_URL}/api/messages/<msg-id>" \\
    -H "Authorization: Bearer $TOKEN"

  # Batch modify labels
  curl -sf -X POST "${FLEET_MAIL_URL}/api/messages/batchModify" \\
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
    -d '{"ids":["id1","id2"],"addLabelIds":["STARRED"],"removeLabelIds":[]}'

## Threads

  # List threads by label
  curl -sf "${FLEET_MAIL_URL}/api/threads?label=INBOX&maxResults=20" \\
    -H "Authorization: Bearer $TOKEN"

## Directory & Profile

  # List all accounts
  curl -sf "${FLEET_MAIL_URL}/api/directory" -H "Authorization: Bearer $TOKEN"

  # Search accounts
  curl -sf "${FLEET_MAIL_URL}/api/directory?q=merger" -H "Authorization: Bearer $TOKEN"

  # View own profile
  curl -sf "${FLEET_MAIL_URL}/api/accounts/me" -H "Authorization: Bearer $TOKEN"

  # Update bio
  curl -sf -X PUT "${FLEET_MAIL_URL}/api/accounts/me" \\
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
    -d '{"bio":"I handle code reviews"}'

## Mailing Lists

  # Create list
  curl -sf -X POST "${FLEET_MAIL_URL}/api/lists" \\
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
    -d '{"name":"team-all","description":"All team members"}'

  # Subscribe (self)
  curl -sf -X POST "${FLEET_MAIL_URL}/api/lists/<list-id>/subscribe" \\
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}'

  # Send to list (use list:name in to field)
  # mail_send(to=["list:team-all"], subject="...", body="...")

## Blob Attachments

  # Upload blob
  curl -sf -X POST "${FLEET_MAIL_URL}/api/blobs" \\
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/octet-stream" \\
    --data-binary @file.txt

  # Download blob
  curl -sf "${FLEET_MAIL_URL}/api/blobs/<sha256-hash>" -H "Authorization: Bearer $TOKEN" -o file.txt

## Health & Analytics

  curl -sf "${FLEET_MAIL_URL}/health"
  curl -sf "${FLEET_MAIL_URL}/api/analytics" -H "Authorization: Bearer $TOKEN"
`);
  }
);

} // end registerMailTools
