# claude-fleet

claude-fleet runs persistent, parallel Claude Code agents on your codebase. Each worker gets its own git worktree, tmux pane, and mailbox — coordinated by hooks and a watchdog that keeps them alive. It aims to be minimal, and does not rebuilt any native claude code features, but orchestrates on top of subagents and agent teams.

## Quick start

Requires: bun (>=1.0), tmux, git, claude (Claude Code CLI >=1.0).

```bash
git clone https://github.com/qbg-dev/claude-fleet && cd claude-fleet
bun install && bun link
fleet onboard
```

This walks you through setup interactively. When it finishes:

```
$ fleet ls
NAME        STATUS   BRANCH              PANE
my-worker   alive    worker/my-worker     %3
merger      alive    worker/merger        %4
```

## How it works

The system is described by two prompts. See them for more detailed explanations:

- [**templates/seed-context.md**](templates/seed-context.md) — what every worker sees on launch. MCP tools, hooks, mail, git safety, verification, the perpetual loop.
- [**templates/onboarding-architect.md**](templates/onboarding-architect.md) — what the onboarding agent follows.

## Reference

- [CLAUDE.md](CLAUDE.md) — architecture, key files, development conventions
- [plugins/](plugins/README.md) — available plugins (context orchestrator, Gmail, Calendar, spending tracker)
- [extensions/](extensions/) — watchdog (auto-respawn), deep-review (adversarial code review)
- [fleet-server](https://github.com/qbg-dev/fleet-server) — Fleet Mail messaging server (Rust + SQLite)

## Usage

```
fleet onboard                           # guided setup (the entry point)
fleet create <name> "<mission>"         # create + launch worker
fleet ls [--json]                       # list workers with liveness
fleet start <name>                      # restart worker
fleet stop <name> [--all]               # graceful stop
fleet attach <name>                     # attach tmux pane
fleet log <name>                        # tail output
fleet mail <name>                       # check inbox
fleet doctor                            # verify installation
fleet nuke <name>                       # destroy worker
```

Full command list: `fleet --help`

Flags: `--model opus|sonnet|haiku`, `--effort high|max`, `--json`, `-p <project>`

Apache-2.0
