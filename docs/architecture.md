# Architecture

claude-ops has five core components. They're all shell scripts + JSON—no servers, no runtimes.

## Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                           claude-ops                                │
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
│  State: {project}/.claude/harness/  +  ~/.claude-ops/state/        │
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
| `~/.claude-ops/bus/side-effects/` | Side-effect scripts (one per declared effect) |

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

Claude Code hooks are shell scripts that fire at defined lifecycle points. claude-ops registers four:

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
- **Stuck agents**: process alive but idle >20 min → kill + respawn in same pane (flat workers) or nudge (harness agents)
- **Crash loops**: >3 crashes/hour → stops retrying, publishes `agent.crash-loop`

### Stuck detection for flat workers

Flat workers don't emit bus events, so the watchdog uses scrollback content analysis. Every check cycle it captures the last 30 lines of the pane and matches against known blocking patterns:

```
Waiting for task|hook error.*hook error|No output.*No output
```

If a pattern persists for >20 minutes (`STUCK_THRESHOLD_SEC=1200`), the watchdog kills the process tree and relaunches Claude in the same pane with a respawn seed. The worker keeps its pane ID and registry entry—it stays the parent agent.

### State files

| File | Purpose |
|------|---------|
| `~/.claude-ops/state/pane-registry.json` | Maps pane IDs to harness names and session IDs |
| `~/.claude-ops/state/sessions/{id}/graceful-stop` | Sentinel written by Stop hook |
| `~/.claude-ops/state/harness-runtime/{name}/` | Per-harness runtime flags |
| `~/.claude-ops/state/harness-runtime/{name}/stuck-candidate` | Timestamp when stuck pattern first seen |
| `~/.claude-ops/state/harness-runtime/{name}/crash-count.json` | Crash timestamps (last hour) |
| `~/.claude-ops/state/watchdog.log` | Stop hook + watchdog log |

### Health check

`scripts/harness-health.sh` gives a full system snapshot without needing to read individual files:

```bash
bash ~/.claude-ops/scripts/harness-health.sh          # colored text summary
bash ~/.claude-ops/scripts/harness-health.sh --json   # machine-readable
```

Checks: pane registry integrity, stale `graceful-stop` markers, crash-loop flags, stuck-candidate markers, `tasks.json` validity (JSON + schema + orphaned in-progress + circular deps), `state.json` consistency, watchdog config.

## Component 5: Multi-Agent Layer

### Harness workers (coordinator-managed)

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

### Flat workers (direct, no coordinator)

Flat workers are simpler: Warren → workers directly. No module-manager layer. Each flat worker is an independent Claude session in its own tmux window, with its own worktree on branch `worker/{name}`.

```
Warren
    ├── worker/chatbot-tools   (branch: worker/chatbot-tools, type: implementer)
    ├── worker/miniapp-ux      (branch: worker/miniapp-ux,    type: implementer)
    ├── worker/conv-monitor    (branch: worker/conv-monitor,  type: monitor)
    └── worker/chief-of-staff  (branch: worker/chief-of-staff, type: coordinator)
                               merges completed branches → main, deploys to prod
```

#### Phase 0 — Vision Gate

Before a new flat worker begins implementation, it must create `vision.html` (a Before/After sketch + approach + acceptance criteria) and have it approved. The Stop hook checks `vision_approved` in `state.json`: if absent or `false`, the session is blocked with a reminder. Workers with existing cycles (`cycles_completed > 0`) are pre-approved.

#### Agent Types

Three typed templates at `~/.claude-ops/templates/flat-worker/types/` define different capability levels:

| Type | Permissions | `perpetual` | Use case |
|------|------------|-------------|----------|
| **implementer** | Full read-write, no sudo/force-push | false | Feature work, bug fixes |
| **monitor** | Read-only (no Edit/Write/deploy) | true | Production observation, anomaly detection |
| **coordinator** | Full + git merge/push + deploy-prod | true | Branch merges, prod deploys, issue triage |

Monitor workers never fix issues themselves—they report to the coordinator (chief-of-staff) via `worker-message.sh`. The coordinator then creates implementer tasks or notifies Warren. This preserves the read-only safety boundary while ensuring findings are acted on.

Each flat worker gets a `tasks.json` flat task list (not nested under `.tasks`—keys are `T001`, `T002`, ...) managed with `worker-task.sh`:

```bash
# Worker pane (auto-detects worker name from git branch or pane registry)
bash ~/.claude-ops/scripts/worker-task.sh add "Fix login bug" --priority high
bash ~/.claude-ops/scripts/worker-task.sh add "Write tests" --after T001      # depends on T001
bash ~/.claude-ops/scripts/worker-task.sh add "Refresh task list" --recurring
bash ~/.claude-ops/scripts/worker-task.sh claim T001
bash ~/.claude-ops/scripts/worker-task.sh complete T001
bash ~/.claude-ops/scripts/worker-task.sh next          # highest-priority unclaimed unblocked task
bash ~/.claude-ops/scripts/worker-task.sh list --pending
bash ~/.claude-ops/scripts/worker-task.sh list --blocked
```

**Flat worker `tasks.json` schema** (different from harness `tasks.json`—flat keys, not nested):

```json
{
  "T001": {
    "subject": "Fix login bug",
    "description": "Details...",
    "status": "pending",
    "priority": "high",
    "recurring": false,
    "blocked_by": [],
    "owner": null,
    "cycles_completed": 0,
    "created_at": "2026-03-01T00:00:00Z",
    "completed_at": null
  }
}
```

Priority ordering: `critical > high > medium > low`. `next` returns the first unclaimed, unblocked task by priority. Recurring tasks reset to `pending` on `complete`, bumping `cycles_completed`.

**Launching:**

```bash
bash {project}/.claude/scripts/launch-flat-worker.sh <worker-name>
```

Creates a worktree on `worker/{name}`, registers in pane-registry, injects a seed prompt. The watchdog handles respawn—flat workers set `perpetual: true` and `sleep_duration` in `state.json`.

### Key files

| File | Purpose |
|------|---------|
| `lib/worker-dispatch.sh` | Worker health checks, dispatch helpers (harness workers) |
| `lib/harness-launch.sh` | Launch harness agents in tmux panes |
| `scripts/launch-worker.sh` | Create worktree + spawn harness worker pane (harness system) |
| `scripts/launch-flat-worker.sh` | Launch flat worker in own tmux window (flat system) |
| `scripts/worker-task.sh` | Per-worker task list management (add/claim/complete/list/next) |
| `scripts/worker-message.sh` | Inter-worker messaging (monitor → coordinator escalation) |
| `scripts/check-flat-workers.sh` | Auto-discover and report flat worker fleet status |
| `scripts/worker-post-commit-hook.sh` | Post-commit hook for worker worktrees (auto-notification) |
| `templates/flat-worker/` | Base template for new flat workers |
| `templates/flat-worker/types/implementer/` | Implementer type (read-write, one-shot, vision gate) |
| `templates/flat-worker/types/monitor/` | Monitor type (read-only, perpetual, reports to coordinator) |
| `templates/flat-worker/types/coordinator/` | Coordinator type (full access, merge/deploy) |
| `~/.claude-ops/state/pane-registry.json` | Maps panes to harnesses (coordinator looks up workers here) |

### Messaging

Agents communicate via the event bus using `hq_send` (from `harness-jq.sh`):

```bash
source ~/.claude-ops/lib/harness-jq.sh
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
| `~/.claude-ops/` | Infrastructure (this repo) | All projects |
| `{project}/.claude/harness/` | Harness files | Harness lifetime |
| `{project}/.claude/bus/` | Event bus per project | Project lifetime |
| `~/.claude-ops/state/sessions/` | Per-session runtime | Session (~24h TTL) |
| `~/.claude-ops/state/harness-runtime/` | Per-harness runtime flags | Until deregistered |
| `~/.claude-ops/state/pane-registry.json` | Pane ↔ harness map | Pruned when panes die |
| `~/.claude-ops/harness/manifests/` | Harness registry entries | Until deregistered |
| `~/.claude-ops/templates/conv-monitor/` | Conv-monitor worker template | All projects |
| `~/.claude-ops/templates/flat-worker/.commit-template.md` | Worker commit format template | All projects |
| `~/.claude-ops/templates/flat-worker/types/` | Agent type templates (implementer/monitor/coordinator) | All projects |
| `~/.claude-ops/scripts/worker-commit.sh` | Structured commit helper | All projects |
| `~/.claude-ops/scripts/worker-message.sh` | Inter-worker messaging | All projects |
| `~/.claude-ops/scripts/scaffold-conv-monitor.sh` | Conv-monitor scaffolding | All projects |
| `{project}/.claude/workers/{name}/` | Flat worker files | Worker lifetime |
