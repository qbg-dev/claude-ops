# claude-fleet

Persistent, parallel AI agents with lifecycle management, runtime hooks, and adversarial code review.

Built on Claude Code. Each agent gets a name, a mission, a git worktree, and durable memory that survives restarts. A watchdog respawns crashed agents. A mail server coordinates them. Dynamic hooks inject behavior at runtime.

We run 20-30 agents simultaneously on production codebases. This is the orchestration layer that makes that work.

## The system

Four composable packages. Each is useful alone. Together they form a fleet.

| Package | What it does | Repo |
|---------|-------------|------|
| **claude-fleet** (this repo) | Core orchestration — agent lifecycle, identity, state, coordination | [qbg-dev/claude-fleet](https://github.com/qbg-dev/claude-fleet) |
| **claude-hooks** | Runtime behavior injection — safety gates, context injection, dynamic hooks | [qbg-dev/claude-hooks](https://github.com/qbg-dev/claude-hooks) |
| **deep-review** | Multi-pass adversarial code review with confidence voting and judge validation | [qbg-dev/deep-review](https://github.com/qbg-dev/deep-review) |
| **fleet-server** | Durable agent-to-agent messaging (Rust + SQLite) | [qbg-dev/fleet-server](https://github.com/qbg-dev/fleet-server) |

```
                    fleet CLI
                        |
        +---------------+---------------+
        |               |               |
   claude-fleet    claude-hooks     deep-review
   (lifecycle)     (behavior)      (review)
        |               |               |
        +-------+-------+               |
                |                        |
          fleet-server              (standalone)
          (coordination)
```

Install any subset. `claude-fleet` alone gives you persistent agents. Add `claude-hooks` for runtime safety rails. Add `deep-review` for adversarial code review. `fleet-server` enables multi-agent coordination.

## Quick start

```bash
# Install
curl -fsSL https://raw.githubusercontent.com/qbg-dev/claude-fleet/main/install.sh | bash
fleet setup

# Create a worker
fleet create my-worker "Fix the login bug in auth.ts"

# Manage
fleet ls                          # list workers
fleet stop my-worker              # graceful stop
fleet start my-worker             # restart
fleet log my-worker               # tail output
fleet mail my-worker              # check inbox
```

## Key ideas

**Persistent identity.** Workers keep their mission, memory, and config across sessions. The worktree is the memory. By cycle 50, a worker's auto-memory knows things a fresh session never could.

**Dynamic hooks.** Workers register PreToolUse hooks to inject context when touching specific files, Stop hooks to block exit until checks pass. Memory as executable code, not static files. We tried complex memory systems and they weren't worth it. Hooks were.

**Agents spawn agents.** Workers use `create_worker` to parallelize work, coordinate results via mail, then merge. A worker's natural workflow: receive mission, break into subtasks, spawn workers, coordinate via mail, aggregate results.

**Adversarial review.** Multiple reviewers with different specializations examine the same code. Confidence voting filters noise. A judge agent does adversarial validation. Material findings are additive. Catches bugs that single-pass review misses.

**Boring infrastructure.** Mail server is Rust + SQLite. State is JSON files on disk. Coordination is LKML-style threads with labels. No databases, no queues, no distributed systems. Everything works both from the terminal and from inside a worker.

## What's inside

- **CLI** — `fleet create/start/stop/ls/config/log/mail/attach/fork/run` (TypeScript + Bun)
- **MCP server** — 20 tools available inside every worker (`mail_send`, `add_hook`, `create_worker`, `deep_review`, `update_state`, etc.)
- **Watchdog** — launchd daemon that monitors agents, detects stuck/crashed workers, respawns them
- **Templates** — seed context that gives workers their identity and operational knowledge

## Requirements

Claude Code, Bun, tmux, git. `fleet setup` checks all of these.

Fleet Mail is required for multi-agent coordination:

```bash
fleet mail-server start                    # local server
fleet mail-server connect http://host:8025 # or connect to existing
```

## License

Apache 2.0
