# Architecture

boring has five core components. They're all shell scripts + JSON—no servers, no runtimes.

## Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                           boring                                │
│                                                                     │
│  ┌───────────────┐    ┌───────────────┐    ┌───────────────────┐   │
│  │    Harness    │    │   Event Bus   │    │      Hooks        │   │
│  │               │    │               │    │                   │   │
│  │  tasks.json   │◄──►│ stream.jsonl  │◄───│  PreToolUse       │   │
│  │  task graph   │    │  pub/sub      │    │  PostToolUse      │   │
│  │  lifecycle    │    │  side-effects │    │  Stop             │   │
│  └───────┬───────┘    └───────┬───────┘    └────────┬──────────┘   │
│          │                   │                      │              │
│  ┌───────▼───────┐   ┌───────▼──────────────────────▼──────────┐   │
│  │   Watchdog    │   │             Multi-Agent Layer            │   │
│  │               │   │                                          │   │
│  │ crash detect  │   │  coordinator ──► worker-1                │   │
│  │ auto-respawn  │   │       │         ► worker-2               │   │
│  │ stuck nudge   │   │  pane-registry, inbox/outbox             │   │
│  └───────────────┘   └──────────────────────────────────────────┘   │
│                                                                     │
│  State: {project}/.claude/harness/  +  ~/.boring/state/        │
└─────────────────────────────────────────────────────────────────────┘
```

## Component 1: Harness

A harness is a named task graph that an agent works through. It lives at `.claude/harness/{name}/` inside your project.

### Key files

| File | Purpose |
|------|---------|
| `tasks.json` | Task graph: statuses, descriptions, blockedBy dependencies |
| `harness.md` | Narrative context for the agent—what the world looks like, constraints, key files |
| `spec.md` | Requirements the agent checks against |
| `acceptance.md` | Pass/fail status per acceptance criterion |
| `policy.json` | Context injection rules (patterns → context snippets) |
| `agents/module-manager/config.json` | Harness config: lifecycle type, sleep duration |
| `agents/module-manager/state.json` | Runtime state: current phase, cycle count |
| `agents/module-manager/MEMORY.md` | Agent's persistent memory across sessions |
| `agents/module-manager/mission.md` | Stable mission statement |
| `agents/module-manager/inbox.jsonl` | Inbound messages (from bus side-effects) |
| `agents/module-manager/outbox.jsonl` | Outbound file-edit events |

### Lifecycle types

**Bounded** (`lifecycle: "bounded"` in config.json): The agent works through tasks until all are `"completed"`, then stops. The Stop hook blocks the session until tasks are done.

**Long-running** (`lifecycle: "long-running"`): The agent runs cycles indefinitely. Each Stop writes a `graceful-stop` sentinel; the watchdog reads `sleep_duration` from config and respawns after that interval.

### Task graph schema

```json
{
  "tasks": {
    "T-1": {
      "status": "pending",
      "description": "What to do",
      "blockedBy": [],
      "owner": null,
      "metadata": {}
    },
    "T-2": {
      "status": "pending",
      "description": "Do this after T-1",
      "blockedBy": ["T-1"]
    }
  }
}
```

`harness-jq.sh` provides task graph query functions: `harness_current_task`, `harness_next_task`, `harness_done_count`, `harness_would_unblock`, etc.

## Component 2: Event Bus

A JSONL-based pub/sub system for inter-agent communication. Each project gets its own bus at `.claude/bus/`.

### Key files

| File | Purpose |
|------|---------|
| `.claude/bus/stream.jsonl` | Append-only event log (one JSON object per line) |
| `.claude/bus/schema.json` | Event type registry with side-effect declarations |
| `.claude/bus/cursors/{consumer}.json` | Per-consumer read position |
| `.claude/bus/seq.json` | Global sequence counter |
| `~/.boring/bus/side-effects/` | Side-effect scripts (one per declared effect) |

### Data flow

```
bus_publish "task.completed" '{"harness":"foo","task_id":"T-1","summary":"done"}'
  → enriches with _seq, _event_type, _ts
  → appends to stream.jsonl
  → looks up side_effects in schema.json for "task.completed"
  → runs update_tasks_json.sh + notify_assignee.sh asynchronously
```

See [Event Bus](event-bus.md) for the full API.

## Component 3: Hooks

Claude Code hooks are shell scripts that fire at defined lifecycle points. boring registers four:

| Hook | Script | What it does |
|------|--------|-------------|
| `PreToolUse` | `pre-tool-context-injector.sh` | Injects context (inbox messages, policy matches, phase state) into tool calls |
| `PostToolUse` | `post-tool-publisher.sh` | Publishes `file-edit` and `tool-call` events to the bus |
| `Stop` | `stop-harness-dispatch.sh` | Routes to the harness gate; blocks if tasks remain |
| `UserPromptSubmit` | `prompt-publisher.sh` | Publishes `prompt` events; triggers inbox sync |

The hooks are the glue between Claude Code sessions and the harness state machine.

See [Hooks](hooks.md) for details.

## Component 4: Watchdog

`scripts/harness-watchdog.sh` is a daemon that monitors agent health.

### What it watches

- **Graceful stops**: agent wrote `graceful-stop` sentinel → watchdog respawns after `sleep_duration`
- **Crashes**: pane died without sentinel → publishes `agent.crash` event, respawns
- **Stuck agents**: process alive but no tool calls for >10 min → sends nudge prompt
- **Crash loops**: >3 crashes/hour → stops retrying, publishes `agent.crash-loop`

### State files

| File | Purpose |
|------|---------|
| `~/.boring/state/pane-registry.json` | Maps pane IDs to harness names and session IDs |
| `~/.boring/state/sessions/{id}/graceful-stop` | Sentinel written by Stop hook |
| `~/.boring/state/harness-runtime/{name}/` | Per-harness runtime flags |
| `~/.boring/state/watchdog.log` | Stop hook + watchdog log |

## Component 5: Multi-Agent Layer

Multiple agents can work on the same harness concurrently. The pattern is:

```
coordinator (module-manager)
    │
    ├── launch worker-1 via launch-worker.sh
    ├── launch worker-2 via launch-worker.sh
    │
    └── assign tasks via hq_send / tasks.json ownership
```

Workers claim tasks by setting `owner` and publishing `task.started`. When done, they publish `task.completed` which triggers `update_tasks_json.sh` side-effect to mark the task complete.

### Key files

| File | Purpose |
|------|---------|
| `lib/worker-dispatch.sh` | Worker health checks, dispatch helpers |
| `lib/harness-launch.sh` | Launch harness agents in tmux panes |
| `scripts/launch-worker.sh` | Create worktree + spawn harness worker pane (old system) |
| `scripts/launch-flat-worker.sh` | Launch flat worker agent in own tmux window (new system) |
| `scripts/check-flat-workers.sh` | Auto-discover and report flat worker fleet status |
| `scripts/worker-post-commit-hook.sh` | Post-commit hook for worker worktrees (auto-notification) |
| `templates/flat-worker/` | Template files for scaffolding new flat workers |
| `~/.boring/state/pane-registry.json` | Maps panes to harnesses (coordinator looks up workers here) |

### Messaging

Agents communicate via the event bus using `hq_send` (from `harness-jq.sh`):

```bash
source ~/.boring/lib/harness-jq.sh
hq_send "my-harness" "my-harness/worker-1" "directive" "Focus on T-3 next"
```

The `cell-message` event type triggers `notify_assignee.sh` + `inject_directive_if_flagged.sh` side-effects, which write to the recipient's `inbox.jsonl` and flag the message for injection on next tool call.

## Data Flow: End-to-End

```
User seeds agent via Claude Code TUI
    │
    ├── PreToolUse hook fires on each tool call
    │     → inject policy matches, inbox messages, phase context
    │
    ├── Agent works on tasks; edits files; calls tools
    │     → PostToolUse publishes file-edit + tool-call events
    │
    ├── Agent marks task done, publishes task.completed
    │     → update_tasks_json side-effect updates tasks.json
    │     → notify_assignee informs coordinator via inbox
    │
    └── Agent tries to stop → Stop hook fires
          → harness gate: tasks remaining? → block
          → all done? → ask for MEMORY.md update, allow stop
          → long-running? → write graceful-stop, allow stop
                              → watchdog respawns after sleep_duration
```

## File Ownership Map

| Location | Owned by | Lifetime |
|----------|----------|----------|
| `~/.boring/` | Infrastructure (this repo) | All projects |
| `{project}/.claude/harness/` | Harness files | Harness lifetime |
| `{project}/.claude/bus/` | Event bus per project | Project lifetime |
| `~/.boring/state/sessions/` | Per-session runtime | Session (~24h TTL) |
| `~/.boring/state/harness-runtime/` | Per-harness runtime flags | Until deregistered |
| `~/.boring/state/pane-registry.json` | Pane ↔ harness map | Pruned when panes die |
| `~/.boring/harness/manifests/` | Harness registry entries | Until deregistered |
| `~/.boring/templates/conv-monitor/` | Conv-monitor worker template | All projects |
| `~/.boring/templates/flat-worker/.commit-template.md` | Worker commit format template | All projects |
| `~/.boring/scripts/worker-commit.sh` | Structured commit helper | All projects |
| `~/.boring/scripts/scaffold-conv-monitor.sh` | Conv-monitor scaffolding | All projects |
| `{project}/.claude/workers/{name}/` | Flat worker files | Worker lifetime |
