import { defineCommand } from "citty";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { FLEET_MAIL_URL, workerDir, resolveProject } from "../lib/paths";
import { fail } from "../lib/fmt";

export default defineCommand({
  meta: { name: "mail", description: "Check worker's Fleet Mail inbox" },
  args: {
    name:    { type: "positional", description: "Worker name", required: true },
    label:   { type: "string", description: "Filter by label", default: "UNREAD" },
    project: { type: "string", description: "Override project detection" },
  },
  async run({ args }) {
    const project = args.project || resolveProject();
    const tokenPath = join(workerDir(project, args.name), "token");

    if (!existsSync(tokenPath)) fail(`No token for '${args.name}'`);
    const token = readFileSync(tokenPath, "utf-8").trim();
    if (!token) fail(`Empty token for '${args.name}'`);

    try {
      const resp = await fetch(
        `${FLEET_MAIL_URL}/api/messages?label=${args.label}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );

      if (!resp.ok) {
        console.log("Fleet Mail unreachable or error:", resp.status);
        process.exit(1);
      }

      const data = await resp.json() as { messages?: Array<{ id: string; from: string; subject: string; date: string }> };
      if (!data.messages?.length) {
        console.log(`No messages with label '${args.label}'`);
        return;
      }

      for (const msg of data.messages) {
        console.log(JSON.stringify({ id: msg.id, from: msg.from, subject: msg.subject, date: msg.date }, null, 2));
      }
    } catch {
      console.log("Fleet Mail unreachable");
      process.exit(1);
    }
  },
});
