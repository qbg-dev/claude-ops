# claude-fleet

Lightweight, tmux-based orchestration for Claude Code. Use as much compute as possible, as effectively as possible.

**The pitch:** Claude Code is powerful but ephemeral — sessions end, context is lost, and you manage one agent at a time. claude-fleet makes workers *persistent* and *parallel*. Each worker gets its own git worktree, tmux pane, and durable memory. A watchdog respawns them on crash. An MCP server gives them 20 tools for messaging, state, hooks, and fleet coordination.

## What You Get

- **Persistent workers** — Watchdog (launchd, every 30s) detects stopped/stuck/crashed workers and respawns them. Workers survive crashes, context compaction, and `/stop`.
- **Git worktree isolation** — Each worker gets its own branch and worktree. Claude Code scopes auto-memory by path, so different worktree = isolated memory. By cycle 50, a worker knows things a fresh session never could.
- **Fleet Mail** — Workers message each other, report to coordinators, and track tasks via a durable mail system (LKML model — tasks are mail threads with labels).
- **Dynamic hooks** — Workers manage their own guardrails at runtime: blocking gates before recycling, context injection on tool use, safety checks on destructive operations. 12 immutable system hooks prevent catastrophic actions (rm -rf, force push, etc.).
- **MCP server** — 20 tools available inside every worker: `mail_send`, `mail_inbox`, `update_state`, `add_hook`, `create_worker`, `recycle`, `deep_review`, and more.
- **Single CLI** — `fleet create`, `fleet start`, `fleet stop`, `fleet ls` — everything from one command.

## Quick Start

```bash
# 1. Clone
git clone git@github.com:qbg-dev/claude-fleet.git ~/.claude-fleet

# 2. Bootstrap (creates symlinks, registers MCP, checks deps)
~/.claude-fleet/bin/fleet setup

# 3. Create your first worker
fleet create my-worker "Fix the login bug in auth.ts"
```

That's it. The worker launches in a tmux pane, reads its mission, and starts working.

## Requirements

| Tool | Install | Why |
|------|---------|-----|
| bun | `curl -fsSL https://bun.sh/install \| bash` | Runs CLI + MCP server |
| tmux | `brew install tmux` | Pane management |
| git | `brew install git` | Worktree isolation |

`fleet setup` checks all of these and tells you what's missing.

## CLI Reference

```bash
fleet setup                              # One-time bootstrap
fleet create <name> "<mission>"          # Create + launch worker
fleet start  <name>                      # Restart existing worker
fleet stop   <name> [--all]              # Graceful stop
fleet ls     [--json]                    # List all workers with liveness
fleet config <name> [key] [value]        # Get/set worker config
fleet defaults [key] [value]             # Global defaults
fleet fork   <parent> <child> "<mission>" # Fork from existing session
fleet log    <name>                      # Tail worker's tmux pane
fleet mail   <name>                      # Check worker's inbox
fleet mcp    [register|status|build]     # Manage MCP server
```

### Flags

```bash
--model opus|sonnet|haiku       # Override model
--effort low|medium|high|max    # Reasoning effort
--window <name>                 # tmux window group
--no-launch                     # Create without launching
--save                          # Persist overrides to config
--json                          # Machine-readable output
```

### Resolution Chain

CLI flag > per-worker `config.json` > `defaults.json` > hardcoded defaults

## Architecture

```
                    fleet CLI
                       │
          ┌────────────┼────────────┐
          │            │            │
      tmux panes   git worktrees  Fleet Mail
          │            │            │
     ┌────┴────┐  ┌────┴────┐  ┌───┴───┐
     │ worker1 │  │ worker2 │  │ mail  │
     │ Claude  │  │ Claude  │  │server │
     │ Code    │  │ Code    │  └───────┘
     └────┬────┘  └────┬────┘
          │            │
     MCP server (20 tools)
          │
     watchdog (launchd, 30s)
```

Each worker = Claude Code session + git worktree + tmux pane + persistent config.

Workers never push or merge. A designated merger handles main.

## Data Model

```
~/.claude/fleet/
├── defaults.json                 # Global defaults (model, effort, permissions)
├── {project}/
│   ├── fleet.json                # Fleet-wide config (tmux session, authorities)
│   ├── {worker-name}/
│   │   ├── config.json           # Settings (model, hooks, permissions, meta)
│   │   ├── state.json            # Runtime (status, pane, session, cycles)
│   │   ├── mission.md            # Worker's prompt/purpose
│   │   ├── launch.sh             # Auto-generated restart command
│   │   └── token                 # Fleet Mail auth token
│   └── missions/                 # Symlinks to worker missions

~/.claude-fleet/                  # Infrastructure (this repo)
├── bin/fleet                     # CLI shim (delegates to TypeScript)
├── cli/                          # TypeScript CLI (citty + Bun)
│   ├── index.ts                  # Entry point
│   ├── commands/                 # Subcommands (create, start, stop, ls, ...)
│   └── lib/                      # Shared modules (config, tmux, paths, fmt)
├── mcp/worker-fleet/             # MCP server (TypeScript)
├── hooks/                        # Claude Code hooks (gates, publishers, interceptors)
├── engine/                       # Hook engine + session logger
├── scripts/                      # Launch, watchdog, git hooks
├── templates/                    # Worker archetypes
└── lib/                          # Shared bash libraries
```

## Hook System

### 12 System Hooks (always active, irremovable)

| What's blocked | Why |
|----------------|-----|
| `rm -rf /`, `~`, `.` | Catastrophic deletion |
| `git reset --hard` | Irreversible state loss |
| `git push --force` | Overwrites shared history |
| `git checkout main` | Workers stay on their branch |
| `git merge` | Workers don't merge — use Fleet Mail |
| Direct edit of `config.json`, `state.json`, `token` | Use MCP tools instead |

### Dynamic Hooks (worker self-governance)

Workers register their own hooks at runtime:

```
# Block recycling until TypeScript compiles
add_hook(event="Stop", description="verify TypeScript compiles")

# Inject context when editing ontology files
add_hook(event="PreToolUse", content="Use applyAction() for ontology writes",
  condition={file_glob: "src/ontology/**"})

# Complete a gate after verification
complete_hook("dh-1", result="PASS — no TS errors")
```

Hooks fire on all Claude Code events: PreToolUse, PostToolUse, Stop, UserPromptSubmit, PreCompact, SubagentStart/Stop, and more.

## Watchdog

The watchdog runs via launchd (every 30s) and keeps workers alive:

1. **Liveness check** — Heartbeat timestamps updated on every prompt/tool use
2. **Stuck detection** — If no activity for 10+ minutes, kill and respawn
3. **Crash-loop protection** — >3 crashes/hour → stop and alert
4. **Perpetual cycles** — Workers call `recycle()` when done; watchdog respawns after `sleep_duration`

Workers don't `sleep` — they exit cleanly, and the watchdog owns the timer.

## MCP Tools (inside workers)

| Tool | Description |
|------|-------------|
| `mail_send(to, subject, body)` | Message workers, coordinators, or the operator |
| `mail_inbox(label?)` | Read inbox (UNREAD, TASK, INBOX) |
| `update_state(key, value)` | Persist state across recycles |
| `add_hook(event, ...)` | Register dynamic hooks (gates or injectors) |
| `complete_hook(id)` | Mark a blocking gate as done |
| `create_worker(name, mission)` | Spawn a new worker |
| `recycle(message?)` | Clean restart (blocked until all gates pass) |
| `save_checkpoint(summary)` | Snapshot working state for crash recovery |
| `deep_review(scope)` | Spawn adversarial reviewer |

[Full reference: 20 tools total](docs/architecture.md)

## Fleet Mail

Workers coordinate via a durable mail server (self-hosted, Rust + Dolt):

- **Messaging**: Direct, broadcast, mailing lists
- **Tasks**: LKML model — tasks are mail threads with labels (`[TASK]`, `P1`, `IN_PROGRESS`)
- **Merge requests**: Workers send structured merge requests to the merger
- **Escalation**: `mail_send(to="user")` reaches the human operator

## Docs

- [Getting Started](docs/getting-started.md) — Installation and first worker
- [Architecture](docs/architecture.md) — Component deep dive
- [Hooks](docs/hooks.md) — Claude Code hook lifecycle
- [Event Bus](docs/event-bus.md) — JSONL event streaming

## License

Apache 2.0
