# claude-fleet

Orchestration for Claude Code agents. Workers run in tmux panes on git worktrees, coordinate via Fleet Mail, watchdog keeps them alive.

## Entry point

`fleet onboard` is the only entry point. It runs `fleet setup` internally, then launches a fleet architect agent that walks you through everything. Ask it anything.

## Dependencies

```
Required:  bun (>=1.0), tmux, git, claude (Claude Code CLI >=1.0)
Auto-installed:  Fleet Mail (boring-mail server — requires Rust/cargo if building locally)
Optional:  boring-mail-tui (Fleet Mail TUI client), oxlint/biome (deep review linting)
```

## Architecture

| Package | Purpose |
|---------|---------|
| **claude-fleet** | Core — lifecycle, identity, state, MCP server, CLI |
| **claude-hooks** | Runtime behavior — safety gates, context injection |
| **deep-review** | Multi-pass adversarial code review |
| **fleet-server** | Agent-to-agent messaging (Rust + SQLite) |

## CLI

```
fleet onboard                           # guided setup + fleet design (the entry point)
fleet create <name> "<mission>"         # create + launch worker
fleet start <name>                      # restart worker
fleet stop <name> [--all]               # graceful stop
fleet ls [--json]                       # list with liveness
fleet status                            # fleet overview dashboard
fleet completion                        # output shell completion script
fleet config <name> [key] [value]       # get/set config
fleet defaults [key] [value]            # global defaults
fleet fork <parent> <child> "<mission>" # fork from existing
fleet recycle [name]                    # restart with fresh context
fleet log <name>                        # tail output
fleet attach <name>                     # attach tmux pane
fleet mail <name>                       # check inbox
fleet mail-server [connect|start]       # Fleet Mail
fleet mcp [register|status]             # MCP server
fleet run <name> "<command>"            # run in worktree
fleet tui [--account <name>]            # Fleet Mail TUI client
fleet layout <save|restore|list|delete> # tmux layout persistence
fleet deep-review <scope>               # adversarial code review
fleet pipeline <program> [opts]         # launch a program-API pipeline
fleet hook <add|rm|ls|complete>         # manage dynamic hooks
fleet doctor                            # verify installation
fleet nuke <name>                       # destroy worker
```

Flags: `--model opus|sonnet|haiku`, `--effort high|max`, `--save`, `--json`, `-p <project>`

Resolution: CLI flag > worker `config.json` > `defaults.json` > hardcoded

## MCP tools (16)

Available inside every worker session via `mcp__worker-fleet__*`:

| Tool | What |
|------|------|
| `mail_send(to, subject, body)` | Message workers, coordinators, operator |
| `mail_inbox(label?)` | Read inbox (UNREAD, TASK, INBOX) |
| `mail_read(id)` | Read specific message |
| `mail_help()` | Mail reference + curl examples for search, threads, labels |
| `get_worker_state(name?)` | Single worker or fleet overview (name='all') |
| `update_state(key, value)` | Persist state across recycles |
| `add_hook(event, desc, ...)` | Register dynamic hook (gate, inject, or script) |
| `complete_hook(id, result?)` | Mark gate as done (unblocks event) |
| `remove_hook(id)` | Archive a dynamic hook |
| `list_hooks(scope?)` | List active hooks (static + dynamic) |
| `manage_worker_hooks(action, target)` | Cross-worker hook management (add/remove/complete/list) |
| `round_stop(message)` | End work round: checkpoint + handoff + cycle report |
| `save_checkpoint(summary)` | Snapshot state for crash recovery |
| `create_worker(name, mission, type?)` | Spawn worker from within a session |
| `fleet_help()` | Fleet reference docs |
| `deep_review(scope, spec)` | Adversarial multi-pass code review |

## Worker types

| Type | Lifecycle | Use case |
|------|-----------|----------|
| implementer | one-shot | Fix bugs, build features |
| optimizer | perpetual | Run evals, fix gaps |
| monitor | perpetual | Watch for anomalies |
| merger | perpetual | Cherry-pick to main, deploy |
| chief-of-staff | perpetual | Relay messages, monitor fleet |
| verifier | one-shot | Exhaustive testing |
| reviewer | one-shot | Code review |

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

30 hooks across 18 Claude Code events. Installed by `setup-hooks.sh` from `hooks/manifest.json`.

Three ownership tiers: system (irremovable) > creator (worker can't remove) > self (worker manages).

Workers register dynamic hooks at runtime:
```
add_hook(event="Stop", description="verify TypeScript compiles")
add_hook(event="PreToolUse", content="inject this context", condition={file_glob: "src/**"})
complete_hook("dh-1", result="PASS")
```

## Watchdog

launchd daemon (`com.tmux-agents.watchdog`), 30s poll. Respawns dead workers, kills stuck (10min timeout), crash-loop protection (3/hr max). Perpetual workers call `round_stop()` — watchdog respawns after `sleep_duration`.

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
| `extensions/watchdog/` | Watchdog daemon (extension) |
| `extensions/review/` | Deep review rules + pre-commit verification (extension) |
| `templates/flat-worker/types/` | Worker archetypes |
| `templates/seed-context.md` | Worker seed context |
| `cli/commands/tui.ts` | Fleet Mail TUI launcher |
| `cli/commands/layout.ts` | tmux layout persistence |
| `cli/commands/deep-review.ts` | Adversarial code review launcher |
| `cli/commands/pipeline.ts` | Program-API pipeline launcher |
| `scripts/setup-hooks.sh` | Hook installer |
| `scripts/lint-hooks.sh` | Hook verifier |
| `REVIEW.md` | Symlink → `extensions/review/REVIEW.md` |

## Troubleshooting

**Fleet Mail contention**: If `mail_send` fails under load, fleet-server uses SQLite WAL mode with 30s `busy_timeout`. The MCP client retries 3x with exponential backoff.

**Token issues**: Run `fleet doctor` to verify tokens. Reset with `fleet mail-server connect <url> --token <token>`.

**Worker stuck**: Check `fleet ls` for pane health. Kill with `fleet stop <name>`. Watchdog auto-restarts perpetual workers (those with `sleep_duration > 0`).

**Fleet Mail unreachable**: Run `fleet mail-server status` to check connectivity. If using a remote server, verify the URL with `fleet mail-server connect <url>`. If building locally, ensure Rust/cargo is installed.

## Conventions

- Workers never push or merge — merger handles main
- Shell scripts: `set -euo pipefail`
- Config locks: `mkdir` atomicity
- tmux: never literal Enter (`send-keys -H 0d`), never `display-message -p '#{pane_id}'`
- All shared types in `shared/types.ts`
- `sleep_duration: null` = one-shot, `N > 0` = perpetual
- Extensions live in `extensions/{name}/` with a `manifest.json` (name, version, description, what it provides)
