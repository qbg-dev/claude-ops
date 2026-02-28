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
