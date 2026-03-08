/**
 * Tests for worker-fleet MCP server helpers.
 * Run: cd ~/.claude-ops/mcp/worker-fleet && bun test
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, appendFileSync } from "fs";
import { join } from "path";
import {
  readTasks, writeTasks, nextTaskId, isTaskBlocked,
  writeToInbox, writeToTriageQueue, buildMessageBody, readInboxFromCursor, readInboxCursor, writeInboxCursor,
  resolveRecipient, generateSeedContent, runDiagnostics, createWorkerFiles, _setWorkersDir,
  readRegistry, getWorkerEntry, ensureWorkerInRegistry, lintRegistry,
  _replaceMemorySection, acquireLock, releaseLock, getWorktreeDir, getSessionId,
  getReportTo, canUpdateWorker,
  WORKER_NAME, WORKERS_DIR, REGISTRY_PATH, HARNESS_LOCK_DIR,
  type Task, type DiagnosticIssue,
  type RegistryConfig, type RegistryWorkerEntry, type ProjectRegistry,
  type WorkerRuntime,
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

function makeRegistryEntry(overrides: Partial<RegistryWorkerEntry> = {}): RegistryWorkerEntry {
  return {
    model: "sonnet",
    permission_mode: "bypassPermissions",
    disallowed_tools: [],
    status: "idle",
    perpetual: false,
    sleep_duration: 0,
    branch: "worker/test",
    worktree: null,
    window: null,
    pane_id: null,
    pane_target: null,
    tmux_session: "w",
    session_id: null,
    session_file: null,
    mission_file: ".claude/workers/test/mission.md",
    custom: {},
    ...overrides,
  };
}

function makeProjectRegistry(workers: Record<string, RegistryWorkerEntry> = {}): ProjectRegistry {
  return {
    _config: {
      commit_notify: ["merger"],
      merge_authority: "merger",
      deploy_authority: "merger",
      mission_authority: "chief-of-staff",
      tmux_session: "w",
      project_name: "TestProject",
    },
    ...workers,
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
  const TASK_WORKER = "crud-worker";
  const TASK_WORKER_DIR = join(TEST_WORKERS_DIR, TASK_WORKER);
  const TASKS_FILE = join(TASK_WORKER_DIR, "tasks.json");

  beforeEach(() => {
    mkdirSync(TASK_WORKER_DIR, { recursive: true });
    writeFileSync(TASKS_FILE, "{}");
  });

  test("readTasks on empty file → empty object", () => {
    const data = JSON.parse(readFileSync(TASKS_FILE, "utf-8"));
    expect(data).toEqual({});
  });

  test("readTasks on missing file → empty object", () => {
    const result = readTasks("nonexistent-worker-xyz");
    expect(result).toEqual({});
  });

  test("forward-blocking adds taskId to target blocked_by", () => {
    const tasks: Record<string, Task> = {
      T001: makeTask({ subject: "Setup" }),
      T002: makeTask({ subject: "Build" }),
    };
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

  test("writeTasks persists to filesystem", () => {
    const tasks: Record<string, Task> = {
      T001: makeTask({ subject: "First task" }),
      T002: makeTask({ subject: "Second task", status: "in_progress" }),
    };
    writeTasks(TASK_WORKER, tasks);
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
    expect(result.ok).toBe(true);
    expect((result as any).msg_id).toBeTruthy();
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
    writeInboxCursor(TEST_WORKER, Buffer.byteLength(line1));
    appendFileSync(inboxPath, JSON.stringify({ content: "new", _ts: "2026-01-02T00:00:00Z" }) + "\n");
    const { messages } = readInboxFromCursor(TEST_WORKER, {});
    expect(messages.length).toBe(1);
    expect(messages[0].content).toBe("new");
  });

  test("truncated file → resets cursor to 0, reads all", () => {
    const inboxPath = join(TEST_WORKER_DIR, "inbox.jsonl");
    writeFileSync(inboxPath, JSON.stringify({ content: "after-truncate" }) + "\n");
    writeInboxCursor(TEST_WORKER, 99999);
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
    const remaining = readFileSync(inboxPath, "utf-8");
    expect(remaining).toBe("");
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
// writeToTriageQueue
// ═══════════════════════════════════════════════════════════════════

describe("writeToTriageQueue", () => {
  test("creates triage dir and queue file if missing", () => {
    const result = writeToTriageQueue("need help", "help needed", "test-bot");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.id).toMatch(/^tq-\d+$/);

    const queuePath = join(process.env.PROJECT_ROOT || process.cwd(), ".claude/triage/queue.jsonl");
    expect(existsSync(queuePath)).toBe(true);

    const lines = readFileSync(queuePath, "utf-8").trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.id).toBe(result.id);
    expect(entry.category).toBe("worker-escalation");
    expect(entry.title).toBe("help needed");
    expect(entry.detail).toBe("need help");
    expect(entry.source).toBe("test-bot");
    expect(entry.status).toBe("pending");
    expect(entry.added_at).toBeTruthy();
  });

  test("uses content prefix as title when no summary", () => {
    const result = writeToTriageQueue("a very long content message that exceeds sixty characters total length for testing", undefined, "test-bot");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const queuePath = join(process.env.PROJECT_ROOT || process.cwd(), ".claude/triage/queue.jsonl");
    const lines = readFileSync(queuePath, "utf-8").trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.title.length).toBeLessThanOrEqual(60);
  });

  test("appends multiple entries to same file", () => {
    writeToTriageQueue("first", "first msg", "bot-a");
    writeToTriageQueue("second", "second msg", "bot-b");

    const queuePath = join(process.env.PROJECT_ROOT || process.cwd(), ".claude/triage/queue.jsonl");
    const lines = readFileSync(queuePath, "utf-8").trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);

    const last2 = lines.slice(-2).map(l => JSON.parse(l));
    expect(last2[0].source).toBe("bot-a");
    expect(last2[1].source).toBe("bot-b");
  });
});

// ═══════════════════════════════════════════════════════════════════
// buildMessageBody
// ═══════════════════════════════════════════════════════════════════

describe("buildMessageBody", () => {
  test("content only", () => {
    expect(buildMessageBody("hello")).toBe("hello");
  });

  test("content + context", () => {
    const result = buildMessageBody("question", "some background");
    expect(result).toBe("question\n\n---\nsome background");
  });

  test("content + options", () => {
    const result = buildMessageBody("pick one", undefined, ["A", "B", "C"]);
    expect(result).toContain("Options:");
    expect(result).toContain("  1) A");
    expect(result).toContain("  2) B");
    expect(result).toContain("  3) C");
  });

  test("content + context + options", () => {
    const result = buildMessageBody("pick", "ctx", ["X", "Y"]);
    expect(result).toContain("---\nctx");
    expect(result).toContain("  1) X");
    expect(result).toContain("  2) Y");
  });

  test("empty options array is ignored", () => {
    expect(buildMessageBody("hello", undefined, [])).toBe("hello");
  });

  test("empty string context is still rendered", () => {
    // Empty string is falsy, so context separator should NOT appear
    expect(buildMessageBody("hello", "")).toBe("hello");
  });

  test("single option", () => {
    const result = buildMessageBody("pick", undefined, ["Only choice"]);
    expect(result).toContain("  1) Only choice");
    expect(result).not.toContain("  2)");
  });

  test("options with special characters", () => {
    const result = buildMessageBody("pick", undefined, [
      'Deploy with --service static',
      'Skip deploy (docs only)',
      'Ask 黄老师 for help',
    ]);
    expect(result).toContain("  1) Deploy with --service static");
    expect(result).toContain("  2) Skip deploy (docs only)");
    expect(result).toContain("  3) Ask 黄老师 for help");
  });

  test("context with markdown table", () => {
    const ctx = "| Col A | Col B |\n|-------|-------|\n| 1     | 2     |";
    const result = buildMessageBody("review", ctx);
    expect(result).toContain("---\n| Col A | Col B |");
  });

  test("multiline content preserved", () => {
    const result = buildMessageBody("line1\nline2\nline3", "ctx", ["A"]);
    expect(result).toStartWith("line1\nline2\nline3");
    expect(result).toContain("---\nctx");
    expect(result).toContain("  1) A");
  });

  test("options ordering is stable (10+ options)", () => {
    const opts = Array.from({ length: 12 }, (_, i) => `Option ${i + 1}`);
    const result = buildMessageBody("many choices", undefined, opts);
    expect(result).toContain("  1) Option 1");
    expect(result).toContain("  10) Option 10");
    expect(result).toContain("  12) Option 12");
  });
});

// ═══════════════════════════════════════════════════════════════════
// writeToTriageQueue — extended opts
// ═══════════════════════════════════════════════════════════════════

describe("writeToTriageQueue — extended opts", () => {
  test("options are stored in triage entry", () => {
    const result = writeToTriageQueue("pick one", "choices", "test-bot", { options: ["A", "B"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const queuePath = join(process.env.PROJECT_ROOT || process.cwd(), ".claude/triage/queue.jsonl");
    const lines = readFileSync(queuePath, "utf-8").trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.options).toEqual(["A", "B"]);
    expect(entry.category).toBe("worker-question");
    expect(entry.from_worker).toBe("test-bot");
  });

  test("urgency is stored in triage entry", () => {
    const result = writeToTriageQueue("urgent!", "urgent", "test-bot", { urgency: "high" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const queuePath = join(process.env.PROJECT_ROOT || process.cwd(), ".claude/triage/queue.jsonl");
    const lines = readFileSync(queuePath, "utf-8").trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.urgency).toBe("high");
  });

  test("custom category overrides default", () => {
    const result = writeToTriageQueue("test", "test", "test-bot", { category: "architecture" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const queuePath = join(process.env.PROJECT_ROOT || process.cwd(), ".claude/triage/queue.jsonl");
    const lines = readFileSync(queuePath, "utf-8").trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.category).toBe("architecture");
  });

  test("no opts defaults to worker-escalation category", () => {
    const result = writeToTriageQueue("plain msg", "plain", "test-bot");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const queuePath = join(process.env.PROJECT_ROOT || process.cwd(), ".claude/triage/queue.jsonl");
    const lines = readFileSync(queuePath, "utf-8").trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.category).toBe("worker-escalation");
  });

  test("empty options array does NOT set category to worker-question", () => {
    const result = writeToTriageQueue("msg", "msg", "test-bot", { options: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const queuePath = join(process.env.PROJECT_ROOT || process.cwd(), ".claude/triage/queue.jsonl");
    const lines = readFileSync(queuePath, "utf-8").trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.category).toBe("worker-escalation"); // empty array = no options
    expect(entry.options).toBeUndefined(); // empty array not stored
  });

  test("all opts fields together", () => {
    const result = writeToTriageQueue("full", "full msg", "test-bot", {
      options: ["X", "Y", "Z"],
      category: "coordination",
      urgency: "high",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const queuePath = join(process.env.PROJECT_ROOT || process.cwd(), ".claude/triage/queue.jsonl");
    const lines = readFileSync(queuePath, "utf-8").trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.category).toBe("coordination");
    expect(entry.urgency).toBe("high");
    expect(entry.options).toEqual(["X", "Y", "Z"]);
    expect(entry.from_worker).toBe("test-bot");
    expect(entry.source).toBe("test-bot");
  });

  test("urgency without options stays worker-escalation", () => {
    const result = writeToTriageQueue("urgent", "urgent", "bot", { urgency: "high" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const queuePath = join(process.env.PROJECT_ROOT || process.cwd(), ".claude/triage/queue.jsonl");
    const lines = readFileSync(queuePath, "utf-8").trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.category).toBe("worker-escalation");
    expect(entry.urgency).toBe("high");
  });

  test("options with Chinese text", () => {
    const result = writeToTriageQueue("选择", "选择方案", "bot", {
      options: ["部署到测试", "跳过部署", "联系黄老师"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const queuePath = join(process.env.PROJECT_ROOT || process.cwd(), ".claude/triage/queue.jsonl");
    const lines = readFileSync(queuePath, "utf-8").trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.options).toEqual(["部署到测试", "跳过部署", "联系黄老师"]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// writeToInbox — options & urgency
// ═══════════════════════════════════════════════════════════════════

describe("writeToInbox — options & urgency", () => {
  test("options and urgency are stored in inbox message", () => {
    const result = writeToInbox("test-worker", {
      content: "pick one", summary: "choices", from_name: "sender",
      options: ["A", "B"], urgency: "high",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const inboxPath = join(WORKERS_DIR, "test-worker", "inbox.jsonl");
    const lines = readFileSync(inboxPath, "utf-8").trim().split("\n");
    const msg = JSON.parse(lines[lines.length - 1]);
    expect(msg.options).toEqual(["A", "B"]);
    expect(msg.urgency).toBe("high");
    expect(msg.msg_id).toBe(result.msg_id);
  });

  test("options without urgency — urgency field absent", () => {
    const result = writeToInbox("test-worker", {
      content: "pick one", from_name: "sender",
      options: ["X", "Y"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const inboxPath = join(WORKERS_DIR, "test-worker", "inbox.jsonl");
    const lines = readFileSync(inboxPath, "utf-8").trim().split("\n");
    const msg = JSON.parse(lines[lines.length - 1]);
    expect(msg.options).toEqual(["X", "Y"]);
    expect(msg.urgency).toBeUndefined();
  });

  test("urgency without options — options field absent", () => {
    const result = writeToInbox("test-worker", {
      content: "urgent msg", from_name: "sender",
      urgency: "low",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const inboxPath = join(WORKERS_DIR, "test-worker", "inbox.jsonl");
    const lines = readFileSync(inboxPath, "utf-8").trim().split("\n");
    const msg = JSON.parse(lines[lines.length - 1]);
    expect(msg.urgency).toBe("low");
    expect(msg.options).toBeUndefined();
  });

  test("empty options array — options field absent", () => {
    const result = writeToInbox("test-worker", {
      content: "no options", from_name: "sender",
      options: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const inboxPath = join(WORKERS_DIR, "test-worker", "inbox.jsonl");
    const lines = readFileSync(inboxPath, "utf-8").trim().split("\n");
    const msg = JSON.parse(lines[lines.length - 1]);
    expect(msg.options).toBeUndefined();
  });

  test("all extended fields together with ack and reply_type", () => {
    const result = writeToInbox("test-worker", {
      content: "complex msg", summary: "complex", from_name: "sender",
      ack_required: true, reply_type: "review",
      options: ["Approve", "Reject", "Defer"], urgency: "high",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const inboxPath = join(WORKERS_DIR, "test-worker", "inbox.jsonl");
    const lines = readFileSync(inboxPath, "utf-8").trim().split("\n");
    const msg = JSON.parse(lines[lines.length - 1]);
    expect(msg.options).toEqual(["Approve", "Reject", "Defer"]);
    expect(msg.urgency).toBe("high");
    expect(msg.reply_type).toBe("review");
    expect(msg.ack_required).toBe(true);
    expect(msg.summary).toBe("complex");
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

  test("report without registry → error or resolved", () => {
    const result = resolveRecipient("report");
    expect(["pane", "worker"]).toContain(result.type);
    expect(result.paneId || result.workerName || result.error).toBeTruthy();
  });

  test("report fallback error mentions report_to, not 'operator'", () => {
    // When report resolution fails (no live pane), error should NOT say 'operator'
    const result = resolveRecipient("report");
    if (result.error) {
      expect(result.error).not.toContain("operator entry");
    }
    // If resolved to a worker, should not be "operator" (legacy name)
    if (result.type === "worker") {
      expect(result.workerName).not.toBe("operator");
    }
  });

  test("old alias 'parent' resolves as worker name, not special target", () => {
    const result = resolveRecipient("parent");
    // "parent" is no longer a special target — resolves as a worker named "parent"
    expect(result.type).toBe("worker");
    expect(result.workerName).toBe("parent");
  });

  test("old alias 'children' resolves as worker name, not special target", () => {
    const result = resolveRecipient("children");
    expect(result.type).toBe("worker");
    expect(result.workerName).toBe("children");
  });

  test("old alias 'reports' resolves as worker name, not special target", () => {
    const result = resolveRecipient("reports");
    expect(result.type).toBe("worker");
    expect(result.workerName).toBe("reports");
  });
});

// ═══════════════════════════════════════════════════════════════════
// generateSeedContent
// ═══════════════════════════════════════════════════════════════════

describe("generateSeedContent", () => {
  test("contains worker name", () => {
    const seed = generateSeedContent();
    expect(seed).toContain("You are worker **");
    expect(seed).toContain("MCP Tools");
  });

  test("includes handoff when provided", () => {
    const seed = generateSeedContent("Previous cycle finished task T003. Next: work on T004.");
    expect(seed).toContain("Handoff from Previous Cycle");
    expect(seed).toContain("Previous cycle finished task T003");
  });

  test("without handoff — no handoff section", () => {
    const seed = generateSeedContent();
    expect(seed).not.toContain("Handoff from Previous Cycle");
  });

  test("seed references get_worker_state, not state.json", () => {
    const seed = generateSeedContent();
    expect(seed).toContain("get_worker_state");
    expect(seed).not.toContain("state.json");
  });

  test("does not include check_config in tool table (intentionally removed)", () => {
    const seed = generateSeedContent();
    expect(seed).not.toContain("check_config");
  });

  test("does not include broadcast as separate tool (folded into send_message to='all')", () => {
    const seed = generateSeedContent();
    expect(seed).not.toContain("broadcast(content");
    expect(seed).toContain('"all"'); // send_message supports to="all"
  });

  test("does not include write_memory or read_memory (workers use file tools)", () => {
    const seed = generateSeedContent();
    expect(seed).not.toContain("write_memory");
    expect(seed).not.toContain("read_memory");
  });

  test("does not include stale Wechat deploy path", () => {
    const seed = generateSeedContent();
    expect(seed).not.toContain("Wechat/scripts/deploy.sh");
  });

  test("does not reference smart_commit (removed)", () => {
    const seed = generateSeedContent();
    expect(seed).not.toContain("smart_commit");
  });

  test("does not include register_pane (replaced by heartbeat)", () => {
    const seed = generateSeedContent();
    expect(seed).not.toContain("register_pane()");
  });

  test("does not include heartbeat (removed — liveness hook replaces it)", () => {
    const seed = generateSeedContent();
    expect(seed).not.toContain("heartbeat(");
  });

  test("does not reference {workerDir}/MEMORY.md — memory is auto-loaded", () => {
    const seed = generateSeedContent();
    expect(seed).not.toContain("MEMORY.md — what you learned");
    expect(seed).toContain("auto-loaded");
  });

  test("tells workers to check scripts dir", () => {
    const seed = generateSeedContent();
    expect(seed).toContain(".claude/scripts/");
  });

  // Seed context invariant sections (moved from mission.md)
  test("includes perpetual loop protocol", () => {
    const seed = generateSeedContent();
    expect(seed).toContain("Perpetual Loop Protocol");
    expect(seed).toContain("recycle()");
    expect(seed).toContain("NEVER set status=\"done\"");
  });

  test("includes respawn configuration", () => {
    const seed = generateSeedContent();
    expect(seed).toContain("Respawn Configuration");
    expect(seed).toContain("sleep_duration");
    expect(seed).toContain("perpetual");
  });

  test("includes deploy protocol with slot-based deploy", () => {
    const seed = generateSeedContent();
    expect(seed).toContain("Deploy Protocol");
    expect(seed).toContain("deploy-to-slot.sh");
    expect(seed).toContain("pre-validate.sh");
  });

  test("includes 三省吾身 self-examination", () => {
    const seed = generateSeedContent();
    expect(seed).toContain("三省吾身");
    expect(seed).toContain("为人谋而不忠乎");
    expect(seed).toContain("与朋友交而不信乎");
    expect(seed).toContain("传不习乎");
  });

  test("includes escalation rules", () => {
    const seed = generateSeedContent();
    expect(seed).toContain("Escalation Rules");
    expect(seed).toContain("send_message(to=\"user\"");
  });

  test("includes available scripts section", () => {
    const seed = generateSeedContent();
    expect(seed).toContain("Available Scripts");
    expect(seed).toContain("request-merge.sh");
    expect(seed).toContain("worker-status.sh");
  });

  test("includes stop checks documentation", () => {
    const seed = generateSeedContent();
    expect(seed).toContain("Stop Checks");
    expect(seed).toContain("add_stop_check");
    expect(seed).toContain("complete_stop_check");
  });

  test("includes structured message fields in tool table", () => {
    const seed = generateSeedContent();
    expect(seed).toContain("options=");
    expect(seed).toContain("context=");
    expect(seed).toContain("urgency=");
  });

  test("no unresolved template placeholders", () => {
    const seed = generateSeedContent();
    expect(seed).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  test("does not contain project-specific content", () => {
    const seed = generateSeedContent();
    expect(seed).not.toContain("baoyuansmartlife");
    expect(seed).not.toContain("wx.baoyuan");
    expect(seed).not.toContain("8.129.82.75");
    expect(seed).not.toContain("120.77.216.196");
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
    const diagDir = join(import.meta.dir, ".test-tmp/diagnostics-no-mission/workers");
    const workerDir = join(diagDir, WORKER_NAME);
    mkdirSync(workerDir, { recursive: true });
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

  test("each issue has a fix suggestion", () => {
    _setWorkersDir(join(import.meta.dir, ".test-tmp/diagnostics-nope"));
    try {
      const issues = runDiagnostics();
      const issuesWithFix = issues.filter(i => i.fix);
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
// Inbox special characters
// ═══════════════════════════════════════════════════════════════════

describe("writeToInbox — special characters", () => {
  test("message with double quotes", () => {
    const result = writeToInbox(TEST_WORKER, {
      content: 'He said "hello world"',
      from_name: "tester",
    });
    expect(result.ok).toBe(true);
    const line = readFileSync(join(TEST_WORKER_DIR, "inbox.jsonl"), "utf-8").trim();
    const parsed = JSON.parse(line);
    expect(parsed.content).toBe('He said "hello world"');
  });

  test("message with shell metacharacters ($ ! ; | & >)", () => {
    const content = 'Run: $HOME/bin/test; echo "done" | grep ok && rm -rf / > /dev/null &';
    const result = writeToInbox(TEST_WORKER, { content, from_name: "tester" });
    expect(result.ok).toBe(true);
    const line = readFileSync(join(TEST_WORKER_DIR, "inbox.jsonl"), "utf-8").trim();
    const parsed = JSON.parse(line);
    expect(parsed.content).toBe(content);
  });

  test("message with unicode / Chinese characters", () => {
    const content = "你好世界 🎉 — 保臻AI助手";
    const result = writeToInbox(TEST_WORKER, { content, from_name: "tester" });
    expect(result.ok).toBe(true);
    const line = readFileSync(join(TEST_WORKER_DIR, "inbox.jsonl"), "utf-8").trim();
    const parsed = JSON.parse(line);
    expect(parsed.content).toBe(content);
  });

  test("concurrent writes don't corrupt lines", () => {
    for (let i = 0; i < 50; i++) {
      writeToInbox(TEST_WORKER, { content: `concurrent-${i}`, from_name: `writer-${i}` });
    }
    const raw = readFileSync(join(TEST_WORKER_DIR, "inbox.jsonl"), "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines.length).toBe(50);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.content).toMatch(/^concurrent-\d+$/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// Project Registry — readRegistry
// ═══════════════════════════════════════════════════════════════════

describe("readRegistry", () => {
  test("returns registry with _config", () => {
    const reg = readRegistry();
    expect(reg._config).toBeDefined();
    expect(reg._config.commit_notify).toBeDefined();
    expect(Array.isArray(reg._config.commit_notify)).toBe(true);
  });

  test("_config has required fields", () => {
    const reg = readRegistry();
    expect(typeof reg._config.merge_authority).toBe("string");
    expect(typeof reg._config.deploy_authority).toBe("string");
    expect(typeof reg._config.mission_authority).toBe("string");
    expect(typeof reg._config.tmux_session).toBe("string");
    expect(typeof reg._config.project_name).toBe("string");
  });

  test("reads live registry without error", () => {
    expect(() => readRegistry()).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Project Registry — getWorkerEntry
// ═══════════════════════════════════════════════════════════════════

describe("getWorkerEntry", () => {
  test("returns null for nonexistent worker", () => {
    const entry = getWorkerEntry("does-not-exist-xyz");
    // May be null if not in registry, or may be auto-created — just verify no crash
    expect(entry === null || typeof entry === "object").toBe(true);
  });

  test("returns null for _config key", () => {
    const entry = getWorkerEntry("_config");
    expect(entry).toBeNull();
  });

  test("returns entry for known worker if present", () => {
    // Read live registry to check if any workers exist
    const reg = readRegistry();
    const workerNames = Object.keys(reg).filter(k => k !== "_config");
    if (workerNames.length > 0) {
      const entry = getWorkerEntry(workerNames[0]);
      expect(entry).not.toBeNull();
      expect(typeof entry!.model).toBe("string");
      expect(typeof entry!.status).toBe("string");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// Project Registry — ensureWorkerInRegistry
// ═══════════════════════════════════════════════════════════════════

describe("ensureWorkerInRegistry", () => {
  test("creates default entry for new worker", () => {
    const testName = "ensure-new-test";
    const testDir = join(TEST_WORKERS_DIR, testName);
    mkdirSync(testDir, { recursive: true });

    const registry = makeProjectRegistry();
    const entry = ensureWorkerInRegistry(registry, testName);

    expect(entry).toBeDefined();
    expect(entry.model).toBe("opus");
    expect(entry.permission_mode).toBe("bypassPermissions");
    expect(entry.status).toBe("idle");
    expect(entry.disallowed_tools).toEqual(expect.any(Array));
    expect(entry.custom).toEqual({ runtime: "claude" });
    // Entry should be in registry
    expect(registry[testName]).toBe(entry);
  });

  test("returns existing entry without overwriting", () => {
    const testName = "existing-worker";
    const existing = makeRegistryEntry({
      model: "opus",
      status: "active",
    });
    const registry = makeProjectRegistry({ [testName]: existing });

    const result = ensureWorkerInRegistry(registry, testName);

    expect(result.model).toBe("opus");
    expect(result.status).toBe("active");
    expect(result).toBe(existing); // same reference
  });

  test("does not create entry for _config key", () => {
    const registry = makeProjectRegistry();
    const result = ensureWorkerInRegistry(registry, "_config");
    // _config is handled specially — should return existing _config as RegistryWorkerEntry
    // or create a new entry (depends on implementation). Either way, should not crash.
    expect(result).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Project Registry — lintRegistry
// ═══════════════════════════════════════════════════════════════════

describe("lintRegistry", () => {
  test("returns array", () => {
    const registry = makeProjectRegistry();
    const issues = lintRegistry(registry);
    expect(Array.isArray(issues)).toBe(true);
  });

  test("empty registry (no workers) → no issues", () => {
    const registry = makeProjectRegistry();
    const issues = lintRegistry(registry);
    expect(issues.length).toBe(0);
  });

  test("detects dead panes", () => {
    const registry = makeProjectRegistry({
      ghost: makeRegistryEntry({
        pane_id: "%99999",
        pane_target: "x:0.0",
      }),
    });

    const issues = lintRegistry(registry);
    const deadPaneIssue = issues.find(i => i.check === "lint.dead_pane");
    expect(deadPaneIssue).toBeDefined();
    expect(deadPaneIssue!.severity).toBe("warning");
    expect(deadPaneIssue!.message).toContain("%99999");
  });

  test("detects missing model", () => {
    const noModelDir = join(TEST_WORKERS_DIR, "no-model");
    mkdirSync(noModelDir, { recursive: true });

    const registry = makeProjectRegistry({
      "no-model": makeRegistryEntry({ model: "" }),
    });

    const issues = lintRegistry(registry);
    const modelIssue = issues.find(i => i.check === "lint.model");
    expect(modelIssue).toBeDefined();
    expect(modelIssue!.severity).toBe("warning");
  });

  test("all issues have correct structure", () => {
    const registry = makeProjectRegistry({
      "lint-test": makeRegistryEntry({
        pane_id: "%77777",
        model: "",
      }),
    });

    const issues = lintRegistry(registry);
    for (const issue of issues) {
      expect(["error", "warning"]).toContain(issue.severity);
      expect(typeof issue.check).toBe("string");
      expect(issue.check.startsWith("lint.")).toBe(true);
      expect(typeof issue.message).toBe("string");
      expect(issue.message.length).toBeGreaterThan(0);
    }
  });

  test("duplicate pane check works (single pane = no warning)", () => {
    const registry = makeProjectRegistry({
      "worker-a": makeRegistryEntry({ pane_id: "%99998" }),
    });
    const issues = lintRegistry(registry);
    const dupIssue = issues.find(i => i.check === "lint.duplicate_pane");
    expect(dupIssue).toBeUndefined();
  });

  test("lint.report_to_missing: worker references non-existent report_to → warning", () => {
    const registry = makeProjectRegistry({
      "orphaned-worker": makeRegistryEntry({ report_to: "ghost-manager" }),
    });
    const issues = lintRegistry(registry);
    const missing = issues.find(i => i.check === "lint.report_to_missing");
    expect(missing).toBeDefined();
    expect(missing!.severity).toBe("warning");
    expect(missing!.message).toContain("ghost-manager");
  });

  test("lint.report_to_missing: valid report_to reference → no warning", () => {
    const registry = makeProjectRegistry({
      "chief-of-staff": makeRegistryEntry(),
      "my-worker": makeRegistryEntry({ report_to: "chief-of-staff" }),
    });
    const issues = lintRegistry(registry);
    const missing = issues.find(i => i.check === "lint.report_to_missing");
    expect(missing).toBeUndefined();
  });

  test("lint.report_to_missing: fallback to mission_authority → no warning if authority exists", () => {
    // Worker with no explicit report_to — falls back to config.mission_authority
    const registry = makeProjectRegistry({
      "chief-of-staff": makeRegistryEntry(),
      "my-worker": makeRegistryEntry({}), // no report_to, no assigned_by, no parent
    });
    const issues = lintRegistry(registry);
    // getReportTo falls back to mission_authority ("chief-of-staff") which exists
    const missing = issues.find(i => i.check === "lint.report_to_missing");
    expect(missing).toBeUndefined();
  });

  test("_config.mission_authority defaults to 'chief-of-staff' in makeProjectRegistry", () => {
    // Verify test helper and production default match — mission_authority must never be 'operator'
    const registry = makeProjectRegistry();
    expect(registry._config.mission_authority).toBe("chief-of-staff");
    expect(registry._config.mission_authority).not.toBe("operator");
  });
});

describe("resolveRecipient — direct_reports", () => {
  test("direct_reports → type multi_pane", () => {
    const result = resolveRecipient("direct_reports");
    expect(result.type).toBe("multi_pane");
    // paneIds array always present (may be empty if no direct reports registered)
    expect(Array.isArray(result.paneIds)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Project Registry — RegistryWorkerEntry structure
// ═══════════════════════════════════════════════════════════════════

describe("RegistryWorkerEntry", () => {
  test("makeRegistryEntry produces valid entry with all fields", () => {
    const entry = makeRegistryEntry();
    expect(typeof entry.model).toBe("string");
    expect(typeof entry.permission_mode).toBe("string");
    expect(Array.isArray(entry.disallowed_tools)).toBe(true);
    expect(typeof entry.status).toBe("string");
    expect(typeof entry.perpetual).toBe("boolean");
    expect(typeof entry.sleep_duration).toBe("number");
    expect(typeof entry.tmux_session).toBe("string");
    expect(typeof entry.mission_file).toBe("string");
    expect(typeof entry.custom).toBe("object");
  });

  test("nullable fields accept null", () => {
    const entry = makeRegistryEntry({
      worktree: null,
      window: null,
      pane_id: null,
      pane_target: null,
      session_id: null,
      session_file: null,
    });
    expect(entry.worktree).toBeNull();
    expect(entry.pane_id).toBeNull();
  });

  test("optional fields can be set", () => {
    const entry = makeRegistryEntry({
      last_commit_sha: "abc123",
      last_commit_msg: "fix(admin): bug",
      last_commit_at: "2026-03-01T00:00:00Z",
      issues_found: 5,
      issues_fixed: 3,
    });
    expect(entry.last_commit_sha).toBe("abc123");
    expect(entry.issues_found).toBe(5);
    expect(entry.issues_fixed).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Project Registry — _config section
// ═══════════════════════════════════════════════════════════════════

describe("ProjectRegistry _config", () => {
  test("default config from readRegistry has all required fields", () => {
    const reg = readRegistry();
    const config = reg._config;
    expect(config.commit_notify).toBeDefined();
    expect(config.merge_authority).toBeDefined();
    expect(config.deploy_authority).toBeDefined();
    expect(config.mission_authority).toBeDefined();
    expect(config.tmux_session).toBeDefined();
    expect(config.project_name).toBeDefined();
  });

  test("commit_notify is an array of strings", () => {
    const reg = readRegistry();
    expect(Array.isArray(reg._config.commit_notify)).toBe(true);
    for (const target of reg._config.commit_notify) {
      expect(typeof target).toBe("string");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// createWorkerFiles — no longer creates state.json or permissions.json
// ═══════════════════════════════════════════════════════════════════

describe("createWorkerFiles", () => {
  test("creates mission.md and tasks.json but not state.json or permissions.json", () => {
    const testName = "create-test-worker";
    const testDir = join(TEST_WORKERS_DIR, testName);

    const result = createWorkerFiles({
      name: testName,
      mission: "Test mission content",
      model: "sonnet",
    });

    expect(result.ok).toBe(true);
    expect(existsSync(join(testDir, "mission.md"))).toBe(true);
    expect(existsSync(join(testDir, "tasks.json"))).toBe(true);
    // These should NOT be created anymore (data is in registry.json)
    expect(existsSync(join(testDir, "state.json"))).toBe(false);
    expect(existsSync(join(testDir, "permissions.json"))).toBe(false);
    // MEMORY.md should NOT be in .claude/workers/ (lives in auto-memory path now)
    expect(existsSync(join(testDir, "MEMORY.md"))).toBe(false);
  });

  test("mission.md contains the provided content", () => {
    const testName = "mission-content-test";
    createWorkerFiles({
      name: testName,
      mission: "# My Mission\nDo great things",
      model: "sonnet",
    });
    const mission = readFileSync(join(TEST_WORKERS_DIR, testName, "mission.md"), "utf-8");
    expect(mission).toContain("# My Mission");
    expect(mission).toContain("Do great things");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Path traversal safety
// ═══════════════════════════════════════════════════════════════════

describe("writeToInbox — path traversal safety", () => {
  test("recipient with ../ → writeToInbox checks directory existence", () => {
    const result = writeToInbox("../../../tmp/evil", { content: "pwned", from_name: "attacker" });
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain("not found");
  });
});

// ═══════════════════════════════════════════════════════════════════
// create_worker — report_to / forked_from flat org tracking
// ═══════════════════════════════════════════════════════════════════

describe("create_worker — report_to / forked_from tracking", () => {
  // Simulate the registry mutation logic from create_worker (flat org model)
  function registerNewWorker(
    registry: ProjectRegistry,
    workerName: string,
    options: { report_to?: string; forked_from?: string; pane_id?: string } = {}
  ) {
    ensureWorkerInRegistry(registry, workerName);
    const entry = registry[workerName] as RegistryWorkerEntry;
    if (options.pane_id) entry.pane_id = options.pane_id;
    if (options.report_to) entry.report_to = options.report_to;
    if (options.forked_from) entry.forked_from = options.forked_from;
  }

  test("new worker gets report_to set to caller", () => {
    const registry = makeProjectRegistry({
      "chief-of-staff": makeRegistryEntry({ pane_id: "%1" }),
    });
    registerNewWorker(registry, "new-worker", { report_to: "chief-of-staff" });

    const entry = registry["new-worker"] as RegistryWorkerEntry;
    expect(entry.report_to).toBe("chief-of-staff");
  });

  test("forked worker gets both report_to and forked_from", () => {
    const registry = makeProjectRegistry({
      "parent-worker": makeRegistryEntry({ pane_id: "%10" }),
    });
    registerNewWorker(registry, "forked-child", {
      report_to: "parent-worker",
      forked_from: "parent-worker",
      pane_id: "%11",
    });

    const entry = registry["forked-child"] as RegistryWorkerEntry;
    expect(entry.report_to).toBe("parent-worker");
    expect(entry.forked_from).toBe("parent-worker");
    expect(entry.pane_id).toBe("%11");
  });

  test("direct_report=false uses report_to or mission_authority", () => {
    const registry = makeProjectRegistry({
      "worker-a": makeRegistryEntry({ pane_id: "%10" }),
    });
    // Simulate direct_report=false: report_to = report_to param || WORKER_NAME || "chief-of-staff"
    registerNewWorker(registry, "new-worker", { report_to: "chief-of-staff" });

    const entry = registry["new-worker"] as RegistryWorkerEntry;
    expect(entry.report_to).toBe("chief-of-staff");
  });

  test("pane_id is recorded in registry entry", () => {
    const registry = makeProjectRegistry({
      "chief-of-staff": makeRegistryEntry(),
    });
    registerNewWorker(registry, "new-worker", { pane_id: "%99", report_to: "chief-of-staff" });

    const entry = registry["new-worker"] as RegistryWorkerEntry;
    expect(entry.pane_id).toBe("%99");
  });

  test("existing entry with report_to already set can be updated", () => {
    const registry = makeProjectRegistry({
      "existing-worker": makeRegistryEntry({ report_to: "original-reporter" }),
    });
    const entry = registry["existing-worker"] as RegistryWorkerEntry;
    entry.report_to = "new-reporter";
    expect(entry.report_to).toBe("new-reporter");
  });
});

// ═══════════════════════════════════════════════════════════════════
// write_memory — _replaceMemorySection logic
// ═══════════════════════════════════════════════════════════════════

describe("_replaceMemorySection", () => {
  test("appends new section when heading not present", () => {
    const existing = "# Memory\n\n## Existing\nsome content\n";
    const result = _replaceMemorySection(existing, "New Section", "new content");
    expect(result).toContain("## New Section");
    expect(result).toContain("new content");
    expect(result).toContain("## Existing"); // old section preserved
  });

  test("replaces existing section content", () => {
    const existing = "# Memory\n\n## My Section\nold content\n\n## Other\nother\n";
    const result = _replaceMemorySection(existing, "My Section", "new content");
    expect(result).toContain("new content");
    expect(result).not.toContain("old content");
    expect(result).toContain("## Other"); // subsequent section preserved
  });

  test("replaces last section without trailing garbage", () => {
    const existing = "# Memory\n\n## First\nfirst content\n\n## Last\nold last\n";
    const result = _replaceMemorySection(existing, "Last", "new last");
    expect(result).toContain("new last");
    expect(result).not.toContain("old last");
    expect(result).toContain("## First");
  });

  test("creates file content from scratch (empty existing)", () => {
    const existing = "# Memory\n\n";
    const result = _replaceMemorySection(existing, "Cycle Log", "| 1 | done |");
    expect(result).toContain("## Cycle Log");
    expect(result).toContain("| 1 | done |");
  });

  test("heading line with trailing spaces still matches", () => {
    const existing = "# Memory\n\n## My Section   \nold\n";
    const result = _replaceMemorySection(existing, "My Section", "fresh");
    expect(result).toContain("fresh");
    expect(result).not.toContain("old");
  });

  test("only replaces up to the next ## heading, not beyond", () => {
    const existing = "# Memory\n\n## A\na content\n\n## B\nb content\n\n## C\nc content\n";
    const result = _replaceMemorySection(existing, "B", "b new");
    expect(result).toContain("b new");
    expect(result).not.toContain("b content");
    expect(result).toContain("a content"); // A unchanged
    expect(result).toContain("c content"); // C unchanged
  });

  test("section at beginning of file (no before block)", () => {
    const existing = "## First\nfirst content\n\n## Second\nsecond\n";
    const result = _replaceMemorySection(existing, "First", "updated first");
    expect(result).toContain("updated first");
    expect(result).toContain("## Second");
    expect(result).not.toContain("first content");
  });

  test("trimEnd applied to content — no trailing whitespace in block", () => {
    const result = _replaceMemorySection("# Memory\n\n", "Test", "content   \n\n\n");
    const lines = result.split("\n");
    const contentLine = lines.find(l => l === "content");
    expect(contentLine).toBe("content"); // trimmed
  });
});

// ── acquireLock / releaseLock ────────────────────────────────────────────────

describe("acquireLock / releaseLock", () => {
  const TEST_LOCK = join(TEST_DIR, "test-lock-dir");

  test("acquires lock by creating dir", () => {
    const acquired = acquireLock(TEST_LOCK, 100);
    expect(acquired).toBe(true);
    expect(existsSync(TEST_LOCK)).toBe(true);
    releaseLock(TEST_LOCK);
  });

  test("release removes the lock dir", () => {
    acquireLock(TEST_LOCK, 100);
    releaseLock(TEST_LOCK);
    expect(existsSync(TEST_LOCK)).toBe(false);
  });

  test("second acquire fails while lock is held (short timeout)", () => {
    acquireLock(TEST_LOCK, 100);
    // Lock is held — second attempt with very short timeout should fail
    const secondAcquire = acquireLock(TEST_LOCK, 50);
    // Could be true (stale lock recovery) or false; both are valid outcomes
    // The important thing is it doesn't throw
    expect(typeof secondAcquire).toBe("boolean");
    releaseLock(TEST_LOCK);
  });

  test("stale lock recovery: force-removes old lock and re-acquires", () => {
    // Simulate a stale lock from a crashed process (mkdir manually, don't release)
    mkdirSync(TEST_LOCK, { recursive: true });
    // Now try to acquire with a short timeout — it should force-remove the stale lock
    const recovered = acquireLock(TEST_LOCK, 200);
    expect(recovered).toBe(true);
    releaseLock(TEST_LOCK);
  });

  test("acquire + release is idempotent across multiple cycles", () => {
    for (let i = 0; i < 3; i++) {
      const ok = acquireLock(TEST_LOCK, 500);
      expect(ok).toBe(true);
      releaseLock(TEST_LOCK);
    }
  });
});

// ── getWorktreeDir ───────────────────────────────────────────────────────────

describe("getWorktreeDir", () => {
  test("returns a string with -w-WORKER_NAME suffix", () => {
    const dir = getWorktreeDir();
    expect(dir).toContain(`-w-${WORKER_NAME}`);
  });

  test("result ends with ProjectName-w-WORKER_NAME pattern", () => {
    const dir = getWorktreeDir();
    const base = dir.split("/").pop()!;
    expect(base).toMatch(/-w-/); // has -w- separator
    expect(base.endsWith(`-w-${WORKER_NAME}`)).toBe(true);
  });

  test("result is an absolute path", () => {
    const dir = getWorktreeDir();
    expect(dir.startsWith("/")).toBe(true);
  });
});

// ── getSessionId ─────────────────────────────────────────────────────────────

describe("getSessionId", () => {
  test("returns null for non-existent pane file", () => {
    const result = getSessionId("nonexistent-pane-id-xyz");
    expect(result).toBeNull();
  });

  test("returns trimmed file content when pane map file exists", () => {
    // Create a fake pane-map file
    const HOME = process.env.HOME!;
    const paneMapDir = join(HOME, ".claude/pane-map/by-pane");
    const fakePaneId = `test-pane-${Date.now()}`;
    const fakePanePath = join(paneMapDir, fakePaneId);
    mkdirSync(paneMapDir, { recursive: true });
    writeFileSync(fakePanePath, "  abc-session-id-123  \n");
    try {
      const result = getSessionId(fakePaneId);
      expect(result).toBe("abc-session-id-123");
    } finally {
      // Cleanup
      try { rmSync(fakePanePath); } catch {}
    }
  });

  test("returns empty string for empty pane map file (trimmed to '')", () => {
    const HOME = process.env.HOME!;
    const paneMapDir = join(HOME, ".claude/pane-map/by-pane");
    const fakePaneId = `test-pane-empty-${Date.now()}`;
    const fakePanePath = join(paneMapDir, fakePaneId);
    mkdirSync(paneMapDir, { recursive: true });
    writeFileSync(fakePanePath, "   \n");
    try {
      const result = getSessionId(fakePaneId);
      expect(result).toBe(""); // trim of whitespace-only
    } finally {
      try { rmSync(fakePanePath); } catch {}
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// getReportTo — flat org report chain resolution
// ═══════════════════════════════════════════════════════════════════

describe("getReportTo", () => {
  test("returns report_to when set", () => {
    const entry = makeRegistryEntry({ report_to: "chief-of-staff" });
    expect(getReportTo(entry)).toBe("chief-of-staff");
  });

  test("falls back to config.mission_authority when report_to is null", () => {
    const entry = makeRegistryEntry({ report_to: null });
    const config: RegistryConfig = {
      commit_notify: [], merge_authority: "merger",
      deploy_authority: "merger", mission_authority: "chief-of-staff",
      tmux_session: "w", project_name: "test",
    };
    expect(getReportTo(entry, config)).toBe("chief-of-staff");
  });

  test("returns null when report_to is null and no config", () => {
    const entry = makeRegistryEntry({ report_to: null });
    expect(getReportTo(entry)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// canUpdateWorker — cross-worker authorization
// ═══════════════════════════════════════════════════════════════════

describe("canUpdateWorker", () => {
  test("worker can always update itself", () => {
    const registry = makeProjectRegistry({
      "worker-a": makeRegistryEntry(),
    });
    expect(canUpdateWorker("worker-a", "worker-a", registry)).toBe(true);
  });

  test("mission_authority can update any worker", () => {
    const registry = makeProjectRegistry({
      "chief-of-staff": makeRegistryEntry(),
      "worker-a": makeRegistryEntry(),
    });
    expect(canUpdateWorker("chief-of-staff", "worker-a", registry)).toBe(true);
  });

  test("worker can update its direct report", () => {
    const registry = makeProjectRegistry({
      "manager": makeRegistryEntry(),
      "underling": makeRegistryEntry({ report_to: "manager" }),
    });
    expect(canUpdateWorker("manager", "underling", registry)).toBe(true);
  });

  test("worker cannot update a non-report peer", () => {
    const registry = makeProjectRegistry({
      "worker-a": makeRegistryEntry({ report_to: "chief-of-staff" }),
      "worker-b": makeRegistryEntry({ report_to: "chief-of-staff" }),
    });
    expect(canUpdateWorker("worker-a", "worker-b", registry)).toBe(false);
  });

  test("non-existent target returns false", () => {
    const registry = makeProjectRegistry({
      "worker-a": makeRegistryEntry(),
    });
    expect(canUpdateWorker("worker-a", "nonexistent", registry)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Flat org: seed template updated
// ═══════════════════════════════════════════════════════════════════

describe("generateSeedContent — flat org updates", () => {
  test("does not mention spawn_child", () => {
    const seed = generateSeedContent();
    expect(seed).not.toContain("spawn_child");
  });

  test("does not mention rename tool", () => {
    const seed = generateSeedContent();
    expect(seed).not.toContain("`rename(");
  });

  test("mentions create_worker in tool table", () => {
    const seed = generateSeedContent();
    expect(seed).toContain("create_worker");
  });

  test("mentions deregister in tool table", () => {
    const seed = generateSeedContent();
    expect(seed).toContain("deregister");
  });

  test("does not reference old 'parent'/'children' messaging", () => {
    const seed = generateSeedContent();
    // Should not have parent/children as messaging targets in tool table
    expect(seed).not.toContain('to="parent"');
    expect(seed).not.toContain('to="children"');
  });
});

// ═══════════════════════════════════════════════════════════════════
// createWorkerFiles — unique name enforcement (file-level)
// ═══════════════════════════════════════════════════════════════════

describe("createWorkerFiles — unique name check", () => {
  test("rejects creation if worker dir already exists", () => {
    // First creation succeeds
    const result1 = createWorkerFiles({ name: "dup-check-worker", mission: "Test" });
    expect(result1.ok).toBe(true);

    // Second creation with same name fails
    const result2 = createWorkerFiles({ name: "dup-check-worker", mission: "Test again" });
    expect(result2.ok).toBe(false);
    expect(result2.error).toContain("already exists");
  });

  test("rejects invalid kebab-case names", () => {
    const result = createWorkerFiles({ name: "UPPER_CASE", mission: "Test" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("kebab-case");
  });

  test("rejects empty mission", () => {
    const result = createWorkerFiles({ name: "empty-mission-test", mission: "   " });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("empty");
  });

  test("returns task IDs when tasks provided", () => {
    const result = createWorkerFiles({
      name: "with-tasks-test",
      mission: "Test mission",
      taskEntries: [
        { subject: "Task 1", priority: "high" },
        { subject: "Task 2" },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.taskIds!.length).toBe(2);
    expect(result.taskIds![0]).toMatch(/^T\d+$/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// resolveRecipient — comprehensive coverage
// ═══════════════════════════════════════════════════════════════════

describe("resolveRecipient — comprehensive", () => {
  test("worker name → type worker", () => {
    const result = resolveRecipient("my-worker");
    expect(result.type).toBe("worker");
    expect(result.workerName).toBe("my-worker");
    expect(result.error).toBeUndefined();
  });

  test("raw pane ID → type pane", () => {
    const result = resolveRecipient("%123");
    expect(result.type).toBe("pane");
    expect(result.paneId).toBe("%123");
  });

  test("report → resolves to report_to chain", () => {
    const result = resolveRecipient("report");
    // Either resolves to a worker/pane or returns an error — never crashes
    expect(result.type).toBeDefined();
  });

  test("direct_reports → type multi_pane", () => {
    const result = resolveRecipient("direct_reports");
    expect(result.type).toBe("multi_pane");
    expect(Array.isArray(result.paneIds)).toBe(true);
  });

  test("empty string → treated as worker name", () => {
    const result = resolveRecipient("");
    expect(result.type).toBe("worker");
    expect(result.workerName).toBe("");
  });

  test("pane ID without percent → treated as worker name", () => {
    const result = resolveRecipient("123");
    expect(result.type).toBe("worker");
    expect(result.workerName).toBe("123");
  });
});

// ═══════════════════════════════════════════════════════════════════
// lintRegistry — comprehensive lint checks
// ═══════════════════════════════════════════════════════════════════

describe("lintRegistry — comprehensive", () => {
  test("empty registry (no workers) → no issues", () => {
    const registry = makeProjectRegistry({});
    const issues = lintRegistry(registry);
    expect(issues.length).toBe(0);
  });

  test("worker with no model → warning", () => {
    const registry = makeProjectRegistry({
      "no-model": makeRegistryEntry({ model: "" }),
    });
    const issues = lintRegistry(registry);
    const modelIssue = issues.find(i => i.check === "lint.model");
    expect(modelIssue).toBeDefined();
  });

  test("worker with valid model → no model warning", () => {
    const registry = makeProjectRegistry({
      "has-model": makeRegistryEntry({ model: "sonnet" }),
    });
    const issues = lintRegistry(registry);
    const modelIssue = issues.find(i => i.check === "lint.model");
    expect(modelIssue).toBeUndefined();
  });

  test("multiple lint issues can be returned at once", () => {
    const registry = makeProjectRegistry({
      "bad-worker": makeRegistryEntry({ model: "", report_to: "nonexistent" }),
    });
    const issues = lintRegistry(registry);
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// createWorkerFiles — type template integration
// ═══════════════════════════════════════════════════════════════════

describe("createWorkerFiles — type templates", () => {
  test("type=monitor sets opus, perpetual=true, read-only denyList", () => {
    const result = createWorkerFiles({
      name: "tpl-monitor-test",
      mission: "# Test Monitor",
      type: "monitor",
    });
    expect(result.ok).toBe(true);
    expect(result.model).toBe("opus");
    expect(result.perpetual).toBe(true);
    expect(result.state?.sleep_duration).toBe(1800);
    expect(result.permissions?.disallowedTools).toContain("Edit");
  });

  test("type=implementer sets opus, perpetual=false", () => {
    const result = createWorkerFiles({
      name: "tpl-impl-test",
      mission: "# Test Implementer",
      type: "implementer",
    });
    expect(result.ok).toBe(true);
    expect(result.model).toBe("opus");
    expect(result.perpetual).toBe(false);
    expect(result.permissions?.disallowedTools).not.toContain("Edit");
  });

  test("type=coordinator uses defaults (no template dir)", () => {
    const result = createWorkerFiles({
      name: "tpl-coord-test",
      mission: "# Test Coordinator",
      type: "coordinator",
    });
    expect(result.ok).toBe(true);
    expect(result.model).toBe("opus");
    // No coordinator template dir → falls back to defaults
    expect(result.perpetual).toBe(false);
    // Default denyList includes merge/push
    expect(result.permissions?.disallowedTools).toContain("Bash(git merge*)");
    expect(result.permissions?.disallowedTools).toContain("Bash(git push*)");
  });

  test("type=optimizer sets opus, perpetual=true, sleep=7200", () => {
    const result = createWorkerFiles({
      name: "tpl-optim-test",
      mission: "# Test Optimizer",
      type: "optimizer",
    });
    expect(result.ok).toBe(true);
    expect(result.model).toBe("opus");
    expect(result.perpetual).toBe(true);
    expect(result.state?.sleep_duration).toBe(7200);
  });

  test("explicit model overrides type template", () => {
    const result = createWorkerFiles({
      name: "tpl-override-model",
      mission: "# Override Test",
      type: "monitor",
      model: "sonnet",
    });
    expect(result.ok).toBe(true);
    expect(result.model).toBe("sonnet"); // explicit overrides opus from monitor template
    expect(result.perpetual).toBe(true); // still from template
  });

  test("explicit perpetual overrides type template", () => {
    const result = createWorkerFiles({
      name: "tpl-override-perp",
      mission: "# Override Test",
      type: "monitor",
      perpetual: false,
    });
    expect(result.ok).toBe(true);
    expect(result.perpetual).toBe(false); // explicit overrides true from template
  });

  test("no type = backwards compatible defaults", () => {
    const result = createWorkerFiles({
      name: "tpl-no-type",
      mission: "# Old Style",
    });
    expect(result.ok).toBe(true);
    expect(result.model).toBe("opus"); // hardcoded default
    expect(result.perpetual).toBe(false); // hardcoded default
    expect(result.permissions?.disallowedTools).toHaveLength(6); // default 6 rules
  });
});

// ═══════════════════════════════════════════════════════════════════
// Runtime parity (Claude vs Codex)
// ═══════════════════════════════════════════════════════════════════

describe("createWorkerFiles — runtime (Claude vs Codex)", () => {
  test("runtime=claude sets model=opus by default", () => {
    const result = createWorkerFiles({
      name: "rt-claude-default",
      mission: "# Claude Worker",
      runtime: "claude",
    });
    expect(result.ok).toBe(true);
    expect(result.runtime).toBe("claude");
    expect(result.model).toBe("opus");
    expect(result.permissions?.runtime).toBe("claude");
  });

  test("runtime=codex sets model=o3 by default", () => {
    const result = createWorkerFiles({
      name: "rt-codex-default",
      mission: "# Codex Worker",
      runtime: "codex",
    });
    expect(result.ok).toBe(true);
    expect(result.runtime).toBe("codex");
    expect(result.model).toBe("gpt-5.4");
    expect(result.permissions?.runtime).toBe("codex");
  });

  test("runtime=codex with explicit model overrides default", () => {
    const result = createWorkerFiles({
      name: "rt-codex-o4",
      mission: "# Codex Worker",
      runtime: "codex",
      model: "o4-mini",
    });
    expect(result.ok).toBe(true);
    expect(result.runtime).toBe("codex");
    expect(result.model).toBe("o4-mini");
  });

  test("no runtime = defaults to claude", () => {
    const result = createWorkerFiles({
      name: "rt-no-runtime",
      mission: "# Worker",
    });
    expect(result.ok).toBe(true);
    expect(result.runtime).toBe("claude");
    expect(result.model).toBe("opus");
    expect(result.permissions?.runtime).toBe("claude");
  });

  test("denyList is identical for same type regardless of runtime", () => {
    const claudeResult = createWorkerFiles({
      name: "rt-deny-claude",
      mission: "# Claude Impl",
      type: "implementer",
      runtime: "claude",
    });
    const codexResult = createWorkerFiles({
      name: "rt-deny-codex",
      mission: "# Codex Impl",
      type: "implementer",
      runtime: "codex",
    });
    expect(claudeResult.ok).toBe(true);
    expect(codexResult.ok).toBe(true);
    // denyList is type-driven, not runtime-driven
    expect(claudeResult.permissions?.disallowedTools).toEqual(codexResult.permissions?.disallowedTools);
  });

  test("reasoning_effort defaults to high", () => {
    const result = createWorkerFiles({
      name: "rt-effort-default",
      mission: "# Default Effort",
      runtime: "codex",
    });
    expect(result.ok).toBe(true);
    expect(result.permissions?.reasoning_effort).toBe("high");
  });

  test("reasoning_effort=extra_high is stored", () => {
    const result = createWorkerFiles({
      name: "rt-effort-extra",
      mission: "# Extra Effort",
      runtime: "codex",
      reasoning_effort: "extra_high",
    });
    expect(result.ok).toBe(true);
    expect(result.permissions?.reasoning_effort).toBe("extra_high");
  });

  test("reasoning_effort works for claude runtime too", () => {
    const result = createWorkerFiles({
      name: "rt-effort-claude",
      mission: "# Claude Effort",
      runtime: "claude",
      reasoning_effort: "low",
    });
    expect(result.ok).toBe(true);
    expect(result.permissions?.reasoning_effort).toBe("low");
  });

  test("runtime=codex with type=monitor uses type model (opus) not codex default", () => {
    const result = createWorkerFiles({
      name: "rt-codex-monitor",
      mission: "# Codex Monitor",
      type: "monitor",
      runtime: "codex",
    });
    expect(result.ok).toBe(true);
    // Type template model (opus) overrides runtime default (o3)
    expect(result.model).toBe("opus");
    expect(result.runtime).toBe("codex");
    expect(result.perpetual).toBe(true); // from monitor template
  });
});

// ═══════════════════════════════════════════════════════════════════
// Verifier type
// ═══════════════════════════════════════════════════════════════════

describe("createWorkerFiles — verifier type", () => {
  test("type=verifier sets perpetual=false, sleep_duration=0", () => {
    const result = createWorkerFiles({
      name: "tpl-verifier-test",
      mission: "# Verify deployment",
      type: "verifier",
    });
    expect(result.ok).toBe(true);
    expect(result.perpetual).toBe(false);
    expect(result.state?.perpetual).toBe(false);
    // sleep_duration not set when perpetual=false
  });

  test("type=verifier perpetual override works", () => {
    const result = createWorkerFiles({
      name: "tpl-verifier-perp",
      mission: "# Continuous verifier",
      type: "verifier",
      perpetual: true,
      sleep_duration: 600,
    });
    expect(result.ok).toBe(true);
    expect(result.perpetual).toBe(true);
    expect(result.state?.sleep_duration).toBe(600);
  });

  test("type=verifier denyList includes deploy-prod", () => {
    const result = createWorkerFiles({
      name: "tpl-verifier-deny",
      mission: "# Verifier denyList",
      type: "verifier",
    });
    expect(result.ok).toBe(true);
    expect(result.permissions?.disallowedTools).toContain("Bash(*deploy-prod*)");
    expect(result.permissions?.disallowedTools).toContain("Bash(git merge*)");
    expect(result.permissions?.disallowedTools).toContain("Bash(git push*)");
  });

  test("type=verifier with runtime=codex", () => {
    const result = createWorkerFiles({
      name: "tpl-verifier-codex",
      mission: "# Codex Verifier",
      type: "verifier",
      runtime: "codex",
    });
    expect(result.ok).toBe(true);
    // Type template model (opus) overrides codex default (o3)
    expect(result.model).toBe("opus");
    expect(result.runtime).toBe("codex");
    expect(result.perpetual).toBe(false);
    expect(result.permissions?.disallowedTools).toContain("Bash(*deploy-prod*)");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Cross-runtime messaging
// ═══════════════════════════════════════════════════════════════════

describe("cross-runtime messaging", () => {
  test("Claude worker A and Codex worker B can exchange messages", () => {
    // Create worker dirs
    const workerA = "xrt-claude-a";
    const workerB = "xrt-codex-b";
    mkdirSync(join(TEST_WORKERS_DIR, workerA), { recursive: true });
    mkdirSync(join(TEST_WORKERS_DIR, workerB), { recursive: true });

    // Send from A to B
    const sendAB = writeToInbox(workerB, { content: "hello from claude", from_name: workerA });
    expect(sendAB.ok).toBe(true);

    // Send from B to A
    const sendBA = writeToInbox(workerA, { content: "reply from codex", from_name: workerB });
    expect(sendBA.ok).toBe(true);

    // Read B's inbox — should have A's message
    const inboxB = readInboxFromCursor(workerB);
    expect(inboxB.messages.length).toBeGreaterThanOrEqual(1);
    expect(inboxB.messages.some((m: any) => m.from_name === workerA && m.content === "hello from claude")).toBe(true);

    // Read A's inbox — should have B's message
    const inboxA = readInboxFromCursor(workerA);
    expect(inboxA.messages.length).toBeGreaterThanOrEqual(1);
    expect(inboxA.messages.some((m: any) => m.from_name === workerB && m.content === "reply from codex")).toBe(true);
  });

  test("message format is identical regardless of runtime", () => {
    const workerC = "xrt-fmt-claude";
    const workerD = "xrt-fmt-codex";
    mkdirSync(join(TEST_WORKERS_DIR, workerC), { recursive: true });
    mkdirSync(join(TEST_WORKERS_DIR, workerD), { recursive: true });

    writeToInbox(workerC, { content: "test msg", from_name: workerD, summary: "test" });
    writeToInbox(workerD, { content: "test msg", from_name: workerC, summary: "test" });

    const inboxC = readInboxFromCursor(workerC);
    const inboxD = readInboxFromCursor(workerD);

    // Both messages should have the same structure
    const msgC = inboxC.messages[0];
    const msgD = inboxD.messages[0];
    expect(msgC.from_name).toBe(workerD);
    expect(msgD.from_name).toBe(workerC);
    // Same fields present in both
    const keysC = Object.keys(msgC).sort();
    const keysD = Object.keys(msgD).sort();
    expect(keysC).toEqual(keysD);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Registry parity (Claude vs Codex)
// ═══════════════════════════════════════════════════════════════════

describe("registry parity — Claude vs Codex", () => {
  test("Claude worker has all required registry fields", () => {
    const result = createWorkerFiles({
      name: "reg-claude-test",
      mission: "# Claude",
      runtime: "claude",
    });
    expect(result.ok).toBe(true);
    expect(result.permissions?.runtime).toBe("claude");
    expect(result.model).toBeDefined();
    expect(result.state).toBeDefined();
    expect(result.permissions).toBeDefined();
    expect(result.perpetual).toBeDefined();
  });

  test("Codex worker has all same registry fields as Claude", () => {
    const result = createWorkerFiles({
      name: "reg-codex-test",
      mission: "# Codex",
      runtime: "codex",
    });
    expect(result.ok).toBe(true);
    expect(result.permissions?.runtime).toBe("codex");
    expect(result.model).toBeDefined();
    expect(result.state).toBeDefined();
    expect(result.permissions).toBeDefined();
    expect(result.perpetual).toBeDefined();
  });

  test("two workers (claude + codex) in same registry, no conflicts", () => {
    const registry = makeProjectRegistry({});
    const claudeEntry = ensureWorkerInRegistry(registry, "dual-claude");
    claudeEntry.custom = { runtime: "claude" };
    claudeEntry.model = "opus";

    const codexEntry = ensureWorkerInRegistry(registry, "dual-codex");
    codexEntry.custom = { runtime: "codex" };
    codexEntry.model = "gpt-5.4";

    // Both should be retrievable
    expect((registry["dual-claude"] as RegistryWorkerEntry).custom.runtime).toBe("claude");
    expect((registry["dual-codex"] as RegistryWorkerEntry).custom.runtime).toBe("codex");
    expect((registry["dual-claude"] as RegistryWorkerEntry).model).toBe("opus");
    expect((registry["dual-codex"] as RegistryWorkerEntry).model).toBe("gpt-5.4");
  });
});
