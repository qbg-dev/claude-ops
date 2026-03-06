# Getting Started with claude-ops

This guide walks you through installing claude-ops, scaffolding your first harness, and launching your first autonomous agent.

## Prerequisites

- macOS or Linux
- `git`, `jq`, `tmux`, `bash` (4+)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- A project to run agents on

## Step 1: Install

```bash
curl -fsSL https://raw.githubusercontent.com/qbg-dev/claude-ops/main/install.sh | bash
```

The installer:
1. Clones the repo to `~/.claude-ops`
2. Adds `~/.claude-ops/bin` to your `PATH`
3. Registers the four Claude Code hooks in `~/.claude/settings.json`
4. Verifies the installation

After install, reload your shell:
```bash
source ~/.zshrc  # or ~/.bash_profile / ~/.bashrc
```

### Verify

```bash
bash ~/.claude-ops/tests/run-all.sh
```

All tests should pass (163 tests, 10 suites).

## Step 2: Scaffold a Harness

A *harness* is a named task graph that an agent works through. Create one in your project:

```bash
bash ~/.claude-ops/scripts/scaffold.sh my-feature /path/to/your/project
```

This creates:

```
/path/to/your/project/
└── .claude/
    ├── harness/
    │   └── my-feature/
    │       ├── tasks.json        ← task graph (you edit this)
    │       ├── harness.md        ← context for the agent
    │       ├── spec.md           ← acceptance criteria template
    │       ├── acceptance.md     ← pass/fail tracker
    │       ├── policy.json       ← context injection rules
    │       └── agents/
    │           └── module-manager/
    │               ├── config.json
    │               ├── state.json
    │               ├── MEMORY.md
    │               ├── mission.md
    │               ├── inbox.jsonl
    │               └── outbox.jsonl
    └── scripts/
        └── my-feature-seed.sh   ← generates the agent seed prompt
```

For a long-running (recurring) harness:

```bash
bash ~/.claude-ops/scripts/scaffold.sh --long-running monitor /path/to/project
```

## Step 3: Define Your Tasks

Edit `.claude/harness/my-feature/tasks.json`:

```json
{
  "tasks": {
    "T-1": {
      "status": "pending",
      "description": "Analyze the codebase and create a plan",
      "blockedBy": []
    },
    "T-2": {
      "status": "pending",
      "description": "Implement the feature",
      "blockedBy": ["T-1"]
    },
    "T-3": {
      "status": "pending",
      "description": "Write tests and update docs",
      "blockedBy": ["T-2"]
    }
  }
}
```

Task schema:
- `status`: `"pending"` | `"in_progress"` | `"completed"`
- `blockedBy`: list of task IDs that must complete first
- `description`: what this task does
- `owner`: (optional) which agent owns it
- `metadata`: (optional) arbitrary extra data

## Step 4: Write the Harness Context

Edit `.claude/harness/my-feature/harness.md` to give the agent:
- What the end goal looks like
- Key files and APIs to know about
- Constraints and rationale

The better this file is, the better the agent performs when it re-reads it after a session boundary.

## Step 5: Generate the Seed Prompt

```bash
bash /path/to/project/.claude/scripts/my-feature-seed.sh > /tmp/my-feature-seed.txt
```

Review the seed—it summarizes the harness state and instructs the agent on how to proceed.

## Step 6: Launch the Agent

Open a tmux session and pipe the seed to Claude Code:

```bash
tmux new-session -s my-agent
cat /tmp/my-feature-seed.txt | claude --dangerously-skip-permissions --model claude-sonnet-4-6
```

The agent will:
1. Read the harness files
2. Pick the first unblocked task
3. Work until the task is done
4. Mark it complete and move to the next

The **Stop hook** (`stop-harness-dispatch.sh`) fires when Claude tries to stop. For a bounded harness with incomplete tasks, it blocks the stop and shows the current task state—so the agent keeps working.

## Step 7: Monitor Progress

Check current status via tmux:
```bash
tmux list-panes -a  # find your agent pane
tmux attach -t my-agent
```

Or read the task graph directly:
```bash
cat /path/to/project/.claude/harness/my-feature/tasks.json | jq '.tasks | to_entries[] | {id: .key, status: .value.status}'
```

## How the Stop Gate Works

When Claude Code tries to stop, the Stop hook fires. For a bounded harness:

- **Tasks remaining**: hook blocks the stop and shows current task + what's next
- **All tasks done**: hook asks the agent to update `MEMORY.md` and run `bus_git_checkpoint` before allowing stop
- **Long-running harness**: hook allows stop, writes a `graceful-stop` sentinel; the watchdog sees this and respawns after the configured sleep duration

This is what makes agents keep working without manual intervention.

## Next Steps

- [Architecture](architecture.md) — understand the 5 components
- [Event Bus](event-bus.md) — inter-agent messaging
- [Hooks](hooks.md) — context injection and policy enforcement
- Multi-agent: spawn a coordinator with `worker-dispatch.sh`
