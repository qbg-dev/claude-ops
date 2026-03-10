# Getting Started

## Prerequisites

- **bun** — `curl -fsSL https://bun.sh/install | bash`
- **jq** — `brew install jq`
- **tmux** — `brew install tmux`
- **git** — `brew install git`
- **Claude Code** — [claude.ai/code](https://claude.ai/code)

## Install

```bash
# Clone the repo
git clone git@github.com:qbg-dev/claude-fleet.git ~/.claude-fleet

# Run setup (creates symlinks, registers MCP server, checks deps)
~/.claude-fleet/bin/fleet setup
```

`fleet setup` does everything:
- Checks that bun, jq, and tmux are installed
- Creates symlinks (`~/.claude-fleet`, `~/.claude-ops` for compat, `~/.local/bin/fleet`)
- Creates `~/.claude/fleet/defaults.json` with global defaults
- Registers the MCP server in `~/.claude/settings.json`

If `~/.local/bin` isn't in your PATH, add it:
```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

## Create Your First Worker

```bash
# Start a tmux session (if not already in one)
tmux new -s w

# Create a worker — this does everything:
#   creates config, state, mission files
#   creates a git worktree on branch worker/my-worker
#   provisions Fleet Mail account
#   launches Claude Code in a tmux pane
#   injects the mission as a seed prompt
fleet create my-worker "Fix the login timeout bug in src/auth/sso.ts"
```

## What Happens

1. **Directory created** at `~/.claude/fleet/{project}/my-worker/` with:
   - `config.json` — model, effort, permissions, 12 system hooks
   - `state.json` — runtime status, pane ID, session history
   - `mission.md` — the worker's purpose
   - `launch.sh` — auto-generated restart command
   - `token` — Fleet Mail auth

2. **Git worktree** created at `../{project}-w-my-worker` on branch `worker/my-worker`

3. **Claude Code** launched in a tmux pane with the mission injected

4. **Worker starts working** — reads mission, does the task, commits to its branch

## Managing Workers

```bash
# List all workers (with liveness detection)
fleet ls

# NAME             STATUS   MODEL   PANE   WINDOW        BRANCH
# my-worker        active   opus    %42    my-worker     worker/my-worker

# Check a worker's output
fleet log my-worker

# Stop a worker gracefully
fleet stop my-worker

# Restart with a different model
fleet start my-worker --model sonnet

# Restart and save the override
fleet start my-worker --model sonnet --save

# Stop all workers
fleet stop --all
```

## Configuration

### Per-Worker Config

```bash
fleet config my-worker                    # show full config
fleet config my-worker model              # get value
fleet config my-worker model sonnet       # set + regenerate launch.sh
fleet config my-worker sleep_duration 900 # 15-min respawn cycle
```

### Global Defaults

```bash
fleet defaults                            # show defaults
fleet defaults model sonnet               # all new workers use sonnet
fleet defaults effort max                 # all new workers use max effort
```

### Resolution Chain

CLI flag > per-worker `config.json` > `defaults.json` > hardcoded defaults

## Persistent Workers (Watchdog)

Workers can run perpetually — working, recycling, sleeping, respawning:

```bash
# Set a 15-minute sleep between cycles
fleet config my-worker sleep_duration 900
```

The watchdog (launchd daemon, checks every 30s) handles:
- **Respawning** after `recycle()` + sleep
- **Crash recovery** — detects dead panes, relaunches
- **Stuck detection** — kills workers idle >10 minutes

Inside the worker, the perpetual loop is:
```
1. mail_inbox() — act on messages
2. git fetch && git rebase origin/main
3. Do work, commit changes
4. add_hook(event="Stop", description="verify TypeScript compiles")
5. complete_hook("dh-1") after verifying
6. recycle() — exits cleanly, watchdog respawns after sleep_duration
```

## Dynamic Hooks

Workers govern themselves through runtime hooks:

```
# Block recycling until you've verified your work
add_hook(event="Stop", description="verify deployment works")

# Inject context when editing specific files
add_hook(event="PreToolUse",
  content="Use applyAction() for ontology writes",
  condition={file_glob: "src/ontology/**"})

# Complete a gate after checking
complete_hook("dh-1", result="PASS")
```

12 system hooks are always active and irremovable (block rm -rf, force push, etc.).

## Forking Workers

Fork an existing worker's session to spawn a child with inherited context:

```bash
fleet fork my-worker analyst "Analyze the performance of the auth module"
```

The child inherits the parent's conversation history via `--resume --fork-session`.

## Fleet Mail

### Setup

Fleet Mail is required. Connect to an existing server or self-host:

```bash
# Option A: Connect to existing
fleet mail-server connect http://your-server:8025 --token <admin-token>

# Option B: Self-host (single binary, SQLite storage)
fleet mail-server start
```

`fleet setup` checks Fleet Mail connectivity. Workers auto-provision accounts on `fleet create`.

### Usage

Workers coordinate through a durable mail server. Inside a worker:

```
mail_send(to="merger", subject="MERGE REQUEST", body="branch: worker/my-worker...")
mail_inbox()                           # check for messages
mail_inbox(label="TASK")               # list task threads
```

From the CLI:
```bash
fleet mail my-worker                   # check a worker's inbox
```

## MCP Server

The MCP server gives workers 20 tools for coordination. It's registered globally in `~/.claude/settings.json`.

```bash
fleet mcp status                       # check registration
fleet mcp register                     # re-register (e.g., after bun upgrade)
fleet mcp build                        # rebuild compiled JS from TypeScript
```

## Key Insight: Memory Through Worktrees

Each worktree has a unique filesystem path. Claude Code scopes auto-memory by path, so different worktree = isolated memory — no configuration needed. Workers accumulate domain knowledge across cycles because the watchdog respawns them in the same worktree.

## Next Steps

- Read [Architecture](architecture.md) for the full component deep dive
- Read [Hooks](hooks.md) for the dynamic hook system
- Explore `~/.claude-fleet/templates/` for worker archetypes
