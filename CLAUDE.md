# claude-fleet

Orchestration for Claude Code agents. Workers run in tmux panes on git worktrees, coordinate via Fleet Mail, watchdog keeps them alive.

## Entry point

`fleet onboard` is the only entry point. It runs `fleet setup` internally, then launches a fleet architect agent that walks you through everything. Ask it anything.

## Architecture

| Package | Purpose |
|---------|---------|
| **claude-fleet** | Core — lifecycle, identity, state, MCP server, CLI |
| **claude-hooks** | Runtime behavior — safety gates, context injection |
| **deep-review** | Multi-pass adversarial code review |
| **fleet-server** | Agent-to-agent messaging (Rust + SQLite) |

## CLI

```
fleet onboard                           # guided setup + fleet design
fleet create <name> "<mission>"         # create + launch worker
fleet start <name>                      # restart worker
fleet stop <name> [--all]               # graceful stop
fleet ls [--json]                       # list with liveness
fleet config <name> [key] [value]       # get/set config
fleet defaults [key] [value]            # global defaults
fleet fork <parent> <child> "<mission>" # fork from existing
fleet log <name>                        # tail output
fleet attach <name>                     # attach tmux pane
fleet mail <name>                       # check inbox
fleet mail-server [connect|start]       # Fleet Mail
fleet mcp [register|status]             # MCP server
fleet run <name> "<command>"            # run in worktree
fleet doctor                            # verify installation
fleet nuke <name>                       # destroy worker
```

Flags: `--model opus|sonnet|haiku`, `--effort high|max`, `--save`, `--json`, `-p <project>`

Resolution: CLI flag > worker `config.json` > `defaults.json` > hardcoded

## MCP tools (20)

Available inside every worker session via `mcp__worker-fleet__*`:

| Tool | What |
|------|------|
| `mail_send(to, subject, body)` | Message workers, coordinators, operator |
| `mail_inbox(label?)` | Read inbox (UNREAD, TASK, INBOX) |
| `mail_read(id)` | Read specific message |
| `mail_help()` | Mail reference |
| `get_worker_state(name?)` | Single worker or fleet overview |
| `update_state(key, value)` | Persist state across recycles |
| `add_hook(event, desc, ...)` | Register dynamic hook |
| `complete_hook(id, result?)` | Mark gate as done |
| `remove_hook(id)` | Remove hook |
| `list_hooks(scope?)` | List active hooks |
| `recycle(message?)` | Clean restart (blocked until gates pass) |
| `save_checkpoint(summary)` | Snapshot state for crash recovery |
| `create_worker(name, type, mission)` | Spawn worker |
| `register_worker(name, config)` | Register existing |
| `deregister_worker(name)` | Remove from registry |
| `move_worker(name, project)` | Move to project |
| `standby_worker(name)` | Toggle standby |
| `fleet_template(type)` | Preview archetype |
| `fleet_help()` | Fleet reference |
| `deep_review(scope, spec)` | Adversarial review |

## Worker types

| Type | Lifecycle | Use case |
|------|-----------|----------|
| implementer | one-shot | Fix bugs, build features |
| optimizer | perpetual | Run evals, fix gaps |
| monitor | perpetual | Watch for anomalies |
| merger | perpetual | Cherry-pick to main, deploy |
| chief-of-staff | perpetual | Relay messages, monitor fleet |
| verifier | one-shot | Exhaustive testing |

Templates: `templates/flat-worker/types/{type}/mission.md`

## Storage

```
~/.claude/fleet/
├── defaults.json
└── {project}/
    ├── fleet.json
    └── {worker}/
        ├── config.json
        ├── state.json
        ├── mission.md
        ├── launch.sh
        └── token
```

## Hooks

40+ hooks across 18 Claude Code events. Installed by `setup-hooks.sh` from `hooks/manifest.json`.

Three ownership tiers: system (irremovable) > creator (worker can't remove) > self (worker manages).

Workers register dynamic hooks at runtime:
```
add_hook(event="Stop", description="verify TypeScript compiles")
add_hook(event="PreToolUse", content="inject this context", condition={file_glob: "src/**"})
complete_hook("dh-1", result="PASS")
```

## Watchdog

launchd daemon (`com.tmux-agents.watchdog`), 30s poll. Respawns dead workers, kills stuck (10min timeout), crash-loop protection (3/hr max). Perpetual workers call `recycle()` — watchdog respawns after `sleep_duration`.

Install: `bash extensions/watchdog/install.sh`

## Key files

| Path | What |
|------|------|
| `cli/index.ts` | CLI entry |
| `cli/commands/` | Subcommands |
| `cli/commands/onboard.ts` | Fleet architect agent |
| `mcp/worker-fleet/index.ts` | MCP server |
| `shared/types.ts` | Canonical types |
| `hooks/manifest.json` | Hook registry |
| `hooks/gates/` | Safety gates |
| `hooks/interceptors/` | Context injection |
| `hooks/publishers/` | Event publishing |
| `extensions/watchdog/` | Watchdog daemon |
| `templates/flat-worker/types/` | Worker archetypes |
| `templates/seed-context.md` | Worker seed context |
| `scripts/setup-hooks.sh` | Hook installer |
| `scripts/lint-hooks.sh` | Hook verifier |

## Conventions

- Workers never push or merge — merger handles main
- Shell scripts: `set -euo pipefail`
- Config locks: `mkdir` atomicity
- tmux: never literal Enter (`send-keys -H 0d`), never `display-message -p '#{pane_id}'`
- All shared types in `shared/types.ts`
- `sleep_duration: null` = one-shot, `N > 0` = perpetual
