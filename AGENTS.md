# boring — Agent Bootstrap Reference

> This file is the single-file reference for setting up and using boring.
> An agent can curl this file and immediately understand the system.
>
> ```bash
> curl -fsSL https://raw.githubusercontent.com/qbg-dev/boring/main/AGENTS.md
> ```

---

## Installation

```bash
curl -fsSL https://raw.githubusercontent.com/qbg-dev/boring/main/install.sh | bash
source ~/.zshrc  # or ~/.bash_profile
```

This clones to `~/.boring`, adds `bin/` to PATH, and registers 4 hooks in `~/.claude/settings.json`.

**Prerequisites**: git, jq, tmux, bash 4+, Claude Code.

---

## Core Concepts

**Harness** — a named task graph that an agent works through. Lives at `.claude/harness/{name}/` inside your project.

**Coordinator** — an agent that manages a task graph, delegates to workers, and collects results.

**Worker** — an agent that claims tasks from a harness, executes them, and publishes completion events.

**Event Bus** — JSONL append log at `.claude/bus/stream.jsonl`. Pub/sub with pluggable side-effects.

**Hooks** — four Claude Code hooks that wire sessions to harness state:
- `PreToolUse` → context injection (inbox, policy, phase)
- `PostToolUse` → publishes tool-call and file-edit events
- `Stop` → blocks session if tasks remain; respawns long-running agents
- `UserPromptSubmit` → triggers context sync

---

## Create a Harness

```bash
# Bounded (stops when tasks done)
bash ~/.boring/scripts/scaffold.sh my-feature /path/to/project

# Long-running (watchdog respawns after sleep)
bash ~/.boring/scripts/scaffold.sh --long-running monitor /path/to/project
```

Files created:
```
.claude/harness/{name}/
├── tasks.json                          ← task graph (edit this)
├── harness.md                          ← agent context
├── spec.md                             ← requirements
├── acceptance.md                       ← pass/fail tracker
├── policy.json                         ← context injection rules
└── agents/module-manager/
    ├── config.json                     ← lifecycle, model, sleep_duration
    ├── state.json                      ← runtime state
    ├── MEMORY.md                       ← persistent agent memory
    ├── mission.md                      ← stable mission statement
    ├── inbox.jsonl                     ← inbound messages
    ├── outbox.jsonl                    ← file-edit events
    └── permissions.json                ← tool allow/deny list
.claude/scripts/{name}-seed.sh          ← generates seed prompt
```

---

## Task Graph (tasks.json)

```json
{
  "tasks": {
    "T-1": {
      "status": "pending",
      "description": "What to do",
      "blockedBy": [],
      "owner": null
    },
    "T-2": {
      "status": "pending",
      "description": "Do this after T-1",
      "blockedBy": ["T-1"],
      "owner": null
    }
  }
}
```

Statuses: `"pending"` → `"in_progress"` → `"completed"`.

---

## Launch an Agent

```bash
# Generate seed prompt
bash /path/to/project/.claude/scripts/{name}-seed.sh > /tmp/seed.txt

# Launch in tmux pane (headful TUI)
cat /tmp/seed.txt | claude --dangerously-skip-permissions --model claude-sonnet-4-6
```

The Stop hook will keep the agent working until all tasks are `"completed"`.

---

## Event Bus API

```bash
source ~/.boring/lib/event-bus.sh

# Publish
bus_publish "task.completed" '{"harness":"foo","task_id":"T-1","summary":"done"}'
bus_publish "cell-message" '{"from":"coordinator","to":"worker-1","body":"Start T-3"}'
bus_publish "notification" '{"message":"Build failed","title":"CI Alert"}'

# Read (consumer with cursor)
bus_subscribe "my-agent"
events=$(bus_read "my-agent" --type "task.completed")
bus_ack "my-agent" 42

# Query (ad-hoc)
bus_query --type "task.completed" --limit 20
bus_query --from "worker-1" --since "2026-02-28T00:00:00Z"
bus_query --pattern "task\\." --raw

# Git checkpoint
bus_git_checkpoint "auto: wave 1 complete"

# Compact stream
bus_compact
```

---

## Harness State API (harness-jq.sh)

```bash
source ~/.boring/lib/harness-jq.sh

TASKS=".claude/harness/my-feature/tasks.json"

harness_current_task "$TASKS"      # first in_progress or pending task
harness_next_task "$TASKS"         # next pending task after current
harness_done_count "$TASKS"        # count of completed tasks
harness_total_count "$TASKS"       # total task count
harness_task_description "$TASKS" "T-1"
harness_would_unblock "$TASKS" "T-1"  # tasks unblocked if T-1 completes
harness_lifecycle "$TASKS"         # "bounded" or "long-running"

# Atomic JSON write
locked_jq_write "$TASKS" '.tasks["T-1"].status = "completed"'

# Messaging
hq_send "my-harness" "my-harness/worker-1" "directive" "Focus on T-3"
# Types: status, regression, directive, task, question

# Bump session counter
harness_bump_session "$TASKS"
```

---

## Hooks Reference

### PreToolUse — Context Injector

`hooks/interceptors/pre-tool-context-injector.sh`

Fires before every tool call. Injects:
- Policy rule matches (from `policy.json`)
- Inbox messages (last 30 min, max 5)
- Acceptance summary (pass/fail status)
- File-edit warnings from other agents
- Phase context (long-running harnesses)

### Stop Hook — Harness Gate

`hooks/gates/stop-harness-dispatch.sh`

For **bounded** harnesses:
- Tasks remain → `hook_block` with current state (agent reads and continues)
- All done → `hook_block` asking for MEMORY.md update + git checkpoint

For **long-running** harnesses:
- Writes `graceful-stop` sentinel → `hook_pass`
- Watchdog reads `sleep_duration` from config, respawns after that interval

**Escape**: `touch ~/.boring/state/sessions/{session_id}/allow-stop`

### Custom Hooks

```bash
#!/usr/bin/env bash
set -euo pipefail
trap 'echo "{}"; exit 0' ERR

source ~/.boring/lib/pane-resolve.sh
INPUT=$(cat)
hook_parse_input "$INPUT"        # sets $_HOOK_SESSION_ID, $_HOOK_TOOL_NAME, $_HOOK_TOOL_INPUT
resolve_pane_and_harness "$_HOOK_SESSION_ID"

# hook_pass         → allow (exit 0)
# hook_block "msg"  → block with message (exit 1)
# hook_context "x"  → inject additionalContext (exit 0 with JSON)

hook_pass
```

---

## Multi-Agent Pattern

```bash
source ~/.boring/lib/harness-jq.sh

# Coordinator: launch a worker
bash ~/.boring/scripts/launch-worker.sh my-harness worker-alpha

# Send a directive
hq_send "my-harness" "my-harness/worker-alpha" "directive" "Review src/api/, write to review-api.md"

# Worker: claim a task and publish completion
locked_jq_write ".claude/harness/my-harness/worker-alpha/tasks.json" '.tasks["W-1"].status = "in_progress"'
# ... do the work ...
bus_publish "task.completed" '{"harness":"my-harness","worker":"my-harness/worker-alpha","task_id":"W-1","summary":"done"}'
```

Side-effects automatically:
- Update task status in coordinator's `tasks.json`
- Deliver a message to coordinator's inbox
- Inject the message on coordinator's next PreToolUse

---

## Flat Worker Pattern (New)

Simpler alternative to the harness system. No module managers, no event bus. Workers run in their own tmux windows with individual worktrees.

```bash
# Launch a flat worker (from project root)
bash ~/.boring/scripts/launch-flat-worker.sh my-worker

# Or with project override
bash ~/.boring/scripts/launch-flat-worker.sh my-worker --project /path/to/repo

# Check fleet status
bash ~/.boring/scripts/check-flat-workers.sh

# Scaffold a new worker from template
cp -r ~/.boring/templates/flat-worker/ .claude/workers/my-worker/
# Then edit mission.md, permissions.json
```

Worker directory structure: `.claude/workers/{name}/` with `mission.md`, `permissions.json`, `state.json`, `MEMORY.md`.

Each worker gets a git worktree at `../{ProjectName}-w-{name}` on branch `worker/{name}`.

The watchdog (`harness-watchdog.sh`) handles both harness agents and flat workers (detects `worker/*` canonical names).

---

## Respawn Configuration (Flat Workers)

Each flat worker controls its own respawn behavior via two fields in `state.json`:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `perpetual` | bool | true | `true` = watchdog respawns after `sleep_duration`; `false` = one-shot, never respawned after graceful stop |
| `sleep_duration` | int (seconds) | 900 | How long to wait before respawning (only used when `perpetual: true`) |

### How It Works

1. Worker finishes its cycle → Stop hook writes `graceful-stop` sentinel → session exits
2. Watchdog detects `graceful-stop` → calls `harness_sleep_duration("worker/{name}")`
3. `harness_sleep_duration` reads `state.json`:
   - `perpetual: false` → returns `"none"` → watchdog logs "SKIP: not respawning" and returns
   - `sleep_duration` set → returns that value → watchdog waits, then respawns
   - Neither set → returns `"900"` (15 min legacy default)

### Suggested Cadences

```json
{ "perpetual": true, "sleep_duration": 1800 }    // Monitoring/urgent: 30 min
{ "perpetual": true, "sleep_duration": 3600 }    // Active dev: 1h
{ "perpetual": true, "sleep_duration": 7200 }    // Review/maintenance: 2h
{ "perpetual": true, "sleep_duration": 10800 }   // Regression sweeps: 3h
{ "perpetual": true, "sleep_duration": 14400 }   // Optimization: 4h
{ "perpetual": false }                           // One-shot: never respawn
```

Fields can be changed mid-run — the watchdog reads `state.json` fresh on each check cycle.

---

## End-of-Cycle Checklist (for agents)

At the end of each cycle:

```bash
# 1. Update MEMORY.md (synthesize learnings, keep ≤200 lines)

# 2. Bump session counter
source ~/.boring/lib/harness-jq.sh
harness_bump_session .claude/harness/{name}/tasks.json

# 3. Publish completions
source ~/.boring/lib/event-bus.sh
bus_publish "task.completed" '{"harness":"{name}","task_id":"T-N","summary":"one line"}'

# 4. Git checkpoint
bus_git_checkpoint "auto: cycle N complete"
```

---

## Key File Paths

| Path | Contents |
|------|----------|
| `~/.boring/lib/harness-jq.sh` | Task graph API |
| `~/.boring/lib/event-bus.sh` | Event bus API |
| `~/.boring/scripts/scaffold.sh` | Harness scaffolding |
| `~/.boring/scripts/harness-watchdog.sh` | Watchdog daemon |
| `~/.boring/hooks/interceptors/pre-tool-context-injector.sh` | PreToolUse hook |
| `~/.boring/hooks/gates/stop-harness-dispatch.sh` | Stop hook |
| `~/.boring/bus/schema.json` | Event type + side-effect registry |
| `~/.boring/state/pane-registry.json` | Pane ↔ harness map |
| `~/.boring/state/watchdog.log` | Stop hook + watchdog log |
| `.claude/harness/{name}/tasks.json` | Task graph |
| `.claude/harness/{name}/agents/module-manager/inbox.jsonl` | Inbound messages |
| `.claude/harness/{name}/agents/module-manager/MEMORY.md` | Persistent memory |
| `.claude/bus/stream.jsonl` | Event stream (project-local) |
| `~/.boring/templates/conv-monitor/` | Conv-monitor worker template |
| `~/.boring/templates/flat-worker/.commit-template.md` | Standardized worker commit format |
| `~/.boring/scripts/scaffold-conv-monitor.sh` | Scaffold conv-monitor for a project |
| `~/.boring/scripts/worker-commit.sh` | Structured commit helper for flat workers |
| `~/.boring/scripts/worker-bus-emit.sh` | Worker → bus message emitter |
| `~/.boring/scripts/worker-outbox-sync.sh` | Bus → per-worker outbox materializer |
| `~/.boring/scripts/worker-inbox.sh` | Human-readable worker message summary |

---

## Conv-Monitor Pattern

A production conversation anomaly monitor — a READ-ONLY flat worker that SSHes to prod, queries the SQLite database, and reports anomalies. Designed for chatbot deployments where you need continuous oversight of live conversations without touching production data.

### What It Monitors (6 Categories)

| Category | Examples |
|----------|----------|
| **1. Security** | Identity spoofing, social engineering, prompt injection, data exfiltration, privilege escalation |
| **2. Bot Quality** | Unanswered messages, slow responses, tool loop exhaustion, hallucinations, system detail leaks |
| **3. Conversation Flow** | Unresolved loops, handoff failures, multiple identity claims, format anomalies |
| **4. Tool Execution** | Unhandled tool errors, SQL injection attempts |
| **5. Business Logic** | Work order anomalies, bot over-promising |
| **6. Volume Patterns** | Unusual per-user volume, zero-traffic detection, stuck loops, token usage spikes |

### Scaffold for a New Project

```bash
bash ~/.boring/scripts/scaffold-conv-monitor.sh \
  --name conv-monitor \
  --host 120.77.216.196 \
  --ssh-pass 'your-ssh-password' \
  --db-path '/opt/app/data/chatbot.db' \
  --domain 'wx.example.com' \
  --projects '80 (ProjectA), 73 (ProjectB)'
```

This creates `.claude/workers/conv-monitor/` with:
- `mission.md` — full mission with all 6 categories and SQL queries
- `permissions.json` — read-only (blocks Edit, Write, destructive SQL, deploy-prod)
- `state.json` — per-category finding counters
- `MEMORY.md` — cycle log template

### Launch

```bash
bash ~/.boring/scripts/launch-flat-worker.sh conv-monitor
```

### Customize

The template is designed for SQLite-backed chatbot systems with these tables: `conversations`, `kf_messages`, `user_facts`, `usage_logs`, `work_order_drafts`, `audit_log`.

To adapt for your project:
1. **Add queries**: Follow the existing pattern (SSH + sqlite3, 6-hour window, LIMIT clauses)
2. **Adjust thresholds**: Change message count limits, response time thresholds, token budgets
3. **Add categories**: Extend state.json with new category counters
4. **Change database**: If using PostgreSQL/MySQL instead of SQLite, update the SSH query pattern

### Permissions

The conv-monitor uses a strict read-only permission set:
- **Blocked**: Edit, Write, NotebookEdit, git push/merge/reset, deploy-prod, all SQL write operations (INSERT, UPDATE, DELETE, DROP, ALTER)
- **Allowed**: Bash (read-only SSH + sqlite3 SELECT), Read, Grep, Glob

### Cycle Protocol

Each 30-minute cycle:
1. SSH to prod, run all category queries
2. Classify findings (CRITICAL / WARNING / INFO)
3. For CRITICALs: pull full conversation thread for analysis
4. Append cycle report to MEMORY.md
5. Update state.json counters
6. Emit bus events for urgent findings
7. Sleep 30 minutes, repeat

The worker never sets `status="done"` — it runs perpetually until killed.

---

## Worker Commit Tooling

Standardized commit format and helper script for flat workers. Ensures every worker commit has consistent metadata, verification markers, and traceability.

### Commit Template

Located at `~/.boring/templates/flat-worker/.commit-template.md`. Format:

```
type(scope): short description [MISSION-ITEM]

## What changed
- bullet points

## Verification
- [x] bun test — result
- [x] tsc --noEmit — result
- [x] Deploy test — result
- [x] Endpoint verified — result
- [x] Screenshots — path or N/A

## Context
- Mission item: R01, F12, etc.
- Worker: worker-name
- Branch: worker/worker-name
- Cycle: N

Co-Authored-By: Claude sonnet <noreply@anthropic.com>
```

### worker-commit.sh

Located at `~/.boring/scripts/worker-commit.sh`. Usage:

```bash
# Simple (auto-runs bun test + tsc)
bash worker-commit.sh "fix(chatbot): prevent identity spoofing [R01]"

# Pre-verified (skip running tests)
bash worker-commit.sh "fix(chatbot): prevent identity spoofing [R01]" \
  --verified-test --verified-tsc --verified-deploy

# Interactive mode (prompts for type, scope, description)
bash worker-commit.sh --interactive

# Stage specific files
bash worker-commit.sh "feat(admin): add dashboard tab [F12]" --add "src/admin/app/pages/Dashboard.tsx"
```

Features:
- Validates `type(scope): description` format
- Auto-runs `bun test` and `tsc --noEmit` on staged files
- Auto-detects UI changes (.tsx/.css) and reminds about screenshots
- Updates worker state.json with commit SHA and timestamp
- Increments `issues_fixed` counter for `fix()` commits
- Reads model name from worker permissions.json for Co-Authored-By
