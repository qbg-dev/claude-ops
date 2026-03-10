# Getting Started

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- [bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- [tmux](https://github.com/tmux/tmux) — `brew install tmux`
- git

## Install

```bash
git clone git@github.com:qbg-dev/claude-fleet.git ~/.claude-fleet
~/.claude-fleet/bin/fleet setup
```

`fleet setup` checks deps, creates symlinks, registers the MCP server in `~/.claude/settings.json`, creates default config, and verifies Fleet Mail connectivity.

If `~/.local/bin` isn't in your PATH:
```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
```

## Fleet Mail

Fleet Mail is required before setup. Workers use it for coordination.

```bash
fleet mail-server start                    # start local (requires fleet-server binary)
fleet mail-server connect http://host:8025 # or connect to existing
fleet mail-server status                   # check connection
```

## First Worker

```bash
tmux new -s w                              # start tmux (if not already in one)
fleet create my-worker "Fix the login bug"
```

This creates config + worktree + tmux pane, provisions a Fleet Mail account, launches Claude Code, and injects the mission.

Worker files at `~/.claude/fleet/{project}/my-worker/`:
- `config.json` — model, effort, hooks, permissions
- `state.json` — status, pane, session history
- `mission.md` — the worker's purpose
- `launch.sh` — auto-generated restart command
- `token` — Fleet Mail auth

Git worktree at `../{project}-w-my-worker` on branch `worker/my-worker`.

## Managing Workers

```bash
fleet ls                          # list workers (with liveness)
fleet log my-worker               # tail output
fleet stop my-worker              # graceful stop
fleet start my-worker             # restart
fleet start my-worker --model sonnet --save  # restart with override, persist
fleet stop --all                  # stop everything
```

## Configuration

```bash
fleet config my-worker                    # show full config
fleet config my-worker model sonnet       # set value (regenerates launch.sh)
fleet config my-worker sleep_duration 900 # 15-min respawn cycle

fleet defaults                            # show global defaults
fleet defaults model sonnet               # all new workers use sonnet
```

Resolution: CLI flag > worker `config.json` > `defaults.json` > hardcoded defaults

## Persistent Workers

Set `sleep_duration` to make a worker perpetual. The watchdog (launchd, 30s) handles the lifecycle:

1. Worker does work, calls `recycle()` when done
2. Watchdog waits `sleep_duration` seconds
3. Watchdog respawns Claude in the same pane with a fresh seed
4. Cycle repeats

Crash recovery: dead panes detected and relaunched. Stuck detection: idle >10min → kill and respawn. Crash-loop protection: >3 crashes/hr → stop.

## Dynamic Hooks

Workers register their own guardrails at runtime:

```
add_hook(event="Stop", description="verify TypeScript compiles")
complete_hook("dh-1", result="PASS — no TS errors")

add_hook(event="PreToolUse",
  content="Use applyAction() for ontology writes",
  condition={file_glob: "src/ontology/**"})
```

12 system hooks are always active (block rm -rf, force push, etc.). Workers can't disable them.

## Forking

Fork a worker to spawn a child with inherited context:

```bash
fleet fork my-worker analyst "Analyze auth module performance"
```

## Next Steps

- [Architecture](architecture.md) — component deep dive
- [Hooks](hooks.md) — hook system reference
- [Worker Types](../templates/flat-worker/types/README.md) — 6 archetypes
