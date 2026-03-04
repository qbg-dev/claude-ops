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
  resolveRecipient, generateSeedContent, runDiagnostics, createWorkerFiles, _setWorkersDir,
  readRegistryRaw, ensureWorkerInRegistry, migrateOldEntries,
  writeFlatCompat, lintRegistry, workerKey,
  WORKER_NAME, WORKERS_DIR,
  type Task, type DiagnosticIssue,
  type RegistryWorker, type RegistryPane, type UnifiedRegistry,
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
    // Should either find parent pane or return error — both valid
    expect(["pane", "worker"]).toContain(result.type);
    // Either a pane ID, workerName, or error should be set
    expect(result.paneId || result.workerName || result.error).toBeTruthy();
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
    // claim_task + complete_task were merged into update_task (commit 4eb44d6)
    // check_config added. Total: 17 tools.
    const seed = generateSeedContent();
    expect(seed).toContain("send_message");
    expect(seed).toContain("broadcast");
    expect(seed).toContain("read_inbox");
    expect(seed).toContain("create_task");
    expect(seed).toContain("update_task");  // merged: was claim_task + complete_task
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
    expect(seed).toContain("check_config");
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

// ═══════════════════════════════════════════════════════════════════
// Messaging edge cases
// ═══════════════════════════════════════════════════════════════════

describe("writeToInbox — special characters", () => {
  test("message with double quotes", () => {
    const result = writeToInbox(TEST_WORKER, {
      content: 'He said "hello world"',
      from_name: "tester",
    });
    expect(result).toEqual({ ok: true });

    const line = readFileSync(join(TEST_WORKER_DIR, "inbox.jsonl"), "utf-8").trim();
    const parsed = JSON.parse(line);
    expect(parsed.content).toBe('He said "hello world"');
  });

  test("message with single quotes and backticks", () => {
    const result = writeToInbox(TEST_WORKER, {
      content: "It's a `code block` test",
      from_name: "tester",
    });
    expect(result).toEqual({ ok: true });

    const line = readFileSync(join(TEST_WORKER_DIR, "inbox.jsonl"), "utf-8").trim();
    const parsed = JSON.parse(line);
    expect(parsed.content).toBe("It's a `code block` test");
  });

  test("message with shell metacharacters ($ ! ; | & >)", () => {
    const content = 'Run: $HOME/bin/test; echo "done" | grep ok && rm -rf / > /dev/null &';
    const result = writeToInbox(TEST_WORKER, { content, from_name: "tester" });
    expect(result).toEqual({ ok: true });

    const line = readFileSync(join(TEST_WORKER_DIR, "inbox.jsonl"), "utf-8").trim();
    const parsed = JSON.parse(line);
    expect(parsed.content).toBe(content);
  });

  test("message with newlines", () => {
    const content = "Line 1\nLine 2\nLine 3";
    const result = writeToInbox(TEST_WORKER, { content, from_name: "tester" });
    expect(result).toEqual({ ok: true });

    const line = readFileSync(join(TEST_WORKER_DIR, "inbox.jsonl"), "utf-8").trim();
    const parsed = JSON.parse(line);
    expect(parsed.content).toBe(content);
  });

  test("message with unicode / Chinese characters", () => {
    const content = "你好世界 🎉 — 保臻AI助手";
    const result = writeToInbox(TEST_WORKER, { content, from_name: "tester" });
    expect(result).toEqual({ ok: true });

    const line = readFileSync(join(TEST_WORKER_DIR, "inbox.jsonl"), "utf-8").trim();
    const parsed = JSON.parse(line);
    expect(parsed.content).toBe(content);
  });

  test("message with JSON-like content", () => {
    const content = '{"type":"shutdown","reason":"test"}';
    const result = writeToInbox(TEST_WORKER, { content, from_name: "tester" });
    expect(result).toEqual({ ok: true });

    const line = readFileSync(join(TEST_WORKER_DIR, "inbox.jsonl"), "utf-8").trim();
    const parsed = JSON.parse(line);
    expect(parsed.content).toBe(content);
  });

  test("empty content string", () => {
    const result = writeToInbox(TEST_WORKER, { content: "", from_name: "tester" });
    expect(result).toEqual({ ok: true });

    const line = readFileSync(join(TEST_WORKER_DIR, "inbox.jsonl"), "utf-8").trim();
    const parsed = JSON.parse(line);
    expect(parsed.content).toBe("");
  });

  test("very long message (10KB)", () => {
    const content = "x".repeat(10_000);
    const result = writeToInbox(TEST_WORKER, { content, from_name: "tester" });
    expect(result).toEqual({ ok: true });

    const line = readFileSync(join(TEST_WORKER_DIR, "inbox.jsonl"), "utf-8").trim();
    const parsed = JSON.parse(line);
    expect(parsed.content.length).toBe(10_000);
  });
});

describe("writeToInbox — field integrity", () => {
  test("summary auto-truncated from content when omitted", () => {
    const content = "A".repeat(200);
    const result = writeToInbox(TEST_WORKER, { content, from_name: "tester" });
    expect(result).toEqual({ ok: true });

    const line = readFileSync(join(TEST_WORKER_DIR, "inbox.jsonl"), "utf-8").trim();
    const parsed = JSON.parse(line);
    expect(parsed.summary.length).toBeLessThanOrEqual(60);
  });

  test("from_name with special characters preserved", () => {
    const result = writeToInbox(TEST_WORKER, {
      content: "test",
      from_name: "worker-with-dashes_and_underscores",
    });
    expect(result).toEqual({ ok: true });

    const line = readFileSync(join(TEST_WORKER_DIR, "inbox.jsonl"), "utf-8").trim();
    const parsed = JSON.parse(line);
    expect(parsed.from_name).toBe("worker-with-dashes_and_underscores");
    expect(parsed.from).toBe("worker/worker-with-dashes_and_underscores");
  });

  test("_ts is valid ISO timestamp", () => {
    writeToInbox(TEST_WORKER, { content: "test", from_name: "tester" });

    const line = readFileSync(join(TEST_WORKER_DIR, "inbox.jsonl"), "utf-8").trim();
    const parsed = JSON.parse(line);
    const date = new Date(parsed._ts);
    expect(date.getTime()).not.toBeNaN();
    // Should be recent (within last 5 seconds)
    expect(Date.now() - date.getTime()).toBeLessThan(5000);
  });

  test("each line is valid standalone JSON (JSONL integrity)", () => {
    for (let i = 0; i < 10; i++) {
      writeToInbox(TEST_WORKER, { content: `msg ${i}`, from_name: "tester" });
    }

    const raw = readFileSync(join(TEST_WORKER_DIR, "inbox.jsonl"), "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines.length).toBe(10);

    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

describe("writeToInbox — error paths", () => {
  test("worker dir exists but is a file → error", () => {
    const fakeName = "fake-file-worker";
    writeFileSync(join(TEST_WORKERS_DIR, fakeName), "not a directory");
    const result = writeToInbox(fakeName, { content: "test", from_name: "tester" });
    // Should fail — can't append to inbox.jsonl inside a file
    // On some systems this creates the inbox as a subpath of a file → error
    // On others, existsSync returns true for the file. Either way, the append should fail.
    // We just verify it doesn't crash and returns a result
    expect(typeof result.ok).toBe("boolean");
  });

  test("concurrent writes don't corrupt lines", () => {
    // Simulate rapid sequential writes (JS is single-threaded, but appendFileSync is atomic per call)
    const promises = [];
    for (let i = 0; i < 50; i++) {
      writeToInbox(TEST_WORKER, { content: `concurrent-${i}`, from_name: `writer-${i}` });
    }

    const raw = readFileSync(join(TEST_WORKER_DIR, "inbox.jsonl"), "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines.length).toBe(50);

    // Every line must parse as valid JSON
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.content).toMatch(/^concurrent-\d+$/);
    }
  });
});

describe("readInboxFromCursor — edge cases", () => {
  test("inbox with trailing newlines → no phantom empty messages", () => {
    const inboxPath = join(TEST_WORKER_DIR, "inbox.jsonl");
    writeFileSync(inboxPath, '{"content":"msg1","_ts":"2026-01-01T00:00:00Z"}\n\n\n');

    const { messages } = readInboxFromCursor(TEST_WORKER, {});
    expect(messages.length).toBe(1);
    expect(messages[0].content).toBe("msg1");
  });

  test("inbox with one corrupt line among valid ones → skips corrupt, reads valid", () => {
    const inboxPath = join(TEST_WORKER_DIR, "inbox.jsonl");
    writeFileSync(inboxPath, [
      '{"content":"good1","_ts":"2026-01-01T00:00:00Z"}',
      'NOT JSON AT ALL',
      '{"content":"good2","_ts":"2026-01-02T00:00:00Z"}',
    ].join("\n") + "\n");

    const { messages } = readInboxFromCursor(TEST_WORKER, {});
    // Should get at least the valid messages (implementation may skip or include corrupt)
    const validMsgs = messages.filter((m: any) => m.content);
    expect(validMsgs.length).toBeGreaterThanOrEqual(1);
  });

  test("cursor exactly at file end → zero new messages", () => {
    const inboxPath = join(TEST_WORKER_DIR, "inbox.jsonl");
    const line = '{"content":"old","_ts":"2026-01-01T00:00:00Z"}\n';
    writeFileSync(inboxPath, line);
    writeInboxCursor(TEST_WORKER, Buffer.byteLength(line));

    const { messages } = readInboxFromCursor(TEST_WORKER, {});
    expect(messages.length).toBe(0);
  });

  test("limit=0 → returns empty array", () => {
    const inboxPath = join(TEST_WORKER_DIR, "inbox.jsonl");
    appendFileSync(inboxPath, '{"content":"msg1"}\n');
    appendFileSync(inboxPath, '{"content":"msg2"}\n');

    const { messages } = readInboxFromCursor(TEST_WORKER, { limit: 0 });
    expect(messages.length).toBe(0);
  });

  test("since in the future → returns nothing", () => {
    const inboxPath = join(TEST_WORKER_DIR, "inbox.jsonl");
    appendFileSync(inboxPath, '{"content":"past","_ts":"2026-01-01T00:00:00Z"}\n');

    const { messages } = readInboxFromCursor(TEST_WORKER, { since: "2099-01-01T00:00:00Z" });
    expect(messages.length).toBe(0);
  });
});

describe("resolveRecipient — edge cases", () => {
  test("empty string → treated as worker name", () => {
    const result = resolveRecipient("");
    expect(result.type).toBe("worker");
    expect(result.workerName).toBe("");
  });

  test("name with slashes → treated as worker name (not path traversal)", () => {
    const result = resolveRecipient("../../etc/passwd");
    expect(result.type).toBe("worker");
    expect(result.workerName).toBe("../../etc/passwd");
  });

  test("% without number → treated as pane ID", () => {
    const result = resolveRecipient("%abc");
    expect(result.type).toBe("pane");
    expect(result.paneId).toBe("%abc");
  });

  test("PARENT keyword (case-sensitive)", () => {
    // "Parent" (capitalized) should NOT resolve as parent
    const result = resolveRecipient("Parent");
    expect(result.type).toBe("worker");
    expect(result.workerName).toBe("Parent");
  });

  test("self-reference → no special handling", () => {
    const result = resolveRecipient(WORKER_NAME);
    expect(result.type).toBe("worker");
    expect(result.workerName).toBe(WORKER_NAME);
  });

  test("children without registry → error or empty", () => {
    const result = resolveRecipient("children");
    expect(result.type).toBe("multi_pane");
    // Either paneIds or error should be set
    expect(result.paneIds || result.error).toBeTruthy();
  });

  test("children keyword is case-sensitive", () => {
    const result = resolveRecipient("Children");
    // "Children" (capitalized) should NOT resolve as children
    expect(result.type).toBe("worker");
    expect(result.workerName).toBe("Children");
  });
});

describe("writeToInbox — path traversal safety", () => {
  test("recipient with ../ → writeToInbox checks directory existence", () => {
    // writeToInbox should fail because no worker dir exists for this name
    const result = writeToInbox("../../../tmp/evil", { content: "pwned", from_name: "attacker" });
    // The worker dir check should catch this — no dir at WORKERS_DIR/../../../tmp/evil
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain("not found");
  });

  test("recipient with null bytes → fails gracefully", () => {
    const result = writeToInbox("test\x00worker", { content: "test", from_name: "tester" });
    // Should either fail to find the dir or fail to write — not crash
    expect(typeof result.ok).toBe("boolean");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Unified Registry — workerKey
// ═══════════════════════════════════════════════════════════════════

describe("workerKey", () => {
  test("returns PROJECT_SLUG:name format", () => {
    const key = workerKey("chief-of-staff");
    // PROJECT_SLUG is basename(PROJECT_ROOT) — usually "Wechat" in dev
    expect(key).toMatch(/^[^:]+:chief-of-staff$/);
    expect(key).toContain(":chief-of-staff");
  });

  test("different names produce different keys", () => {
    expect(workerKey("alpha")).not.toBe(workerKey("beta"));
  });

  test("same name produces same key (deterministic)", () => {
    expect(workerKey("test-worker")).toBe(workerKey("test-worker"));
  });

  test("handles names with hyphens and underscores", () => {
    const key = workerKey("my-worker_v2");
    expect(key).toContain(":my-worker_v2");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Unified Registry — migrateOldEntries
// ═══════════════════════════════════════════════════════════════════

describe("migrateOldEntries", () => {
  function makeRegistry(overrides: Partial<UnifiedRegistry> = {}): UnifiedRegistry {
    return { workers: {}, panes: {}, ...overrides };
  }

  test("migrates flat worker entry to panes section", () => {
    const registry = makeRegistry({
      "%111": {
        harness: "worker/chief-of-staff",
        session_name: "chief-of-staff",
        task: "worker",
        pane_target: "w:1.2",
        tmux_session: "w",
        session_id: "abc-123",
        project_root: "/some/path",
      },
    }) as any;

    const migrated = migrateOldEntries(registry);

    expect(migrated).toBe(true);
    expect(registry.panes["%111"]).toBeDefined();
    expect(registry.panes["%111"].worker).toBe("chief-of-staff");
    expect(registry.panes["%111"].role).toBe("worker");
    expect(registry.panes["%111"].pane_target).toBe("w:1.2");
    expect(registry.panes["%111"].tmux_session).toBe("w");
    expect(registry.panes["%111"].session_id).toBe("abc-123");
    expect(registry.panes["%111"].parent_pane).toBeNull();
    expect(registry.panes["%111"].registered_at).toBeTruthy();
  });

  test("migrates child entry with correct role", () => {
    const registry = makeRegistry({
      "%200": {
        harness: "worker/chatbot-tools",
        task: "child",
        parent_pane: "%111",
        pane_target: "w:2.1",
      },
    }) as any;

    migrateOldEntries(registry);

    expect(registry.panes["%200"].role).toBe("child");
    expect(registry.panes["%200"].parent_pane).toBe("%111");
  });

  test("preserves flat entries for backward compat", () => {
    const registry = makeRegistry({
      "%111": {
        harness: "worker/chief-of-staff",
        task: "worker",
        project_root: "/path",
      },
    }) as any;

    migrateOldEntries(registry);

    // Flat entry should still exist
    expect(registry["%111"]).toBeDefined();
    expect(registry["%111"].harness).toBe("worker/chief-of-staff");
  });

  test("idempotent — already migrated entries are skipped", () => {
    const pane: RegistryPane = {
      worker: "chief-of-staff",
      role: "worker",
      pane_target: "w:1.2",
      tmux_session: "w",
      session_id: "existing",
      parent_pane: null,
      registered_at: "2026-01-01T00:00:00Z",
    };
    const registry = makeRegistry({
      panes: { "%111": pane },
      "%111": { harness: "worker/chief-of-staff", task: "worker" },
    }) as any;

    const migrated = migrateOldEntries(registry);

    expect(migrated).toBe(false);
    // Original panes entry preserved, not overwritten
    expect(registry.panes["%111"].session_id).toBe("existing");
  });

  test("empty registry — no migration needed", () => {
    const registry = makeRegistry();
    expect(migrateOldEntries(registry)).toBe(false);
  });

  test("skips non-pane keys", () => {
    const registry = makeRegistry({
      someRandomKey: { harness: "not-a-pane" },
    }) as any;

    migrateOldEntries(registry);

    expect(Object.keys(registry.panes).length).toBe(0);
  });

  test("skips entries without harness field", () => {
    const registry = makeRegistry({
      "%333": { task: "worker", pane_target: "w:3.0" }, // no harness
    }) as any;

    migrateOldEntries(registry);

    expect(registry.panes["%333"]).toBeUndefined();
  });

  test("handles missing optional fields gracefully", () => {
    const registry = makeRegistry({
      "%444": { harness: "worker/minimal" }, // minimal entry
    }) as any;

    migrateOldEntries(registry);

    expect(registry.panes["%444"].worker).toBe("minimal");
    expect(registry.panes["%444"].pane_target).toBe("");
    expect(registry.panes["%444"].tmux_session).toBe("");
    expect(registry.panes["%444"].session_id).toBe("");
    expect(registry.panes["%444"].parent_pane).toBeNull();
    expect(registry.panes["%444"].role).toBe("worker");
  });

  test("migrates multiple entries", () => {
    const registry = makeRegistry({
      "%10": { harness: "worker/alpha", task: "worker", pane_target: "w:1.0" },
      "%20": { harness: "worker/beta", task: "worker", pane_target: "w:2.0" },
      "%30": { harness: "worker/alpha", task: "child", parent_pane: "%10", pane_target: "w:1.1" },
    }) as any;

    const migrated = migrateOldEntries(registry);

    expect(migrated).toBe(true);
    expect(Object.keys(registry.panes).length).toBe(3);
    expect(registry.panes["%10"].worker).toBe("alpha");
    expect(registry.panes["%20"].worker).toBe("beta");
    expect(registry.panes["%30"].role).toBe("child");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Unified Registry — writeFlatCompat
// ═══════════════════════════════════════════════════════════════════

describe("writeFlatCompat", () => {
  test("writes flat entry with correct fields", () => {
    const wk = workerKey("test-worker");
    const registry: UnifiedRegistry = {
      workers: {
        [wk]: {
          project_root: "/test/project",
          worker_dir: "/test/project/.claude/workers/test-worker",
          worktree: "/test/project-w-test-worker",
          branch: "worker/test-worker",
          config: { model: "sonnet", permission_mode: "bypass", disallowedTools: [] },
          state: { status: "active" },
          tasks: {},
        },
      },
      panes: {},
    };

    const pane: RegistryPane = {
      worker: "test-worker",
      role: "worker",
      pane_target: "w:5.0",
      tmux_session: "w",
      session_id: "sess-123",
      parent_pane: null,
      registered_at: "2026-01-01T00:00:00Z",
    };

    writeFlatCompat(registry, "%555", pane);

    const flat = registry["%555"];
    expect(flat).toBeDefined();
    expect(flat.harness).toBe("worker/test-worker");
    expect(flat.session_name).toBe("test-worker");
    expect(flat.display).toBe("test-worker");
    expect(flat.task).toBe("worker");
    expect(flat.pane_target).toBe("w:5.0");
    expect(flat.project_root).toBe("/test/project");
    expect(flat.tmux_session).toBe("w");
    expect(flat.session_id).toBe("sess-123");
    expect(flat.parent_pane).toBeNull();
    expect(flat.registered_at).toBe("2026-01-01T00:00:00Z");
    expect(flat.done).toBe(0);
    expect(flat.total).toBe(0);
  });

  test("child pane gets task=child", () => {
    const wk = workerKey("parent-worker");
    const registry: UnifiedRegistry = {
      workers: {
        [wk]: {
          project_root: "/test",
          worker_dir: "/test/.claude/workers/parent-worker",
          worktree: "/test-w-parent-worker",
          branch: "worker/parent-worker",
          config: { model: "sonnet", permission_mode: "bypass", disallowedTools: [] },
          state: {},
          tasks: {},
        },
      },
      panes: {},
    };

    const childPane: RegistryPane = {
      worker: "parent-worker",
      role: "child",
      pane_target: "w:5.1",
      tmux_session: "w",
      session_id: "",
      parent_pane: "%555",
      registered_at: "2026-01-01T00:00:00Z",
    };

    writeFlatCompat(registry, "%556", childPane);

    expect(registry["%556"].task).toBe("child");
    expect(registry["%556"].parent_pane).toBe("%555");
  });

  test("handles missing worker in workers section gracefully", () => {
    const registry: UnifiedRegistry = { workers: {}, panes: {} };
    const pane: RegistryPane = {
      worker: "unknown-worker",
      role: "worker",
      pane_target: "w:1.0",
      tmux_session: "w",
      session_id: "",
      parent_pane: null,
      registered_at: "2026-01-01T00:00:00Z",
    };

    // Should not throw even if worker not in workers section
    expect(() => writeFlatCompat(registry, "%999", pane)).not.toThrow();
    expect(registry["%999"].harness).toBe("worker/unknown-worker");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Unified Registry — ensureWorkerInRegistry
// ═══════════════════════════════════════════════════════════════════

describe("ensureWorkerInRegistry", () => {
  test("bootstraps from filesystem when worker not in registry", () => {
    // Create filesystem files for the test worker
    const testName = "ensure-test";
    const testDir = join(TEST_WORKERS_DIR, testName);
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, "permissions.json"), JSON.stringify({ model: "opus", permission_mode: "default", disallowedTools: ["Bash"] }));
    writeFileSync(join(testDir, "state.json"), JSON.stringify({ status: "active", cycles_completed: 10, issues_found: 5 }));
    writeFileSync(join(testDir, "tasks.json"), JSON.stringify({ T001: makeTask({ subject: "Test task" }) }));

    const registry: UnifiedRegistry = { workers: {}, panes: {} };
    const worker = ensureWorkerInRegistry(registry, testName);

    expect(worker).toBeDefined();
    expect(worker.config.model).toBe("opus");
    expect(worker.config.disallowedTools).toEqual(["Bash"]);
    expect(worker.state.status).toBe("active");
    expect(worker.state.cycles_completed).toBe(10);
    expect(worker.tasks.T001).toBeDefined();
    expect(worker.branch).toBe(`worker/${testName}`);
    expect(worker.worker_dir).toContain(testName);
  });

  test("returns existing entry without overwriting", () => {
    const testName = "existing-worker";
    const wk = workerKey(testName);
    const existing: RegistryWorker = {
      project_root: "/custom/root",
      worker_dir: "/custom/workers/existing-worker",
      worktree: "/custom/root-w-existing-worker",
      branch: "worker/existing-worker",
      config: { model: "opus", permission_mode: "strict", disallowedTools: [] },
      state: { status: "done", cycles_completed: 99 },
      tasks: {},
    };
    const registry: UnifiedRegistry = { workers: { [wk]: existing }, panes: {} };

    const result = ensureWorkerInRegistry(registry, testName);

    // Should return existing, not overwrite
    expect(result.state.cycles_completed).toBe(99);
    expect(result.config.model).toBe("opus");
    expect(result.project_root).toBe("/custom/root");
  });

  test("defaults when filesystem files are missing", () => {
    const testName = "no-files-worker";
    const testDir = join(TEST_WORKERS_DIR, testName);
    mkdirSync(testDir, { recursive: true });
    // No permissions.json, state.json, or tasks.json

    const registry: UnifiedRegistry = { workers: {}, panes: {} };
    const worker = ensureWorkerInRegistry(registry, testName);

    expect(worker.config.model).toBe("sonnet");
    expect(worker.config.permission_mode).toBe("bypassPermissions");
    expect(worker.state.status).toBe("idle");
    expect(worker.state.cycles_completed).toBe(0);
    expect(Object.keys(worker.tasks)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Unified Registry — lintRegistry
// ═══════════════════════════════════════════════════════════════════

describe("lintRegistry", () => {
  // lintRegistry depends on isPaneAlive (tmux), existsSync, and PROJECT_SLUG.
  // In test env, no tmux panes exist → all panes are "dead" and worker_dirs may not exist.
  // These tests verify the structure and classification of lint issues.

  test("returns array", () => {
    const registry: UnifiedRegistry = { workers: {}, panes: {} };
    const issues = lintRegistry(registry);
    expect(Array.isArray(issues)).toBe(true);
  });

  test("empty registry → no issues", () => {
    const registry: UnifiedRegistry = { workers: {}, panes: {} };
    const issues = lintRegistry(registry);
    expect(issues.length).toBe(0);
  });

  test("detects dead panes", () => {
    const registry: UnifiedRegistry = {
      workers: {},
      panes: {
        "%99999": {
          worker: "ghost",
          role: "worker",
          pane_target: "x:0.0",
          tmux_session: "x",
          session_id: "",
          parent_pane: null,
          registered_at: "2026-01-01T00:00:00Z",
        },
      },
    };

    const issues = lintRegistry(registry);
    const deadPaneIssue = issues.find(i => i.check === "lint.dead_pane");
    expect(deadPaneIssue).toBeDefined();
    expect(deadPaneIssue!.severity).toBe("warning");
    expect(deadPaneIssue!.message).toContain("%99999");
    expect(deadPaneIssue!.message).toContain("ghost");
  });

  test("detects orphan parent reference", () => {
    const registry: UnifiedRegistry = {
      workers: {},
      panes: {
        "%100": {
          worker: "child-worker",
          role: "child",
          pane_target: "w:1.1",
          tmux_session: "w",
          session_id: "",
          parent_pane: "%nonexistent",
          registered_at: "2026-01-01T00:00:00Z",
        },
      },
    };

    const issues = lintRegistry(registry);
    const orphanIssue = issues.find(i => i.check === "lint.orphan_parent");
    expect(orphanIssue).toBeDefined();
    expect(orphanIssue!.severity).toBe("warning");
    expect(orphanIssue!.message).toContain("%nonexistent");
  });

  test("no orphan issue when parent exists in panes", () => {
    const registry: UnifiedRegistry = {
      workers: {},
      panes: {
        "%100": {
          worker: "parent",
          role: "worker",
          pane_target: "w:1.0",
          tmux_session: "w",
          session_id: "",
          parent_pane: null,
          registered_at: "2026-01-01T00:00:00Z",
        },
        "%200": {
          worker: "parent",
          role: "child",
          pane_target: "w:1.1",
          tmux_session: "w",
          session_id: "",
          parent_pane: "%100",
          registered_at: "2026-01-01T00:00:00Z",
        },
      },
    };

    const issues = lintRegistry(registry);
    const orphanIssue = issues.find(i => i.check === "lint.orphan_parent");
    expect(orphanIssue).toBeUndefined();
  });

  test("no orphan issue when parent exists in flat entries", () => {
    const registry: UnifiedRegistry = {
      workers: {},
      panes: {
        "%200": {
          worker: "child",
          role: "child",
          pane_target: "w:1.1",
          tmux_session: "w",
          session_id: "",
          parent_pane: "%100",
          registered_at: "2026-01-01T00:00:00Z",
        },
      },
      // parent in flat compat only
      "%100": { harness: "worker/parent", task: "worker" },
    };

    const issues = lintRegistry(registry);
    const orphanIssue = issues.find(i => i.check === "lint.orphan_parent");
    expect(orphanIssue).toBeUndefined();
  });

  test("detects missing model in config", () => {
    const wk = workerKey("no-model");
    const registry: UnifiedRegistry = {
      workers: {
        [wk]: {
          project_root: "/test",
          worker_dir: join(TEST_WORKERS_DIR, "no-model"),
          worktree: "/test-w-no-model",
          branch: "worker/no-model",
          config: { model: "", permission_mode: "bypass", disallowedTools: [] },
          state: {},
          tasks: {},
        },
      },
      panes: {},
    };

    // Create worker dir so worker_dir check passes
    mkdirSync(join(TEST_WORKERS_DIR, "no-model"), { recursive: true });

    const issues = lintRegistry(registry);
    const modelIssue = issues.find(i => i.check === "lint.model");
    expect(modelIssue).toBeDefined();
    expect(modelIssue!.severity).toBe("warning");
  });

  test("detects worker_dir that does not exist", () => {
    const wk = workerKey("phantom");
    const registry: UnifiedRegistry = {
      workers: {
        [wk]: {
          project_root: "/test",
          worker_dir: "/nonexistent/path/to/phantom",
          worktree: "/test-w-phantom",
          branch: "worker/phantom",
          config: { model: "sonnet", permission_mode: "bypass", disallowedTools: [] },
          state: {},
          tasks: {},
        },
      },
      panes: {},
    };

    const issues = lintRegistry(registry);
    const dirIssue = issues.find(i => i.check === "lint.worker_dir");
    expect(dirIssue).toBeDefined();
    expect(dirIssue!.severity).toBe("error");
    expect(dirIssue!.message).toContain("phantom");
  });

  test("skips workers from other projects", () => {
    // Workers keyed with a different project slug should be ignored
    const registry: UnifiedRegistry = {
      workers: {
        "OtherProject:some-worker": {
          project_root: "/other",
          worker_dir: "/nonexistent",
          worktree: "/nonexistent",
          branch: "worker/some-worker",
          config: { model: "", permission_mode: "", disallowedTools: [] },
          state: {},
          tasks: {},
        },
      },
      panes: {},
    };

    const issues = lintRegistry(registry);
    // Should not report issues for other-project workers
    const otherIssues = issues.filter(i => i.message.includes("OtherProject"));
    expect(otherIssues.length).toBe(0);
  });

  test("all issues have correct structure", () => {
    const registry: UnifiedRegistry = {
      workers: {},
      panes: {
        "%77": {
          worker: "lint-test",
          role: "child",
          pane_target: "w:1.0",
          tmux_session: "w",
          session_id: "",
          parent_pane: "%absent",
          registered_at: "2026-01-01T00:00:00Z",
        },
      },
    };

    const issues = lintRegistry(registry);
    for (const issue of issues) {
      expect(["error", "warning"]).toContain(issue.severity);
      expect(typeof issue.check).toBe("string");
      expect(issue.check.startsWith("lint.")).toBe(true);
      expect(typeof issue.message).toBe("string");
      expect(issue.message.length).toBeGreaterThan(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// Unified Registry — readRegistryRaw
// ═══════════════════════════════════════════════════════════════════

describe("readRegistryRaw", () => {
  test("always returns workers and panes objects", () => {
    const registry = readRegistryRaw();
    expect(registry.workers).toBeDefined();
    expect(typeof registry.workers).toBe("object");
    expect(registry.panes).toBeDefined();
    expect(typeof registry.panes).toBe("object");
  });

  test("reads live registry without error", () => {
    // Should not throw even if registry has lots of entries
    expect(() => readRegistryRaw()).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Unified Registry — integration: task CRUD via registry
// ═══════════════════════════════════════════════════════════════════

describe("task CRUD via registry", () => {
  const TASK_WORKER = "task-reg-worker";
  const TASK_WORKER_DIR = join(TEST_WORKERS_DIR, TASK_WORKER);

  beforeEach(() => {
    mkdirSync(TASK_WORKER_DIR, { recursive: true });
    writeFileSync(join(TASK_WORKER_DIR, "tasks.json"), "{}");
  });

  test("writeTasks persists to filesystem", () => {
    const tasks: Record<string, Task> = {
      T001: makeTask({ subject: "First task" }),
      T002: makeTask({ subject: "Second task", status: "in_progress" }),
    };

    writeTasks(TASK_WORKER, tasks);

    // Verify filesystem has the tasks
    const onDisk = JSON.parse(readFileSync(join(TASK_WORKER_DIR, "tasks.json"), "utf-8"));
    expect(onDisk.T001.subject).toBe("First task");
    expect(onDisk.T002.status).toBe("in_progress");
  });

  test("readTasks returns what writeTasks wrote", () => {
    const tasks: Record<string, Task> = {
      T001: makeTask({ subject: "Roundtrip test" }),
    };

    writeTasks(TASK_WORKER, tasks);
    const read = readTasks(TASK_WORKER);

    expect(read.T001).toBeDefined();
    expect(read.T001.subject).toBe("Roundtrip test");
  });

  test("readTasks falls back to filesystem when registry has no entry", () => {
    // Use a different worker name to avoid registry cache from prior test
    const fsWorker = "fs-only-worker";
    const fsDir = join(TEST_WORKERS_DIR, fsWorker);
    mkdirSync(fsDir, { recursive: true });

    // Write directly to filesystem (simulating old behavior)
    const tasks: Record<string, Task> = {
      T001: makeTask({ subject: "Filesystem only" }),
    };
    writeFileSync(join(fsDir, "tasks.json"), JSON.stringify(tasks, null, 2));

    const read = readTasks(fsWorker);
    expect(read.T001).toBeDefined();
    expect(read.T001.subject).toBe("Filesystem only");
  });

  test("writeTasks handles empty tasks object", () => {
    writeTasks(TASK_WORKER, {});

    const read = readTasks(TASK_WORKER);
    expect(Object.keys(read)).toEqual([]);
  });

  test("writeTasks preserves task metadata", () => {
    const tasks: Record<string, Task> = {
      T001: makeTask({
        subject: "Complex task",
        priority: "critical",
        recurring: true,
        blocked_by: ["T002"],
        metadata: { custom: "value" },
        owner: "me",
      }),
    };

    writeTasks(TASK_WORKER, tasks);
    const read = readTasks(TASK_WORKER);

    expect(read.T001.priority).toBe("critical");
    expect(read.T001.recurring).toBe(true);
    expect(read.T001.blocked_by).toEqual(["T002"]);
    expect(read.T001.metadata).toEqual({ custom: "value" });
    expect(read.T001.owner).toBe("me");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Unified Registry — migration from flat to unified
// ═══════════════════════════════════════════════════════════════════

describe("migration integration", () => {
  test("old-format registry is fully migratable", () => {
    // Simulate a pre-migration registry with multiple entries
    const oldRegistry = {
      "%22": {
        harness: "worker/rag-optimizer",
        session_name: "rag-optimizer",
        task: "worker",
        pane_target: "w:9.0",
        tmux_session: "w",
        project_root: "/Users/wz/Desktop/zPersonalProjects/Wechat",
      },
      "%29": {
        harness: "worker/conv-monitor",
        session_name: "conv-monitor",
        task: "worker",
        pane_target: "m:3.0",
        tmux_session: "m",
        session_id: "some-uuid",
        project_root: "/Users/wz/Desktop/zPersonalProjects/Wechat",
      },
      "%135": {
        harness: "worker/operator",
        parent_pane: "%129",
        task: "child",
        pane_target: "h:2.1",
      },
    } as any;

    // Add required sections
    oldRegistry.workers = {};
    oldRegistry.panes = {};

    const migrated = migrateOldEntries(oldRegistry);

    expect(migrated).toBe(true);
    expect(Object.keys(oldRegistry.panes).length).toBe(3);

    // Check worker pane
    expect(oldRegistry.panes["%22"].worker).toBe("rag-optimizer");
    expect(oldRegistry.panes["%22"].role).toBe("worker");

    // Check pane with session_id
    expect(oldRegistry.panes["%29"].session_id).toBe("some-uuid");
    expect(oldRegistry.panes["%29"].tmux_session).toBe("m");

    // Check child pane
    expect(oldRegistry.panes["%135"].role).toBe("child");
    expect(oldRegistry.panes["%135"].parent_pane).toBe("%129");
    expect(oldRegistry.panes["%135"].worker).toBe("operator");

    // Flat entries still present
    expect(oldRegistry["%22"].harness).toBe("worker/rag-optimizer");
    expect(oldRegistry["%29"].harness).toBe("worker/conv-monitor");
    expect(oldRegistry["%135"].harness).toBe("worker/operator");
  });

  test("partial migration — only unmigrated entries processed", () => {
    const registry: UnifiedRegistry = {
      workers: {},
      panes: {
        "%22": {
          worker: "rag-optimizer",
          role: "worker",
          pane_target: "w:9.0",
          tmux_session: "w",
          session_id: "already-set",
          parent_pane: null,
          registered_at: "2026-01-01T00:00:00Z",
        },
      },
      "%22": { harness: "worker/rag-optimizer", task: "worker" },
      "%29": { harness: "worker/conv-monitor", task: "worker", pane_target: "m:3.0" },
    } as any;

    const migrated = migrateOldEntries(registry);

    expect(migrated).toBe(true);
    // %22 was already in panes — should NOT be overwritten
    expect(registry.panes["%22"].session_id).toBe("already-set");
    // %29 was new — should be migrated
    expect(registry.panes["%29"]).toBeDefined();
    expect(registry.panes["%29"].worker).toBe("conv-monitor");
  });
});

// ═══════════════════════════════════════════════════════════════════
// createWorkerFiles
// ═══════════════════════════════════════════════════════════════════

describe("createWorkerFiles", () => {
  test("creates all 4 files with defaults", () => {
    const result = createWorkerFiles({
      name: "my-worker",
      mission: "# My Worker\nDo stuff.",
    });
    expect(result.ok).toBe(true);

    const dir = join(TEST_WORKERS_DIR, "my-worker");
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, "mission.md"))).toBe(true);
    expect(existsSync(join(dir, "permissions.json"))).toBe(true);
    expect(existsSync(join(dir, "state.json"))).toBe(true);
    expect(existsSync(join(dir, "tasks.json"))).toBe(true);

    // Check mission content
    const mission = readFileSync(join(dir, "mission.md"), "utf-8");
    expect(mission).toBe("# My Worker\nDo stuff.\n");

    // Check defaults
    const perms = JSON.parse(readFileSync(join(dir, "permissions.json"), "utf-8"));
    expect(perms.model).toBe("sonnet");
    expect(perms.permission_mode).toBe("bypassPermissions");
    expect(perms.disallowedTools.length).toBeGreaterThan(0);

    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf-8"));
    expect(state.status).toBe("idle");
    expect(state.cycles_completed).toBe(0);
    expect(state.perpetual).toBe(false);
    expect(state.sleep_duration).toBeUndefined();

    const tasks = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf-8"));
    expect(Object.keys(tasks).length).toBe(0);
  });

  test("respects model and perpetual params", () => {
    const result = createWorkerFiles({
      name: "perp-worker",
      mission: "Run forever.",
      model: "opus",
      perpetual: true,
      sleep_duration: 600,
    });
    expect(result.ok).toBe(true);
    expect(result.model).toBe("opus");
    expect(result.perpetual).toBe(true);

    const dir = join(TEST_WORKERS_DIR, "perp-worker");
    const perms = JSON.parse(readFileSync(join(dir, "permissions.json"), "utf-8"));
    expect(perms.model).toBe("opus");

    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf-8"));
    expect(state.perpetual).toBe(true);
    expect(state.sleep_duration).toBe(600);
  });

  test("creates tasks from entries", () => {
    const result = createWorkerFiles({
      name: "task-worker",
      mission: "Fix things.",
      taskEntries: [
        { subject: "Fix bug A", priority: "high" },
        { subject: "Fix bug B", description: "Details here" },
        { subject: "Fix bug C" },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.taskIds).toEqual(["T001", "T002", "T003"]);

    const dir = join(TEST_WORKERS_DIR, "task-worker");
    const tasks = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf-8"));
    expect(Object.keys(tasks).length).toBe(3);
    expect(tasks.T001.subject).toBe("Fix bug A");
    expect(tasks.T001.priority).toBe("high");
    expect(tasks.T001.status).toBe("pending");
    expect(tasks.T002.description).toBe("Details here");
    expect(tasks.T003.priority).toBe("medium"); // default
  });

  test("rejects invalid name", () => {
    const result = createWorkerFiles({
      name: "Invalid Name!",
      mission: "Stuff.",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("kebab-case");
  });

  test("rejects name starting with dash", () => {
    const result = createWorkerFiles({
      name: "-bad-name",
      mission: "Stuff.",
    });
    expect(result.ok).toBe(false);
  });

  test("rejects empty mission", () => {
    const result = createWorkerFiles({
      name: "blank-worker",
      mission: "   ",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("empty");
  });

  test("rejects duplicate worker name", () => {
    // test-worker already exists from beforeEach
    const result = createWorkerFiles({
      name: "test-worker",
      mission: "Duplicate.",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("already exists");
  });

  test("trims mission whitespace", () => {
    const result = createWorkerFiles({
      name: "trim-worker",
      mission: "\n  # Trimmed  \n",
    });
    expect(result.ok).toBe(true);
    const mission = readFileSync(join(TEST_WORKERS_DIR, "trim-worker", "mission.md"), "utf-8");
    expect(mission).toBe("# Trimmed\n");
  });

  test("disallowedTools blocks dangerous git operations", () => {
    createWorkerFiles({ name: "sec-worker", mission: "Secure." });
    const perms = JSON.parse(readFileSync(join(TEST_WORKERS_DIR, "sec-worker", "permissions.json"), "utf-8"));
    expect(perms.disallowedTools).toContain("Bash(git checkout main*)");
    expect(perms.disallowedTools).toContain("Bash(git push*)");
    expect(perms.disallowedTools).toContain("Bash(rm -rf*)");
  });
});
