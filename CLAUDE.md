# claude-fleet

Orchestration for Claude Code agents. Workers run in tmux panes on git worktrees, coordinate via Fleet Mail, watchdog keeps them alive.

- **Entry point**: `fleet onboard`—runs setup and launches a fleet architect agent. Run `fleet --help` for all CLI commands.
- **MCP tools**: Available in worker sessions as `mcp__worker-fleet__*`. Call `fleet_help()` for full reference on all 16 tools.
- **Hooks**: Runtime gates, injectors, and scripts on 18 Claude Code events. Call `mcp__claude-hooks__list_hooks()` to see active hooks; tool schemas on `add_hook` document all options.
- **Conventions**: Workers never push/merge (merger handles main). tmux: never literal Enter (`send-keys -H 0d`), never `display-message -p '#{pane_id}'`.

## CLI

```
fleet onboard                           # guided setup + fleet design (the entry point)
fleet setup [--extensions]              # bootstrap infrastructure
fleet create <name> "<mission>"         # create + launch worker
fleet start <name>                      # restart worker
fleet stop <name> [--all]               # graceful stop
fleet list|ls [--json]                  # list with liveness
fleet status                            # fleet overview dashboard
fleet completion                        # output shell completion script
fleet get <name>                        # show worker mission + info
fleet register [--name <n>]            # register session with Fleet Mail
fleet session ls|info|sync              # session lifecycle
fleet state get|set                     # persistent key-value state
fleet checkpoint "<summary>"            # save state checkpoint
fleet attach <name>                     # attach tmux pane
fleet config <name> [key] [value]       # get/set config
fleet defaults [key] [value]            # global defaults
fleet fork <parent> <child> "<mission>" # fork from existing
fleet recycle [name]                    # restart with fresh context
fleet log <name>                        # tail output
fleet mail send|inbox|read|help         # Fleet Mail communication
fleet mail-server [connect|start]       # Fleet Mail server
fleet mcp [register|status]             # MCP server
fleet run <name> "<command>"            # run in worktree
fleet tui [--account <name>]            # Fleet Mail TUI client
fleet layout <save|restore|list|delete> # tmux layout persistence
fleet deep-review <scope>               # adversarial code review
fleet pipeline <program> [opts]         # launch a program-API pipeline
fleet hook <add|rm|ls|complete>         # manage dynamic hooks
fleet launch                            # launch fleet from manifest
fleet deploy <host> <repo-url>          # deploy fleet to remote
fleet doctor                            # verify installation
fleet nuke <name>                       # destroy worker
fleet update [--reload] [--extensions]  # pull + reinstall + setup
fleet completion                        # output shell completion
```

## Key files

| Path | What |
|------|------|
| `cli/index.ts` | CLI entry |
| `cli/commands/` | Subcommands |
| `cli/commands/register.ts` | Session auto-registration |
| `cli/commands/mail.ts` | Fleet Mail send/inbox/read/help |
| `cli/commands/state.ts` | Persistent key-value state |
| `cli/commands/checkpoint.ts` | State checkpoint |
| `cli/commands/session.ts` | Session lifecycle (ls/info/sync) |
| `cli/commands/onboard.ts` | Fleet architect agent |
| `cli/lib/mail-client.ts` | CLI-level Fleet Mail HTTP client |
| `shared/identity.ts` | Session-first identity resolution |
| `shared/types.ts` | Canonical types |
| `mcp/worker-fleet/index.ts` | MCP server (16 tools) |
| `hooks/manifest.json` | Hook registry |
| `templates/seed-context.md` | Worker seed context |
| `config/tmux.conf` | Agent-optimized tmux config |

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

## MCP tools (16)

Available inside every worker session via `mcp__worker-fleet__*`. Call `fleet_help()` or `mail_help()` for full reference.

## Hooks

45 hooks across 18 Claude Code events. Installed by `setup-hooks.sh` from `hooks/manifest.json`.


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
