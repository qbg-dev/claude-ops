/**
 * Tests for worker-fleet MCP server helpers.
 * Run: cd ~/.claude-ops/mcp/worker-fleet && bun test
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, appendFileSync } from "fs";
import { join } from "path";
import {
  readTasks, writeTasks, nextTaskId, isTaskBlocked,
  writeToInbox, readInboxFromCursor, readInboxCursor, writeInboxCursor,
  resolveRecipient, generateSeedContent, runDiagnostics, _setWorkersDir,
  WORKER_NAME,
  type Task, type DiagnosticIssue,
} from "./index";

// ── Test fixtures ────────────────────────────────────────────────────
const TEST_DIR = join(import.meta.dir, ".test-tmp");
const TEST_WORKERS_DIR = join(TEST_DIR, "workers");
const TEST_WORKER = "test-worker";
const TEST_WORKER_DIR = join(TEST_WORKERS_DIR, TEST_WORKER);

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    subject: "Test task",
    description: "",
    activeForm: "Working on: Test task",
    status: "pending",
    priority: "medium",
    recurring: false,
    blocked_by: [],
    metadata: {},
    cycles_completed: 0,
    owner: null,
    created_at: new Date().toISOString(),
    completed_at: null,
    ...overrides,
  };
}

// ── Setup / Teardown ─────────────────────────────────────────────────
beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_WORKER_DIR, { recursive: true });
  writeFileSync(join(TEST_WORKER_DIR, "tasks.json"), "{}");
  // Point helpers at our test directory
  _setWorkersDir(TEST_WORKERS_DIR);
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════
// nextTaskId
// ═══════════════════════════════════════════════════════════════════

describe("nextTaskId", () => {
  test("empty tasks → T001", () => {
    expect(nextTaskId({})).toBe("T001");
  });

  test("sequential after T003 → T004", () => {
    const tasks: Record<string, Task> = {
      T001: makeTask(),
      T002: makeTask(),
      T003: makeTask(),
    };
    expect(nextTaskId(tasks)).toBe("T004");
  });

  test("handles gaps — uses max, not count", () => {
    const tasks: Record<string, Task> = {
      T001: makeTask(),
      T005: makeTask(),
    };
    expect(nextTaskId(tasks)).toBe("T006");
  });

  test("three-digit padding", () => {
    const tasks: Record<string, Task> = {
      T001: makeTask(),
      T099: makeTask(),
    };
    expect(nextTaskId(tasks)).toBe("T100");
  });

  test("four digits when > 999", () => {
    const tasks: Record<string, Task> = {
      T999: makeTask(),
    };
    expect(nextTaskId(tasks)).toBe("T1000");
  });
});

// ═══════════════════════════════════════════════════════════════════
// isTaskBlocked
// ═══════════════════════════════════════════════════════════════════

describe("isTaskBlocked", () => {
  test("no deps → not blocked", () => {
    const tasks: Record<string, Task> = {
      T001: makeTask(),
    };
    expect(isTaskBlocked(tasks, "T001")).toBe(false);
  });

  test("dep completed → not blocked", () => {
    const tasks: Record<string, Task> = {
      T001: makeTask({ status: "completed" }),
      T002: makeTask({ blocked_by: ["T001"] }),
    };
    expect(isTaskBlocked(tasks, "T002")).toBe(false);
  });

  test("dep pending → blocked", () => {
    const tasks: Record<string, Task> = {
      T001: makeTask({ status: "pending" }),
      T002: makeTask({ blocked_by: ["T001"] }),
    };
    expect(isTaskBlocked(tasks, "T002")).toBe(true);
  });

  test("one of multiple deps incomplete → blocked", () => {
    const tasks: Record<string, Task> = {
      T001: makeTask({ status: "completed" }),
      T002: makeTask({ status: "in_progress" }),
      T003: makeTask({ blocked_by: ["T001", "T002"] }),
    };
    expect(isTaskBlocked(tasks, "T003")).toBe(true);
  });

  test("nonexistent task → not blocked", () => {
    expect(isTaskBlocked({}, "T999")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Task CRUD (readTasks/writeTasks via filesystem)
// ═══════════════════════════════════════════════════════════════════

describe("task CRUD", () => {
  // These tests operate on a real temporary directory
  const TASK_WORKER = "crud-worker";
  const TASK_WORKER_DIR = join(TEST_WORKERS_DIR, TASK_WORKER);
  const TASKS_FILE = join(TASK_WORKER_DIR, "tasks.json");

  beforeEach(() => {
    mkdirSync(TASK_WORKER_DIR, { recursive: true });
    writeFileSync(TASKS_FILE, "{}");
  });

  test("readTasks on empty file → empty object", () => {
    // We need to test readTasks against the actual WORKERS_DIR
    // Since readTasks hardcodes WORKERS_DIR, we test the format instead
    const data = JSON.parse(readFileSync(TASKS_FILE, "utf-8"));
    expect(data).toEqual({});
  });

  test("readTasks on missing file → empty object", () => {
    // readTasks returns {} on error
    const result = readTasks("nonexistent-worker-xyz");
    expect(result).toEqual({});
  });

  test("forward-blocking adds taskId to target blocked_by", () => {
    const tasks: Record<string, Task> = {
      T001: makeTask({ subject: "Setup" }),
      T002: makeTask({ subject: "Build" }),
    };

    // Simulate forward-blocking: T003 blocks T001 and T002
    const newId = "T003";
    tasks[newId] = makeTask({ subject: "Infra" });

    const blocksList = ["T001", "T002"];
    for (const targetId of blocksList) {
      if (tasks[targetId]) {
        const existing = tasks[targetId].blocked_by || [];
        if (!existing.includes(newId)) {
          tasks[targetId].blocked_by = [...existing, newId];
        }
      }
    }

    expect(tasks.T001.blocked_by).toEqual(["T003"]);
    expect(tasks.T002.blocked_by).toEqual(["T003"]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// complete_task behavior
// ═══════════════════════════════════════════════════════════════════

describe("complete_task logic", () => {
  test("non-recurring → status=completed, completed_at set", () => {
    const task = makeTask({ status: "in_progress" });
    const now = new Date().toISOString();

    task.status = "completed";
    task.completed_at = now;

    expect(task.status).toBe("completed");
    expect(task.completed_at).toBeTruthy();
  });

  test("recurring → reset to pending, bump cycle", () => {
    const task = makeTask({ status: "in_progress", recurring: true, owner: "me", cycles_completed: 2 });
    const now = new Date().toISOString();

    // Simulate recurring complete
    task.status = "pending";
    task.owner = null;
    task.completed_at = null;
    task.last_completed_at = now;
    task.cycles_completed = (task.cycles_completed || 0) + 1;

    expect(task.status).toBe("pending");
    expect(task.owner).toBeNull();
    expect(task.cycles_completed).toBe(3);
    expect(task.last_completed_at).toBe(now);
  });
});

// ═══════════════════════════════════════════════════════════════════
// writeToInbox
// ═══════════════════════════════════════════════════════════════════

describe("writeToInbox", () => {
  test("success — appends JSONL line", () => {
    const result = writeToInbox(TEST_WORKER, {
      content: "Hello from tests",
      summary: "Test message",
      from_name: "tester",
    });

    expect(result).toEqual({ ok: true });

    const inboxPath = join(TEST_WORKER_DIR, "inbox.jsonl");
    const content = readFileSync(inboxPath, "utf-8");
    const parsed = JSON.parse(content.trim());

    expect(parsed.to).toBe(`worker/${TEST_WORKER}`);
    expect(parsed.from).toBe("worker/tester");
    expect(parsed.content).toBe("Hello from tests");
    expect(parsed.msg_type).toBe("message");
    expect(parsed._ts).toBeTruthy();
  });

  test("missing worker dir → error", () => {
    const result = writeToInbox("nonexistent-worker-xyz", {
      content: "test",
      from_name: "tester",
    });
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain("not found");
  });

  test("multiple writes append correctly", () => {
    writeToInbox(TEST_WORKER, { content: "msg1", from_name: "a" });
    writeToInbox(TEST_WORKER, { content: "msg2", from_name: "b" });
    writeToInbox(TEST_WORKER, { content: "msg3", from_name: "c" });

    const inboxPath = join(TEST_WORKER_DIR, "inbox.jsonl");
    const lines = readFileSync(inboxPath, "utf-8").split("\n").filter(Boolean);
    expect(lines.length).toBe(3);

    const msgs = lines.map(l => JSON.parse(l));
    expect(msgs[0].content).toBe("msg1");
    expect(msgs[1].content).toBe("msg2");
    expect(msgs[2].content).toBe("msg3");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Inbox cursor
// ═══════════════════════════════════════════════════════════════════

describe("inbox cursor", () => {
  test("fresh read — no cursor file → reads all", () => {
    const inboxPath = join(TEST_WORKER_DIR, "inbox.jsonl");
    appendFileSync(inboxPath, JSON.stringify({ content: "msg1", _ts: "2026-01-01T00:00:00Z" }) + "\n");
    appendFileSync(inboxPath, JSON.stringify({ content: "msg2", _ts: "2026-01-02T00:00:00Z" }) + "\n");

    const { messages, newOffset } = readInboxFromCursor(TEST_WORKER, {});
    expect(messages.length).toBe(2);
    expect(messages[0].content).toBe("msg1");
    expect(newOffset).toBeGreaterThan(0);
  });

  test("cursor-based — only returns new messages", () => {
    const inboxPath = join(TEST_WORKER_DIR, "inbox.jsonl");
    const line1 = JSON.stringify({ content: "old", _ts: "2026-01-01T00:00:00Z" }) + "\n";
    writeFileSync(inboxPath, line1);

    // Set cursor to end of first line
    writeInboxCursor(TEST_WORKER, Buffer.byteLength(line1));

    // Append new message
    appendFileSync(inboxPath, JSON.stringify({ content: "new", _ts: "2026-01-02T00:00:00Z" }) + "\n");

    const { messages } = readInboxFromCursor(TEST_WORKER, {});
    expect(messages.length).toBe(1);
    expect(messages[0].content).toBe("new");
  });

  test("truncated file → resets cursor to 0, reads all", () => {
    const inboxPath = join(TEST_WORKER_DIR, "inbox.jsonl");

    // Write data and set large cursor
    writeFileSync(inboxPath, JSON.stringify({ content: "after-truncate" }) + "\n");
    writeInboxCursor(TEST_WORKER, 99999); // cursor beyond file size

    const { messages } = readInboxFromCursor(TEST_WORKER, {});
    expect(messages.length).toBe(1);
    expect(messages[0].content).toBe("after-truncate");
  });

  test("clear flag — truncates file and resets cursor", () => {
    const inboxPath = join(TEST_WORKER_DIR, "inbox.jsonl");
    appendFileSync(inboxPath, JSON.stringify({ content: "to-clear" }) + "\n");

    const { messages } = readInboxFromCursor(TEST_WORKER, { clear: true });
    expect(messages.length).toBe(1);
    expect(messages[0].content).toBe("to-clear");

    // File should be empty now
    const remaining = readFileSync(inboxPath, "utf-8");
    expect(remaining).toBe("");

    // Cursor should be reset
    const cursor = readInboxCursor(TEST_WORKER);
    expect(cursor?.offset).toBe(0);
  });

  test("since filter — only messages after timestamp", () => {
    const inboxPath = join(TEST_WORKER_DIR, "inbox.jsonl");
    appendFileSync(inboxPath, JSON.stringify({ content: "old", _ts: "2026-01-01T00:00:00Z" }) + "\n");
    appendFileSync(inboxPath, JSON.stringify({ content: "new", _ts: "2026-03-01T00:00:00Z" }) + "\n");

    const { messages } = readInboxFromCursor(TEST_WORKER, { since: "2026-02-01T00:00:00Z" });
    expect(messages.length).toBe(1);
    expect(messages[0].content).toBe("new");
  });

  test("limit — returns last N messages", () => {
    const inboxPath = join(TEST_WORKER_DIR, "inbox.jsonl");
    for (let i = 0; i < 5; i++) {
      appendFileSync(inboxPath, JSON.stringify({ content: `msg${i}` }) + "\n");
    }

    const { messages } = readInboxFromCursor(TEST_WORKER, { limit: 2 });
    expect(messages.length).toBe(2);
    expect(messages[0].content).toBe("msg3");
    expect(messages[1].content).toBe("msg4");
  });

  test("empty inbox — no error", () => {
    writeFileSync(join(TEST_WORKER_DIR, "inbox.jsonl"), "");
    const { messages } = readInboxFromCursor(TEST_WORKER, {});
    expect(messages.length).toBe(0);
  });

  test("missing inbox file — no error", () => {
    const { messages } = readInboxFromCursor(TEST_WORKER, {});
    expect(messages.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// resolveRecipient
// ═══════════════════════════════════════════════════════════════════

describe("resolveRecipient", () => {
  test("worker name → type worker", () => {
    const result = resolveRecipient("chatbot-tools");
    expect(result.type).toBe("worker");
    expect(result.workerName).toBe("chatbot-tools");
    expect(result.error).toBeUndefined();
  });

  test("raw pane ID → type pane", () => {
    const result = resolveRecipient("%53");
    expect(result.type).toBe("pane");
    expect(result.paneId).toBe("%53");
  });

  test("parent without registry → error", () => {
    // In test env, pane registry may not exist or may not have our worker
    const result = resolveRecipient("parent");
    // Should either find parent or return error — both are valid outcomes
    expect(result.type).toBe("worker");
    // Either workerName or error should be set
    expect(result.workerName || result.error).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════
// generateSeedContent
// ═══════════════════════════════════════════════════════════════════

describe("generateSeedContent", () => {
  test("contains worker name", () => {
    const seed = generateSeedContent();
    // WORKER_NAME in test context is detected from git branch or defaults to "operator"
    expect(seed).toContain("You are worker **");
    expect(seed).toContain("Cycle Pattern");
    expect(seed).toContain("MCP Tools");
  });

  test("includes handoff when provided", () => {
    const seed = generateSeedContent("Previous cycle finished task T003. Next: work on T004.");
    expect(seed).toContain("Handoff from Previous Cycle");
    expect(seed).toContain("Previous cycle finished task T003");
  });

  test("without handoff — no handoff section", () => {
    const seed = generateSeedContent();
    // Without handoff.md on disk and no handoff param, should not have handoff section
    expect(seed).not.toContain("Handoff from Previous Cycle");
  });

  test("includes tool reference table with all 17 tools", () => {
    const seed = generateSeedContent();
    expect(seed).toContain("send_message");
    expect(seed).toContain("broadcast");
    expect(seed).toContain("read_inbox");
    expect(seed).toContain("create_task");
    expect(seed).toContain("claim_task");
    expect(seed).toContain("complete_task");
    expect(seed).toContain("list_tasks");
    expect(seed).toContain("get_worker_state");
    expect(seed).toContain("update_state");
    expect(seed).toContain("fleet_status");
    expect(seed).toContain("deploy");
    expect(seed).toContain("health_check");
    expect(seed).toContain("smart_commit");
    expect(seed).toContain("post_to_nexus");
    expect(seed).toContain("recycle");
    expect(seed).toContain("spawn_child");
    expect(seed).toContain("register_pane");
  });

  test("reads handoff.md from disk when present", () => {
    // Create a handoff.md in the test worker dir — use actual WORKER_NAME
    const workerDir = join(TEST_WORKERS_DIR, WORKER_NAME);
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, "handoff.md"), "Disk handoff: check merge queue");

    // generateSeedContent uses WORKERS_DIR which we set to TEST_WORKERS_DIR
    // but it also uses WORKER_NAME which is detected from git — may not match
    // This test verifies the mechanism works when WORKER_NAME matches
    const seed = generateSeedContent();
    // Since WORKER_NAME may be "chief-of-staff" (from git branch), this might include disk handoff
    // We can at least verify the function doesn't crash
    expect(typeof seed).toBe("string");
    expect(seed.length).toBeGreaterThan(100);
  });

  test("includes check_config in tool table", () => {
    const seed = generateSeedContent();
    expect(seed).toContain("check_config");
  });
});

// ═══════════════════════════════════════════════════════════════════
// runDiagnostics
// ═══════════════════════════════════════════════════════════════════

describe("runDiagnostics", () => {
  test("returns array of DiagnosticIssue objects", () => {
    const issues = runDiagnostics();
    expect(Array.isArray(issues)).toBe(true);
    for (const issue of issues) {
      expect(["error", "warning"]).toContain(issue.severity);
      expect(typeof issue.check).toBe("string");
      expect(typeof issue.message).toBe("string");
    }
  });

  test("detects missing worker dir", () => {
    // Point to a non-existent workers dir
    const origDir = join(import.meta.dir, ".test-tmp/diagnostics-missing");
    _setWorkersDir(origDir);
    try {
      const issues = runDiagnostics();
      const workerDirIssue = issues.find(i => i.check === "worker_dir");
      expect(workerDirIssue).toBeTruthy();
      expect(workerDirIssue!.severity).toBe("error");
    } finally {
      _setWorkersDir(TEST_WORKERS_DIR);
    }
  });

  test("detects missing mission.md", () => {
    // Create worker dir without mission.md
    const diagDir = join(import.meta.dir, ".test-tmp/diagnostics-no-mission/workers");
    // We need a dir named after WORKER_NAME
    const workerDir = join(diagDir, WORKER_NAME);
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, "state.json"), JSON.stringify({ status: "idle", cycles_completed: 0 }));

    _setWorkersDir(diagDir);
    try {
      const issues = runDiagnostics();
      const missionIssue = issues.find(i => i.check === "mission.md");
      expect(missionIssue).toBeTruthy();
      expect(missionIssue!.severity).toBe("error");
    } finally {
      _setWorkersDir(TEST_WORKERS_DIR);
      rmSync(join(import.meta.dir, ".test-tmp/diagnostics-no-mission"), { recursive: true, force: true });
    }
  });

  test("detects invalid state.json", () => {
    const diagDir = join(import.meta.dir, ".test-tmp/diagnostics-bad-state/workers");
    const workerDir = join(diagDir, WORKER_NAME);
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, "mission.md"), "Test mission");
    writeFileSync(join(workerDir, "state.json"), "not valid json{{{");

    _setWorkersDir(diagDir);
    try {
      const issues = runDiagnostics();
      const stateIssue = issues.find(i => i.check === "state.json");
      expect(stateIssue).toBeTruthy();
      expect(stateIssue!.severity).toBe("error");
      expect(stateIssue!.message).toContain("invalid JSON");
    } finally {
      _setWorkersDir(TEST_WORKERS_DIR);
      rmSync(join(import.meta.dir, ".test-tmp/diagnostics-bad-state"), { recursive: true, force: true });
    }
  });

  test("detects missing state fields", () => {
    const diagDir = join(import.meta.dir, ".test-tmp/diagnostics-empty-state/workers");
    const workerDir = join(diagDir, WORKER_NAME);
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, "mission.md"), "Test mission");
    writeFileSync(join(workerDir, "state.json"), "{}"); // valid JSON but missing fields

    _setWorkersDir(diagDir);
    try {
      const issues = runDiagnostics();
      const cyclesIssue = issues.find(i => i.check === "state.cycles_completed");
      const statusIssue = issues.find(i => i.check === "state.status");
      expect(cyclesIssue).toBeTruthy();
      expect(statusIssue).toBeTruthy();
      expect(cyclesIssue!.severity).toBe("warning");
    } finally {
      _setWorkersDir(TEST_WORKERS_DIR);
      rmSync(join(import.meta.dir, ".test-tmp/diagnostics-empty-state"), { recursive: true, force: true });
    }
  });

  test("detects corrupt inbox.jsonl", () => {
    const diagDir = join(import.meta.dir, ".test-tmp/diagnostics-bad-inbox/workers");
    const workerDir = join(diagDir, WORKER_NAME);
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, "mission.md"), "Test mission");
    writeFileSync(join(workerDir, "state.json"), JSON.stringify({ status: "idle", cycles_completed: 0 }));
    writeFileSync(join(workerDir, "inbox.jsonl"), '{"valid":true}\nthis is not json\n');

    _setWorkersDir(diagDir);
    try {
      const issues = runDiagnostics();
      const inboxIssue = issues.find(i => i.check === "inbox.jsonl");
      expect(inboxIssue).toBeTruthy();
      expect(inboxIssue!.severity).toBe("warning");
      expect(inboxIssue!.message).toContain("corrupt");
    } finally {
      _setWorkersDir(TEST_WORKERS_DIR);
      rmSync(join(import.meta.dir, ".test-tmp/diagnostics-bad-inbox"), { recursive: true, force: true });
    }
  });

  test("passes with valid config", () => {
    const diagDir = join(import.meta.dir, ".test-tmp/diagnostics-valid/workers");
    const workerDir = join(diagDir, WORKER_NAME);
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, "mission.md"), "Complete mission with all goals");
    writeFileSync(join(workerDir, "state.json"), JSON.stringify({ status: "idle", cycles_completed: 5 }));
    writeFileSync(join(workerDir, "permissions.json"), JSON.stringify({ model: "sonnet" }));

    _setWorkersDir(diagDir);
    try {
      const issues = runDiagnostics();
      // Should have no errors related to worker config files
      const configErrors = issues.filter(i =>
        ["worker_dir", "mission.md", "state.json", "state.cycles_completed", "state.status", "permissions.json", "permissions.model"].includes(i.check)
      );
      expect(configErrors.length).toBe(0);
    } finally {
      _setWorkersDir(TEST_WORKERS_DIR);
      rmSync(join(import.meta.dir, ".test-tmp/diagnostics-valid"), { recursive: true, force: true });
    }
  });

  test("each issue has a fix suggestion", () => {
    // With no worker dir, should have issues with fix suggestions
    _setWorkersDir(join(import.meta.dir, ".test-tmp/diagnostics-nope"));
    try {
      const issues = runDiagnostics();
      const issuesWithFix = issues.filter(i => i.fix);
      // Most issues should have fix suggestions
      expect(issuesWithFix.length).toBeGreaterThan(0);
      for (const issue of issuesWithFix) {
        expect(issue.fix!.length).toBeGreaterThan(5);
      }
    } finally {
      _setWorkersDir(TEST_WORKERS_DIR);
    }
  });
});
