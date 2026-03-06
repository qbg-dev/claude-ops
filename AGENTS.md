# claude-ops — Agent Bootstrap Reference

> Single-file reference. An agent can curl this and immediately understand the system.
>
> ```bash
> curl -fsSL https://raw.githubusercontent.com/qbg-dev/claude-ops/main/AGENTS.md
> ```

---

## Core Idea

Each worker is a Claude Code session in a tmux pane, on its own git worktree. Workers commit on their branch, talk via MCP, and a watchdog respawns them. Memory persists across restarts because Claude Code scopes auto-memory by filesystem path — different worktree = different memory.

---

## Quick Launch

```bash
# 1. Write a mission
mkdir -p .claude/workers/my-worker
cat > .claude/workers/my-worker/mission.md << 'EOF'
# my-worker
## Mission
What this worker does.
## Cycle Protocol
1. read_inbox(), rebase onto main
2. Do the work, commit
3. send_message to merger with merge request
4. recycle()
EOF

# 2. Add to registry.json (see below for schema)

# 3. Launch
bash ~/.claude-ops/scripts/launch-flat-worker.sh my-worker
```

Or from a running worker: `create_worker(name: "my-worker", mission: "...", launch: true)`

---

## Registry Schema

`.claude/workers/registry.json` — single source of truth for all workers:

```jsonc
{
  "_config": {
    "commit_notify": ["merger"],     // who gets post-commit notifications
    "merge_authority": "merger",     // who merges to main
    "tmux_session": "w",            // tmux session name
    "project_name": "my-project"
  },
  "my-worker": {
    "model": "sonnet",                        // or "opus"
    "permission_mode": "bypassPermissions",
    "disallowed_tools": ["Bash(git push*)"],  // permission sandbox
    "perpetual": true,                        // true = respawn after sleep
    "sleep_duration": 3600,                   // seconds between cycles
    "branch": "worker/my-worker",
    "window": "workers",                      // tmux window group
    "report_to": "chief-of-staff",             // who manages this worker
    // Auto-populated by launch script + MCP:
    "status": "running",                      // idle|running|sleeping
    "pane_id": "%42",
    "pane_target": "w:workers.0",
    "session_id": "abc123...",
    "cycles_completed": 5,
    "last_commit_sha": "def456..."
  }
}
```

---

## MCP Tools (15)

Loaded via `.mcp.json`. Identity auto-detected from git branch. Source: `mcp/worker-fleet/index.ts`.

| Tool | What |
|------|------|
| `send_message(to, content, summary)` | Send to worker name, "report", "direct_reports", or "all" |
| `read_inbox()` | Drain durable inbox (JSONL). Returns structured messages |
| `fleet_status()` | All workers: status, branch, pane, last commit |
| `get_worker_state(worker)` | Another worker's full state |
| `update_state(key, value)` | Update own state (status, counters) |
| `create_task(subject, priority)` | Add to own task list |
| `update_task(task_id, status)` | Move task through pending→in_progress→completed |
| `list_tasks()` | Show own task list |
| `recycle()` | End cycle gracefully, watchdog respawns |
| `heartbeat()` | Confirm alive, bump counters |
| `create_worker(name, mission, ...)` | Create + launch; fork_from_session=true inherits context |
| `check_config()` | Lint registry for misconfigurations |
| `reload()` | Re-read registry without restart |
| `deregister()` | Remove self from registry |
| `standby()` | Put worker in standby (registered but not running) |

**Messaging insight**: writes to `inbox.jsonl` first (durable, survives crashes), then delivers via tmux (instant). Two-phase = never lost.

---

## Worker Types

Templates at `~/.claude-ops/templates/flat-worker/types/`:

| Type | `perpetual` | Key permissions | Use case |
|------|------------|----------------|----------|
| **implementer** | false | Read-write, no push | Task-backlog-driven fixes and features |
| **optimizer** | true | Read-write, no push | Eval-driven: run evals, fix worst gaps, prove improvement |
| **monitor** | true | Read-only (no Edit/Write) | Watch for anomalies, report to coordinator |
| **coordinator** | true | Full + merge + deploy | Merge branches, deploy prod, triage reports |

---

## Git Discipline

- **One branch per worker**: `worker/{name}` — never shared, never pushed by workers
- **Post-commit hook** (`scripts/worker-post-commit-hook.sh`): auto-notifies merger on every commit
- **Commit-msg hook**: adds `Worker:` and `Cycle:` trailers for traceability
- **Merge protocol**: worker sends structured merge request via `send_message` → merger cherry-picks to main → merger deploys → worker verifies → ACK

---

## Watchdog

`scripts/worker-watchdog.sh` — launchd daemon, checks every 30s.

| State | Detection | Action |
|-------|-----------|--------|
| Graceful stop | `graceful-stop` file | Wait `sleep_duration`, respawn |
| Crash | Pane died, no sentinel | Respawn immediately |
| Stuck >20min | Scrollback md5 unchanged | Kill + respawn |
| Crash-loop | >3/hour | Stop, notify human |

**Key insight**: stuck detection uses scrollback hash diff, not bus events. No instrumentation needed — works with any Claude session.

---

## Hooks

Four hooks in `~/.claude/settings.json` (registered by install.sh):

| Hook | Script | Purpose |
|------|--------|---------|
| PreToolUse | `hooks/interceptors/pre-tool-context-injector.sh` | Inject inbox + policy before tool calls |
| PostToolUse | `hooks/publishers/post-tool-publisher.sh` | Publish tool-call events |
| Stop | `hooks/gates/stop-worker-dispatch.sh` | Write graceful-stop sentinel |
| PromptSubmit | `hooks/publishers/prompt-publisher.sh` | Inbox sync trigger |

---

## Key Files

| Path | What |
|------|------|
| `scripts/launch-flat-worker.sh` | Full launch sequence (worktree + tmux + hooks + seed + register) |
| `scripts/worker-watchdog.sh` | Respawn daemon |
| `mcp/worker-fleet/index.ts` | MCP server — all 15 tools |
| `lib/fleet-jq.sh` | Registry read/write, task helpers, atomic JSON ops |
| `templates/flat-worker/types/` | Worker type templates (implementer/monitor/coordinator) |
| `scripts/worker-post-commit-hook.sh` | Git hook: auto-notify merger |
| `scripts/check-flat-workers.sh` | Fleet status table |

---

## Legacy: Harness System

The older harness model (task graphs at `.claude/harness/`, event bus at `lib/event-bus.sh`, side-effects at `bus/side-effects/`) is still functional. It uses `scaffold.sh` to create harnesses with `tasks.json` dependency graphs and coordinator/worker delegation.

Flat workers replaced it for daily use. The harness system remains for complex multi-phase work that benefits from formal task dependencies and bus-driven side-effects.

Key files if you need it: `scripts/scaffold.sh`, `lib/event-bus.sh`, `lib/harness-jq.sh`, `bus/schema.json`.
