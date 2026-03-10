# claude-fleet

Lightweight, tmux-based orchestration for Claude Code. Workers run in tmux panes on git worktrees, talk via Fleet Mail, watchdog keeps them alive.

## Install

```bash
git clone git@github.com:qbg-dev/claude-fleet.git ~/.claude-fleet
~/.claude-fleet/bin/fleet setup
```

`fleet setup` checks deps (bun, jq, tmux), creates symlinks, registers the MCP server globally, and creates default config.

## Quick Start

```bash
fleet create my-worker "Fix the login bug"    # create + launch
fleet ls                                      # list workers
fleet stop my-worker                          # graceful stop
fleet start my-worker --model opus --save     # restart with override
```

## Architecture

```
watchdog (launchd, every 30s)
  └── reads registry.json → for each worker:
        alive + running?     → skip
        alive + stuck 10m?   → kill + resume
        alive + sleep done?  → kill + respawn
        dead + perpetual?    → new pane + relaunch
        3+ crashes/hr?       → stop, alert

hooks (settings.json)
  stop-worker-dispatch     → route stop to recycle
  stop-inbox-drain         → block stop if unread messages
  pre-tool-context-injector→ inject fleet context
  post-tool-publisher      → emit events

MCP server (per-project via .mcp.json)
  messaging:  send_message, read_inbox
  state:      get_worker_state (name="all" for fleet), update_state
  tasks:      create_task, update_task, list_tasks
  lifecycle:  recycle (resume=true for hot-restart), create_worker, deregister, standby
```

## Key Files

| File | Purpose |
|------|---------|
| `mcp/worker-fleet/index.ts` | MCP server (12 tools) |
| `scripts/harness-watchdog.sh` | Respawn daemon |
| `scripts/launch-flat-worker.sh` | Create worktree + pane + seed Claude |
| `scripts/init-project.sh` | Bootstrap any repo |
| `scripts/setup-hooks.sh` | Install hooks from manifest |
| `scripts/lint-hooks.sh` | Verify hooks (`--fix` to repair) |
| `hooks/manifest.json` | All 16 hooks |

## Watchdog

Runs via launchd (`com.claude-fleet.harness-watchdog`), checks every 30s.

**Stuck detection**: Liveness heartbeat hook (fires on every tool call, prompt submit, stop) writes epoch to `~/.claude-fleet/state/watchdog-runtime/{worker}/liveness`. Watchdog checks: if `now - liveness > 60s` → stuck. Scrollback MD5 diff as secondary signal.

**Respawn**: Kill Claude → `_record_relaunch(worker, reason)` (increments `watchdog_relaunches` + writes `last_relaunch.{at, reason}` in registry) → touch liveness → rebuild command → send to pane → wait for TUI → inject seed.

```bash
launchctl kickstart -k gui/$(id -u)/com.claude-fleet.harness-watchdog  # restart
bash ~/.claude-fleet/scripts/harness-watchdog.sh --status              # state table
```

## Development

```bash
# Edit + rebuild MCP
cd ~/.claude-fleet/mcp/worker-fleet
vim index.ts
bun build index.ts --target=node --outfile=index.js

# Tests
bash ~/.claude-fleet/tests/run-all.sh

# Hooks
bash ~/.claude-fleet/scripts/setup-hooks.sh      # install
bash ~/.claude-fleet/scripts/lint-hooks.sh --fix  # verify + repair
```

## mission_authority

The `_config.mission_authority` field (defaults to `"chief-of-staff"`) defines the fleet's privileged worker. This worker can:

- **Deregister** any worker (others can only deregister themselves)
- **Standby** any worker (others can only standby themselves)
- **Update state** of any worker (others can only update themselves)
- **Receive all alerts**: watchdog dead-worker notifications, recycle notifications
- **Priority inbox**: seed prompt tells workers to prioritize messages from mission_authority
- **Default report_to**: all new workers report to mission_authority unless overridden

Change it in `registry.json` `_config` to use a different coordinator name.

## Subagent Types

Non-worker agents launched via the Agent tool for specific pre-tasks.

| Type | Doc | Use case |
|------|-----|----------|
| **thoroughly-paranoid-examiner** | `docs/thoroughly-paranoid-examiner.md` | Pre-verification: exhaustively enumerate every user journey before spawning a verifier worker. See `commands/complex-verification.md`. |

## Conventions

- Shell: `set -euo pipefail`, JSON via `jq`, registry locks via `mkdir`
- tmux: never literal `Enter` (use `send-keys -H 0d`), never `display-message -p '#{pane_id}'`
