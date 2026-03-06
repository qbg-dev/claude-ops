# claude-ops — Worker Fleet Infrastructure for Claude Code

Run fleets of autonomous Claude Code agents. Each worker = one git worktree + one tmux pane + one persistent memory. Workers commit on their own branches, talk via MCP, and a watchdog respawns them forever.

## The Key Insight

Claude Code scopes auto-memory by filesystem path. **Git worktrees give each worker a different path, so each worker gets isolated persistent memory for free.** By cycle 50, a worker knows things a fresh session never could.

```
project-w-merger/        → memory at ~/.claude/projects/...-w-merger/memory/
project-w-optimizer/     → memory at ~/.claude/projects/...-w-optimizer/memory/
project-w-patrol/        → memory at ~/.claude/projects/...-w-patrol/memory/
```

## How It Works

1. **Launch** creates a git worktree on `worker/{name}`, opens a tmux pane, starts Claude with a seed prompt
2. **Worker** reads its mission, does work, commits on its branch, messages the merger
3. **Watchdog** detects when Claude stops or crashes, respawns after a configurable sleep
4. **MCP server** gives workers 15 tools: messaging, tasks, state, fleet visibility
5. **Git hooks** auto-notify the merger on every commit, add Worker/Cycle trailers

Workers never push or merge. One designated merger handles main. This is enforced by `--disallowed-tools`.

## Quick Start

```bash
# 1. Install
git clone git@github.com:qbg-dev/claude-ops.git ~/.claude-ops
cd ~/.claude-ops/mcp/worker-fleet && bun install

# 2. In your project, create .mcp.json (see mcp/worker-fleet/index.ts header for schema)
# 3. Create .claude/workers/registry.json (see templates/flat-worker/ for examples)
# 4. Create .claude/workers/my-worker/mission.md

# 5. Launch
bash ~/.claude-ops/scripts/launch-flat-worker.sh my-worker
```

Or create workers from any running worker: `create_worker(name: "my-worker", mission: "...", launch: true)`

## Key Concepts

| Concept | What | Where to look |
|---------|------|---------------|
| **Registry** | Single source of truth for all workers (config, state, pane info) | `.claude/workers/registry.json` |
| **Mission** | What a worker does, its cycle protocol | `.claude/workers/{name}/mission.md` |
| **MCP tools** | 15 tools: messaging, tasks, state, fleet | `mcp/worker-fleet/index.ts` |
| **Watchdog** | Respawns workers on stop/crash, detects stuck | `scripts/worker-watchdog.sh` |
| **Git hooks** | Auto-notify merger, add trailers | `scripts/worker-post-commit-hook.sh` |
| **Permission sandbox** | `disallowed_tools` in registry enforced at launch | `scripts/launch-flat-worker.sh` |
| **Worker types** | implementer / optimizer / monitor / coordinator | `templates/flat-worker/types/` |
| **Seed generation** | Builds the initial prompt from mission + memory + inbox | `mcp/worker-fleet/index.ts:generateSeedContent()` |

## Communication Model

Workers use MCP tools (not shell scripts) to talk:

- `send_message(to, content)` — durable (inbox.jsonl) + instant (tmux delivery)
- `read_inbox()` — drain messages, returns structured list
- `fleet_status()` — see every worker's status, branch, pane, last commit
- `get_worker_state(worker)` — read another worker's detailed state

Messages survive crashes. Workers check inbox at cycle start.

## Git Discipline

- One branch per worker (`worker/{name}`), never shared
- Workers commit freely, never push — merger is the single gatekeeper
- Post-commit hook auto-notifies merger on every commit
- Commit-msg hook adds `Worker:` / `Cycle:` trailers
- Merge requests sent via `send_message` with structured format

## Docs

| Doc | When to read |
|-----|-------------|
| [Getting Started](docs/getting-started.md) | First-time setup, launching your first worker |
| [Architecture](docs/architecture.md) | How components connect, data flow, file ownership |
| [Hooks](docs/hooks.md) | PreToolUse context injection, Stop hook lifecycle |
| [Event Bus](docs/event-bus.md) | Legacy pub/sub system (still available, not primary) |

## License

Apache 2.0
