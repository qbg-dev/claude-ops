#!/usr/bin/env bun
/**
 * harness-api — Local Bun server that serves harness state as JSON.
 * Run: bun run ~/.claude-ops/scripts/harness-api.ts
 * Listens on :7777 with CORS enabled for qbg.dev.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join } from "path";

const PORT = parseInt(process.env.HARNESS_API_PORT || "7777");
const HOME = process.env.HOME || "/Users/wz";
const MANIFESTS_DIR = join(HOME, ".claude-ops/harness/manifests");
const HEALTH_FILE = "/tmp/harness_health.json";
const METRICS_FILE = "/tmp/harness_metrics.jsonl";
const SWEEP_STATE = "/tmp/harness_sweep_state.json";
const SESSION_REGISTRY = join(HOME, ".claude-ops/state/session-registry.json");
const PID_FILE = "/tmp/harness_control_plane.pid";

function readJson(path: string, fallback: any = null): any {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return fallback;
  }
}

function readManifests() {
  const results: any[] = [];
  try {
    if (!existsSync(MANIFESTS_DIR)) return results;
    for (const name of readdirSync(MANIFESTS_DIR)) {
      const manifest = readJson(join(MANIFESTS_DIR, name, "manifest.json"));
      if (!manifest) continue;
      let progress: any = null;
      if (manifest.project_root && manifest.files?.progress) {
        progress = readJson(join(manifest.project_root, manifest.files.progress));
      }
      results.push({ name, manifest, progress });
    }
  } catch {}
  return results;
}

function getControlPlane(): { running: boolean; pid: number | null } {
  try {
    if (!existsSync(PID_FILE)) return { running: false, pid: null };
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
    if (isNaN(pid)) return { running: false, pid: null };
    try { process.kill(pid, 0); return { running: true, pid }; }
    catch { return { running: false, pid }; }
  } catch { return { running: false, pid: null }; }
}

function readMetrics(limit: number): any[] {
  try {
    if (!existsSync(METRICS_FILE)) return [];
    const lines = readFileSync(METRICS_FILE, "utf-8").trim().split("\n");
    return lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function getLatestIdleSeconds(): Record<string, number> {
  const result: Record<string, number> = {};
  try {
    if (!existsSync(METRICS_FILE)) return result;
    const lines = readFileSync(METRICS_FILE, "utf-8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const m = JSON.parse(lines[i]);
        if (m.harness && m.idle_seconds != null && !(m.harness in result)) {
          result[m.harness] = m.idle_seconds;
        }
      } catch {}
    }
  } catch {}
  return result;
}

function getProjectRoots(): string[] {
  const roots = new Set<string>();
  try {
    if (!existsSync(MANIFESTS_DIR)) return [];
    for (const name of readdirSync(MANIFESTS_DIR)) {
      const manifest = readJson(join(MANIFESTS_DIR, name, "manifest.json"));
      if (manifest?.project_root) roots.add(manifest.project_root);
    }
  } catch {}
  return Array.from(roots);
}

function readIssues(): any[] {
  const issues: any[] = [];
  for (const root of getProjectRoots()) {
    const file = join(root, "claude_files/agent-issues.jsonl");
    try {
      if (!existsSync(file)) continue;
      const content = readFileSync(file, "utf-8").trim();
      if (!content) continue;
      for (const line of content.split("\n")) {
        try {
          const issue = JSON.parse(line);
          issue.project_root = root;
          issues.push(issue);
        } catch {}
      }
    } catch {}
  }
  return issues.sort((a, b) => {
    const ta = a.timestamp || a.ts || "";
    const tb = b.timestamp || b.ts || "";
    return tb.localeCompare(ta);
  });
}

function readAgents(): any[] {
  const agents: any[] = [];
  try {
    const tmpFiles = readdirSync("/tmp").filter(f => f.startsWith("tmux_pane_meta_"));
    for (const f of tmpFiles) {
      const paneId = f.replace("tmux_pane_meta_", "");
      const meta = readJson(join("/tmp", f));
      if (!meta) continue;
      const statusFile = join("/tmp", `tmux_pane_status_${paneId}`);
      let statusText = "";
      try {
        if (existsSync(statusFile)) statusText = readFileSync(statusFile, "utf-8").trim();
      } catch {}
      // Compute idle from file mtime
      let idleSeconds: number | null = null;
      try {
        const metaStat = statSync(join("/tmp", f));
        idleSeconds = Math.floor((Date.now() - metaStat.mtimeMs) / 1000);
      } catch {}
      agents.push({
        pane_id: paneId,
        harness: meta.harness || null,
        task: meta.task || null,
        done: meta.done ?? null,
        total: meta.total ?? null,
        display: meta.display || null,
        status_text: statusText,
        idle_seconds: idleSeconds,
      });
    }
  } catch {}
  return agents;
}

const SWEEP_INTERVALS_MAP: Record<string, number> = {
  "dead-agent-detector": 240,
  "progress-reconcile": 1200,
  "commit-reminder": 1800,
  "claude-md-cleanup": 3600,
  "meta-reflect": 3600,
  "stale-cleanup": 7200,
  "file-index": 7200,
  "issue-triage": 1200,
};

function readSweeps(): any[] {
  const sweepState = readJson(SWEEP_STATE, {});
  const results: any[] = [];

  // Collect all sweep keys (deduplicate numbered vs unnumbered)
  const seenClean = new Set<string>();
  const sweepKeys: { key: string; clean: string; epoch: number }[] = [];
  for (const [key, val] of Object.entries(sweepState) as [string, any][]) {
    // Skip non-sweep keys like "liveness", "readiness", "stuck", "reconcile"
    if (!key.startsWith("sweep_") && !key.startsWith("sweep_0")) continue;
    const epoch = typeof val === "number" ? val : val?.last_run;
    if (!epoch) continue;
    // Clean: sweep_03-stale-cleanup → stale-cleanup, sweep_stale-cleanup → stale-cleanup
    const clean = key.replace(/^sweep_\d+-/, "").replace(/^sweep_/, "").replace(/\.sh$/, "");
    // Prefer unnumbered keys (newer format) over numbered
    if (seenClean.has(clean)) {
      // Keep the one with the more recent epoch
      const existing = sweepKeys.find(s => s.clean === clean);
      if (existing && epoch > existing.epoch) {
        existing.key = key;
        existing.epoch = epoch;
      }
      continue;
    }
    seenClean.add(clean);
    sweepKeys.push({ key, clean, epoch });
  }

  // Read sweep actions from metrics
  const allSweepActions: Record<string, any[]> = {};
  try {
    if (existsSync(METRICS_FILE)) {
      const lines = readFileSync(METRICS_FILE, "utf-8").trim().split("\n");
      // Scan last 2000 lines for sweep events
      const start = Math.max(0, lines.length - 2000);
      for (let i = start; i < lines.length; i++) {
        try {
          const m = JSON.parse(lines[i]);
          if (m.type !== "sweep" || !m.name) continue;
          const clean = m.name.replace(/^sweep_\d+-/, "").replace(/^sweep_/, "").replace(/\.sh$/, "");
          if (!allSweepActions[clean]) allSweepActions[clean] = [];
          allSweepActions[clean].push({
            action: m.action || "unknown",
            target: m.target || m.pane || null,
            reason: m.reason || null,
            ts: m.ts || m.timestamp || null,
            modified_files: m.modified_files ?? null,
            last_commit_min_ago: m.last_commit_min_ago ?? null,
            context_lines: m.context_lines ?? null,
          });
        } catch {}
      }
    }
  } catch {}

  // Read sweep reports
  const reportExcerpts: Record<string, string> = {};
  for (const root of getProjectRoots()) {
    const reportsDir = join(root, "claude_files/sweep-reports");
    try {
      if (!existsSync(reportsDir)) continue;
      for (const f of readdirSync(reportsDir)) {
        if (!f.endsWith(".md")) continue;
        try {
          const content = readFileSync(join(reportsDir, f), "utf-8");
          const lines = content.split("\n").filter(l => l.trim()).slice(0, 6);
          const name = f.replace(".md", "").replace("-report", "");
          reportExcerpts[name] = lines.join("\n");
        } catch {}
      }
    } catch {}
  }

  for (const { clean, epoch } of sweepKeys) {
    const lastRunIso = new Date(epoch * 1000).toISOString();
    const interval = SWEEP_INTERVALS_MAP[clean] || 3600;
    const ageSec = (Date.now() / 1000) - epoch;
    const health: "green" | "amber" | "red" =
      ageSec > interval * 3 ? "red" :
      ageSec > interval * 2 ? "amber" : "green";

    const actions = (allSweepActions[clean] || []).slice(-10);
    // Build action summary
    let actionSummary = "";
    if (actions.length > 0) {
      const counts: Record<string, number> = {};
      for (const a of actions) {
        counts[a.action] = (counts[a.action] || 0) + 1;
      }
      actionSummary = Object.entries(counts)
        .map(([action, count]) => count > 1 ? `${action} ${count}x` : action)
        .join(", ");
    }

    // Match report by sweep name or partial match
    const excerpt = reportExcerpts[clean]
      || Object.entries(reportExcerpts).find(([k]) => clean.includes(k) || k.includes(clean))?.[1]
      || null;

    results.push({
      name: clean,
      last_run_iso: lastRunIso,
      interval_seconds: interval,
      health,
      recent_actions: actions,
      action_summary: actionSummary || null,
      report_excerpt: excerpt,
    });
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

function readBeads(): { wisps: any[]; claims: Record<string, any>; gates: Record<string, any> } {
  const allWisps: any[] = [];
  let allClaims: Record<string, any> = {};
  let allGates: Record<string, any> = {};
  for (const root of getProjectRoots()) {
    const file = join(root, "claude_files/harness-beads.json");
    const data = readJson(file);
    if (!data) continue;
    if (Array.isArray(data.wisps)) allWisps.push(...data.wisps);
    if (Array.isArray(data["reconcile-wisps"])) allWisps.push(...data["reconcile-wisps"]);
    if (data.claims && typeof data.claims === "object") Object.assign(allClaims, data.claims);
    if (data.gates && typeof data.gates === "object") Object.assign(allGates, data.gates);
  }
  // Sort wisps by timestamp descending
  allWisps.sort((a, b) => {
    const ta = a.ts || a.timestamp || "";
    const tb = b.ts || b.timestamp || "";
    return tb.localeCompare(ta);
  });
  return { wisps: allWisps, claims: allClaims, gates: allGates };
}

function cors(res: Response): Response {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return res;
}

function json(data: any): Response {
  return cors(new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  }));
}

Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    if (url.pathname === "/dashboard") {
      const entries = readManifests();
      const health = readJson(HEALTH_FILE, { harnesses: {} });
      const harnessHealth = health.harnesses || health;

      const idleMap = getLatestIdleSeconds();

      const harnesses = entries.map(({ name, manifest, progress }) => {
        const tasks = progress?.tasks || {};
        const taskList = Object.values(tasks) as any[];
        const completed = taskList.filter(t => t.status === "completed").length;
        const in_progress = taskList.filter(t => t.status === "in_progress").length;
        const pending = taskList.filter(t => t.status === "pending").length;
        const blocked = taskList.filter(t => (t.blockedBy || []).length > 0 && t.status === "pending").length;

        const currentTask = Object.entries(tasks)
          .find(([_, t]: any) => t.status === "in_progress")?.[0]
          || Object.entries(tasks)
          .find(([_, t]: any) => t.status === "pending" && !(t.blockedBy || []).length)?.[0]
          || null;

        const hh = harnessHealth[name] || {};
        const worker = hh.worker || { alive: false, status: "unknown", restarts: 0 };
        const monitor = hh.monitor || { alive: false, status: "unknown" };

        let lastActivity: string | null = null;
        try {
          const actFile = `/tmp/claude_activity_${name}.jsonl`;
          if (existsSync(actFile)) {
            const lines = readFileSync(actFile, "utf-8").trim().split("\n");
            const last = JSON.parse(lines[lines.length - 1]);
            lastActivity = last.timestamp || last.ts || null;
          }
        } catch {}

        // Task details for expandable view
        const task_details = Object.entries(tasks).map(([id, t]: [string, any]) => ({
          id,
          status: t.status || "pending",
          description: t.description || "",
          blockedBy: t.blockedBy || [],
          owner: t.owner || null,
          steps: (t.steps || []).length,
          completed_steps: (t.completed_steps || []).length,
        }));

        // Full learnings and commits arrays
        const rawLearnings = progress?.learnings || [];
        const learnings = rawLearnings.map((l: any) =>
          typeof l === "string" ? l : l.text || l.message || JSON.stringify(l)
        );
        const rawCommits = progress?.commits || [];
        const commits = rawCommits.map((c: any) =>
          typeof c === "string" ? c : c.hash ? `${c.hash.slice(0, 7)} ${c.message || ""}`.trim() : JSON.stringify(c)
        );

        return {
          name,
          status: progress?.status || manifest.status || "unknown",
          mission: progress?.mission || "",
          project_root: manifest.project_root || "",
          tasks: { total: taskList.length, completed, in_progress, pending, blocked },
          current_task: currentTask,
          worker, monitor, last_activity: lastActivity,
          learnings_count: rawLearnings.length,
          commits_count: rawCommits.length,
          session_count: progress?.session_count || 0,
          task_details,
          learnings,
          commits,
          idle_seconds: idleMap[name] ?? null,
        };
      });

      const sweepState = readJson(SWEEP_STATE, {});
      const sweeps: Record<string, { last_run_iso: string }> = {};
      for (const [key, val] of Object.entries(sweepState) as [string, any][]) {
        const epoch = typeof val === "number" ? val : val?.last_run;
        if (epoch) sweeps[key] = { last_run_iso: new Date(epoch * 1000).toISOString() };
      }

      return json({
        harnesses,
        sweeps,
        sessions: readJson(SESSION_REGISTRY, {}),
        control_plane: getControlPlane(),
        updated_at: new Date().toISOString(),
      });
    }

    if (url.pathname === "/metrics") {
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "100"), 500);
      return json({ metrics: readMetrics(limit), count: readMetrics(limit).length });
    }

    if (url.pathname === "/health") {
      return json({ ok: true });
    }

    if (url.pathname === "/issues") {
      return json({ issues: readIssues() });
    }

    if (url.pathname === "/agents") {
      return json({ agents: readAgents() });
    }

    if (url.pathname === "/beads") {
      return json(readBeads());
    }

    if (url.pathname === "/sweeps") {
      return json({ sweeps: readSweeps() });
    }

    return cors(new Response("not found", { status: 404 }));
  },
});

console.log(`harness-api listening on :${PORT}`);
