/**
 * Tests for relay-server — cross-machine worker fleet communication.
 * Run: cd ~/.claude-ops/mcp/relay-server && bun test
 *
 * Tests cover:
 *   - Auth (Bearer token validation)
 *   - Health endpoint
 *   - Worker discovery (/workers)
 *   - Inbox message delivery (POST /msg)
 *   - Inbox read (GET /inbox/:project/:worker)
 *   - Task read (GET /tasks/:project/:worker)
 *   - State read/write
 *   - Error handling (404s, bad requests, auth failures)
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, appendFileSync } from "fs";
import { join } from "path";

// ── Test fixtures ────────────────────────────────────────────────────
const TEST_DIR = join(import.meta.dir, ".test-tmp");
const TEST_PROJECT = "TestProject";
const TEST_PROJECT_DIR = join(TEST_DIR, TEST_PROJECT);
const TEST_WORKERS_DIR = join(TEST_PROJECT_DIR, ".claude/workers");
const TEST_WORKER = "test-worker";
const TEST_WORKER_DIR = join(TEST_WORKERS_DIR, TEST_WORKER);
const TEST_SECRET = "test-secret-" + Math.random().toString(36).slice(2);
const TEST_PORT = 13847 + Math.floor(Math.random() * 1000);
const SECRET_PATH = join(TEST_DIR, "relay-secret");

let serverProcess: ReturnType<typeof Bun.spawn> | null = null;
let baseUrl: string;

// ── Setup ────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Create test directory structure
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_WORKER_DIR, { recursive: true });
  writeFileSync(join(TEST_WORKER_DIR, "tasks.json"), "{}");
  writeFileSync(join(TEST_WORKER_DIR, "state.json"), JSON.stringify({ status: "idle", cycles_completed: 3 }));
  writeFileSync(SECRET_PATH, TEST_SECRET);

  // Create a second worker
  const worker2Dir = join(TEST_WORKERS_DIR, "other-worker");
  mkdirSync(worker2Dir, { recursive: true });
  writeFileSync(join(worker2Dir, "tasks.json"), JSON.stringify({
    T001: { subject: "Fix bug", status: "pending", priority: "high" },
    T002: { subject: "Deploy", status: "completed", priority: "medium" },
  }));
  writeFileSync(join(worker2Dir, "state.json"), JSON.stringify({ status: "active", cycles_completed: 7 }));

  // Start relay server
  baseUrl = `http://localhost:${TEST_PORT}`;
  serverProcess = Bun.spawn(["bun", "run", join(import.meta.dir, "index.ts")], {
    env: {
      ...process.env,
      RELAY_PORT: String(TEST_PORT),
      RELAY_PROJECT_ROOTS: TEST_PROJECT_DIR,
      CLAUDE_OPS_DIR: TEST_DIR, // so it reads our test secret
      HOME: process.env.HOME!,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Wait for server to be ready
  for (let i = 0; i < 30; i++) {
    try {
      const resp = await fetch(`${baseUrl}/health`, {
        headers: { Authorization: `Bearer ${TEST_SECRET}` },
      });
      if (resp.ok) break;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
});

afterAll(() => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// Clean inbox before each test
beforeEach(() => {
  const inboxPath = join(TEST_WORKER_DIR, "inbox.jsonl");
  if (existsSync(inboxPath)) writeFileSync(inboxPath, "");
});

// ── Helper ───────────────────────────────────────────────────────────

async function relay(
  method: string,
  path: string,
  body?: any,
  secret = TEST_SECRET,
): Promise<{ status: number; data: any }> {
  const opts: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
  };
  if (body && method !== "GET") {
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(`${baseUrl}${path}`, opts);
  const data = resp.headers.get("content-type")?.includes("json")
    ? await resp.json()
    : await resp.text();
  return { status: resp.status, data };
}

// ═══════════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════════

describe("auth", () => {
  test("valid token → 200", async () => {
    const { status } = await relay("GET", "/health");
    expect(status).toBe(200);
  });

  test("wrong token → 401", async () => {
    const { status } = await relay("GET", "/health", undefined, "wrong-secret");
    expect(status).toBe(401);
  });

  test("no token → 401", async () => {
    const resp = await fetch(`${baseUrl}/health`);
    expect(resp.status).toBe(401);
  });

  test("empty Bearer → 401", async () => {
    const { status } = await relay("GET", "/health", undefined, "");
    expect(status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════════════
// GET /health
// ═══════════════════════════════════════════════════════════════════

describe("GET /health", () => {
  test("returns ok + projects", async () => {
    const { status, data } = await relay("GET", "/health");
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(Array.isArray(data.projects)).toBe(true);
    expect(data.projects).toContain(TEST_PROJECT);
    expect(typeof data.uptime).toBe("number");
    expect(typeof data.hostname).toBe("string");
  });
});

// ═══════════════════════════════════════════════════════════════════
// GET /workers
// ═══════════════════════════════════════════════════════════════════

describe("GET /workers", () => {
  test("lists workers per project", async () => {
    const { status, data } = await relay("GET", "/workers");
    expect(status).toBe(200);
    expect(data[TEST_PROJECT]).toBeDefined();
    expect(data[TEST_PROJECT]).toContain(TEST_WORKER);
    expect(data[TEST_PROJECT]).toContain("other-worker");
  });

  test("excludes hidden dirs (starting with .)", async () => {
    // Create a hidden worker dir
    mkdirSync(join(TEST_WORKERS_DIR, ".hidden-worker"), { recursive: true });
    const { data } = await relay("GET", "/workers");
    expect(data[TEST_PROJECT]).not.toContain(".hidden-worker");
    rmSync(join(TEST_WORKERS_DIR, ".hidden-worker"), { recursive: true });
  });

  test("excludes _ prefixed dirs", async () => {
    mkdirSync(join(TEST_WORKERS_DIR, "_archive"), { recursive: true });
    const { data } = await relay("GET", "/workers");
    expect(data[TEST_PROJECT]).not.toContain("_archive");
    rmSync(join(TEST_WORKERS_DIR, "_archive"), { recursive: true });
  });
});

// ═══════════════════════════════════════════════════════════════════
// POST /msg
// ═══════════════════════════════════════════════════════════════════

describe("POST /msg", () => {
  test("delivers message to inbox", async () => {
    const { status, data } = await relay("POST", "/msg", {
      project: TEST_PROJECT,
      worker: TEST_WORKER,
      content: "Hello from relay test",
      summary: "relay test",
      from_name: "tester",
    });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);

    // Verify inbox
    const inboxPath = join(TEST_WORKER_DIR, "inbox.jsonl");
    const line = readFileSync(inboxPath, "utf-8").trim();
    const msg = JSON.parse(line);
    expect(msg.content).toBe("Hello from relay test");
    expect(msg.from_name).toBe("tester");
    expect(msg.channel).toBe("relay");
    expect(msg._ts).toBeTruthy();
  });

  test("multiple messages append correctly", async () => {
    await relay("POST", "/msg", { project: TEST_PROJECT, worker: TEST_WORKER, content: "msg1", from_name: "a" });
    await relay("POST", "/msg", { project: TEST_PROJECT, worker: TEST_WORKER, content: "msg2", from_name: "b" });
    await relay("POST", "/msg", { project: TEST_PROJECT, worker: TEST_WORKER, content: "msg3", from_name: "c" });

    const inboxPath = join(TEST_WORKER_DIR, "inbox.jsonl");
    const lines = readFileSync(inboxPath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(3);
    expect(JSON.parse(lines[0]).content).toBe("msg1");
    expect(JSON.parse(lines[2]).content).toBe("msg3");
  });

  test("missing project → 404", async () => {
    const { status, data } = await relay("POST", "/msg", {
      project: "NonexistentProject",
      worker: TEST_WORKER,
      content: "test",
    });
    expect(status).toBe(404);
    expect(data.error).toContain("not found");
  });

  test("missing worker → 404", async () => {
    const { status, data } = await relay("POST", "/msg", {
      project: TEST_PROJECT,
      worker: "nonexistent-worker",
      content: "test",
    });
    expect(status).toBe(404);
    expect(data.error).toContain("not found");
  });

  test("missing required fields → 400", async () => {
    const { status, data } = await relay("POST", "/msg", { project: TEST_PROJECT });
    expect(status).toBe(400);
    expect(data.error).toContain("Missing");
  });

  test("message with special characters preserved", async () => {
    const content = '你好世界 "quotes" $VAR `backtick` \n newline & pipe | > <';
    await relay("POST", "/msg", {
      project: TEST_PROJECT,
      worker: TEST_WORKER,
      content,
      from_name: "tester",
    });

    const inboxPath = join(TEST_WORKER_DIR, "inbox.jsonl");
    const msg = JSON.parse(readFileSync(inboxPath, "utf-8").trim());
    expect(msg.content).toBe(content);
  });

  test("auto-generates summary from content when omitted", async () => {
    const longContent = "A".repeat(200);
    await relay("POST", "/msg", {
      project: TEST_PROJECT,
      worker: TEST_WORKER,
      content: longContent,
      from_name: "tester",
    });

    const inboxPath = join(TEST_WORKER_DIR, "inbox.jsonl");
    const msg = JSON.parse(readFileSync(inboxPath, "utf-8").trim());
    expect(msg.summary.length).toBeLessThanOrEqual(60);
  });

  test("defaults from_name to 'remote' when omitted", async () => {
    await relay("POST", "/msg", {
      project: TEST_PROJECT,
      worker: TEST_WORKER,
      content: "test",
    });

    const inboxPath = join(TEST_WORKER_DIR, "inbox.jsonl");
    const msg = JSON.parse(readFileSync(inboxPath, "utf-8").trim());
    expect(msg.from_name).toBe("remote");
  });
});

// ═══════════════════════════════════════════════════════════════════
// GET /inbox/:project/:worker
// ═══════════════════════════════════════════════════════════════════

describe("GET /inbox", () => {
  test("reads inbox messages", async () => {
    const inboxPath = join(TEST_WORKER_DIR, "inbox.jsonl");
    appendFileSync(inboxPath, JSON.stringify({ content: "msg1", _ts: "2026-01-01T00:00:00Z" }) + "\n");
    appendFileSync(inboxPath, JSON.stringify({ content: "msg2", _ts: "2026-01-02T00:00:00Z" }) + "\n");

    const { status, data } = await relay("GET", `/inbox/${TEST_PROJECT}/${TEST_WORKER}`);
    expect(status).toBe(200);
    expect(data.messages.length).toBe(2);
    expect(data.messages[0].content).toBe("msg1");
  });

  test("since filter works", async () => {
    const inboxPath = join(TEST_WORKER_DIR, "inbox.jsonl");
    appendFileSync(inboxPath, JSON.stringify({ content: "old", _ts: "2025-01-01T00:00:00Z" }) + "\n");
    appendFileSync(inboxPath, JSON.stringify({ content: "new", _ts: "2026-06-01T00:00:00Z" }) + "\n");

    const { data } = await relay("GET", `/inbox/${TEST_PROJECT}/${TEST_WORKER}?since=2026-01-01T00:00:00Z`);
    expect(data.messages.length).toBe(1);
    expect(data.messages[0].content).toBe("new");
  });

  test("limit works", async () => {
    const inboxPath = join(TEST_WORKER_DIR, "inbox.jsonl");
    for (let i = 0; i < 10; i++) {
      appendFileSync(inboxPath, JSON.stringify({ content: `msg${i}`, _ts: `2026-01-${String(i+1).padStart(2,"0")}T00:00:00Z` }) + "\n");
    }

    const { data } = await relay("GET", `/inbox/${TEST_PROJECT}/${TEST_WORKER}?limit=3`);
    expect(data.messages.length).toBe(3);
  });

  test("empty inbox → empty array", async () => {
    const { data } = await relay("GET", `/inbox/${TEST_PROJECT}/${TEST_WORKER}`);
    expect(data.messages).toEqual([]);
  });

  test("nonexistent project → 404", async () => {
    const { status } = await relay("GET", "/inbox/BadProject/test-worker");
    expect(status).toBe(404);
  });

  test("nonexistent worker inbox → empty array", async () => {
    // Worker exists but no inbox.jsonl file (beforeEach may have cleared it)
    const { data } = await relay("GET", `/inbox/${TEST_PROJECT}/${TEST_WORKER}`);
    expect(data.messages).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// GET /tasks/:project/:worker
// ═══════════════════════════════════════════════════════════════════

describe("GET /tasks", () => {
  test("reads tasks.json", async () => {
    const { status, data } = await relay("GET", `/tasks/${TEST_PROJECT}/other-worker`);
    expect(status).toBe(200);
    expect(data.T001).toBeDefined();
    expect(data.T001.subject).toBe("Fix bug");
    expect(data.T001.status).toBe("pending");
    expect(data.T002.status).toBe("completed");
  });

  test("empty tasks → empty object", async () => {
    const { status, data } = await relay("GET", `/tasks/${TEST_PROJECT}/${TEST_WORKER}`);
    expect(status).toBe(200);
    expect(data).toEqual({});
  });

  test("nonexistent project → 404", async () => {
    const { status } = await relay("GET", "/tasks/BadProject/worker");
    expect(status).toBe(404);
  });

  test("nonexistent worker → empty object", async () => {
    // Worker dir doesn't exist — tasks.json missing
    const { status, data } = await relay("GET", `/tasks/${TEST_PROJECT}/ghost-worker`);
    expect(status).toBe(200);
    expect(data).toEqual({});
  });
});

// ═══════════════════════════════════════════════════════════════════
// GET/PUT /state/:project/:worker
// ═══════════════════════════════════════════════════════════════════

describe("GET /state", () => {
  test("reads state.json", async () => {
    const { status, data } = await relay("GET", `/state/${TEST_PROJECT}/${TEST_WORKER}`);
    expect(status).toBe(200);
    expect(data.status).toBe("idle");
    expect(data.cycles_completed).toBe(3);
  });

  test("nonexistent project → 404", async () => {
    const { status } = await relay("GET", "/state/BadProject/worker");
    expect(status).toBe(404);
  });
});

describe("PUT /state", () => {
  test("updates a state key", async () => {
    const { status, data } = await relay("PUT", `/state/${TEST_PROJECT}/${TEST_WORKER}`, {
      key: "status",
      value: "active",
    });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);

    // Verify the file was updated
    const state = JSON.parse(readFileSync(join(TEST_WORKER_DIR, "state.json"), "utf-8"));
    expect(state.status).toBe("active");
    expect(state.cycles_completed).toBe(3); // other fields preserved

    // Restore
    writeFileSync(join(TEST_WORKER_DIR, "state.json"), JSON.stringify({ status: "idle", cycles_completed: 3 }));
  });

  test("adds new key to state", async () => {
    await relay("PUT", `/state/${TEST_PROJECT}/${TEST_WORKER}`, {
      key: "new_field",
      value: 42,
    });

    const state = JSON.parse(readFileSync(join(TEST_WORKER_DIR, "state.json"), "utf-8"));
    expect(state.new_field).toBe(42);

    // Restore
    writeFileSync(join(TEST_WORKER_DIR, "state.json"), JSON.stringify({ status: "idle", cycles_completed: 3 }));
  });

  test("missing key → 400", async () => {
    const { status, data } = await relay("PUT", `/state/${TEST_PROJECT}/${TEST_WORKER}`, {
      value: "test",
    });
    expect(status).toBe(400);
    expect(data.error).toContain("key");
  });

  test("nonexistent project → 404", async () => {
    const { status } = await relay("PUT", "/state/BadProject/worker", { key: "x", value: 1 });
    expect(status).toBe(404);
  });

  test("nonexistent worker → creates state.json", async () => {
    // Create the worker dir without state.json
    const newWorkerDir = join(TEST_WORKERS_DIR, "new-state-worker");
    mkdirSync(newWorkerDir, { recursive: true });

    const { status, data } = await relay("PUT", `/state/${TEST_PROJECT}/new-state-worker`, {
      key: "status",
      value: "starting",
    });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);

    const state = JSON.parse(readFileSync(join(newWorkerDir, "state.json"), "utf-8"));
    expect(state.status).toBe("starting");

    rmSync(newWorkerDir, { recursive: true });
  });
});

// ═══════════════════════════════════════════════════════════════════
// 404 for unknown routes
// ═══════════════════════════════════════════════════════════════════

describe("unknown routes", () => {
  test("GET /unknown → 404", async () => {
    const { status } = await relay("GET", "/unknown");
    expect(status).toBe(404);
  });

  test("POST /health → 404 (wrong method)", async () => {
    const { status } = await relay("POST", "/health");
    expect(status).toBe(404);
  });

  test("GET / → 404", async () => {
    const { status } = await relay("GET", "/");
    expect(status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Edge cases
// ═══════════════════════════════════════════════════════════════════

describe("edge cases", () => {
  test("project slug with special chars in URL", async () => {
    // URL encoding should be handled
    const { status } = await relay("GET", `/tasks/${encodeURIComponent("Project With Spaces")}/worker`);
    expect(status).toBe(404); // project won't exist, but shouldn't crash
  });

  test("worker name with dashes and underscores", async () => {
    const workerDir = join(TEST_WORKERS_DIR, "my-worker_v2");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, "state.json"), JSON.stringify({ status: "test" }));

    const { status, data } = await relay("GET", `/state/${TEST_PROJECT}/my-worker_v2`);
    expect(status).toBe(200);
    expect(data.status).toBe("test");

    rmSync(workerDir, { recursive: true });
  });

  test("concurrent message delivery", async () => {
    // Send 5 messages in parallel (keep small to avoid overwhelming test server)
    const promises = Array.from({ length: 5 }, (_, i) =>
      relay("POST", "/msg", {
        project: TEST_PROJECT,
        worker: TEST_WORKER,
        content: `concurrent-${i}`,
        from_name: `sender-${i}`,
      })
    );
    const results = await Promise.all(promises);

    // All should succeed
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.data.ok).toBe(true);
    }

    // Verify all messages in inbox
    const inboxPath = join(TEST_WORKER_DIR, "inbox.jsonl");
    const lines = readFileSync(inboxPath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(5);

    // Each line should be valid JSON
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test("large message body (50KB)", async () => {
    const content = "x".repeat(50_000);
    const { status, data } = await relay("POST", "/msg", {
      project: TEST_PROJECT,
      worker: TEST_WORKER,
      content,
      from_name: "tester",
    });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);

    const inboxPath = join(TEST_WORKER_DIR, "inbox.jsonl");
    const msg = JSON.parse(readFileSync(inboxPath, "utf-8").trim());
    expect(msg.content.length).toBe(50_000);
  });
});
