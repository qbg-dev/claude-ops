import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  openSync,
  fstatSync,
  statSync,
  readSync,
  closeSync,
  truncateSync,
  lstatSync,
  rmSync,
  copyFileSync,
  cpSync
} from "fs";
import { join, basename } from "path";
import { execSync, spawnSync } from "child_process";
const HOME = process.env.HOME;
const PROJECT_ROOT = process.env.PROJECT_ROOT || "/Users/wz/Desktop/zPersonalProjects/Wechat";
const CLAUDE_OPS = process.env.CLAUDE_OPS_DIR || join(HOME, ".claude-ops");
let WORKERS_DIR = join(PROJECT_ROOT, ".claude/workers");
function _setWorkersDir(dir) {
  WORKERS_DIR = dir;
}
const HARNESS_LOCK_DIR = join(CLAUDE_OPS, "state/locks");
const REGISTRY_PATH = join(PROJECT_ROOT, ".claude/workers/registry.json");
const WORKER_MESSAGE_SH = join(CLAUDE_OPS, "scripts/worker-message.sh");
const CHECK_WORKERS_SH = join(CLAUDE_OPS, "scripts/check-flat-workers.sh");
function detectWorkerName() {
  if (process.env.WORKER_NAME)
    return process.env.WORKER_NAME;
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: process.cwd(),
      encoding: "utf-8",
      timeout: 5000
    }).trim();
    if (branch.startsWith("worker/"))
      return branch.slice("worker/".length);
    const dirName = basename(process.cwd());
    const match = dirName.match(/-w-(.+)$/);
    if (match)
      return match[1];
  } catch {}
  return "operator";
}
const WORKER_NAME = detectWorkerName();
let _cachedBranch = null;
try {
  _cachedBranch = execSync("git rev-parse --abbrev-ref HEAD", {
    cwd: process.cwd(),
    encoding: "utf-8",
    timeout: 5000
  }).trim();
} catch {}
function runScript(cmd, args, opts = {}) {
  const result = spawnSync("bash", [cmd, ...args], {
    cwd: opts.cwd || PROJECT_ROOT,
    encoding: "utf-8",
    timeout: opts.timeout || 30000,
    env: { ...process.env, PROJECT_ROOT }
  });
  return {
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    exitCode: result.status ?? 1
  };
}
function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}
const LINT_ENABLED = process.env.WORKER_FLEET_LINT !== "0";
function getReportTo(w, config) {
  return w.report_to || w.assigned_by || w.parent || config?.mission_authority || null;
}
function canUpdateWorker(callerName, targetName, registry) {
  if (callerName === targetName)
    return true;
  const config = registry._config;
  if (callerName === config?.mission_authority)
    return true;
  const target = registry[targetName];
  if (target && getReportTo(target, config) === callerName)
    return true;
  return false;
}
function readRegistry() {
  const raw = readJsonFile(REGISTRY_PATH);
  if (!raw || !raw._config) {
    return {
      _config: {
        commit_notify: ["merger"],
        merge_authority: "merger",
        deploy_authority: "merger",
        mission_authority: "chief-of-staff",
        tmux_session: "w",
        project_name: basename(PROJECT_ROOT)
      }
    };
  }
  return raw;
}
function getWorkerEntry(name) {
  const reg = readRegistry();
  const entry = reg[name];
  if (!entry || name === "_config")
    return null;
  return entry;
}
function withRegistryLocked(fn) {
  const lockPath = join(HARNESS_LOCK_DIR, "worker-registry");
  if (!acquireLock(lockPath)) {
    throw new Error("Could not acquire worker-registry lock after 10s — stale lock?");
  }
  try {
    const registry = readRegistry();
    const result = fn(registry);
    writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + `
`);
    return result;
  } finally {
    releaseLock(join(HARNESS_LOCK_DIR, "worker-registry"));
  }
}
function ensureWorkerInRegistry(registry, name) {
  if (registry[name] && name !== "_config") {
    const e = registry[name];
    if (!e.custom)
      e.custom = {};
    return e;
  }
  const projectName = PROJECT_ROOT.split("/").pop();
  const worktreeDir = join(PROJECT_ROOT, "..", `${projectName}-w-${name}`);
  const entry = {
    model: "opus",
    permission_mode: "bypassPermissions",
    disallowed_tools: [],
    status: "idle",
    perpetual: false,
    sleep_duration: 1800,
    cycles_completed: 0,
    last_cycle_at: null,
    branch: `worker/${name}`,
    worktree: worktreeDir,
    window: null,
    pane_id: null,
    pane_target: null,
    tmux_session: registry._config?.tmux_session || "w",
    session_id: null,
    session_file: null,
    mission_file: `.claude/workers/${name}/mission.md`,
    custom: {}
  };
  registry[name] = entry;
  return entry;
}
function syncTasksToFilesystem(name, tasks) {
  try {
    const tasksPath = join(WORKERS_DIR, name, "tasks.json");
    const dir = join(WORKERS_DIR, name);
    if (existsSync(dir)) {
      writeFileSync(tasksPath, JSON.stringify(tasks, null, 2) + `
`);
    }
  } catch {}
}
function lintRegistry(registry) {
  if (!LINT_ENABLED)
    return [];
  const issues = [];
  for (const [name, entry] of Object.entries(registry)) {
    if (name === "_config")
      continue;
    const w = entry;
    const workerDir = join(WORKERS_DIR, name);
    if (!existsSync(workerDir)) {
      issues.push({ severity: "error", check: "lint.worker_dir", message: `Worker '${name}' worker_dir doesn't exist: ${workerDir}` });
    }
    if (w.pane_id && !isPaneAlive(w.pane_id)) {
      issues.push({ severity: "warning", check: "lint.dead_pane", message: `Dead pane ${w.pane_id} (worker: ${name})`, fix: "Auto-pruned on fleet_status()" });
    }
    if (w.worktree && w.branch !== "main" && !existsSync(w.worktree)) {
      issues.push({ severity: "warning", check: "lint.worktree", message: `Worker '${name}' worktree doesn't exist: ${w.worktree}` });
    }
    if (!w.model) {
      issues.push({ severity: "warning", check: "lint.model", message: `Worker '${name}' has no model configured` });
    }
  }
  const workerPanes = {};
  for (const [name, entry] of Object.entries(registry)) {
    if (name === "_config")
      continue;
    const w = entry;
    if (w.pane_id && isPaneAlive(w.pane_id)) {
      if (!workerPanes[name])
        workerPanes[name] = [];
      workerPanes[name].push(w.pane_id);
    }
  }
  for (const [name, panes] of Object.entries(workerPanes)) {
    if (panes.length > 1) {
      issues.push({ severity: "warning", check: "lint.duplicate_pane", message: `Worker '${name}' has ${panes.length} live panes: ${panes.join(", ")}` });
    }
  }
  const allWorkerNames = Object.keys(registry).filter((n) => n !== "_config");
  for (const name of allWorkerNames) {
    const w = registry[name];
    const reportTo = getReportTo(w, registry._config);
    if (reportTo && !registry[reportTo]) {
      issues.push({ severity: "warning", check: "lint.report_to_missing", message: `Worker '${name}' report_to '${reportTo}' doesn't exist in registry` });
    }
  }
  return issues;
}
function acquireLock(lockPath, maxWaitMs = 1e4) {
  const start = Date.now();
  while (true) {
    try {
      mkdirSync(lockPath, { recursive: false });
      return true;
    } catch {
      if (Date.now() - start > maxWaitMs) {
        try {
          execSync(`rm -rf "${lockPath}"`, { timeout: 2000 });
        } catch {}
        try {
          mkdirSync(lockPath, { recursive: false });
          return true;
        } catch {}
        return false;
      }
      execSync("sleep 0.1", { timeout: 1000 });
    }
  }
}
function releaseLock(lockPath) {
  try {
    execSync(`rm -rf "${lockPath}"`, { timeout: 2000 });
  } catch {}
}
function getTasksPath(worker) {
  return join(WORKERS_DIR, worker, "tasks.json");
}
function readTasks(worker) {
  const path = getTasksPath(worker);
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}
function writeTasks(worker, tasks) {
  syncTasksToFilesystem(worker, tasks);
}
function nextTaskId(tasks) {
  const ids = Object.keys(tasks);
  if (ids.length === 0)
    return "T001";
  const nums = ids.map((id) => parseInt(id.replace(/^T/, ""), 10)).filter((n) => !isNaN(n));
  const max = nums.length > 0 ? Math.max(...nums) : 0;
  const next = max + 1;
  return next < 1000 ? `T${String(next).padStart(3, "0")}` : `T${next}`;
}
function isTaskBlocked(tasks, taskId) {
  const task = tasks[taskId];
  if (!task)
    return false;
  const deps = task.blocked_by || [];
  return deps.length > 0 && deps.some((d) => tasks[d]?.status !== "completed");
}
function generateMsgId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function getInboxPath(worker) {
  return join(WORKERS_DIR, worker, "inbox.jsonl");
}
function getCursorPath(worker) {
  return join(WORKERS_DIR, worker, "inbox-cursor.json");
}
function readInboxCursor(worker) {
  try {
    const data = JSON.parse(readFileSync(getCursorPath(worker), "utf-8"));
    if (typeof data?.offset === "number")
      return data;
    return null;
  } catch {
    return null;
  }
}
function writeInboxCursor(worker, offset, pending_replies) {
  writeFileSync(getCursorPath(worker), JSON.stringify({
    offset,
    last_read_at: new Date().toISOString(),
    pending_replies: pending_replies || []
  }) + `
`);
}
function removePendingReply(worker, msgId) {
  const cursor = readInboxCursor(worker);
  if (!cursor?.pending_replies?.length)
    return;
  const filtered = cursor.pending_replies.filter((p) => p.msg_id !== msgId);
  if (filtered.length !== cursor.pending_replies.length) {
    writeInboxCursor(worker, cursor.offset, filtered);
  }
}
function readInboxFromCursor(worker, opts = {}) {
  const inboxPath = getInboxPath(worker);
  if (!existsSync(inboxPath))
    return { messages: [], newOffset: 0 };
  const cursor = readInboxCursor(worker);
  const startOffset = cursor?.offset ?? 0;
  let fd;
  try {
    fd = openSync(inboxPath, "r");
  } catch {
    return { messages: [], newOffset: 0 };
  }
  try {
    const stat = fstatSync(fd);
    const fileSize = stat.size;
    const wasTruncated = fileSize < startOffset;
    const readFrom = wasTruncated ? 0 : startOffset;
    const bytesToRead = fileSize - readFrom;
    const existingPending = wasTruncated ? [] : cursor?.pending_replies || [];
    if (bytesToRead <= 0) {
      if (opts.clear) {
        truncateSync(inboxPath, 0);
        writeInboxCursor(worker, 0, []);
      }
      return { messages: [], newOffset: fileSize };
    }
    const buffer = Buffer.alloc(bytesToRead);
    readSync(fd, buffer, 0, bytesToRead, readFrom);
    const newData = buffer.toString("utf-8");
    let entries = newData.split(`
`).filter(Boolean).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
    const newPending = entries.filter((e) => e.ack_required === true && e.msg_id && !e.in_reply_to).map((e) => {
      const p = {
        msg_id: e.msg_id,
        from_name: e.from_name || "?",
        summary: e.summary || e.content?.slice(0, 40) + "..." || "?",
        _ts: e._ts || new Date().toISOString()
      };
      if (e.reply_type)
        p.reply_type = e.reply_type;
      return p;
    });
    const mergedPending = [...existingPending, ...newPending];
    if (opts.since) {
      entries = entries.filter((e) => {
        const ts = e._ts || e.ts || e.timestamp || "";
        return ts >= opts.since;
      });
    }
    if (opts.limit !== undefined) {
      entries = opts.limit > 0 ? entries.slice(-opts.limit) : [];
    }
    const newOffset = fileSize;
    writeInboxCursor(worker, opts.clear ? 0 : newOffset, opts.clear ? [] : mergedPending);
    if (opts.clear) {
      try {
        truncateSync(inboxPath, 0);
      } catch {}
    }
    return { messages: entries, newOffset };
  } finally {
    closeSync(fd);
  }
}
function writeToInbox(recipientName, message) {
  const workerDir = join(WORKERS_DIR, recipientName);
  if (!existsSync(workerDir)) {
    return { ok: false, error: `Worker directory not found: ${recipientName}` };
  }
  const msgId = generateMsgId();
  const inboxPath = join(workerDir, "inbox.jsonl");
  const payload = {
    msg_id: msgId,
    to: `worker/${recipientName}`,
    from: `worker/${message.from_name}`,
    from_name: message.from_name,
    content: message.content,
    summary: message.summary || message.content.slice(0, 60),
    ack_required: message.ack_required !== false,
    in_reply_to: message.in_reply_to || null,
    msg_type: "message",
    channel: "worker-message",
    _ts: new Date().toISOString()
  };
  if (message.reply_type)
    payload.reply_type = message.reply_type;
  try {
    appendFileSync(inboxPath, JSON.stringify(payload) + `
`);
    return { ok: true, msg_id: msgId };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
function resolveRecipient(to) {
  if (to.startsWith("%")) {
    return { type: "pane", paneId: to };
  }
  if (to === "report") {
    try {
      const registry = readRegistry();
      const config = registry._config;
      const myEntry = registry[WORKER_NAME];
      const reportToName = myEntry ? getReportTo(myEntry, config) : config?.mission_authority;
      if (reportToName && reportToName !== WORKER_NAME) {
        const reportToEntry = registry[reportToName];
        if (reportToEntry?.pane_id && isPaneAlive(reportToEntry.pane_id)) {
          if (existsSync(join(WORKERS_DIR, reportToName))) {
            return { type: "worker", workerName: reportToName };
          }
          return { type: "pane", paneId: reportToEntry.pane_id };
        }
        return { type: "pane", error: `'${reportToName}' (report_to for '${WORKER_NAME}') has no live pane` };
      }
      return { type: "pane", error: `No report_to found for worker '${WORKER_NAME}'` };
    } catch {
      return { type: "pane", error: "Failed to read registry" };
    }
  }
  if (to === "direct_reports") {
    try {
      const registry = readRegistry();
      const config = registry._config;
      const paneIds = [];
      for (const [name, entry] of Object.entries(registry)) {
        if (name === "_config")
          continue;
        const w = entry;
        const reportTo = getReportTo(w, config);
        if (reportTo === WORKER_NAME && w.pane_id && isPaneAlive(w.pane_id)) {
          paneIds.push(w.pane_id);
        }
      }
      if (paneIds.length === 0) {
        return { type: "multi_pane", paneIds: [], error: "No workers reporting to you have live panes" };
      }
      return { type: "multi_pane", paneIds };
    } catch {
      return { type: "multi_pane", error: "Failed to read registry" };
    }
  }
  return { type: "worker", workerName: to };
}
function tmuxSendMessage(paneId, text) {
  const tmpFile = join(process.env.HOME || "/tmp", `.claude-ops/tmp/msg-${Date.now()}.txt`);
  try {
    const tmpDir = join(process.env.HOME || "/tmp", ".claude-ops/tmp");
    if (!existsSync(tmpDir))
      mkdirSync(tmpDir, { recursive: true });
    writeFileSync(tmpFile, text);
    spawnSync("tmux", ["load-buffer", tmpFile], { timeout: 5000 });
    spawnSync("tmux", ["paste-buffer", "-t", paneId, "-d"], { timeout: 5000 });
  } finally {
    try {
      rmSync(tmpFile);
    } catch {}
  }
  spawnSync("sleep", ["0.3"]);
  spawnSync("tmux", ["send-keys", "-t", paneId, "-H", "0d"], { timeout: 5000 });
}
function isPaneAlive(paneId) {
  try {
    const result = spawnSync("tmux", ["has-session", "-t", paneId], {
      encoding: "utf-8",
      timeout: 3000
    });
    if (result.status !== 0)
      return false;
    const check = spawnSync("tmux", ["display-message", "-t", paneId, "-p", "#{pane_id}"], {
      encoding: "utf-8",
      timeout: 3000
    });
    return check.status === 0 && check.stdout.trim() === paneId;
  } catch {
    return false;
  }
}
function findOwnPane() {
  const tmuxPane = process.env.TMUX_PANE;
  if (tmuxPane) {
    const entry = getWorkerEntry(WORKER_NAME);
    if (entry?.pane_id === tmuxPane) {
      return { paneId: tmuxPane, paneTarget: entry.pane_target || "" };
    }
    try {
      const target = execSync(`tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' | awk -v id="${tmuxPane}" '$1 == id {print $2}'`, { encoding: "utf-8", timeout: 5000 }).trim();
      if (target)
        return { paneId: tmuxPane, paneTarget: target };
    } catch {}
    return { paneId: tmuxPane, paneTarget: "" };
  }
  const entry = getWorkerEntry(WORKER_NAME);
  if (entry?.pane_id) {
    return { paneId: entry.pane_id, paneTarget: entry.pane_target || "" };
  }
  return null;
}
function getSessionId(paneId) {
  const paneMapPath = join(HOME, ".claude/pane-map/by-pane", paneId);
  try {
    return readFileSync(paneMapPath, "utf-8").trim();
  } catch {
    return null;
  }
}
function getWorkerModel() {
  try {
    const entry = getWorkerEntry(WORKER_NAME);
    return entry?.model || "opus";
  } catch {
    return "opus";
  }
}
function getWorktreeDir() {
  const projectName = PROJECT_ROOT.split("/").pop();
  return join(PROJECT_ROOT, "..", `${projectName}-w-${WORKER_NAME}`);
}
function generateSeedContent(handoff) {
  const workerDir = join(PROJECT_ROOT, ".claude/workers", WORKER_NAME);
  const worktreeDir = getWorktreeDir();
  const branch = `worker/${WORKER_NAME}`;
  let seed = `You are worker **${WORKER_NAME}**.
Worktree: ${worktreeDir} (branch: ${branch})
Worker config: ${workerDir}/

Read these files NOW in this order:
1. ${workerDir}/mission.md — your goals and tasks
2. Call \`get_worker_state()\` — your current cycle count and status (stored in registry.json)
3. Check \`.claude/scripts/${WORKER_NAME}/\` for existing scripts

Your MEMORY.md is auto-loaded by Claude (see "persistent auto memory directory" in your context).
Use Edit/Write to update it directly at that path. Then begin your cycle immediately.

## Cycle Pattern

Every cycle follows this sequence:

1. **Heartbeat** — \`heartbeat(cycles_completed=N)\` — auto-registers your pane + stamps cycle state in one call
2. **Drain inbox** — \`read_inbox()\` — act on messages before anything else (cursor-based, no data loss)
3. **Create tasks** — If your task list is empty or stale, read your mission.md and \`create_task\` for each goal. As you explore the codebase, \`create_task\` for discovered work items too. Your tasks are your contract with the fleet — keep them current.
4. **Check tasks** — \`list_tasks(filter="pending")\` — find highest-priority unblocked work
5. **Claim** — \`update_task(task_id="T00N", status="in_progress")\` — mark what you're working on
6. **Do the work** — investigate, fix, test, commit, deploy, verify
7. **Complete** — \`update_task(task_id="T00N", status="completed")\` — only after fully verified
8. **Perpetual?** — if \`perpetual: true\`, sleep for \`sleep_duration\` seconds, then loop

If your inbox has a message from Warren or chief-of-staff, prioritize it over your current task list.

## MCP Tools (\`mcp__worker-fleet__*\`)

| Tool | What it does |
|------|-------------|
| \`send_message(to, content, summary, fyi?, in_reply_to?, reply_type?)\` | Send to a worker; \`fyi=true\` = no reply needed; \`in_reply_to="msg_id"\` to ack; \`reply_type="e2e_verify"\` to tag expected reply type |
| \`read_inbox(limit?, since?, clear?)\` | Read your inbox; messages marked [NEEDS REPLY] require a response via \`in_reply_to\` |
| \`create_task(subject, priority?, ...)\` | Add a task to your task list |
| \`update_task(task_id, status?, subject?, owner?, ...)\` | Update task status/fields — claim, complete, delete, reassign |
| \`list_tasks(filter?, worker?)\` | List tasks; \`worker="all"\` for cross-worker view |
| \`get_worker_state(name?)\` | Read any worker's state from registry.json |
| \`update_state(key, value)\` | Update your state in registry.json + emit bus event |
| \`fleet_status()\` | Full fleet overview (all workers) |
| \`recycle(message?)\` | Self-recycle: write handoff, restart fresh with new context |
| \`create_worker(name, mission, launch=true, fork_from_session=true)\` | Fork yourself into a new worker with your conversation context |
| \`heartbeat(cycles_completed?, extra?)\` | Call at start of each cycle: auto-registers pane + stamps last_cycle_at, status, cycles_completed |
| \`deregister(name)\` | Remove a worker from the registry (rename = create_worker + deregister) |
| \`reload()\` | Hot-restart: exit + resume same session to pick up new MCP config |

These are native MCP tool calls — no bash wrappers needed.

## Rules
- **Use your MCP tools proactively.** The worker-fleet MCP tools (\`mcp__worker-fleet__*\`) are your primary affordances for coordination, state management, and task tracking. Each tool provides capabilities that make you more effective and visible to the fleet — use them whenever appropriate, not just when explicitly told.
- **Fix everything.** Never just report issues — investigate, fix, deploy, document in MEMORY.md.
- **Git discipline**: Stage only specific files (\`git add src/foo.ts\`). NEVER \`git add -A\`. Commit to branch **${branch}** only. Never checkout main.
- **Deploy**: TEST only. See your mission.md for project-specific deploy commands.
- **Verify before completing**: Tests pass + TypeScript clean + deploy succeeds + endpoint/UI verified.
- **Report everything to chief-of-staff via MCP**: On any bug, error, test failure, completed task, or finding worth noting — use \`send_message(to="chief-of-staff", content="...", summary="...")\`. Never append to inbox.jsonl directly. Never silently move on.
- **Send results back**: When your mission produces output (analysis, compiled data, recommendations) — send it to chief-of-staff via \`send_message\`.

## If You Run Continuously (Perpetual Mode)

Each cycle: **Observe → Decide → Act → Measure → Adapt** — you're an LLM, not a cron job. Adapt.

- **Save learnings**: Edit your MEMORY.md (auto-loaded path — see "persistent auto memory directory" in your context). Claude picks it up next session automatically.
- **Scripts first**: Check \`.claude/scripts/${WORKER_NAME}/\` before writing inline bash. If you do something twice, save it as a script there. Scripts persist across recycles; one-off bash commands don't.
- **Adapt sleep**: Call \`update_state("sleep_duration", N)\` to tune your cycle interval.
- **Discover new work**: Read server logs, other workers' MEMORY.md, Nexus for issues in your domain.
- **Eliminate waste**: Skip checks that never change; cache expensive lookups.`;
  if (handoff) {
    seed += `

## Handoff from Previous Cycle

${handoff}`;
  }
  const handoffPath = join(WORKERS_DIR, WORKER_NAME, "handoff.md");
  if (!handoff && existsSync(handoffPath)) {
    try {
      const handoffContent = readFileSync(handoffPath, "utf-8").trim();
      if (handoffContent) {
        seed += `

## Handoff from Previous Cycle

${handoffContent}`;
      }
    } catch {}
  }
  return seed;
}
function runDiagnostics() {
  const issues = [];
  if (WORKER_NAME === "operator") {
    issues.push({ severity: "warning", check: "env.WORKER_NAME", message: "Worker name defaulted to 'operator' — not on a worker/* branch and WORKER_NAME not set", fix: "Set WORKER_NAME env or checkout a worker/* branch" });
  }
  const workerDir = join(WORKERS_DIR, WORKER_NAME);
  if (!existsSync(workerDir)) {
    issues.push({ severity: "error", check: "worker_dir", message: `Worker dir missing: ${workerDir}`, fix: `mkdir -p ${workerDir}` });
  } else {
    const missionPath = join(workerDir, "mission.md");
    if (!existsSync(missionPath)) {
      issues.push({ severity: "error", check: "mission.md", message: "mission.md missing — worker has no goals", fix: `Create ${missionPath} with task list and goals` });
    } else {
      try {
        const content = readFileSync(missionPath, "utf-8").trim();
        if (content.length < 10)
          issues.push({ severity: "warning", check: "mission.md", message: "mission.md is nearly empty", fix: "Add goals and tasks to mission.md" });
      } catch {}
    }
    const regEntry = getWorkerEntry(WORKER_NAME);
    if (!regEntry) {
      issues.push({ severity: "error", check: "registry_entry", message: `Worker '${WORKER_NAME}' not in registry.json`, fix: "Run migration or call create_worker to bootstrap entry, then heartbeat() to register" });
    } else {
      if (typeof regEntry.cycles_completed !== "number") {
        issues.push({ severity: "warning", check: "registry.cycles_completed", message: "registry entry missing 'cycles_completed' field", fix: `update_state("cycles_completed", 0)` });
      }
      if (!regEntry.status) {
        issues.push({ severity: "warning", check: "registry.status", message: "registry entry missing 'status' field", fix: `update_state("status", "idle")` });
      }
      if (!regEntry.model) {
        issues.push({ severity: "warning", check: "registry.model", message: "registry entry missing 'model' field — defaulting to opus", fix: `update_state("model", "opus")` });
      }
    }
    const tasksPath = join(workerDir, "tasks.json");
    if (existsSync(tasksPath)) {
      const tasks = readJsonFile(tasksPath);
      if (!tasks) {
        issues.push({ severity: "error", check: "tasks.json", message: "tasks.json is invalid JSON", fix: `Fix or delete ${tasksPath} (will be recreated on create_task)` });
      }
    }
    const inboxPath = join(workerDir, "inbox.jsonl");
    if (existsSync(inboxPath)) {
      try {
        const content = readFileSync(inboxPath, "utf-8");
        const lines = content.trim().split(`
`).filter(Boolean);
        if (lines.length > 0) {
          const lastLine = lines[lines.length - 1];
          try {
            JSON.parse(lastLine);
          } catch {
            issues.push({ severity: "warning", check: "inbox.jsonl", message: "inbox.jsonl has corrupt last line — may cause read errors", fix: `read_inbox(clear=true) to reset, or manually fix ${inboxPath}` });
          }
        }
      } catch {}
    }
  }
  if (_cachedBranch && WORKER_NAME !== "operator") {
    const expectedBranch = `worker/${WORKER_NAME}`;
    if (_cachedBranch !== expectedBranch) {
      issues.push({ severity: "warning", check: "git.branch", message: `On branch '${_cachedBranch}' but expected '${expectedBranch}'`, fix: `git checkout ${expectedBranch}` });
    }
  }
  if (WORKER_NAME !== "operator") {
    const worktreeDir = getWorktreeDir();
    if (!existsSync(worktreeDir)) {
      issues.push({ severity: "warning", check: "worktree", message: `Worktree dir not found: ${worktreeDir}`, fix: `git -C ${PROJECT_ROOT} worktree add ${worktreeDir} -b worker/${WORKER_NAME}` });
    }
  }
  if (process.env.TMUX_PANE) {
    const entry = getWorkerEntry(WORKER_NAME);
    if (!entry) {
      issues.push({ severity: "error", check: "registry", message: `Worker '${WORKER_NAME}' not in registry.json — watchdog cannot monitor you. Call heartbeat() BEFORE doing anything else.`, fix: "Call heartbeat() immediately" });
    } else if (entry.pane_id !== process.env.TMUX_PANE) {
      issues.push({ severity: "error", check: "registry.pane_id", message: `Pane ${process.env.TMUX_PANE} not registered for '${WORKER_NAME}' in registry.json. Call heartbeat() to fix.`, fix: "Call heartbeat() immediately" });
    }
  } else {
    issues.push({ severity: "error", check: "env.TMUX_PANE", message: "TMUX_PANE not set — you are not registered with the fleet. Messaging, watchdog monitoring, and recycle will NOT work.", fix: "Launch via launch-flat-worker.sh or call heartbeat()" });
  }
  try {
    const registry = readRegistry();
    const lintIssues = lintRegistry(registry);
    issues.push(...lintIssues);
  } catch {}
  const requiredScripts = [
    [CHECK_WORKERS_SH, "fleet_status"]
  ];
  for (const [scriptPath, toolName] of requiredScripts) {
    if (!existsSync(scriptPath)) {
      issues.push({ severity: "warning", check: `script.${toolName}`, message: `Script missing for ${toolName}: ${scriptPath}`, fix: `Ensure file exists at ${scriptPath}` });
    }
  }
  try {
    const worktreeDir = getWorktreeDir();
    let gitDir;
    try {
      gitDir = execSync(`git -C "${worktreeDir}" rev-parse --git-dir 2>/dev/null`, { encoding: "utf-8", timeout: 5000, shell: "/bin/bash" }).trim();
      if (!gitDir.startsWith("/"))
        gitDir = join(worktreeDir, gitDir);
    } catch {
      gitDir = join(worktreeDir, ".git");
    }
    const hooksDir = join(gitDir, "hooks");
    const requiredHooks = [
      ["post-commit", "Auto-notify merger/chief-of-staff on commit"],
      ["commit-msg", "Auto-add Worker:/Cycle: trailers to commit messages"]
    ];
    for (const [hookName, desc] of requiredHooks) {
      const hookPath = join(hooksDir, hookName);
      if (!existsSync(hookPath)) {
        issues.push({ severity: "warning", check: `git.hook.${hookName}`, message: `Git ${hookName} hook not installed — ${desc}`, fix: `Relaunch with launch-flat-worker.sh to install hooks, or manually copy from ~/.claude-ops/scripts/worker-${hookName.replace("-", "-")}-hook.sh` });
      } else {
        try {
          const stat = statSync(hookPath);
          if (!(stat.mode & 73)) {
            issues.push({ severity: "warning", check: `git.hook.${hookName}`, message: `Git ${hookName} hook exists but is not executable`, fix: `chmod +x ${hookPath}` });
          }
        } catch {}
      }
    }
  } catch {}
  return issues;
}
let _diagCache = null;
const DIAG_CACHE_TTL_MS = 1e4;
let _firstCallDone = false;
function getCachedDiagnostics() {
  if (_diagCache && Date.now() - _diagCache.ts < DIAG_CACHE_TTL_MS)
    return _diagCache.issues;
  const issues = runDiagnostics();
  _diagCache = { issues, ts: Date.now() };
  return issues;
}
function withStartupDiagnostics(result) {
  if (_firstCallDone)
    return result;
  _firstCallDone = true;
  const issues = getCachedDiagnostics();
  const errors = issues.filter((i) => i.severity === "error");
  if (errors.length === 0)
    return result;
  const prefix = `⚠ Config errors detected (run check_config for full report):
` + errors.map((i) => `  ✘ [${i.check}] ${i.message}${i.fix ? ` → ${i.fix}` : ""}`).join(`
`) + `

`;
  return {
    content: [{ type: "text", text: prefix + result.content[0].text }]
  };
}
function withPendingReminder(result) {
  const cursor = readInboxCursor(WORKER_NAME);
  const pending = cursor?.pending_replies || [];
  if (pending.length === 0)
    return result;
  const suffix = `

⚠ ${pending.length} PENDING REPLY(S):
` + pending.map((p) => {
    const typeTag = p.reply_type ? `[${p.reply_type}] ` : "";
    return `  ${typeTag}${p.msg_id} from ${p.from_name}: "${p.summary}"`;
  }).join(`
`) + `
Reply: send_message(to=<sender>, in_reply_to="<msg_id>", content="...", summary="...")`;
  return {
    content: [{ type: "text", text: result.content[0].text + suffix }]
  };
}
const server = new McpServer({
  name: "worker-fleet",
  version: "2.0.0"
});
server.registerTool("send_message", { description: `Primary inter-worker communication. Messages require a reply by default — the recipient is reminded at recycle/standby if they haven't replied. Use fyi=true for informational messages that don't need a response. Use in_reply_to with a msg_id to acknowledge a message you received. Writes to the recipient's durable inbox (survives restarts) and delivers instantly via tmux if the pane is live. Use to="all" to broadcast fleet-wide (expensive — use sparingly). Use to="report" to message who you report_to. Use to="direct_reports" to message all workers who report_to you.`, inputSchema: {
  to: z.string().describe("Worker name, 'report', 'direct_reports', 'all' (broadcast to every worker), or raw pane ID '%NN'"),
  content: z.string().describe("Message content"),
  summary: z.string().describe("Short preview (5-10 words)"),
  fyi: z.boolean().optional().describe("If true, no reply expected — informational only (default: false = reply expected)"),
  in_reply_to: z.string().optional().describe("msg_id of a message you're replying to — marks it as acknowledged"),
  reply_type: z.string().optional().describe("What kind of reply is expected: 'ack' (simple acknowledgment), 'e2e_verify' (verify on main test and confirm), 'review' (review and provide feedback). Stored in message and shown in pending replies.")
} }, async ({ to, content, summary, fyi, in_reply_to, reply_type }) => {
  if (to === "all") {
    const broadcastFyi = fyi !== false;
    const failures = [];
    const successes = [];
    try {
      const dirs = readdirSync(WORKERS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_")).map((d) => d.name).filter((name) => name !== WORKER_NAME);
      for (const name of dirs) {
        const result = writeToInbox(name, { content, summary, from_name: WORKER_NAME, ack_required: !broadcastFyi, reply_type });
        if (result.ok)
          successes.push(name);
        else
          failures.push(`${name}: ${result.error}`);
      }
    } catch (e) {
      return { content: [{ type: "text", text: `Error listing workers: ${e.message}` }], isError: true };
    }
    try {
      const args = ["broadcast", content];
      if (summary)
        args.push("--summary", summary);
      runScript(WORKER_MESSAGE_SH, args, { timeout: 1e4 });
    } catch {}
    let msg = `Broadcast to ${successes.length} workers`;
    if (failures.length > 0)
      msg += `
Failed: ${failures.join(", ")}`;
    return { content: [{ type: "text", text: msg }] };
  }
  const resolved = resolveRecipient(to);
  if (resolved.error) {
    return { content: [{ type: "text", text: `Error: ${resolved.error}` }], isError: true };
  }
  if (resolved.type === "multi_pane") {
    const paneIds = resolved.paneIds;
    const successes = [];
    const failures = [];
    const dead = [];
    for (const pId of paneIds) {
      if (!isPaneAlive(pId)) {
        dead.push(pId);
        continue;
      }
      try {
        tmuxSendMessage(pId, `[msg from ${WORKER_NAME}] ${content}`);
        successes.push(pId);
      } catch {
        failures.push(pId);
      }
    }
    let result = successes.length > 0 ? `Sent to ${successes.length} direct reports: ${successes.join(", ")}` : "No live direct reports to deliver to";
    if (dead.length > 0)
      result += `
Dead panes (skipped): ${dead.join(", ")}`;
    if (failures.length > 0)
      result += `
Failed: ${failures.join(", ")}`;
    return { content: [{ type: "text", text: result }], isError: successes.length === 0 };
  }
  if (resolved.type === "pane") {
    if (!isPaneAlive(resolved.paneId)) {
      return { content: [{ type: "text", text: `Error: Pane ${resolved.paneId} is dead (not found in tmux)` }], isError: true };
    }
    try {
      tmuxSendMessage(resolved.paneId, `[msg from ${WORKER_NAME}] ${content}`);
      const label = to === "report" ? `report (pane ${resolved.paneId})` : `pane ${resolved.paneId}`;
      return { content: [{ type: "text", text: `Sent to ${label} (tmux-only, no inbox)` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error sending to pane: ${e.message}` }], isError: true };
    }
  }
  const recipientName = resolved.workerName;
  let paneWarning = "";
  try {
    const registry = readRegistry();
    const entry = registry[recipientName];
    const paneId = entry?.pane_id;
    if (!paneId || !isPaneAlive(paneId)) {
      paneWarning = `
WARNING: Worker '${recipientName}' has no active pane — message queued in inbox but won't be received until the worker is restarted.`;
    }
  } catch {}
  const inboxResult = writeToInbox(recipientName, {
    content,
    summary,
    from_name: WORKER_NAME,
    ack_required: !fyi,
    in_reply_to,
    reply_type
  });
  if (!inboxResult.ok) {
    return { content: [{ type: "text", text: `Error: ${inboxResult.error}` }], isError: true };
  }
  if (in_reply_to) {
    removePendingReply(WORKER_NAME, in_reply_to);
  }
  try {
    const registry = readRegistry();
    const entry = registry[recipientName];
    const paneId = entry?.pane_id;
    if (paneId && isPaneAlive(paneId)) {
      tmuxSendMessage(paneId, `[msg from ${WORKER_NAME}] ${content}`);
    } else {
      const args = ["send", recipientName, content];
      if (summary)
        args.push("--summary", summary);
      runScript(WORKER_MESSAGE_SH, args, { timeout: 1e4 });
    }
  } catch {}
  const ackNote = fyi ? " (fyi, no reply needed)" : "";
  const replyNote = in_reply_to ? ` (acked ${in_reply_to})` : "";
  const typeNote = reply_type ? ` (reply_type: ${reply_type})` : "";
  return withPendingReminder({ content: [{ type: "text", text: `Message sent to ${recipientName} [${inboxResult.msg_id}]${ackNote}${replyNote}${typeNote}${paneWarning}` }] });
});
server.registerTool("read_inbox", { description: "Read messages sent to you by other workers or Warren. Call at the start of every cycle to act on pending instructions before checking tasks. Uses a cursor so repeated calls only return new messages — no data loss on restart. Use clear=true only if you want to explicitly purge old messages.", inputSchema: {
  limit: z.number().optional().describe("Max messages to return (default: all)"),
  since: z.string().optional().describe("ISO timestamp — only messages after this time"),
  clear: z.boolean().optional().describe("If true, clear inbox after reading (replaces clear_inbox)")
} }, async ({ limit, since, clear }) => {
  try {
    const { messages } = readInboxFromCursor(WORKER_NAME, { limit, since, clear });
    if (messages.length === 0) {
      return withStartupDiagnostics({ content: [{ type: "text", text: clear ? "Inbox cleared (was empty)" : "No new messages" }] });
    }
    const formatted = messages.map((m) => {
      const from = m.from_name || m.from || "?";
      const type = m.msg_type || "message";
      const text = m.content || m.message || "";
      const ts = m._ts || m.ts || "";
      const id = m.msg_id ? ` [${m.msg_id}]` : "";
      const ackTag = m.ack_required === true ? " [NEEDS REPLY]" : "";
      const replyTag = m.in_reply_to ? ` (reply to ${m.in_reply_to})` : "";
      return `[${type}]${id} from ${from}${ts ? ` at ${ts}` : ""}${ackTag}${replyTag}: ${text}`;
    }).join(`
`);
    const cursor = readInboxCursor(WORKER_NAME);
    const pending = cursor?.pending_replies || [];
    let pendingSuffix = "";
    if (pending.length > 0) {
      pendingSuffix = `

--- ${pending.length} PENDING REPLIES ---
` + pending.map((p) => {
        const typeTag = p.reply_type ? `[${p.reply_type}] ` : "";
        return `  ${typeTag}${p.msg_id} from ${p.from_name}: "${p.summary}" (${p._ts})`;
      }).join(`
`) + `
Reply with: send_message(to=<sender>, in_reply_to="<msg_id>", content="...", summary="...")`;
    }
    const suffix = clear ? " (inbox cleared)" : "";
    return withStartupDiagnostics({ content: [{ type: "text", text: `${messages.length} messages${suffix}:
${formatted}${pendingSuffix}` }] });
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
  }
});
server.registerTool("create_task", { description: "Track a unit of work you've identified. Use whenever you discover a bug, feature, or investigation that needs doing — even mid-cycle. Tasks survive recycles, can block each other, and give the team visibility into your queue. Prefer creating tasks over holding work in context.", inputSchema: {
  subject: z.string().describe("Task title (imperative form)"),
  description: z.string().optional().describe("Detailed description"),
  priority: z.enum(["critical", "high", "medium", "low"]).optional().describe("Priority level (default: medium)"),
  active_form: z.string().optional().describe("Present continuous label for spinner (e.g. 'Running tests')"),
  blocks: z.string().optional().describe("Comma-separated task IDs that this task blocks (e.g. 'T003,T004')"),
  blocked_by: z.string().optional().describe("Comma-separated task IDs that block this (e.g. 'T001,T002')"),
  recurring: z.boolean().optional().describe("If true, resets to pending when completed")
} }, async ({ subject, description, priority, active_form, blocks, blocked_by, recurring }) => {
  try {
    const tasks = readTasks(WORKER_NAME);
    const taskId = nextTaskId(tasks);
    const now = new Date().toISOString();
    const blockedByList = blocked_by ? blocked_by.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const task = {
      subject,
      description: description || "",
      activeForm: active_form || `Working on: ${subject}`,
      status: "pending",
      priority: priority || "medium",
      recurring: recurring || false,
      blocked_by: blockedByList,
      metadata: {},
      cycles_completed: 0,
      owner: null,
      created_at: now,
      completed_at: null
    };
    tasks[taskId] = task;
    if (blocks) {
      const blocksList = blocks.split(",").map((s) => s.trim()).filter(Boolean);
      for (const targetId of blocksList) {
        if (tasks[targetId]) {
          const existing = tasks[targetId].blocked_by || [];
          if (!existing.includes(taskId)) {
            tasks[targetId].blocked_by = [...existing, taskId];
          }
        }
      }
    }
    writeTasks(WORKER_NAME, tasks);
    let suffix = ` [${task.priority}]`;
    if (recurring)
      suffix += " (recurring)";
    if (blockedByList.length > 0)
      suffix += ` (after: ${blockedByList.join(",")})`;
    if (blocks)
      suffix += ` (blocks: ${blocks})`;
    return withPendingReminder({ content: [{ type: "text", text: `Added ${taskId}: ${subject}${suffix}` }] });
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
  }
});
server.registerTool("update_task", { description: "Advance a task through its lifecycle or reassign it. Claim work with status='in_progress' before starting (prevents double-work across workers). Mark 'completed' only after fully verified. Use 'deleted' to discard irrelevant tasks. Set add_blocked_by to express dependencies that gate execution.", inputSchema: {
  task_id: z.string().describe("Task ID (e.g. 'T001')"),
  status: z.enum(["pending", "in_progress", "completed", "deleted"]).optional().describe("New status"),
  subject: z.string().optional().describe("New subject"),
  description: z.string().optional().describe("New description"),
  active_form: z.string().optional().describe("Present continuous label for spinner"),
  priority: z.enum(["critical", "high", "medium", "low"]).optional().describe("New priority"),
  owner: z.string().optional().describe("New owner (worker name)"),
  add_blocked_by: z.string().optional().describe("Comma-separated task IDs to add as blockers"),
  add_blocks: z.string().optional().describe("Comma-separated task IDs this task should block")
} }, async ({ task_id, status, subject, description, active_form, priority, owner, add_blocked_by, add_blocks }) => {
  try {
    const tasks = readTasks(WORKER_NAME);
    const task = tasks[task_id];
    if (!task) {
      return { content: [{ type: "text", text: `Error: Task ${task_id} not found` }], isError: true };
    }
    const changes = [];
    const now = new Date().toISOString();
    if (status) {
      if (status === "in_progress") {
        if (task.status === "completed") {
          return { content: [{ type: "text", text: `Error: Task ${task_id} already completed` }], isError: true };
        }
        if (task.status === "deleted") {
          return { content: [{ type: "text", text: `Error: Task ${task_id} has been deleted` }], isError: true };
        }
        if (isTaskBlocked(tasks, task_id)) {
          const blockers = (task.blocked_by || []).filter((d) => tasks[d]?.status !== "completed");
          return { content: [{ type: "text", text: `Error: Task ${task_id} blocked by: ${blockers.join(", ")}` }], isError: true };
        }
        task.status = "in_progress";
        task.owner = owner || WORKER_NAME;
        changes.push("claimed");
      } else if (status === "completed") {
        if (task.recurring) {
          task.status = "pending";
          task.owner = null;
          task.completed_at = null;
          task.last_completed_at = now;
          task.cycles_completed = (task.cycles_completed || 0) + 1;
          changes.push(`completed (recurring — reset to pending, cycle #${task.cycles_completed})`);
        } else {
          task.status = "completed";
          task.completed_at = now;
          changes.push("completed");
        }
      } else if (status === "deleted") {
        task.status = "deleted";
        task.deleted_at = now;
        changes.push("deleted");
      } else if (status === "pending") {
        task.status = "pending";
        changes.push("set to pending");
      }
    }
    if (subject) {
      task.subject = subject;
      changes.push("subject updated");
    }
    if (description !== undefined) {
      task.description = description;
      changes.push("description updated");
    }
    if (active_form) {
      task.activeForm = active_form;
      changes.push("activeForm updated");
    }
    if (priority) {
      task.priority = priority;
      changes.push(`priority → ${priority}`);
    }
    if (owner && !status) {
      task.owner = owner;
      changes.push(`owner → ${owner}`);
    }
    if (add_blocked_by) {
      const ids = add_blocked_by.split(",").map((s) => s.trim()).filter(Boolean);
      task.blocked_by = [...new Set([...task.blocked_by || [], ...ids])];
      changes.push(`blocked by: ${ids.join(",")}`);
    }
    if (add_blocks) {
      const ids = add_blocks.split(",").map((s) => s.trim()).filter(Boolean);
      for (const targetId of ids) {
        if (tasks[targetId]) {
          const existing = tasks[targetId].blocked_by || [];
          if (!existing.includes(task_id)) {
            tasks[targetId].blocked_by = [...existing, task_id];
          }
        }
      }
      changes.push(`blocks: ${ids.join(",")}`);
    }
    if (changes.length === 0) {
      return { content: [{ type: "text", text: `No changes specified for ${task_id}` }] };
    }
    writeTasks(WORKER_NAME, tasks);
    return withPendingReminder({ content: [{ type: "text", text: `Updated ${task_id}: ${changes.join(", ")}` }] });
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
  }
});
server.registerTool("list_tasks", { description: "Survey available work before starting a cycle. Use filter='pending' to find unblocked tasks ready to claim. Use worker='all' to see the full fleet's queue and avoid duplicating work another worker is already doing.", inputSchema: {
  filter: z.enum(["all", "pending", "in_progress", "blocked"]).optional().describe("Filter by status (default: all non-deleted)"),
  worker: z.string().optional().describe("Specific worker name, or 'all' for cross-worker view (default: self)")
} }, async ({ filter, worker }) => {
  try {
    const targetWorkers = [];
    const workerName = worker || WORKER_NAME;
    if (workerName === "all") {
      const dirs = readdirSync(WORKERS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_")).map((d) => d.name);
      targetWorkers.push(...dirs);
    } else {
      targetWorkers.push(workerName);
    }
    const results = [];
    let totalCount = 0;
    for (const w of targetWorkers) {
      const tasks = readTasks(w);
      if (Object.keys(tasks).length === 0)
        continue;
      const entries = Object.entries(tasks);
      const filtered = entries.filter(([taskId, t]) => {
        if (t.status === "deleted")
          return false;
        const blocked = isTaskBlocked(tasks, taskId);
        if (filter === "pending")
          return t.status === "pending" && !blocked;
        if (filter === "in_progress")
          return t.status === "in_progress";
        if (filter === "blocked")
          return blocked && t.status !== "completed";
        return true;
      });
      if (filtered.length === 0)
        continue;
      results.push(`## ${w}`);
      for (const [id, t] of filtered) {
        const blocked = isTaskBlocked(tasks, id);
        const status = blocked ? "blocked" : t.status;
        const deps = (t.blocked_by || []).length > 0 ? ` [after:${t.blocked_by.join(",")}]` : "";
        const rec = t.recurring ? " (recurring)" : "";
        results.push(`  ${id} [${t.priority || "medium"}] ${status}: ${t.subject}${deps}${rec}`);
        totalCount++;
      }
    }
    if (results.length === 0) {
      return { content: [{ type: "text", text: "No tasks found" }] };
    }
    return withPendingReminder({ content: [{ type: "text", text: `${totalCount} tasks:
${results.join(`
`)}` }] });
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
  }
});
server.registerTool("get_worker_state", { description: "Read persisted state for any worker — cycles completed, sleep duration, last commit, custom metrics. Call at startup to resume where you left off. Omit name to read your own state.", inputSchema: {
  name: z.string().optional().describe("Worker name (default: self)")
} }, async ({ name }) => {
  try {
    const targetName = name || WORKER_NAME;
    const entry = getWorkerEntry(targetName);
    if (!entry) {
      return { content: [{ type: "text", text: `No state for worker '${targetName}'` }], isError: true };
    }
    const state = {
      status: entry.status,
      cycles_completed: entry.cycles_completed,
      perpetual: entry.perpetual,
      sleep_duration: entry.sleep_duration,
      last_cycle_at: entry.last_cycle_at,
      ...entry.custom
    };
    if (entry.last_commit_sha)
      state.last_commit_sha = entry.last_commit_sha;
    if (entry.last_commit_msg)
      state.last_commit_msg = entry.last_commit_msg;
    if (entry.last_commit_at)
      state.last_commit_at = entry.last_commit_at;
    if (entry.issues_found)
      state.issues_found = entry.issues_found;
    if (entry.issues_fixed)
      state.issues_fixed = entry.issues_fixed;
    return withPendingReminder({ content: [{ type: "text", text: JSON.stringify(state, null, 2) }] });
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
  }
});
server.registerTool("update_state", { description: "Persist state across recycles — cycle count, sleep duration, custom metrics. Call after every cycle to stamp cycles_completed and last_cycle_at. The watchdog reads last_cycle_at to detect stuck workers, so always update it. Pass `worker` to update another worker's state (requires authority: you must be their report_to or the mission_authority).", inputSchema: {
  key: z.string().describe("State key to update (e.g. 'status', 'cycles_completed'). Known keys go top-level; unknown keys go into custom."),
  value: z.union([z.string(), z.number(), z.boolean()]).describe("New value"),
  worker: z.string().optional().describe("Target worker name (default: self). Requires authority — caller must be target's report_to or mission_authority.")
} }, async ({ key, value, worker }) => {
  try {
    const targetName = worker || WORKER_NAME;
    let stateJson = "";
    withRegistryLocked((registry) => {
      if (targetName !== WORKER_NAME && !canUpdateWorker(WORKER_NAME, targetName, registry)) {
        throw new Error(`Not authorized to update '${targetName}' — you are not their report_to or the mission_authority`);
      }
      const entry = ensureWorkerInRegistry(registry, targetName);
      const STATE_KEYS = new Set([
        "status",
        "cycles_completed",
        "perpetual",
        "sleep_duration",
        "last_cycle_at",
        "last_commit_sha",
        "last_commit_msg",
        "last_commit_at",
        "issues_found",
        "issues_fixed",
        "report_to"
      ]);
      if (STATE_KEYS.has(key)) {
        entry[key] = value;
      } else {
        entry.custom[key] = value;
      }
      stateJson = JSON.stringify(entry, null, 2) + `
`;
    });
    try {
      const cacheDir = join(process.env.HOME || "/tmp", ".claude-ops/state/harness-runtime/worker", targetName);
      if (!existsSync(cacheDir))
        mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(cacheDir, "config-cache.json"), stateJson);
    } catch {}
    try {
      const payload = JSON.stringify({
        worker: targetName,
        key,
        value,
        channel: "worker-fleet-mcp",
        updated_by: WORKER_NAME
      });
      execSync(`source "${CLAUDE_OPS}/lib/event-bus.sh" && bus_publish "agent.state-changed" '${payload.replace(/'/g, "'\\''")}'`, { cwd: PROJECT_ROOT, timeout: 5000, encoding: "utf-8", shell: "/bin/bash" });
    } catch {}
    const prefix = targetName !== WORKER_NAME ? `${targetName}.` : "state.";
    return withPendingReminder({ content: [{ type: "text", text: `Updated ${prefix}${key} = ${JSON.stringify(value)}` }] });
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
  }
});
server.registerTool("fleet_status", { description: "Snapshot of every worker's health — pane alive, status, last cycle, recent commits. Use to understand the fleet before spawning workers, to check if a recipient worker is actually running before messaging, or to diagnose why something isn't responding." }, async () => {
  try {
    const registry = withRegistryLocked((reg) => {
      try {
        const dirs = readdirSync(WORKERS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_")).map((d) => d.name);
        for (const name of dirs) {
          ensureWorkerInRegistry(reg, name);
        }
      } catch {}
      for (const [key, entry] of Object.entries(reg)) {
        if (key === "_config" || typeof entry !== "object" || !entry)
          continue;
        const w = entry;
        if (w.pane_id && !isPaneAlive(w.pane_id)) {
          w.pane_id = null;
          w.pane_target = null;
          w.session_id = null;
        }
      }
      return { ...reg };
    });
    const projectName = basename(PROJECT_ROOT);
    let output = `=== Worker Fleet Status (${projectName}) ===
`;
    output += `${new Date().toISOString()}

`;
    const header = `${"Worker".padEnd(22)} ${"Status".padEnd(10)} ${"Cycles".padEnd(8)} ${"Last Cycle".padEnd(24)} ${"Active Task"}`;
    output += header + `
`;
    output += `${"------".padEnd(22)} ${"------".padEnd(10)} ${"------".padEnd(8)} ${"----------".padEnd(24)} ${"-----------"}
`;
    const workerEntries = Object.entries(registry).filter(([key]) => key !== "_config").sort(([a], [b]) => a.localeCompare(b));
    for (const [name, entry] of workerEntries) {
      const w = entry;
      let activeTask = "";
      try {
        const tasks = readTasks(name);
        const ip = Object.entries(tasks).find(([_, t]) => t.status === "in_progress");
        if (ip)
          activeTask = `${ip[0]}: ${ip[1].subject}`.slice(0, 40);
      } catch {}
      output += `${name.padEnd(22)} ${String(w.status || "unknown").padEnd(10)} ${String(w.cycles_completed || 0).padEnd(8)} ${String(w.last_cycle_at || "never").padEnd(24)} ${activeTask}
`;
    }
    output += `
=== Worker State ===
`;
    for (const [name, entry] of workerEntries) {
      const w = entry;
      if (w.custom && Object.keys(w.custom).length > 0) {
        const stateStr = Object.entries(w.custom).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join(", ");
        output += `  ${name}: ${stateStr}
`;
      }
    }
    output += `
=== Pane Check ===
`;
    for (const [name, entry] of workerEntries) {
      const w = entry;
      if (w.pane_id) {
        const alive = isPaneAlive(w.pane_id);
        output += `  ${name} (${w.pane_id} ${w.pane_target || "?"}) ${alive ? "⚡" : "❌ dead"}
`;
      } else {
        output += `  ${name}: NO PANE (dead or not started)
`;
      }
    }
    return withPendingReminder({ content: [{ type: "text", text: output }] });
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
  }
});
function _replaceMemorySection(existing, section, content) {
  const heading = `## ${section}`;
  const lines = existing.split(`
`);
  let sectionStart = -1;
  let sectionEnd = lines.length;
  for (let i = 0;i < lines.length; i++) {
    if (lines[i].trimEnd() === heading) {
      sectionStart = i;
      continue;
    }
    if (sectionStart !== -1 && i > sectionStart && lines[i].startsWith("## ")) {
      sectionEnd = i;
      break;
    }
  }
  const newBlock = [heading, content.trimEnd(), ""].join(`
`);
  if (sectionStart === -1) {
    return existing.trimEnd() + `

` + newBlock + `
`;
  }
  const before = lines.slice(0, sectionStart).join(`
`);
  const after = lines.slice(sectionEnd).join(`
`);
  return (before ? before + `
` : "") + newBlock + (after ? `
` + after : "");
}
server.registerTool("recycle", { description: "Restart yourself with a fresh context window in the same pane. Use when your context is getting full, at the end of a long cycle, or when you've completed your mission. Writes a handoff.md so the next instance knows what happened. Set final=true to exit without restarting (mission complete).", inputSchema: {
  message: z.string().optional().describe("Handoff message for the next instance (what's done, what's next, blockers)"),
  final: z.boolean().optional().describe("If true, this is the last cycle — exit cleanly without restarting. Use when work is complete.")
} }, async ({ message, final }) => {
  const ownPane = findOwnPane();
  if (!ownPane) {
    return { content: [{ type: "text", text: "Error: Could not find own pane in registry. Are you running in tmux?" }], isError: true };
  }
  const recycleCursor = readInboxCursor(WORKER_NAME);
  const pendingReplies = recycleCursor?.pending_replies || [];
  const pendingWarning = pendingReplies.length > 0 ? `

WARNING: ${pendingReplies.length} unreplied message(s):
` + pendingReplies.map((p) => {
    const typeTag = p.reply_type ? `[${p.reply_type}] ` : "";
    return `  - ${typeTag}[${p.msg_id}] from ${p.from_name}: "${p.summary}" (${p._ts})`;
  }).join(`
`) + `
Reply before recycling, or these will carry over to next cycle.` : "";
  const sessionId = getSessionId(ownPane.paneId);
  const worktreeDir = getWorktreeDir();
  const pathSlug = worktreeDir.replace(/\//g, "-").replace(/^-/, "-");
  const transcriptPath = sessionId ? join(HOME, ".claude/projects", pathSlug, `${sessionId}.jsonl`) : null;
  const handoffPath = join(WORKERS_DIR, WORKER_NAME, "handoff.md");
  if (message || transcriptPath) {
    try {
      let handoffContent = message || "";
      if (transcriptPath) {
        handoffContent += `

If you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: ${transcriptPath}`;
      }
      writeFileSync(handoffPath, handoffContent.trim() + `
`);
    } catch (e) {
      return { content: [{ type: "text", text: `Error writing handoff: ${e.message}` }], isError: true };
    }
  }
  try {
    const registry = readRegistry();
    const config = registry._config;
    const cycleReport = message ? `[${WORKER_NAME}] ${final ? "FINAL cycle" : "Cycle"} complete: ${message}` : `[${WORKER_NAME}] ${final ? "FINAL cycle" : "Cycle"} complete (no summary provided)`;
    const operatorName = config?.mission_authority || null;
    if (operatorName && operatorName !== WORKER_NAME) {
      writeToInbox(operatorName, { content: cycleReport, summary: `${WORKER_NAME} cycle done`, from_name: WORKER_NAME });
    }
  } catch {}
  if (final) {
    try {
      withRegistryLocked((registry) => {
        ensureWorkerInRegistry(registry, WORKER_NAME);
        const entry = registry[WORKER_NAME];
        entry.status = "done";
        entry.custom.completed_at = new Date().toISOString();
      });
    } catch {}
    try {
      const exitScript = `/tmp/final-exit-${WORKER_NAME}-${Date.now()}.sh`;
      writeFileSync(exitScript, `#!/bin/bash
sleep 5
tmux send-keys -t "${ownPane.paneId}" "/exit"
tmux send-keys -t "${ownPane.paneId}" -H 0d
rm -f "${exitScript}"
`);
      execSync(`nohup bash "${exitScript}" > /dev/null 2>&1 &`, {
        shell: "/bin/bash",
        timeout: 5000
      });
    } catch {}
    return {
      content: [{
        type: "text",
        text: `Final cycle. Shutting down.
` + `Handoff: ${message ? "written to handoff.md" : "none"}
` + `Parent/operator notified.
` + `Do NOT send any more tool calls — /exit will be sent shortly.` + pendingWarning
      }]
    };
  }
  const model = getWorkerModel();
  const workerDir = join(PROJECT_ROOT, ".claude/workers", WORKER_NAME);
  const seedHandoff = message || "";
  const seedTranscript = transcriptPath ? `

If you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: ${transcriptPath}` : "";
  const seedContent = generateSeedContent((seedHandoff + seedTranscript).trim() || undefined);
  const seedFile = `/tmp/worker-${WORKER_NAME}-seed.txt`;
  writeFileSync(seedFile, seedContent);
  const recycleScript = `/tmp/recycle-${WORKER_NAME}-${Date.now()}.sh`;
  const claudeCmd = `claude --model ${model} --dangerously-skip-permissions --add-dir ${workerDir}`;
  writeFileSync(recycleScript, `#!/bin/bash
# Auto-generated recycle script for ${WORKER_NAME}
set -uo pipefail
PANE_ID="${ownPane.paneId}"
PANE_TARGET="${ownPane.paneTarget}"
SEED_FILE="${seedFile}"

# Wait for MCP tool response to propagate to Claude TUI
sleep 5

# Send /exit to Claude (graceful — keeps pane alive with shell prompt)
tmux send-keys -t "$PANE_ID" "/exit"
tmux send-keys -t "$PANE_ID" -H 0d

# Wait for Claude to exit and shell prompt to return (max 30s)
WAIT=0
while [ "$WAIT" -lt 30 ]; do
  sleep 2; WAIT=$((WAIT+2))
  # Check if Claude is still running in this pane
  PANE_PID=$(tmux list-panes -a -F '#{pane_id} #{pane_pid}' 2>/dev/null | awk -v id="$PANE_ID" '$1 == id {print $2}')
  [ -z "$PANE_PID" ] && { echo "FATAL: pane $PANE_ID gone"; exit 1; }
  CLAUDE_RUNNING=false
  for pid in $(pgrep -P "$PANE_PID" 2>/dev/null); do
    cmd=$(ps -o command= -p "$pid" 2>/dev/null || true)
    [[ "$cmd" == *claude* ]] && CLAUDE_RUNNING=true && break
  done
  [ "$CLAUDE_RUNNING" = "false" ] && break
done

# Small delay for shell prompt to stabilize
sleep 2

# Change to worktree directory
tmux send-keys -t "$PANE_ID" "cd ${worktreeDir}"
tmux send-keys -t "$PANE_ID" -H 0d
sleep 1

# Launch Claude
tmux send-keys -t "$PANE_ID" "${claudeCmd}"
tmux send-keys -t "$PANE_ID" -H 0d

# Wait for TUI ready (poll for statusline, max 90s)
WAIT=0
until tmux capture-pane -t "$PANE_ID" -p 2>/dev/null | grep -qE "bypass permissions|Context left"; do
  sleep 3; WAIT=$((WAIT+3))
  [ "$WAIT" -ge 90 ] && break
done
sleep 3

# Inject seed using a named buffer (prevents race conditions when multiple workers recycle concurrently)
BUFFER_NAME="recycle-${WORKER_NAME}-$$"
tmux load-buffer -b "$BUFFER_NAME" "$SEED_FILE"
tmux paste-buffer -b "$BUFFER_NAME" -t "$PANE_ID" -d
sleep 2
tmux send-keys -t "$PANE_ID" -H 0d

# Cleanup
rm -f "${recycleScript}"
`);
  try {
    execSync(`nohup bash "${recycleScript}" > /tmp/recycle-${WORKER_NAME}.log 2>&1 &`, {
      shell: "/bin/bash",
      timeout: 5000
    });
  } catch (e) {
    return { content: [{ type: "text", text: `Error spawning recycle: ${e.message}` }], isError: true };
  }
  return {
    content: [{
      type: "text",
      text: `Recycling initiated. You will be restarted in ~10 seconds.
` + `Handoff: ${message ? "written to handoff.md" : "none"}
` + `Transcript: ${transcriptPath || "unknown"}
` + `Seed: ${seedFile}
` + `Do NOT send any more tool calls — /exit will be sent shortly.` + pendingWarning
    }]
  };
});
server.registerTool("heartbeat", {
  description: "Call at the start of every cycle. Auto-registers your pane in the fleet (so send_message and fleet_status can find you) and stamps your state — no separate register_pane or update_state needed. Pass cycles_completed to increment your counter. Any extra key/value goes into custom state.",
  inputSchema: {
    cycles_completed: z.number().optional().describe("Your current cycle count — pass N+1 at end of each cycle"),
    status: z.string().optional().describe("Worker status (default: 'active')"),
    extra: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe("Any additional custom state to persist (e.g. {pass_rate: 99, current_focus: 'fix-tests'})")
  }
}, async ({ cycles_completed, status, extra }) => {
  const tmuxPane = process.env.TMUX_PANE;
  let paneTarget = "";
  let tmuxSession = "";
  if (tmuxPane) {
    try {
      const raw = execSync(`tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index} #{session_name}' | awk -v id="${tmuxPane}" '$1 == id {print $2, $3}'`, { encoding: "utf-8", timeout: 5000 }).trim();
      const parts = raw.split(" ");
      paneTarget = parts[0] || "";
      tmuxSession = parts[1] || "";
    } catch {}
  }
  const now = new Date().toISOString();
  let registered = false;
  try {
    withRegistryLocked((registry) => {
      ensureWorkerInRegistry(registry, WORKER_NAME);
      const entry = registry[WORKER_NAME];
      if (tmuxPane && isPaneAlive(tmuxPane)) {
        if (entry.pane_id !== tmuxPane) {
          entry.pane_id = tmuxPane;
          entry.pane_target = paneTarget;
          entry.tmux_session = tmuxSession;
          registered = true;
        }
      }
      entry.status = status || "active";
      entry.last_cycle_at = now;
      if (cycles_completed !== undefined)
        entry.cycles_completed = cycles_completed;
      if (extra) {
        for (const [k, v] of Object.entries(extra))
          entry.custom[k] = v;
      }
    });
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
  }
  try {
    const payload = JSON.stringify({ worker: WORKER_NAME, key: "heartbeat", value: now, channel: "worker-fleet-mcp" });
    execSync(`source "${CLAUDE_OPS}/lib/event-bus.sh" && bus_publish "agent.state-changed" '${payload.replace(/'/g, "'\\''")}'`, { cwd: PROJECT_ROOT, timeout: 5000, encoding: "utf-8", shell: "/bin/bash" });
  } catch {}
  const blocking = [];
  const autoFixed = [];
  if (WORKER_NAME === "operator") {
    blocking.push("WORKER_NAME is 'operator' (env var not set at launch). Your registry entry will conflict with other workers. Notify chief-of-staff and ask to be re-launched via launch-flat-worker.sh with the correct worker name.");
  }
  if (!tmuxPane) {
    blocking.push("TMUX_PANE env var is not set — not running inside tmux. Watchdog cannot monitor you, send_message cannot reach you. You must be launched via launch-flat-worker.sh inside a tmux pane.");
  } else if (!isPaneAlive(tmuxPane)) {
    blocking.push(`TMUX_PANE=${tmuxPane} no longer exists in tmux. Your session is detached or the pane was killed. Re-launch via launch-flat-worker.sh.`);
  }
  try {
    const reg = readRegistry();
    const myEntry = reg[WORKER_NAME];
    if (!myEntry) {
      blocking.push(`Worker '${WORKER_NAME}' still missing from registry.json after heartbeat write — likely a file permission error on ${REGISTRY_PATH}. Check permissions and re-run heartbeat.`);
    } else {
      if (!myEntry.pane_id) {
        blocking.push(`No pane_id in registry for '${WORKER_NAME}' even after heartbeat. Watchdog and messaging cannot reach you. Check TMUX_PANE env var and registry write permissions.`);
      }
      if (!getReportTo(myEntry, reg._config)) {
        const config = reg._config;
        const auth = config?.mission_authority || "chief-of-staff";
        try {
          withRegistryLocked((r) => {
            const e = r[WORKER_NAME];
            if (e && !e.report_to)
              e.report_to = auth;
          });
          autoFixed.push(`report_to auto-set to '${auth}' (mission_authority)`);
        } catch {
          blocking.push(`No report_to set for '${WORKER_NAME}' and auto-fix failed. Run update_state("report_to", "${auth}") before continuing.`);
        }
      }
    }
  } catch {
    blocking.push(`Could not read registry.json to verify state — check file at ${REGISTRY_PATH}.`);
  }
  if (blocking.length > 0) {
    const msg = [
      `HEARTBEAT FAILED — ${blocking.length} issue(s) must be resolved before continuing:`,
      ...blocking.map((b, i) => `${i + 1}. ${b}`)
    ].join(`
`);
    return { content: [{ type: "text", text: msg }], isError: true };
  }
  const parts = [`Heartbeat OK: ${WORKER_NAME} at ${now}`];
  if (registered)
    parts.push(`pane registered: ${tmuxPane} (${paneTarget})`);
  if (cycles_completed !== undefined)
    parts.push(`cycles: ${cycles_completed}`);
  if (autoFixed.length > 0)
    parts.push(`auto-fixed: ${autoFixed.join(", ")}`);
  if (extra)
    parts.push(`custom: ${Object.keys(extra).join(", ")}`);
  try {
    const tasks = readTasks(WORKER_NAME);
    const hasInProgress = Object.values(tasks).some((t) => t.status === "in_progress");
    if (!hasInProgress) {
      const hasPending = Object.values(tasks).some((t) => t.status === "pending");
      if (hasPending) {
        parts.push(`
⚠️ No task marked in_progress. Use list_tasks() then update_task(status='in_progress') to claim your current work.`);
      } else {
        parts.push(`
⚠️ Task list is empty. Use create_task() to register your goals from mission.md, then update_task(status='in_progress') to claim work.`);
      }
    }
  } catch {}
  return withPendingReminder({ content: [{ type: "text", text: parts.join(" | ") }] });
});
server.registerTool("check_config", { description: "Diagnose why things aren't working. Checks your environment, registry entry, required files, git branch, and worktree. Returns specific issues with fix suggestions. Run when something feels wrong — missing messages, watchdog not picking you up, tools misbehaving." }, async () => {
  const issues = getCachedDiagnostics();
  if (issues.length === 0) {
    return { content: [{ type: "text", text: "All checks passed. Configuration looks good." }] };
  }
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  let output = `Found ${issues.length} issue(s): ${errors.length} error(s), ${warnings.length} warning(s)

`;
  if (errors.length > 0) {
    output += `ERRORS (must fix):
`;
    for (const e of errors) {
      output += `  ✘ [${e.check}] ${e.message}
`;
      if (e.fix)
        output += `    Fix: ${e.fix}
`;
    }
    output += `
`;
  }
  if (warnings.length > 0) {
    output += `WARNINGS:
`;
    for (const w of warnings) {
      output += `  ⚠ [${w.check}] ${w.message}
`;
      if (w.fix)
        output += `    Fix: ${w.fix}
`;
    }
  }
  return {
    content: [{ type: "text", text: output }],
    isError: errors.length > 0
  };
});
function createWorkerFiles(input) {
  const { name, mission, model, perpetual, sleep_duration, disallowed_tools, window: windowGroup, assigned_by, permission_mode, taskEntries = [] } = input;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    return { ok: false, error: `Name must be kebab-case (got '${name}')` };
  }
  const workerDir = join(WORKERS_DIR, name);
  if (existsSync(workerDir)) {
    return { ok: false, error: `Worker '${name}' already exists at ${workerDir}` };
  }
  if (!mission.trim()) {
    return { ok: false, error: `Mission cannot be empty` };
  }
  mkdirSync(workerDir, { recursive: true });
  const worktreePath = `${PROJECT_ROOT}-w-${name}`;
  const slug = worktreePath.replace(/\//g, "-");
  const autoMemoryDir = join(HOME, ".claude", "projects", slug, "memory");
  mkdirSync(autoMemoryDir, { recursive: true });
  const autoMemoryPath = join(autoMemoryDir, "MEMORY.md");
  try {
    if (lstatSync(autoMemoryPath).isSymbolicLink()) {
      rmSync(autoMemoryPath);
    }
  } catch {}
  if (!existsSync(autoMemoryPath)) {
    writeFileSync(autoMemoryPath, `# ${name} Memory

`);
  }
  writeFileSync(join(workerDir, "mission.md"), mission.trim() + `
`);
  const selectedModel = model || "opus";
  const defaultDisallowed = [
    "Bash(git checkout main*)",
    "Bash(git merge*)",
    "Bash(git push*)",
    "Bash(git reset --hard*)",
    "Bash(git clean*)",
    "Bash(rm -rf*)"
  ];
  const permissions = {
    model: selectedModel,
    permission_mode: permission_mode || "bypassPermissions",
    disallowedTools: disallowed_tools ?? defaultDisallowed,
    window: windowGroup || null,
    assigned_by: assigned_by || null
  };
  const isPerpetual = perpetual || false;
  const state = {
    status: "idle",
    cycles_completed: 0,
    perpetual: isPerpetual
  };
  if (isPerpetual) {
    state.sleep_duration = sleep_duration || 1800;
  }
  const tasksObj = {};
  const now = new Date().toISOString();
  const taskIds = [];
  for (const entry of taskEntries) {
    const taskId = nextTaskId(tasksObj);
    taskIds.push(taskId);
    tasksObj[taskId] = {
      subject: entry.subject,
      description: entry.description || "",
      activeForm: `Working on: ${entry.subject}`,
      status: "pending",
      priority: entry.priority || "medium",
      recurring: false,
      blocked_by: [],
      metadata: {},
      cycles_completed: 0,
      owner: null,
      created_at: now,
      completed_at: null
    };
  }
  writeFileSync(join(workerDir, "tasks.json"), JSON.stringify(tasksObj, null, 2) + `
`);
  return { ok: true, workerDir, model: selectedModel, perpetual: isPerpetual, taskIds, tasks: tasksObj, state, permissions };
}
server.registerTool("create_worker", { description: "Spin up a new persistent worker with its own mission, memory, and task list. Use when you've identified a domain of work that warrants a dedicated agent — ongoing monitoring, specialized repair, continuous optimization. Set launch=true to start it immediately. Set fork_from_session=true to fork your current conversation context (inherits what you know). Set placement to control where the pane appears.", inputSchema: {
  name: z.string().describe("Worker name in kebab-case (e.g. 'chatbot-fix')"),
  mission: z.string().describe("Full mission.md content (markdown)"),
  model: z.enum(["sonnet", "opus", "haiku"]).optional().describe("LLM model (default: opus)"),
  perpetual: z.boolean().optional().describe("Run in perpetual loop (default: false)"),
  sleep_duration: z.number().optional().describe("Seconds between cycles, only if perpetual (default: 1800)"),
  disallowed_tools: z.string().optional().describe('JSON array of disallowed tool patterns (default: safe git/rm guards). Example: ["Bash(git push*)","Edit","Bash(*deploy*)"]'),
  window: z.string().optional().describe("tmux window group name (e.g. 'optimizers', 'monitors'). Workers in the same group share a tiled layout."),
  assigned_by: z.string().optional().describe("Who assigned this worker (default: calling worker)"),
  permission_mode: z.string().optional().describe("Claude permission mode (default: bypassPermissions)"),
  launch: z.boolean().optional().describe("Auto-launch in tmux after creation (default: false)"),
  tasks: z.string().optional().describe("JSON array of tasks: [{subject, description?, priority?}]"),
  fork_from_session: z.boolean().optional().describe("Fork the caller's Claude session so the new worker inherits conversation context (default: false). Requires launch=true."),
  direct_report: z.boolean().optional().describe("Set report_to to the calling worker instead of mission_authority (default: false)"),
  placement: z.enum(["window", "beside", "new-window"]).optional().describe("Where to place the pane: 'window' (join named window group, default), 'beside' (split next to caller), 'new-window' (fresh named window)")
} }, async ({ name, mission, model, perpetual, sleep_duration, disallowed_tools: disallowedToolsJson, window: windowGroup, assigned_by, permission_mode, launch, tasks: tasksJson, fork_from_session, direct_report, placement }) => {
  try {
    let createPane = function(pl, cwd) {
      const ownPane = findOwnPane();
      const tmuxSession = ownPane?.paneTarget?.split(":")[0] || "w";
      if (pl === "beside") {
        if (!ownPane)
          return null;
        return execSync(`tmux split-window -h -t "${ownPane.paneTarget}" -d -P -F '#{pane_id}' -c "${cwd}"`, { encoding: "utf-8", timeout: 5000 }).trim();
      }
      if (pl === "new-window") {
        return execSync(`tmux new-window -t "${tmuxSession}" -n "${name}" -d -P -F '#{pane_id}' -c "${cwd}"`, { encoding: "utf-8", timeout: 5000 }).trim();
      }
      const winName = windowGroup || "workers";
      const winCheck = spawnSync("tmux", ["list-windows", "-t", tmuxSession, "-F", "#{window_name}"], { encoding: "utf-8" });
      const windows = (winCheck.stdout || "").split(`
`).map((w) => w.trim());
      if (!windows.includes(winName)) {
        return execSync(`tmux new-window -t "${tmuxSession}" -n "${winName}" -d -P -F '#{pane_id}' -c "${cwd}"`, { encoding: "utf-8", timeout: 5000 }).trim();
      }
      const paneId = execSync(`tmux split-window -t "${tmuxSession}:${winName}" -d -P -F '#{pane_id}' -c "${cwd}"`, { encoding: "utf-8", timeout: 5000 }).trim();
      spawnSync("tmux", ["select-layout", "-t", `${tmuxSession}:${winName}`, "tiled"], { encoding: "utf-8" });
      return paneId;
    }, registerPane = function(paneId) {
      let paneTarget = "";
      try {
        paneTarget = execSync(`tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' | awk -v id="${paneId}" '$1 == id {print $2}'`, { encoding: "utf-8", timeout: 5000 }).trim();
      } catch {}
      withRegistryLocked((registry) => {
        const entry = registry[name];
        if (entry) {
          entry.pane_id = paneId;
          entry.pane_target = paneTarget;
          entry.tmux_session = paneTarget?.split(":")[0] || "w";
        }
      });
    }, spawnInPane = function(paneId, cmd, label, cleanupFiles = []) {
      const spawnScript = `/tmp/spawn-worker-${name}-${Date.now()}.sh`;
      const rmCmd = cleanupFiles.length > 0 ? `
rm -f ${cleanupFiles.map((f) => `"${f}"`).join(" ")} "${spawnScript}"` : `
rm -f "${spawnScript}"`;
      writeFileSync(spawnScript, `#!/bin/bash
sleep 1
tmux send-keys -t "${paneId}" "${cmd}" && tmux send-keys -t "${paneId}" -H 0d${rmCmd}
`);
      execSync(`nohup bash "${spawnScript}" > /tmp/spawn-worker-${name}.log 2>&1 &`, { shell: "/bin/bash", timeout: 5000 });
      return `
  Launched (${label}): pane ${paneId}`;
    };
    const existingRegistry = readRegistry();
    if (existingRegistry[name] && name !== "_config") {
      return { content: [{ type: "text", text: `Error: Worker '${name}' already exists in registry. Choose a unique name.` }], isError: true };
    }
    let taskEntries = [];
    if (tasksJson) {
      try {
        const parsed = JSON.parse(tasksJson);
        if (!Array.isArray(parsed)) {
          return { content: [{ type: "text", text: `Error: tasks must be a JSON array` }], isError: true };
        }
        for (const t of parsed) {
          if (!t.subject || typeof t.subject !== "string") {
            return { content: [{ type: "text", text: `Error: Each task must have a string 'subject'` }], isError: true };
          }
        }
        taskEntries = parsed;
      } catch (e) {
        return { content: [{ type: "text", text: `Error parsing tasks JSON: ${e.message}` }], isError: true };
      }
    }
    let disallowedTools;
    if (disallowedToolsJson) {
      try {
        const parsed = JSON.parse(disallowedToolsJson);
        if (!Array.isArray(parsed) || !parsed.every((t) => typeof t === "string")) {
          return { content: [{ type: "text", text: `Error: disallowed_tools must be a JSON array of strings` }], isError: true };
        }
        disallowedTools = parsed;
      } catch (e) {
        return { content: [{ type: "text", text: `Error parsing disallowed_tools JSON: ${e.message}` }], isError: true };
      }
    }
    if (fork_from_session && !launch) {
      return { content: [{ type: "text", text: `Error: fork_from_session=true requires launch=true` }], isError: true };
    }
    const result = createWorkerFiles({ name, mission, model, perpetual, sleep_duration, disallowed_tools: disallowedTools, window: windowGroup, assigned_by, permission_mode, taskEntries });
    if (!result.ok) {
      return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
    }
    const reportTo = direct_report ? WORKER_NAME : assigned_by || WORKER_NAME || "chief-of-staff";
    const { state, permissions, taskIds, model: selectedModel, perpetual: isPerpetual } = result;
    withRegistryLocked((registry) => {
      ensureWorkerInRegistry(registry, name);
      const entry = registry[name];
      entry.model = permissions.model || "opus";
      entry.permission_mode = permissions.permission_mode || "bypassPermissions";
      entry.disallowed_tools = permissions.disallowedTools || [];
      entry.status = state.status || "idle";
      entry.perpetual = state.perpetual || false;
      entry.sleep_duration = state.sleep_duration || 1800;
      entry.cycles_completed = state.cycles_completed || 0;
      if (permissions.window) {
        entry.window = permissions.window;
      }
      entry.report_to = reportTo;
      if (fork_from_session) {
        entry.forked_from = WORKER_NAME;
      }
    });
    const projectName = PROJECT_ROOT.split("/").pop();
    const worktreeDir = join(PROJECT_ROOT, "..", `${projectName}-w-${name}`);
    const workerBranch = `worker/${name}`;
    let worktreeReady = false;
    try {
      if (!existsSync(worktreeDir)) {
        try {
          execSync(`git -C "${PROJECT_ROOT}" branch "${workerBranch}" HEAD 2>/dev/null`, { timeout: 5000 });
        } catch {}
        execSync(`git -C "${PROJECT_ROOT}" worktree add "${worktreeDir}" "${workerBranch}"`, { encoding: "utf-8", timeout: 1e4 });
      }
      worktreeReady = true;
    } catch {}
    let launchInfo = "";
    if (launch) {
      const effectivePlacement = placement || "window";
      const cwd = worktreeReady ? worktreeDir : PROJECT_ROOT;
      if (fork_from_session) {
        const ownPane = findOwnPane();
        const sessionId = ownPane ? getSessionId(ownPane.paneId) : null;
        if (!ownPane) {
          launchInfo = `
  Launch: FAILED — could not find own pane (not in tmux?)`;
        } else if (!sessionId) {
          launchInfo = `
  Launch: FAILED — no session ID for pane ${ownPane.paneId}`;
        } else {
          if (worktreeReady) {
            try {
              const parentSlug = PROJECT_ROOT.replace(/\//g, "-");
              const newSlug = worktreeDir.replace(/\//g, "-");
              const parentProj = join(HOME, ".claude/projects", parentSlug);
              const newProj = join(HOME, ".claude/projects", newSlug);
              mkdirSync(newProj, { recursive: true });
              const jsonlSrc = join(parentProj, `${sessionId}.jsonl`);
              if (existsSync(jsonlSrc))
                copyFileSync(jsonlSrc, join(newProj, `${sessionId}.jsonl`));
              const subdirSrc = join(parentProj, sessionId);
              if (existsSync(subdirSrc))
                cpSync(subdirSrc, join(newProj, sessionId), { recursive: true });
            } catch {}
          }
          try {
            const childPaneId = createPane(effectivePlacement, cwd);
            if (!childPaneId?.startsWith("%")) {
              launchInfo = `
  Launch: FAILED — pane creation returned: ${childPaneId}`;
            } else {
              registerPane(childPaneId);
              const workerModel = selectedModel || "opus";
              const workerDir = join(PROJECT_ROOT, ".claude/workers", name);
              const extraFlags = `--model ${workerModel} --dangerously-skip-permissions --add-dir ${workerDir}`;
              const cwdFlag = worktreeReady ? ` --cwd ${worktreeDir}` : "";
              const forkCmd = `bash ${join(CLAUDE_OPS, "scripts/fork-worker.sh")} ${ownPane.paneId} ${sessionId} --name ${name} --no-worktree${cwdFlag} ${extraFlags}`;
              const taskFile = `/tmp/create-worker-task-${name}-${Date.now()}.txt`;
              const setupPrefix = worktreeReady ? `You are worker "${name}". Your isolated worktree is at ${worktreeDir}.

` : `You are worker "${name}". Create your worktree first: git worktree add ${worktreeDir} worker/${name}

`;
              writeFileSync(taskFile, setupPrefix + mission.slice(0, 500));
              launchInfo = spawnInPane(childPaneId, `cat ${taskFile} | ${forkCmd}`, `fork from ${sessionId}`, [taskFile]);
            }
          } catch (e) {
            launchInfo = `
  Launch: FAILED — ${e.message}`;
          }
        }
      } else if (effectivePlacement === "window" && !fork_from_session) {
        const launchScript = join(CLAUDE_OPS, "scripts/launch-flat-worker.sh");
        if (!existsSync(launchScript)) {
          launchInfo = `
  Launch: FAILED — script not found: ${launchScript}`;
        } else {
          const launchArgs = [launchScript, name, "--project", PROJECT_ROOT];
          if (permissions.window)
            launchArgs.push("--window", permissions.window);
          const launchResult = spawnSync("bash", launchArgs, {
            encoding: "utf-8",
            timeout: 120000,
            env: { ...process.env, PROJECT_ROOT }
          });
          if (launchResult.status === 0) {
            const paneMatch = launchResult.stdout.match(/pane\s+(%\d+)/);
            launchInfo = `
  Launched: pane ${paneMatch ? paneMatch[1] : "unknown"}`;
          } else {
            launchInfo = `
  Launch: FAILED (exit ${launchResult.status}) — ${(launchResult.stderr || "").slice(0, 200)}`;
          }
        }
      } else {
        try {
          const childPaneId = createPane(effectivePlacement, cwd);
          if (!childPaneId?.startsWith("%")) {
            launchInfo = `
  Launch: FAILED — pane creation returned: ${childPaneId}`;
          } else {
            registerPane(childPaneId);
            const workerModel = selectedModel || "opus";
            const workerDir = join(PROJECT_ROOT, ".claude/workers", name);
            const claudeCmd = `CLAUDE_CODE_SKIP_PROJECT_LOCK=1 claude --model ${workerModel} --dangerously-skip-permissions --add-dir ${workerDir}`;
            const seedFile = `/tmp/seed-${name}-${Date.now()}.txt`;
            writeFileSync(seedFile, `You are worker "${name}". Your isolated worktree is at ${worktreeReady ? worktreeDir : "(create it)"}.
Read ${join(WORKERS_DIR, name, "mission.md")} now and begin work.`);
            launchInfo = spawnInPane(childPaneId, `cat ${seedFile} | ${claudeCmd}`, effectivePlacement, [seedFile]);
          }
        } catch (e) {
          launchInfo = `
  Launch: FAILED — ${e.message}`;
        }
      }
    } else {
      launchInfo = `
  Launch: manual — bash launch-flat-worker.sh ${name}`;
    }
    const taskSummary = taskIds.length > 0 ? `${taskIds.length} (${taskIds.join(", ")})` : "none";
    const summary = [
      `Created worker/${name}:`,
      `  Dir: .claude/workers/${name}/`,
      `  Model: ${selectedModel} | Perpetual: ${isPerpetual}`,
      permissions.window ? `  Window: ${permissions.window}` : null,
      `  Reports to: ${reportTo}`,
      fork_from_session ? `  Forked from: ${WORKER_NAME}` : null,
      permissions.disallowedTools.length > 0 ? `  Disallowed: ${permissions.disallowedTools.length} rules` : `  Disallowed: none (full access)`,
      `  Tasks: ${taskSummary}`,
      worktreeReady ? `  Worktree: ${worktreeDir}` : `  Worktree: NOT CREATED (manual setup needed)`,
      launchInfo.trim() ? `  ${launchInfo.trim()}` : null
    ].filter(Boolean).join(`
`);
    return { content: [{ type: "text", text: summary }] };
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
  }
});
server.registerTool("standby", {
  description: "Put a worker into standby mode — keeps it in the registry (easy to restart later) but tells the watchdog to leave it alone. Use when a worker has finished its immediate task but may be needed again. The worker's pane is killed gracefully. To bring it back, use create_worker(launch=true) or bash launch-flat-worker.sh. Same auth rules as deregister: self-only unless you're chief-of-staff.",
  inputSchema: {
    name: z.string().optional().describe("Worker to put in standby (default: yourself). Only chief-of-staff may put other workers in standby."),
    reason: z.string().optional().describe("Why it's going to standby — stored in handoff.md")
  }
}, async ({ name, reason }) => {
  const targetName = name || WORKER_NAME;
  if (targetName !== WORKER_NAME && WORKER_NAME !== "chief-of-staff") {
    return {
      content: [{
        type: "text",
        text: `Only chief-of-staff can put other workers in standby. Contact chief-of-staff to stand down '${targetName}'.`
      }],
      isError: true
    };
  }
  const existing = getWorkerEntry(targetName);
  if (!existing) {
    return {
      content: [{ type: "text", text: `Worker '${targetName}' not found in registry.` }],
      isError: true
    };
  }
  if (reason) {
    try {
      const handoffPath = join(WORKERS_DIR, targetName, "handoff.md");
      const timestamp = new Date().toISOString();
      writeFileSync(handoffPath, `# Standby

**At:** ${timestamp}
**Reason:** ${reason}

Worker is in standby — registered but not running. Launch with \`bash launch-flat-worker.sh ${targetName}\` to resume.
`);
    } catch {}
  }
  const standbyCursor = readInboxCursor(targetName);
  const standbyPending = standbyCursor?.pending_replies || [];
  const standbyPendingWarning = standbyPending.length > 0 ? `
  WARNING: ${standbyPending.length} unreplied message(s):
` + standbyPending.map((p) => {
    const typeTag = p.reply_type ? `[${p.reply_type}] ` : "";
    return `    - ${typeTag}[${p.msg_id}] from ${p.from_name}: "${p.summary}"`;
  }).join(`
`) : "";
  withRegistryLocked((registry) => {
    const entry = registry[targetName];
    if (entry) {
      entry.status = "standby";
      entry.last_cycle_at = new Date().toISOString();
    }
  });
  const paneId = existing.pane_id;
  const tmuxSession = existing.tmux_session || "w";
  let moveResult = "";
  if (paneId) {
    try {
      spawnSync("tmux", ["rename-window", "-t", `${tmuxSession}:stand-by`, "standby"], { encoding: "utf-8" });
      const windowCheck = spawnSync("tmux", ["list-windows", "-t", tmuxSession, "-F", "#{window_name}"], { encoding: "utf-8" });
      const windows = (windowCheck.stdout || "").split(`
`).map((w) => w.trim());
      if (!windows.includes("standby")) {
        spawnSync("tmux", ["new-window", "-t", tmuxSession, "-n", "standby", "-d"], { encoding: "utf-8" });
      }
      const moveRes = spawnSync("tmux", ["move-pane", "-s", paneId, "-t", `${tmuxSession}:standby`], { encoding: "utf-8" });
      if (moveRes.status === 0) {
        moveResult = `
  Pane ${paneId}: moved to ${tmuxSession}:standby`;
        spawnSync("tmux", ["select-layout", "-t", `${tmuxSession}:standby`, "tiled"], { encoding: "utf-8" });
      } else {
        moveResult = `
  Pane ${paneId}: move failed — ${(moveRes.stderr || "").trim()}`;
      }
    } catch (e) {
      moveResult = `
  Pane move error: ${e.message}`;
    }
  } else {
    moveResult = `
  No active pane to move`;
  }
  return {
    content: [{
      type: "text",
      text: [
        `Worker '${targetName}' → standby.`,
        `  Registry: status=standby (watchdog will ignore it)`,
        moveResult.trim() ? `  ${moveResult.trim()}` : null,
        reason ? `  Handoff: written to .claude/workers/${targetName}/handoff.md` : null,
        ``,
        standbyPendingWarning || null,
        ``,
        `To resume: bash ~/.claude-ops/scripts/launch-flat-worker.sh ${targetName}`
      ].filter(Boolean).join(`
`)
    }]
  };
});
server.registerTool("deregister", {
  description: "Remove a worker from the registry (clean up ghost workers or finished one-off workers). Preserves the worker's files (.claude/workers/{name}/) and git worktree — only the registry entry is removed. Workers can only deregister themselves; chief-of-staff can deregister any worker. If you try to deregister someone else, you'll get an error telling you to contact chief-of-staff.",
  inputSchema: {
    name: z.string().optional().describe("Worker name to deregister (default: yourself). Only chief-of-staff may deregister other workers."),
    reason: z.string().optional().describe("Reason for deregistration — written to the worker's handoff.md for posterity")
  }
}, async ({ name, reason }) => {
  const targetName = name || WORKER_NAME;
  if (targetName !== WORKER_NAME && WORKER_NAME !== "chief-of-staff") {
    return {
      content: [{
        type: "text",
        text: `Only chief-of-staff can deregister other workers. Contact chief-of-staff to deregister '${targetName}'.`
      }],
      isError: true
    };
  }
  const existing = getWorkerEntry(targetName);
  if (!existing) {
    return {
      content: [{ type: "text", text: `Worker '${targetName}' not found in registry.` }],
      isError: true
    };
  }
  if (reason) {
    try {
      const handoffPath = join(WORKERS_DIR, targetName, "handoff.md");
      const timestamp = new Date().toISOString();
      writeFileSync(handoffPath, `# Deregistered

**By:** ${WORKER_NAME}
**At:** ${timestamp}
**Reason:** ${reason}
`);
    } catch {}
  }
  const preservedWorktree = existing.worktree || "(none registered)";
  withRegistryLocked((registry) => {
    delete registry[targetName];
  });
  return {
    content: [{
      type: "text",
      text: [
        `Deregistered '${targetName}' from registry.`,
        ``,
        `Preserved (not deleted):`,
        `  Worker files: .claude/workers/${targetName}/`,
        `  Git worktree: ${preservedWorktree}`,
        ``,
        `To fully clean up when ready:`,
        `  git worktree remove ${preservedWorktree}`,
        `  rm -rf .claude/workers/${targetName}/`
      ].join(`
`)
    }]
  };
});
server.registerTool("reload", {
  description: "Hot-restart: exit and resume the same session to pick up new MCP server config, model changes, or permission updates. Unlike recycle (which starts fresh), reload resumes the exact same conversation. Use after the MCP server bundle has been rebuilt.",
  inputSchema: {}
}, async () => {
  const ownPane = findOwnPane();
  if (!ownPane) {
    return { content: [{ type: "text", text: "Error: Could not find own pane in registry. Are you running in tmux?" }], isError: true };
  }
  const sessionId = getSessionId(ownPane.paneId);
  if (!sessionId) {
    return { content: [{ type: "text", text: "Error: Could not detect session ID — cannot resume." }], isError: true };
  }
  const model = getWorkerModel();
  const workerDir = join(PROJECT_ROOT, ".claude/workers", WORKER_NAME);
  const worktreeDir = getWorktreeDir();
  const resumeCmd = `CLAUDE_CODE_SKIP_PROJECT_LOCK=1 claude --model ${model} --dangerously-skip-permissions --add-dir ${workerDir} --resume ${sessionId}`;
  const reloadScript = `/tmp/reload-${WORKER_NAME}-${Date.now()}.sh`;
  writeFileSync(reloadScript, `#!/bin/bash
# Auto-generated reload script for ${WORKER_NAME}
set -uo pipefail
PANE_ID="${ownPane.paneId}"

# Wait for MCP response to propagate
sleep 3

# Send /exit to Claude
tmux send-keys -t "$PANE_ID" "/exit"
tmux send-keys -t "$PANE_ID" -H 0d

# Wait for Claude to exit (max 30s)
WAIT=0
while [ "$WAIT" -lt 30 ]; do
  sleep 2; WAIT=$((WAIT+2))
  PANE_PID=$(tmux list-panes -a -F '#{pane_id} #{pane_pid}' 2>/dev/null | awk -v id="$PANE_ID" '$1 == id {print $2}')
  [ -z "$PANE_PID" ] && { echo "FATAL: pane gone"; exit 1; }
  CLAUDE_RUNNING=false
  for pid in $(pgrep -P "$PANE_PID" 2>/dev/null); do
    cmd=$(ps -o command= -p "$pid" 2>/dev/null || true)
    [[ "$cmd" == *claude* ]] && CLAUDE_RUNNING=true && break
  done
  [ "$CLAUDE_RUNNING" = "false" ] && break
done

sleep 2

# cd to worktree and resume same session
tmux send-keys -t "$PANE_ID" "cd ${worktreeDir}"
tmux send-keys -t "$PANE_ID" -H 0d
sleep 1
tmux send-keys -t "$PANE_ID" "${resumeCmd}"
tmux send-keys -t "$PANE_ID" -H 0d
rm -f "${reloadScript}"
`);
  execSync(`nohup bash "${reloadScript}" > /dev/null 2>&1 &`, {
    shell: "/bin/bash",
    timeout: 5000
  });
  return {
    content: [{
      type: "text",
      text: `Reloading — /exit will be sent in ~3s, then session ${sessionId} will resume.
` + `Model: ${model}
` + `Do NOT send any more tool calls — /exit is imminent.`
    }]
  };
});
async function main() {
  const transport = new StdioServerTransport;
  await server.connect(transport);
}
if (import.meta.main) {
  main().catch((e) => {
    console.error("worker-fleet MCP server fatal:", e);
    process.exit(1);
  });
}

export {
  readTasks,
  writeTasks,
  nextTaskId,
  isTaskBlocked,
  getTasksPath,
  writeToInbox,
  readInboxFromCursor,
  readInboxCursor,
  writeInboxCursor,
  resolveRecipient,
  isPaneAlive,
  readJsonFile,
  acquireLock,
  releaseLock,
  findOwnPane,
  getSessionId,
  getWorkerModel,
  getWorktreeDir,
  generateSeedContent,
  runDiagnostics,
  createWorkerFiles,
  _setWorkersDir,
  readRegistry,
  getWorkerEntry,
  withRegistryLocked,
  ensureWorkerInRegistry,
  lintRegistry,
  _replaceMemorySection,
  getReportTo,
  canUpdateWorker,
  WORKER_NAME,
  WORKERS_DIR,
  HARNESS_LOCK_DIR,
  REGISTRY_PATH
};
