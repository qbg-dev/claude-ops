# boring — Agent Harness Infrastructure for Claude Code

[![Tests](https://github.com/qbg-dev/boring/actions/workflows/ci.yml/badge.svg)](https://github.com/qbg-dev/boring/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)

**boring** is an infrastructure layer built on top of Claude Code that turns Claude sessions into persistent, recoverable agents. It uses Claude Code's native hooks, settings, and session model—no separate runtime.

The design is simple: every agent is either a **coordinator** or a **worker**. Coordinators manage task graphs and delegate to workers. Workers claim tasks, execute them, and report back through an **event bus**. Every tool call flows through Claude Code hooks that log events, inject context, and keep agents on task. A **watchdog** respawns agents after graceful stops or crashes. You can interrupt at any point, steer the agent with a message, and it picks up where it left off.

## Quick Start

```bash
# 1. Install
curl -fsSL https://raw.githubusercontent.com/qbg-dev/boring/main/install.sh | bash

# 2. Scaffold a harness in your project
bash ~/.boring/scripts/scaffold.sh my-feature /path/to/project

# 3. Edit the task graph
$EDITOR /path/to/project/.claude/harness/my-feature/tasks.json

# 4. Generate a seed prompt and launch
bash /path/to/project/.claude/scripts/my-feature-seed.sh > /tmp/seed.txt
cat /tmp/seed.txt | claude --dangerously-skip-permissions --model claude-sonnet-4-6

# 5. Check status
bash ~/.boring/scripts/harness-watchdog.sh --status
```

## Architecture

boring is a **multi-agent layer**. Every Claude session running under boring is registered in `pane-registry.json`—a live map of who is running, in which tmux pane, with which harness. Coordinators and workers can be composed at arbitrary depth; in practice the pattern is one **central coordinator** per repo with one **module-manager** per workstream, each owning its own task graph:

```
central-coordinator
├── module-manager/auth    tasks: [jwt, sessions, ...]
├── module-manager/api     tasks: [routes, validation, ...]
└── module-manager/infra   tasks: [deploy, monitoring, ...]
```

The **watchdog** monitors all registered coordinators, respawns them after graceful sleeps or crashes, and nudges agents that go quiet.

**Hooks** instrument every tool call and session boundary—doing three things at once: logging events to the bus, injecting context, and enforcing permissions.

- **PreToolUse** — injects inbox messages, policy rules, and phase state as context before each tool call
- **PostToolUse** — publishes every tool call and file edit to the event bus
- **Stop** — blocks the session while tasks remain; writes a graceful-stop sentinel for long-running agents; the watchdog reads this sentinel to respawn
- **Permissions** — each agent carries a `permissions.json` listing disallowed tools; the hook enforces it at call time

**The event bus** (`bus/stream.jsonl`) is an append-only JSONL log. Every tool call, message, and lifecycle event lands here. Side-effects in `bus/schema.json` wire event types to behaviors: `cell-message` delivers to the recipient's inbox and records in the sender's outbox; `notification` fires a terminal alert; `worker.regression` notifies the coordinator.

**Each agent has four things and nothing more:**

```
agents/module-manager/
├── MEMORY.md           # persistent knowledge across sessions
├── mission.md          # scope, constraints, escalation path
├── inbox.jsonl         # messages received from other agents
├── outbox.jsonl        # messages sent to other agents
├── config.json         # model, rotation command
└── permissions.json    # disallowed tools for this agent
```

Memory. Parent context. Tasks. Communication. A **harness** wraps the agent with its task graph and shared context:

```
.claude/harness/{name}/
├── tasks.json          # task graph — pending / in_progress / completed
├── harness.md          # terrain map: key files, conventions, scope
├── acceptance.md       # pass/fail criteria
└── agents/
    └── module-manager/ # the agent owning this harness
```

## tmux Layout

Each agent role maps to a tmux primitive. Module-managers get **windows**; their workers get **panes** within that window. This is enforced structurally—the two launch paths use different tmux commands:

- `harness-launch.sh` (module-manager): `tmux new-window -d -t "${TMUX_SESSION}:" -n "$HARNESS"`
- `worker-dispatch.sh` (worker): `tmux split-window -v -d -t "h:${MODULE}"`

The result is a natural visual hierarchy:

```
tmux session "h"
├── window 0 "mod-platform"           module-manager (%539)
│   ├── pane 0: manager
│   ├── pane 1: worker auth-handler
│   └── pane 2: worker api-routes
├── window 1 "mod-tenant"             module-manager (%501)
│   ├── pane 0: manager
│   └── pane 1: worker migration
└── window 2 "hq-v3"                  coordinator (%534)
    ├── pane 0: coordinator
    └── pane 1: monitor (horizontal split)
```

`pane-registry.json` tracks the hierarchy with `agent_role` and `parent` fields, so the watchdog and hooks always know which manager owns which worker:

```json
{
  "%539": { "harness": "mod-platform", "agent_role": "module-manager", "pane_target": "h:0.0" },
  "%540": { "harness": "auth-handler", "agent_role": "worker", "parent": "mod-platform", "pane_target": "h:0.1" }
}
```

Workers run in isolated git worktrees to avoid `.git/index.lock` contention. Monitors use horizontal splits (`-h`) to sit alongside the pane they observe.

## Human Steering

boring is designed for collaborative workflows where you stay in control:

- **Interrupt any time**: type in the tmux pane; the agent reads and adapts
- **Send a message**: `hq_send` delivers to the agent's inbox; PreToolUse injects it on the next tool call
- **Edit the task graph**: plain JSON—add, remove, or reprioritize tasks mid-session
- **Override the stop gate**: `touch ~/.boring/state/sessions/{id}/allow-stop`

## Human-Verifiable Checkpoints

Agents working through a task graph are organized into **waves**—sequential batches of tasks where all tasks in wave N must be completed and reviewed before wave N+1 begins. At each wave boundary, the system enforces a **wave gate**: a synthetic task injected into the dependency graph that blocks the next wave's tasks until the gate is satisfied.

The gate requires the agent to:

1. Commit the wave's work with a conventional message
2. Deploy and inspect every feature in Chrome
3. Take screenshots
4. Generate a self-contained HTML **wave report** from a starter template
5. Open the report and notify the operator
6. Wait for human confirmation before proceeding

Enforcement happens at three levels. The **dependency graph** prevents the agent from picking up next-wave tasks (they're `blockedBy` the gate task). The **Stop hook** prevents the agent from quitting while tasks remain. And **content validation** checks that the report HTML exists on disk and contains required sections (Summary, Tasks Completed, etc.)—the agent can't mark the gate done without a real artifact.

Wave reports live at `~/.boring/harness/reports/{harness}/wave-{N}.html` and serve as the permanent audit trail of what each agent did, when, and what it looked like.

## Directory Structure

```
~/.boring/
├── bin/                  # CLI tools (claude-mux, report-issue, ...)
├── bus/                  # Event bus state (stream.jsonl, schema.json, cursors/)
│   └── side-effects/     # Pluggable side-effect scripts
├── harness/
│   └── manifests/        # Per-harness registry (manifest.json)
├── hooks/
│   ├── dispatch/         # Stop hook modules
│   ├── gates/            # Stop gate + tool policy enforcement
│   ├── interceptors/     # PreToolUse context injection
│   ├── operators/        # PostToolUse checks (no-mock-data, etc.)
│   └── publishers/       # PostToolUse + prompt event publishers
├── lib/                  # Shared libraries (harness-jq.sh, event-bus.sh, ...)
├── scripts/              # CLI scripts (scaffold.sh, watchdog, monitor, ...)
├── sweeps.d/             # Cron-style maintenance sweeps
├── templates/            # Scaffold templates (.tmpl files)
├── tests/                # Test suite

```

## Manual Installation

```bash
git clone git@github.com:qbg-dev/boring.git ~/.boring
```

Add hooks to your Claude Code `settings.json` (`~/.claude/settings.json`):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.boring/hooks/interceptors/pre-tool-context-injector.sh"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.boring/hooks/publishers/post-tool-publisher.sh"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.boring/hooks/gates/stop-harness-dispatch.sh"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.boring/hooks/publishers/prompt-publisher.sh"
          }
        ]
      }
    ]
  }
}
```

## Running Tests

```bash
bash ~/.boring/tests/run-all.sh
```

## License

Apache 2.0 — see [LICENSE](LICENSE).
