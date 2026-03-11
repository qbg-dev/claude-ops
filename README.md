# claude-fleet

Persistent, parallel AI agents on Claude Code.

## Quick start

```bash
fleet onboard
```

`fleet onboard` is the single entry point. It handles everything: dependency checks, Fleet Mail setup, MCP server registration, hook installation, watchdog daemon, and then launches an interactive fleet architect agent that designs your fleet, writes worker missions, and verifies the setup.

After onboarding, verify with `fleet doctor`.

## Dependencies

```
Required:  bun (>=1.0), tmux, git, claude (Claude Code CLI >=1.0)
Auto-installed:  Fleet Mail (boring-mail server — requires Rust/cargo if building locally)
Optional:  boring-mail-tui (Fleet Mail TUI client), oxlint/biome (deep review linting)
```

## After onboarding

```bash
fleet doctor                         # verify installation
fleet create my-worker "Fix the login bug"
fleet ls                             # list workers with liveness
fleet stop my-worker                 # graceful stop
fleet start my-worker                # restart
fleet log my-worker                  # tail output
fleet mail my-worker                 # check inbox
fleet attach my-worker               # attach tmux pane
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
fleet hook <add|rm|ls|complete>         # manage dynamic hooks
fleet doctor                            # verify installation
fleet nuke <name>                       # destroy worker
```

Flags: `--model opus|sonnet|haiku`, `--effort high|max`, `--save`, `--json`, `-p <project>`

Resolution: CLI flag > worker `config.json` > `defaults.json` > hardcoded

## License

Apache 2.0
