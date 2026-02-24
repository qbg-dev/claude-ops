# Agent Teams as Execution Layer

Claude Code's native `TeamCreate`/`TaskCreate`/`SendMessage` provides rich coordination primitives. The harness system treats these as the ephemeral execution layer atop the durable progress.json state.

## Design Principle

| Layer | Role | Lifetime |
|-------|------|----------|
| **Harness** (progress.json) | Durable state — survives /quit, rotation, reboot | Infinite |
| **Team** (TeamCreate) | Ephemeral execution — worker spawn, messaging, task delegation | Per-session |

Progress.json is the checkpoint. TeamCreate/TaskCreate are the runtime. If the session dies, progress.json preserves all state. The next session re-creates the team from scratch.

---

## Harness Modes

Every harness operates in one of two modes:

| Mode | When | Agents | Team? |
|------|------|--------|-------|
| **Swarm** (default) | Any harness with 2+ tasks | 1 lead + N workers | Yes |
| **Solo** | All tasks strictly sequential, no parallelism possible | 1 (the harness agent) | No TeamCreate needed |

**Swarm is the default.** All harnesses should use TeamCreate + worker agents unless every task depends on the previous one. Even harnesses with some sequential dependencies often have independent tasks that benefit from parallel execution.

---

## When to Use Teams (default — almost always)

Teams are the default for all harnesses. Use them whenever you have 2+ tasks.

**Fall back to solo only when:**
- Every single task depends on the previous (fully sequential chain)
- There is literally only 1 task

---

## Team Naming

Team names follow the pattern `harness-{name}` where `{name}` matches the progress.json `.harness` field.

Example: if progress.json has `"harness": "chatbot-agent"`, the team is `harness-chatbot-agent`.

---

## Swarm Architecture

```
┌──────────────────────────────────────────────┐
│ Durable Layer (survives rotation/reboot)      │
│ ┌──────────────────────────────────────────┐  │
│ │ progress.json                             │  │
│ │ .tasks DAG + .state.swarm + .learnings    │  │
│ └──────────────────────────────────────────┘  │
│                    ↕ sync                      │
│ Ephemeral Layer (per-session)                  │
│ ┌──────────────────────────────────────────┐  │
│ │ TeamCreate("harness-{name}")              │  │
│ │ ├── Lead agent (orchestrator)             │  │
│ │ │   ├── TaskCreate for each pending task  │  │
│ │ │   ├── Task(subagent) for workers        │  │
│ │ │   └── SendMessage for coordination      │  │
│ │ ├── Worker 1 (general-purpose, worktree)  │  │
│ │ ├── Worker 2 (general-purpose, worktree)  │  │
│ │ └── Worker N                              │  │
│ └──────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```

---

## Lifecycle

1. **Start**: `{name}-start.sh` activates progress.json, sets `status: "active"`
2. **Team init**: Lead agent calls `TeamCreate("harness-{name}")`, creates `TaskCreate` entries from progress.json pending tasks, spawns workers via `Task(team_name=..., subagent_type="general-purpose")`
3. **Work**: Workers claim tasks via `TaskUpdate(owner=)`, complete them, notify lead via `SendMessage`
4. **Sync**: Lead updates progress.json when workers complete tasks (durable checkpoint)
5. **Rotation**: Lead calls `TeamDelete`, `harness-rotate.sh` launches fresh session, new lead re-creates team from progress.json
6. **Done**: All tasks complete → lead sends `shutdown_request` to workers → `TeamDelete` → progress.json `status="done"`

---

## Task Sync Protocol

### Session Start (progress.json → TaskList)

```
For each task in progress.json where status == "pending" and not blocked:
  TaskCreate(subject=task_id, description=task.description)
```

The lead agent reads progress.json and creates corresponding Claude Code tasks. Task IDs in progress.json become task subjects in the team's TaskList.

### Task Completion (TaskList → progress.json)

When a worker completes a task:
1. Worker calls `TaskUpdate(status="completed")` on the Claude Code task
2. Worker sends `SendMessage` to lead: "Completed {task_id}, summary: ..."
3. Lead updates progress.json: `harness_set_completed "$PROGRESS" "$TASK_ID"`
4. Lead checks `harness_would_unblock "$PROGRESS" "$TASK_ID"` for newly runnable tasks
5. Lead creates new TaskCreate entries for unblocked tasks and assigns to idle workers

### Source of Truth

**progress.json is always the source of truth.** If TaskList and progress.json disagree, re-sync from progress.json.

---

## Worker Spawn Patterns

### Standard worker (shared repo)
```
Task(
  subagent_type="general-purpose",
  team_name="harness-{name}",
  name="worker-1",
  prompt="Read claude_files/{name}-harness.md. Your task: {task description}. When done, update progress and notify lead."
)
```

### Isolated worker (worktree)
```
Task(
  subagent_type="general-purpose",
  team_name="harness-{name}",
  name="worker-1",
  isolation="worktree",
  prompt="Read claude_files/{name}-harness.md. Your task: {task description}. Commit your changes. Notify lead when done."
)
```

Use `isolation: "worktree"` when workers edit different files and you want to avoid conflicts. The worktree is a separate git branch; changes merge back via PR or manual merge.

---

## Message Patterns

### Worker → Lead
- **Task started**: "Starting {task_id}: {brief description}"
- **Task blocked**: "Blocked on {task_id}: {reason}. Need {dependency}."
- **Task completed**: "Completed {task_id}. Summary: {what was done}. Test evidence: {evidence}."
- **Learning discovered**: "Learning: {insight that should persist in progress.json}"

### Lead → Worker
- **Assignment**: "Work on {task_id}: {description}. Key files: {files}."
- **Correction**: "For {task_id}: {feedback}. Adjust approach to {new approach}."
- **Context**: "FYI: {task_id_2} just completed, which changes {relevant info}."

---

## Graceful Shutdown

1. Lead sends `shutdown_request` to each worker
2. Workers respond with `shutdown_response(approve=true)`
3. Lead calls `TeamDelete`
4. Lead updates progress.json with final state

If rotation is triggered during swarm operation:
1. Lead sends `shutdown_request` to all workers
2. Lead waits for responses (timeout: 30s)
3. Lead syncs all progress to progress.json
4. Lead calls `TeamDelete`
5. `harness-rotate.sh` launches fresh session
6. New session re-creates team from progress.json

---

## Fallback

If `TeamCreate` fails or is unavailable (e.g., older Claude Code version), fall back to solo mode. The harness still works — tasks just execute sequentially instead of in parallel.

The start script should check: if `state.mode == "swarm"` but team creation fails, log a warning and proceed in solo mode.

---

## Progress Schema: Swarm State

```json
{
  "state": {
    "mode": "swarm",
    "team_name": "harness-chatbot-agent",
    "max_workers": 3,
    "active_workers": ["worker-1", "worker-2"],
    "pending_merges": ["branch-from-worker-1"],
    "cycle_count": 0,
    "current_phase": "execution",
    "pass_rate_history": []
  }
}
```

The `.state` object is optional and harness-specific. Swarm harnesses populate it; solo harnesses leave it empty or omit it.

---

## Comparison: Teams vs. Tmux Panes

| Aspect | Claude Code Teams | Tmux Panes (legacy) |
|--------|------------------|-------------------|
| **Spawn** | `Task(team_name=...)` | `tmux split-window` + `send-keys` |
| **Messaging** | `SendMessage` (reliable, queued) | `tmux send-keys` (fragile, unsigned) |
| **Task tracking** | `TaskList`/`TaskUpdate` (built-in) | Manual progress.json updates |
| **Lifecycle** | Managed (idle detection, shutdown) | Manual (process watching) |
| **Isolation** | `isolation: "worktree"` | Manual `git worktree` |
| **Discovery** | Team config file | `tmux list-panes` + process tree |

**Teams are the preferred coordination mechanism.** Tmux pane communication remains as fallback for scenarios where teams aren't available or for ad-hoc cross-harness messaging.

---

## Archetype × Swarm Pairing

Each harness archetype maps to swarm differently:

| Archetype | Swarm pattern | Worker count | Isolation |
|-----------|--------------|--------------|-----------|
| **List-driven** | Workers claim tasks from queue, lead assigns | 2-4 (scales with task count) | `worktree` if tasks touch different files |
| **Exploration-first** | Phase 1: Explore-type agents discover work. Phase 2: workers build discovered tasks | 2-3 explorers → lead queues → workers build | Shared repo (explorers read-only), `worktree` for builders |
| **Deadline-driven** | Lead triages priorities, workers take top-N in parallel | 2-3 (less overhead for tight deadlines) | `worktree` (speed over coordination) |

**List-driven + swarm** is the sweet spot — tasks are well-defined, workers are independent, lead just monitors and syncs.

**Exploration-first + swarm** has two phases: (1) explore phase with Explore-type subagents gathering info, (2) build phase with general-purpose workers executing discovered tasks. The lead transitions between phases by updating `state.current_phase` in progress.json.

**Deadline-driven + swarm** benefits from parallelism but needs tighter lead control — the lead should reassign workers when priorities shift mid-sprint.

---

## Hooks Integration

Hooks fire on the **lead agent only** — workers are subagents (Task tool) with their own lifecycle. Key hook considerations:

- **Stop hook**: Blocks the lead from stopping. Should include team status (worker count, pending merges). Workers don't need stop hooks.
- **Context inject**: Should inject team state for the lead on session start.
- **SubagentStop**: Log worker completions for the lead to process.
- **Rotation**: Must TeamDelete before rotating — lead shuts down workers first.

Full swarm-aware hook templates: see `hooks.md` → "Swarm-Aware Hooks" section.
