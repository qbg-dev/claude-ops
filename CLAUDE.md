# claude-fleet

Lightweight, tmux-based orchestration for Claude Code. Workers run in tmux panes on git worktrees, talk via Fleet Mail, watchdog keeps them alive.

## Install

```bash
git clone git@github.com:qbg-dev/claude-fleet.git ~/.claude-fleet
~/.claude-fleet/bin/fleet setup
```

`fleet setup` checks deps (bun, tmux, claude), creates symlinks, registers the MCP server globally, verifies Fleet Mail connectivity, and creates default config.

**Fleet Mail must be reachable before setup.** If you don't have one:
```bash
fleet mail-server start                           # local server (requires fleet-server binary)
fleet mail-server connect http://server:8025      # existing server
```

## Quick Start

```bash
fleet create my-worker "Fix the login bug"    # create + launch
fleet ls                                      # list workers
fleet stop my-worker                          # graceful stop
fleet start my-worker --model opus --save     # restart with override
```

## Architecture

```
                    fleet CLI (commander + Bun)
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

### Storage Model

Per-worker directories at `~/.claude/fleet/{project}/{name}/`:

```
~/.claude/fleet/
├── defaults.json                 # Global defaults (model, effort, permissions)
├── {project}/
│   ├── fleet.json                # Fleet-wide config (tmux session, authorities)
│   └── {worker-name}/
│       ├── config.json           # Settings (model, hooks, permissions, meta)
│       ├── state.json            # Runtime (status, pane, session, cycles)
│       ├── mission.md            # Worker's prompt/purpose
│       ├── launch.sh             # Auto-generated restart command
│       └── token                 # Fleet Mail auth token
```

Config resolution: CLI flag > per-worker `config.json` > `defaults.json` > hardcoded defaults.

## Key Files

| File | Purpose |
|------|---------|
| `cli/index.ts` | CLI entry point (commander + Bun) |
| `cli/commands/` | 16 subcommands (create, start, stop, ls, config, ...) |
| `cli/lib/` | Shared modules (config, tmux, paths, fmt, launch) |
| `mcp/worker-fleet/index.ts` | MCP server entry (20 tools) |
| `mcp/worker-fleet/*.ts` | Extracted modules (config, state, hooks, mail, seed, tmux, ...) |
| `shared/types.ts` | Canonical types shared between CLI and MCP |
| `hooks/manifest.json` | All 40+ hooks (system, project, dynamic) |
| `hooks/gates/` | PreToolUse blocking gates (tool-policy, git-safety) |
| `hooks/interceptors/` | Context injection (pre-tool-context-injector) |
| `hooks/publishers/` | Event publishing (heartbeat, prompt, post-tool) |
| `scripts/harness-watchdog.sh` | Respawn daemon (launchd, 30s) |
| `scripts/launch-flat-worker.sh` | Create worktree + pane + seed Claude |
| `scripts/deep-review.sh` | Multi-pass adversarial review pipeline |
| `scripts/setup-hooks.sh` | Install hooks from manifest |
| `scripts/lint-hooks.sh` | Verify hooks (`--fix` to repair) |
| `templates/flat-worker/types/` | 6 worker archetypes |
| `templates/deep-review/` | Review pipeline templates (worker, coordinator, judge) |
| `tools/dr-context/` | Rust binary for deep review context analysis |
| `tui/` | Terminal UI (React Ink) |

## CLI Reference

```bash
fleet setup                              # One-time bootstrap
fleet create <name> "<mission>"          # Create + launch worker
fleet start  <name>                      # Restart existing worker
fleet stop   <name> [--all]              # Graceful stop
fleet ls     [--json]                    # List all workers with liveness
fleet status                             # Dashboard (default when no subcommand)
fleet config <name> [key] [value]        # Get/set worker config
fleet defaults [key] [value]             # Global defaults
fleet fork   <parent> <child> "<mission>" # Fork from existing session
fleet log    <name>                      # Tail worker's tmux pane
fleet attach <name>                      # Attach to worker's tmux pane
fleet mail   <name>                      # Check worker's inbox
fleet mail-server [connect|start|status] # Manage Fleet Mail server
fleet mcp    [register|status|build]     # Manage MCP server
fleet run    <name> "<command>"          # Run command in worker's worktree
```

### Flags

```bash
--model opus|sonnet|haiku       # Override model
--effort low|medium|high|max    # Reasoning effort
--window <name>                 # tmux window group
--no-launch                     # Create without launching
--save                          # Persist overrides to config
--json                          # Machine-readable output
-p, --project <name>            # Override project detection
```

## MCP Tools (20 tools, available inside every worker)

| Category | Tool | Description |
|----------|------|-------------|
| **Mail** | `mail_send(to, subject, body)` | Message workers, coordinators, or the operator |
| | `mail_inbox(label?)` | Read inbox (UNREAD, TASK, INBOX) |
| | `mail_read(thread_id)` | Read specific thread |
| | `mail_help()` | Show mail commands |
| **State** | `get_worker_state(name?)` | Get single worker or all fleet state |
| | `update_state(key, value)` | Persist state across recycles |
| **Hooks** | `add_hook(event, description, ...)` | Register dynamic hooks (gates or injectors) |
| | `complete_hook(id, result?)` | Mark blocking gate as done |
| | `remove_hook(id)` | Remove non-system hook |
| | `list_hooks(scope?)` | List active dynamic hooks |
| **Lifecycle** | `recycle(message?)` | Clean restart (blocked until all gates pass) |
| | `save_checkpoint(summary)` | Snapshot working state for crash recovery |
| **Fleet** | `create_worker(name, type, mission)` | Spawn a new worker |
| | `register_worker(name, config)` | Register existing worker |
| | `deregister_worker(name)` | Deregister worker (mission_authority only) |
| | `move_worker(name, project)` | Move worker to different project |
| | `standby_worker(name)` | Mark as standby (mission_authority only) |
| | `fleet_template(type)` | Preview worker archetype template |
| | `fleet_help()` | Show fleet commands |
| **Review** | `deep_review(scope, spec, ...)` | Launch multi-pass adversarial review pipeline |

## Hook System

### Universal Fleet Gates (12 system hooks, irremovable)

Enforced via `hooks/gates/tool-policy-gate.sh`:

| Category | Blocked |
|----------|---------|
| **Tmux destruction** | `kill-session`, `kill-window`, `kill-server` |
| **Git destruction** | `push --force`, `reset --hard`, `clean -f`, `checkout .`, `branch -D` |
| **Git workflow** | `checkout main`, `merge` (workers don't merge) |
| **Config protection** | Direct edits to `config.json`, `state.json`, `token` |
| **File destruction** | `rm -rf` |
| **Process killing** | `kill/pkill/killall claude` |

### Dynamic Hooks (worker self-governance)

Workers register their own hooks at runtime via `add_hook()`:

```
# Block recycling until TypeScript compiles
add_hook(event="Stop", description="verify TypeScript compiles")

# Inject context when editing ontology files
add_hook(event="PreToolUse", content="Use applyAction() for ontology writes",
  condition={file_glob: "src/ontology/**"})

# Complete a gate after verification
complete_hook("dh-1", result="PASS — no TS errors")
```

Hook events: PreToolUse, PostToolUse, Stop, UserPromptSubmit, PreCompact, SubagentStart/Stop.

Hook ownership tiers: **system** (irremovable) > **creator** (worker can't remove) > **self** (worker manages).

## Watchdog

Runs via launchd (`com.claude-fleet.harness-watchdog`), checks every 30s:

1. **Liveness check** — Heartbeat timestamps updated on every prompt/tool use
2. **Stuck detection** — No activity for 10+ minutes → kill and respawn
3. **Crash-loop protection** — >3 crashes/hour → stop and alert
4. **Memory-leak recycling** — Workers exceeding memory thresholds get gracefully recycled
5. **Perpetual cycles** — Workers call `recycle()` when done; watchdog respawns after `sleep_duration`

```bash
launchctl kickstart -k gui/$(id -u)/com.claude-fleet.harness-watchdog  # restart
bash ~/.claude-fleet/scripts/harness-watchdog.sh --status              # state table
```

## Worker Archetypes

Six built-in types. Use `fleet_template(type)` to preview.

| Type | Lifecycle | Access | Use case |
|------|-----------|--------|----------|
| **implementer** | One-shot or cycled | Read-write, no push | Task-backlog-driven: fix bugs, build features |
| **optimizer** | Perpetual | Read-write, no push | Eval-driven: run evals, fix worst gaps |
| **monitor** | Perpetual | Read-only | Watch for anomalies, report to chief-of-staff |
| **merger** | Perpetual | Full + cherry-pick + deploy | Cherry-pick worker commits to main |
| **chief-of-staff** | Perpetual | Read + message only | Comms hub: relay messages, monitor fleet health |
| **verifier** | One-shot | Read-write, no push | Exhaustive testing against generated checklists |

## mission_authority

The `mission_authority` field in `fleet.json` (defaults to `"chief-of-staff"`) defines the fleet's privileged worker:

- **Deregister/standby** any worker (others can only act on themselves)
- **Update state** of any worker
- **Receive all alerts** from watchdog (dead-worker, recycle notifications)
- **Priority inbox**: workers prioritize messages from mission_authority

## Development

```bash
# MCP server runs as TypeScript via bun (no build step)
# Edit mcp/worker-fleet/*.ts, restart Claude Code to pick up changes

# Tests
bash tests/run-all.sh
cd tools/dr-context && cargo test    # Rust tests

# Hooks
bash scripts/setup-hooks.sh          # install from manifest
bash scripts/lint-hooks.sh --fix     # verify + repair

# Rebuild dr-context binary
cd tools/dr-context && cargo build --release
cp target/release/dr-context ../../bin/dr-context
codesign -s - ../../bin/dr-context   # macOS ad-hoc sign
```

## Conventions

- Shell: `set -euo pipefail`, JSON via `jq`, config locks via `mkdir`
- tmux: never literal `Enter` (use `send-keys -H 0d`), never `display-message -p '#{pane_id}'`
- Types: all shared types live in `shared/types.ts` — CLI and MCP both import from there
- Hooks: 3 ownership tiers (system > creator > self), gates block via exit code
- Workers: never push/merge, communicate via Fleet Mail, merger handles main
