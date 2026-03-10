import { defineCommand } from "citty";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { FLEET_DATA, FLEET_DIR, FLEET_MAIL_URL } from "../lib/paths";
import { getConfig, getState } from "../lib/config";
import { listPaneIds, sessionExists } from "../lib/tmux";

export default defineCommand({
  meta: { name: "status", description: "Fleet overview — sessions, workers, mail, MCP" },
  args: {
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    const HOME = process.env.HOME || "/tmp";
    const panes = listPaneIds();

    // Discover projects + workers
    let projects: string[] = [];
    try {
      projects = readdirSync(FLEET_DATA, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch {}

    const counts = { active: 0, sleeping: 0, idle: 0, dead: 0 };
    let totalWorkers = 0;

    for (const project of projects) {
      let workers: string[];
      try {
        workers = readdirSync(join(FLEET_DATA, project), { withFileTypes: true })
          .filter(d => d.isDirectory() && !["missions", "_user", "_config"].includes(d.name))
          .map(d => d.name);
      } catch { continue; }

      for (const name of workers) {
        const config = getConfig(project, name);
        const state = getState(project, name);
        if (!config || !state) continue;

        totalWorkers++;
        let status = state.status || "unknown";
        if (status === "active" && state.pane_id && !panes.has(state.pane_id)) {
          status = "dead";
        }
        if (status in counts) counts[status as keyof typeof counts]++;
      }
    }

    // tmux session check
    const tmuxSessions: string[] = [];
    const tmuxResult = Bun.spawnSync(["tmux", "list-sessions", "-F", "#{session_name}"], { stderr: "pipe" });
    if (tmuxResult.exitCode === 0) {
      tmuxSessions.push(...tmuxResult.stdout.toString().trim().split("\n").filter(Boolean));
    }

    // MCP registration
    const settingsFile = join(HOME, ".claude/settings.json");
    let mcpRegistered = false;
    if (existsSync(settingsFile)) {
      try {
        const s = JSON.parse(readFileSync(settingsFile, "utf-8"));
        mcpRegistered = !!s?.mcpServers?.["worker-fleet"];
      } catch {}
    }

    // Fleet Mail reachability
    let mailStatus = "unknown";
    try {
      const resp = await fetch(`${FLEET_MAIL_URL}/health`, { signal: AbortSignal.timeout(3000) });
      mailStatus = resp.ok ? "reachable" : `error (${resp.status})`;
    } catch {
      mailStatus = "unreachable";
    }

    if (args.json) {
      console.log(JSON.stringify({
        projects: projects.length,
        workers: totalWorkers,
        counts,
        tmux_sessions: tmuxSessions,
        mcp_registered: mcpRegistered,
        fleet_mail: mailStatus,
      }, null, 2));
      return;
    }

    // Pretty output
    console.log(chalk.bold("Fleet Status"));
    console.log("");

    // Projects
    console.log(`  ${chalk.cyan("Projects:")}  ${projects.length > 0 ? projects.join(", ") : chalk.dim("none")}`);

    // Workers
    const parts: string[] = [];
    if (counts.active > 0) parts.push(chalk.green(`${counts.active} active`));
    if (counts.sleeping > 0) parts.push(chalk.yellow(`${counts.sleeping} sleeping`));
    if (counts.idle > 0) parts.push(chalk.dim(`${counts.idle} idle`));
    if (counts.dead > 0) parts.push(chalk.red(`${counts.dead} dead`));
    console.log(`  ${chalk.cyan("Workers:")}   ${totalWorkers} total (${parts.join(", ") || "none"})`);

    // tmux
    console.log(`  ${chalk.cyan("tmux:")}      ${tmuxSessions.length > 0 ? tmuxSessions.join(", ") : chalk.red("no sessions")}`);

    // MCP
    console.log(`  ${chalk.cyan("MCP:")}       ${mcpRegistered ? chalk.green("registered") : chalk.red("not registered")}`);

    // Fleet Mail
    const mailColor = mailStatus === "reachable" ? chalk.green : chalk.red;
    console.log(`  ${chalk.cyan("Mail:")}      ${mailColor(mailStatus)} ${chalk.dim(`(${FLEET_MAIL_URL})`)}`);
  },
});
