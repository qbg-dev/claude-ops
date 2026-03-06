#!/usr/bin/env bun
/**
 * relay-server — HTTP relay for cross-machine worker fleet communication.
 *
 * Runs on each machine (MacBook + kevinster). Exposes local worker operations
 * over HTTP so remote MCP servers can route messages transparently.
 *
 * Auto-started by the worker-fleet MCP server as a subprocess.
 * Auth: Bearer token from ~/.claude-ops/relay-secret
 *
 * Endpoints:
 *   GET  /health                       — alive check
 *   POST /msg                          — write to worker inbox + tmux delivery
 *   GET  /inbox/:project/:worker       — read inbox (query: since, limit)
 *   GET  /tasks/:project/:worker       — read tasks.json
 *   GET  /state/:project/:worker       — read state.json
 *   PUT  /state/:project/:worker       — update state key
 *   GET  /fleet                        — run check-flat-workers.sh
 *   GET  /workers                      — list discovered projects + workers
 */

import { readFileSync, appendFileSync, existsSync, readdirSync, writeFileSync } from "fs";
import { join, basename } from "path";
import { spawnSync } from "child_process";

const HOME = process.env.HOME!;
const PORT = parseInt(process.env.RELAY_PORT || "3847", 10);
const CLAUDE_OPS_DIR = process.env.CLAUDE_OPS_DIR || join(HOME, ".claude-ops");
const CLAUDE_OPS = process.env.CLAUDE_OPS_DIR || join(HOME, ".claude-ops");
const CHECK_WORKERS_SH = join(CLAUDE_OPS, "scripts/check-flat-workers.sh");
const WORKER_MESSAGE_SH = join(CLAUDE_OPS, "scripts/worker-message.sh");

// ── Auth ──────────────────────────────────────────────────────────────

const SECRET_PATH = join(CLAUDE_OPS_DIR, "relay-secret");
let RELAY_SECRET = "";
try {
  RELAY_SECRET = readFileSync(SECRET_PATH, "utf-8").trim();
} catch {
  console.error(`FATAL: Cannot read relay secret from ${SECRET_PATH}`);
  process.exit(1);
}

function checkAuth(req: Request): boolean {
  const auth = req.headers.get("Authorization") || "";
  return auth === `Bearer ${RELAY_SECRET}`;
}

function unauthorized(): Response {
  return new Response("Unauthorized", { status: 401 });
}

// ── Project Discovery ─────────────────────────────────────────────────

function discoverProjects(): Map<string, string> {
  // Map<projectSlug, projectRootPath>
  const projects = new Map<string, string>();

  // 1. Explicit env var
  const envRoots = process.env.RELAY_PROJECT_ROOTS;
  if (envRoots) {
    for (const root of envRoots.split(":").filter(Boolean)) {
      if (existsSync(join(root, ".claude/workers"))) {
        projects.set(basename(root), root);
      }
    }
  }

  // 2. Auto-discover from ~/.claude/projects/ (symlink convention)
  try {
    const projectsDir = join(HOME, ".claude/projects");
    if (existsSync(projectsDir)) {
      for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
        // Slugs look like "-Users-wz-Desktop-zPersonalProjects-Wechat"
        if (entry.name.startsWith("-")) {
          const path = entry.name.replace(/^-/, "/").replace(/-/g, "/");
          if (existsSync(path) && existsSync(join(path, ".claude/workers"))) {
            projects.set(basename(path), path);
          }
        }
      }
    }
  } catch {}

  return projects;
}

function getWorkersDir(projectSlug: string): string | null {
  const projects = discoverProjects();
  const root = projects.get(projectSlug);
  if (!root) return null;
  const dir = join(root, ".claude/workers");
  return existsSync(dir) ? dir : null;
}

function getProjectRoot(projectSlug: string): string | null {
  const projects = discoverProjects();
  return projects.get(projectSlug) || null;
}

// ── Route Helpers ─────────────────────────────────────────────────────

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parseRoute(url: URL): { path: string; segments: string[] } {
  const path = url.pathname;
  const segments = path.split("/").filter(Boolean);
  return { path, segments };
}

// ── Server ────────────────────────────────────────────────────────────

Bun.serve({
  port: PORT,
  async fetch(req) {
    if (!checkAuth(req)) return unauthorized();

    const url = new URL(req.url);
    const { segments } = parseRoute(url);
    const method = req.method;

    // GET /health
    if (method === "GET" && segments[0] === "health") {
      return jsonResponse({
        ok: true,
        hostname: process.env.HOSTNAME || spawnSync("hostname", { encoding: "utf-8" }).stdout.trim(),
        uptime: process.uptime(),
        projects: [...discoverProjects().keys()],
      });
    }

    // GET /workers — list all projects and their workers
    if (method === "GET" && segments[0] === "workers") {
      const projects = discoverProjects();
      const result: Record<string, string[]> = {};
      for (const [slug, root] of projects) {
        const workersDir = join(root, ".claude/workers");
        try {
          result[slug] = readdirSync(workersDir, { withFileTypes: true })
            .filter(d => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"))
            .map(d => d.name);
        } catch {
          result[slug] = [];
        }
      }
      return jsonResponse(result);
    }

    // GET /fleet — run check-flat-workers.sh
    if (method === "GET" && segments[0] === "fleet") {
      try {
        // Run for each discovered project
        const projects = discoverProjects();
        const outputs: string[] = [];
        for (const [slug, root] of projects) {
          const result = spawnSync("bash", [CHECK_WORKERS_SH, "--project", root], {
            encoding: "utf-8",
            timeout: 15_000,
            env: { ...process.env, PROJECT_ROOT: root },
          });
          if (result.stdout) {
            outputs.push(`[${slug}]\n${result.stdout.trim()}`);
          }
        }
        return jsonResponse({ output: outputs.join("\n\n") });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // POST /msg — write to worker inbox + tmux delivery
    if (method === "POST" && segments[0] === "msg") {
      try {
        const body = await req.json();
        const { project, worker, content, summary, from_name } = body;
        if (!project || !worker || !content) {
          return jsonResponse({ error: "Missing required fields: project, worker, content" }, 400);
        }

        const workersDir = getWorkersDir(project);
        if (!workersDir) {
          return jsonResponse({ error: `Project not found: ${project}` }, 404);
        }

        const workerDir = join(workersDir, worker);
        if (!existsSync(workerDir)) {
          return jsonResponse({ error: `Worker not found: ${worker} in ${project}` }, 404);
        }

        // Write to inbox (durable)
        const inboxPath = join(workerDir, "inbox.jsonl");
        const payload = {
          to: `worker/${worker}`,
          from: `worker/${from_name || "remote"}`,
          from_name: from_name || "remote",
          content,
          summary: summary || content.slice(0, 60),
          msg_type: "message",
          channel: "relay",
          _ts: new Date().toISOString(),
        };
        appendFileSync(inboxPath, JSON.stringify(payload) + "\n");

        // Best-effort tmux delivery
        try {
          spawnSync("bash", [WORKER_MESSAGE_SH, "send", worker, content, "--summary", summary || ""], {
            encoding: "utf-8",
            timeout: 10_000,
          });
        } catch {}

        return jsonResponse({ ok: true, delivered: "inbox" });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // GET /inbox/:project/:worker
    if (method === "GET" && segments[0] === "inbox" && segments.length >= 3) {
      const [, project, worker] = segments;
      const workersDir = getWorkersDir(project);
      if (!workersDir) return jsonResponse({ error: `Project not found: ${project}` }, 404);

      const inboxPath = join(workersDir, worker, "inbox.jsonl");
      if (!existsSync(inboxPath)) return jsonResponse({ messages: [] });

      try {
        const since = url.searchParams.get("since") || "";
        const limit = parseInt(url.searchParams.get("limit") || "50", 10);
        const lines = readFileSync(inboxPath, "utf-8").trim().split("\n").filter(Boolean);

        let messages = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

        if (since) {
          messages = messages.filter(m => m._ts > since);
        }

        return jsonResponse({ messages: messages.slice(-limit) });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // GET /tasks/:project/:worker
    if (method === "GET" && segments[0] === "tasks" && segments.length >= 3) {
      const [, project, worker] = segments;
      const workersDir = getWorkersDir(project);
      if (!workersDir) return jsonResponse({ error: `Project not found: ${project}` }, 404);

      const tasksPath = join(workersDir, worker, "tasks.json");
      if (!existsSync(tasksPath)) return jsonResponse({});

      try {
        return jsonResponse(JSON.parse(readFileSync(tasksPath, "utf-8")));
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // GET /state/:project/:worker
    if (method === "GET" && segments[0] === "state" && segments.length >= 3) {
      const [, project, worker] = segments;
      const workersDir = getWorkersDir(project);
      if (!workersDir) return jsonResponse({ error: `Project not found: ${project}` }, 404);

      const statePath = join(workersDir, worker, "state.json");
      if (!existsSync(statePath)) return jsonResponse({});

      try {
        return jsonResponse(JSON.parse(readFileSync(statePath, "utf-8")));
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // PUT /state/:project/:worker
    if (method === "PUT" && segments[0] === "state" && segments.length >= 3) {
      const [, project, worker] = segments;
      const workersDir = getWorkersDir(project);
      if (!workersDir) return jsonResponse({ error: `Project not found: ${project}` }, 404);

      try {
        const body = await req.json();
        const { key, value } = body;
        if (!key) return jsonResponse({ error: "Missing 'key'" }, 400);

        const statePath = join(workersDir, worker, "state.json");
        let state: any = {};
        if (existsSync(statePath)) {
          try { state = JSON.parse(readFileSync(statePath, "utf-8")); } catch {}
        }
        state[key] = value;
        writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");

        return jsonResponse({ ok: true });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`relay-server listening on :${PORT}`);
