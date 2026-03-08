# Getting Started

## Prerequisites

git, jq, tmux, bash 4+, bun, Claude Code (authenticated).

## Install

```bash
git clone git@github.com:qbg-dev/claude-ops.git ~/.claude-ops
cd ~/.claude-ops/mcp/worker-fleet && bun install
```

## Set Up a Project

**1. Wire the MCP server** — create `.mcp.json` in your project root. See `mcp/worker-fleet/index.ts` header for the full schema. Minimum:

```jsonc
{
  "mcpServers": {
    "worker-fleet": {
      "command": "bun",
      "args": ["run", "/Users/you/.claude-ops/mcp/worker-fleet/index.ts"],
      "env": { "PROJECT_ROOT": "/path/to/project" }
    }
  }
}
```

**2. Create the registry** — `.claude/workers/registry.json`. The `_config` block sets fleet-wide defaults (who merges, which tmux session, who gets commit notifications):

```jsonc
{
  "_config": {
    "commit_notify": ["merger"],
    "merge_authority": "merger",
    "tmux_session": "w",
    "project_name": "my-project"
  }
}
```

## Launch a Worker

**3. Write a mission** — `.claude/workers/my-worker/mission.md`. The mission is the worker's entire personality and protocol. Good missions have: what to do, when to commit, who to message, and when to recycle. See `templates/flat-worker/types/` for examples per worker type.

**4. Add to registry** — add an entry to registry.json with model, permissions, sleep cadence:

```jsonc
"my-worker": {
  "model": "sonnet",
  "permission_mode": "bypassPermissions",
  "disallowed_tools": ["Bash(git push*)", "Bash(rm -rf*)"],
  "perpetual": true,
  "sleep_duration": 3600,
  "branch": "worker/my-worker",
  "window": "workers"
}
```

**5. Launch** — this creates the worktree, tmux pane, git hooks, seed prompt, and starts Claude:

```bash
bash ~/.claude-ops/scripts/launch-flat-worker.sh my-worker
```

The worker is now autonomous. To create + launch from another running worker:

```
create_worker(name: "my-worker", mission: "...", model: "sonnet", launch: true)
```

## What Happens Under the Hood

`launch-flat-worker.sh` does these things in order:
1. Creates git worktree at `../project-w-my-worker/` on branch `worker/my-worker`
2. Copies `.mcp.json` into worktree (so the worker gets fleet tools)
3. Installs post-commit + commit-msg hooks (auto-notification + trailers)
4. Joins or creates tmux window, splits pane
5. Generates seed prompt via `bun` (reads mission, memory, inbox, registry)
6. Starts Claude Code with `--disallowed-tools` from registry
7. Registers pane ID in registry.json (atomic locked write)

## Watchdog

The watchdog keeps workers alive. Set up as launchd (macOS):

```bash
# See scripts/worker-watchdog.sh header for the full plist template
launchctl load ~/Library/LaunchAgents/com.claude-ops.worker-watchdog.plist
```

It checks every 30s: respawns graceful stops after `sleep_duration`, respawns crashes immediately, kills stuck workers (scrollback unchanged >20min), stops crash-loops (>3/hour).

## Fleet Operations

```bash
bash ~/.claude-ops/scripts/fleet-health.sh          # fleet status + health check
```

From inside any worker: `fleet_status()`, `read_inbox()`, `send_message(to, content)`.

## Key Insight: Memory Through Worktrees

Each worktree has a unique filesystem path → Claude Code's auto-memory is automatically isolated per worker. No configuration needed. Workers accumulate domain knowledge across cycles because the watchdog respawns them in the same worktree.

## Next Steps

- `templates/flat-worker/types/` — implementer, monitor, coordinator templates
- `mcp/worker-fleet/index.ts` — all 15 MCP tools documented in source
- `scripts/launch-flat-worker.sh` — the full launch sequence
- [Architecture](architecture.md) — component diagram and data flow
