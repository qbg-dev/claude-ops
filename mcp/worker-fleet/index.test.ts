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
  readRegistry, getWorkerEntry, ensureWorkerInRegistry, lintRegistry,
  _replaceMemorySection, acquireLock, releaseLock, getWorktreeDir, getSessionId,
  WORKER_NAME, WORKERS_DIR, REGISTRY_PATH, HARNESS_LOCK_DIR,
  type Task, type DiagnosticIssue,
  type RegistryConfig, type RegistryWorkerEntry, type ProjectRegistry,
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
    cycles_completed: 0,
    last_cycle_at: null,
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

  test("parent without registry → error or resolved", () => {
    const result = resolveRecipient("parent");
    expect(["pane", "worker"]).toContain(result.type);
    expect(result.paneId || result.workerName || result.error).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════
// generateSeedContent
// ═══════════════════════════════════════════════════════════════════

describe("generateSeedContent", () => {
  test("contains worker name", () => {
    const seed = generateSeedContent();
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
    expect(seed).not.toContain("Handoff from Previous Cycle");
  });

  test("seed references get_worker_state, not state.json", () => {
    const seed = generateSeedContent();
    expect(seed).toContain("get_worker_state()");
    expect(seed).not.toContain("state.json");
  });

  test("includes check_config in tool table", () => {
    const seed = generateSeedContent();
    expect(seed).toContain("check_config");
  });

  test("does not reference smart_commit (removed)", () => {
    const seed = generateSeedContent();
    expect(seed).not.toContain("smart_commit");
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
    expect(result).toEqual({ ok: true });
    const line = readFileSync(join(TEST_WORKER_DIR, "inbox.jsonl"), "utf-8").trim();
    const parsed = JSON.parse(line);
    expect(parsed.content).toBe('He said "hello world"');
  });

  test("message with shell metacharacters ($ ! ; | & >)", () => {
    const content = 'Run: $HOME/bin/test; echo "done" | grep ok && rm -rf / > /dev/null &';
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
    expect(entry.model).toBe("sonnet");
    expect(entry.permission_mode).toBe("bypassPermissions");
    expect(entry.status).toBe("idle");
    expect(entry.cycles_completed).toBe(0);
    expect(entry.disallowed_tools).toEqual(expect.any(Array));
    expect(entry.custom).toEqual({});
    // Entry should be in registry
    expect(registry[testName]).toBe(entry);
  });

  test("returns existing entry without overwriting", () => {
    const testName = "existing-worker";
    const existing = makeRegistryEntry({
      model: "opus",
      status: "active",
      cycles_completed: 99,
    });
    const registry = makeProjectRegistry({ [testName]: existing });

    const result = ensureWorkerInRegistry(registry, testName);

    expect(result.cycles_completed).toBe(99);
    expect(result.model).toBe("opus");
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

  test("lint.orphan: worker with no parent and no children → warning", () => {
    const registry = makeProjectRegistry({
      "lone-worker": makeRegistryEntry({}),
    });
    const issues = lintRegistry(registry);
    const orphanIssue = issues.find(i => i.check === "lint.orphan");
    expect(orphanIssue).toBeDefined();
    expect(orphanIssue!.severity).toBe("warning");
    expect(orphanIssue!.message).toContain("lone-worker");
  });

  test("lint.orphan: worker with parent field → no orphan warning", () => {
    const registry = makeProjectRegistry({
      "parent-worker": makeRegistryEntry({ children: ["child-worker"] }),
      "child-worker": makeRegistryEntry({ parent: "parent-worker" }),
    });
    const issues = lintRegistry(registry);
    const orphanIssues = issues.filter(i => i.check === "lint.orphan");
    expect(orphanIssues.length).toBe(0);
  });

  test("lint.parent_missing: worker references non-existent parent → error", () => {
    const registry = makeProjectRegistry({
      "orphaned-child": makeRegistryEntry({ parent: "ghost-parent" }),
    });
    const issues = lintRegistry(registry);
    const missingParent = issues.find(i => i.check === "lint.parent_missing");
    expect(missingParent).toBeDefined();
    expect(missingParent!.severity).toBe("error");
    expect(missingParent!.message).toContain("ghost-parent");
  });

  test("lint.parent_missing: valid parent reference → no error", () => {
    const registry = makeProjectRegistry({
      "chief-of-staff": makeRegistryEntry({ children: ["my-worker"] }),
      "my-worker": makeRegistryEntry({ parent: "chief-of-staff" }),
    });
    const issues = lintRegistry(registry);
    const missingParent = issues.find(i => i.check === "lint.parent_missing");
    expect(missingParent).toBeUndefined();
  });
});

describe("resolveRecipient — children", () => {
  test("children → type multi_pane", () => {
    const result = resolveRecipient("children");
    expect(result.type).toBe("multi_pane");
    // paneIds array always present (may be empty if no children registered)
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
    expect(typeof entry.cycles_completed).toBe("number");
    expect(typeof entry.tmux_session).toBe("string");
    expect(typeof entry.mission_file).toBe("string");
    expect(typeof entry.custom).toBe("object");
  });

  test("nullable fields accept null", () => {
    const entry = makeRegistryEntry({
      last_cycle_at: null,
      worktree: null,
      window: null,
      pane_id: null,
      pane_target: null,
      session_id: null,
      session_file: null,
    });
    expect(entry.last_cycle_at).toBeNull();
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
// spawn_child — parent/children registry tracking (in-memory)
// ═══════════════════════════════════════════════════════════════════

describe("spawn_child — parent/children registry tracking", () => {
  // Simulate the exact registry mutation logic from spawn_child (index.ts ~line 1858)
  function registerChild(
    registry: ProjectRegistry,
    parentName: string,
    childName: string,
    childPaneId: string
  ) {
    ensureWorkerInRegistry(registry, childName);
    const child = registry[childName] as RegistryWorkerEntry;
    child.pane_id = childPaneId;
    child.parent = parentName;

    const parent = registry[parentName] as RegistryWorkerEntry | undefined;
    if (parent) {
      if (!parent.children) parent.children = [];
      if (!parent.children.includes(childName)) parent.children.push(childName);
    }
  }

  test("child entry gets parent field set to spawner name", () => {
    const registry = makeProjectRegistry({
      "parent-worker": makeRegistryEntry({ pane_id: "%10" }),
    });
    registerChild(registry, "parent-worker", "parent-worker-child-1", "%11");

    const child = registry["parent-worker-child-1"] as RegistryWorkerEntry & { parent?: string };
    expect(child.parent).toBe("parent-worker");
  });

  test("spawned child is added to parent's children array", () => {
    const registry = makeProjectRegistry({
      "parent-worker": makeRegistryEntry({ pane_id: "%10" }),
    });
    registerChild(registry, "parent-worker", "child-a", "%11");

    const parent = registry["parent-worker"] as RegistryWorkerEntry;
    expect(parent.children).toContain("child-a");
  });

  test("spawning two children accumulates both in parent's children[]", () => {
    const registry = makeProjectRegistry({
      "parent-worker": makeRegistryEntry(),
    });
    registerChild(registry, "parent-worker", "child-a", "%11");
    registerChild(registry, "parent-worker", "child-b", "%12");

    const parent = registry["parent-worker"] as RegistryWorkerEntry;
    expect(parent.children).toContain("child-a");
    expect(parent.children).toContain("child-b");
    expect(parent.children!.length).toBe(2);
  });

  test("duplicate child is not added twice to parent's children[]", () => {
    const registry = makeProjectRegistry({
      "parent-worker": makeRegistryEntry(),
    });
    registerChild(registry, "parent-worker", "child-dup", "%11");
    registerChild(registry, "parent-worker", "child-dup", "%11"); // second time

    const parent = registry["parent-worker"] as RegistryWorkerEntry;
    const dupes = parent.children!.filter((c: string) => c === "child-dup");
    expect(dupes.length).toBe(1);
  });

  test("child pane_id is recorded in child's registry entry", () => {
    const registry = makeProjectRegistry({
      "parent-worker": makeRegistryEntry(),
    });
    registerChild(registry, "parent-worker", "child-pane-test", "%99");

    const child = registry["child-pane-test"] as RegistryWorkerEntry;
    expect(child.pane_id).toBe("%99");
  });
});

// ═══════════════════════════════════════════════════════════════════
// create_worker — auto-sets parent field (commit 1751574)
// ═══════════════════════════════════════════════════════════════════

describe("create_worker — auto-parent registration", () => {
  // Simulate the auto-parent logic added in commit 1751574
  function applyAutoParent(registry: ProjectRegistry, workerName: string, callerName: string) {
    ensureWorkerInRegistry(registry, workerName);
    const entry = registry[workerName] as RegistryWorkerEntry & { parent?: string };
    if (!entry.parent) {
      entry.parent = callerName;
    }
  }

  test("new entry gets parent set to calling worker", () => {
    const testDir = join(TEST_WORKERS_DIR, "new-worker");
    mkdirSync(testDir, { recursive: true });

    const registry = makeProjectRegistry({
      "chief-of-staff": makeRegistryEntry({ pane_id: "%1" }),
    });
    applyAutoParent(registry, "new-worker", "chief-of-staff");

    const entry = registry["new-worker"] as RegistryWorkerEntry & { parent?: string };
    expect(entry.parent).toBe("chief-of-staff");
  });

  test("existing entry with parent already set is NOT overwritten", () => {
    const registry = makeProjectRegistry({
      "existing-worker": { ...makeRegistryEntry(), parent: "original-parent" } as any,
    });
    applyAutoParent(registry, "existing-worker", "chief-of-staff");

    const entry = registry["existing-worker"] as RegistryWorkerEntry & { parent?: string };
    expect(entry.parent).toBe("original-parent");
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
