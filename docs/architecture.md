# Architecture

Four components. All shell scripts + JSON + one TypeScript MCP server.

```
┌──────────────────────────────────────────────────────────────────────┐
│                           claude-fleet                                 │
│                                                                      │
│  ┌──────────────────┐    ┌──────────────────┐   ┌────────────────┐  │
│  │  MCP Server       │    │    Watchdog       │   │     Hooks      │  │
│  │                   │    │                   │   │                │  │
│  │  15 tools:        │    │  launchd daemon   │   │  PreToolUse    │  │
│  │  messaging        │    │  respawn on stop  │   │  PostToolUse   │  │
│  │  tasks            │    │  crash detection  │   │  Stop          │  │
│  │  state            │    │  stuck detection  │   │  PromptSubmit  │  │
│  │  fleet visibility │    │  crash-loop guard │   │                │  │
│  └────────┬─────────┘    └────────┬─────────┘   └───────┬────────┘  │
│           │                       │                      │           │
│  ┌────────▼───────────────────────▼──────────────────────▼────────┐  │
│  │                     Worker Fleet                               │  │
│  │                                                                │  │
│  │  tmux pane ←→ git worktree ←→ Claude session ←→ auto-memory   │  │
│  │  tmux pane ←→ git worktree ←→ Claude session ←→ auto-memory   │  │
│  │  tmux pane ←→ git worktree ←→ Claude session ←→ auto-memory   │  │
│  │                                                                │  │
│  │  Config: {project}/.claude/workers/registry.json               │  │
│  │  State:  ~/.claude-fleet/state/                                  │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

## MCP Server (`mcp/worker-fleet/index.ts`)

The brain. Loaded into every Claude session via `.mcp.json`. Gives workers fleet awareness.

**Key insight**: workers are otherwise isolated Claude sessions. The MCP server is the only way they know about each other. Without it, a worker is just Claude in a worktree.

15 tools in 5 categories — see source for full docs. Identity auto-detected from `WORKER_NAME` env or git branch.

**Messaging is durable**: writes to `inbox.jsonl` (survives crashes) then delivers via tmux (instant). This two-phase approach means messages are never lost even if the recipient is dead.

## Watchdog (`scripts/worker-watchdog.sh`)

A launchd daemon that makes workers immortal. Checks every 30s.

**Three-layer stuck detection** (the hard problem):
1. **`(running)` guard** — if statusline shows `(running)`, worker is executing a bash command → skip. Prevents false positives on long deploys.
2. **Scrollback hash diff** — md5 of last 30 lines, compared to previous check. Same hash = idle.
3. **Time threshold** — idle >20min → kill + respawn with fresh seed.

**Crash-loop protection**: >3 crashes/hour → stop retrying, alert human. Prevents burning API credits.

**Perpetual workers** sleep between cycles. The watchdog reads `sleep_duration` from the registry and waits before respawning. One-shot workers (`perpetual: false`) are not respawned.

## Hooks (`hooks/`)

Four Claude Code hooks registered in `~/.claude/settings.json`:

| Hook | What it does | Why it matters |
|------|-------------|----------------|
| **PreToolUse** | Injects inbox messages + policy context before each tool call | Workers see messages without polling |
| **PostToolUse** | Publishes tool-call events to event bus | Audit trail, side-effects |
| **Stop** | Writes `graceful-stop` sentinel for watchdog | Clean respawn vs crash recovery |
| **PromptSubmit** | Publishes prompt events, triggers inbox sync | Context freshness |

The Stop hook is the lifecycle controller. For bounded work, it blocks until tasks are done. For perpetual workers, it writes the sentinel and lets the watchdog handle respawn timing.

## Registry (`{project}/.claude/workers/registry.json`)

Single source of truth. Everything about a worker is here: model, permissions, status, pane ID, branch, sleep cadence. The MCP server reads it, the launch script writes it, the watchdog checks it.

**`_config`** block stores fleet-wide settings: who merges, who gets commit notifications, tmux session name.

**Atomic writes**: all registry mutations use `mkdir`-based file locks to prevent corruption from concurrent workers.

## Data Flow

```
launch-flat-worker.sh
  → creates worktree on worker/{name}
  → installs post-commit hook
  → starts Claude with seed prompt
  → registers pane in registry.json

Worker runs autonomously:
  → PreToolUse hook injects inbox on each tool call
  → Worker commits → post-commit hook notifies merger
  → Worker calls recycle() → Stop hook writes graceful-stop

Watchdog sees graceful-stop:
  → waits sleep_duration
  → generates fresh seed (reads mission + memory + inbox)
  → respawns Claude in same pane
  → cycle repeats
```

## File Ownership

| Location | What | Lifetime |
|----------|------|----------|
| `~/.claude-fleet/` | Infrastructure (this repo) | All projects |
| `{project}/.claude/workers/` | Worker config + state | Project lifetime |
| `{project}/.claude/workers/{name}/inbox.jsonl` | Durable messages | Append-only |
| `~/.claude-fleet/state/sessions/` | Per-session runtime | ~24h TTL |
| `~/.claude/projects/{path}/memory/` | Claude auto-memory per worktree | Permanent |

## Legacy: Harness System

The older harness system (task graphs, event bus, side-effects, coordinator/worker pattern) still exists at `.claude/harness/` and `lib/event-bus.sh`. It's functional but not the primary model. Flat workers with MCP messaging replaced it for day-to-day use. The event bus is still available for side-effect-driven workflows if needed.
