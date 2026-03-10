# claude-fleet

Lightweight, tmux-based orchestration for Claude Code. Use as much compute as possible, as effectively as possible.

**The pitch:** Claude Code is powerful but ephemeral — sessions end, context is lost, and you manage one agent at a time. claude-fleet makes workers *persistent* and *parallel*. Each worker gets its own git worktree, tmux pane, and durable memory. A watchdog respawns them on crash. An MCP server gives them 20+ tools for messaging, state, hooks, and fleet coordination.

## Quick Start

```bash
# 1. Clone
git clone git@github.com:qbg-dev/claude-fleet.git ~/.claude-fleet

# 2. Bootstrap (creates symlinks, registers MCP, checks deps)
~/.claude-fleet/bin/fleet setup

# 3. Create your first worker
fleet create my-worker "Fix the login bug in auth.ts"
```

That's it. The worker launches in a tmux pane, reads its mission, and starts working.

## Requirements

| Tool | Install | Why |
|------|---------|-----|
| bun | `curl -fsSL https://bun.sh/install \| bash` | Runs CLI + MCP server |
| tmux | `brew install tmux` | Pane management |
| git | `brew install git` | Worktree isolation |
| cargo | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` | Build `dr-context` (deep review analysis) |

`fleet setup` checks all of these and tells you what's missing.

## What You Get

- **Persistent workers** — Watchdog (launchd, every 30s) detects stopped/stuck/crashed workers and respawns them. Workers survive crashes, context compaction, and `/stop`.
- **Git worktree isolation** — Each worker gets its own branch and worktree. Claude Code scopes auto-memory by path, so different worktree = isolated memory. By cycle 50, a worker knows things a fresh session never could.
- **Fleet Mail** — Workers message each other, report to coordinators, and track tasks via a durable mail system (LKML model — tasks are mail threads with labels).
- **Dynamic hooks** — Workers manage their own guardrails at runtime: blocking gates before recycling, context injection on tool use, safety checks on destructive operations.
- **Safety gates** — Universal fleet-wide blocks on destructive operations (rm -rf, force push, tmux kill-session, git reset --hard, etc.) enforced via PreToolUse hooks.
- **Deep review pipeline** — Multi-pass adversarial code review with path enumeration, confidence voting, adversarial judging, and optional end-to-end verification.
- **MCP server** — 20+ tools available inside every worker: `mail_send`, `mail_inbox`, `update_state`, `add_hook`, `create_worker`, `recycle`, `deep_review`, and more.
- **Single CLI** — `fleet create`, `fleet start`, `fleet stop`, `fleet ls` — everything from one command.

---

## Architecture

```
                    fleet CLI
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
     MCP server (20+ tools)
          │
     watchdog (launchd, 30s)
```

Each worker = Claude Code session + git worktree + tmux pane + persistent config.

Workers never push or merge. A designated merger handles main.

### Components

| Component | What it does | Docs |
|-----------|-------------|------|
| **MCP Server** | 20+ tools for messaging, state, tasks, hooks, fleet visibility | [architecture.md](docs/architecture.md) |
| **Watchdog** | launchd daemon (30s): respawn dead/stuck workers, crash-loop protection | [architecture.md](docs/architecture.md) |
| **Hooks** | PreToolUse/PostToolUse/Stop/PromptSubmit lifecycle hooks | [hooks.md](docs/hooks.md) |
| **Fleet Mail** | Durable mail server (Rust + Dolt), LKML-style task threads | [architecture.md](docs/architecture.md) |
| **Deep Review** | Multi-pass adversarial code review pipeline | [Deep Review](#deep-review) |
| **CLI** | `fleet` command for all fleet operations | [CLI Reference](#cli-reference) |

---

## CLI Reference

```bash
fleet setup                              # One-time bootstrap
fleet create <name> "<mission>"          # Create + launch worker
fleet start  <name>                      # Restart existing worker
fleet stop   <name> [--all]              # Graceful stop
fleet ls     [--json]                    # List all workers with liveness
fleet config <name> [key] [value]        # Get/set worker config
fleet defaults [key] [value]             # Global defaults
fleet fork   <parent> <child> "<mission>" # Fork from existing session
fleet log    <name>                      # Tail worker's tmux pane
fleet mail   <name>                      # Check worker's inbox
fleet mcp    [register|status|build]     # Manage MCP server
```

### Flags

```bash
--model opus|sonnet|haiku       # Override model
--effort low|medium|high|max    # Reasoning effort
--window <name>                 # tmux window group
--no-launch                     # Create without launching
--save                          # Persist overrides to config
--json                          # Machine-readable output
```

### Resolution Chain

CLI flag > per-worker `config.json` > `defaults.json` > hardcoded defaults

---

## Worker Archetypes

Six built-in worker types. Use `get_worker_template(type)` to preview, then `create_worker(type=..., mission=...)` to create.

| Type | Lifecycle | Access | Use case |
|------|-----------|--------|----------|
| **implementer** | One-shot or cycled | Read-write, no push | Task-backlog-driven: fix bugs, build features |
| **optimizer** | Perpetual | Read-write, no push | Eval-driven: run evals, fix worst gaps, prove improvement |
| **monitor** | Perpetual | Read-only | Watch for anomalies, report to chief-of-staff |
| **merger** | Perpetual | Full + cherry-pick + deploy | Cherry-pick worker commits to main, deploy to test, notify for E2E |
| **chief-of-staff** | Perpetual | Read + message only | Comms hub: relay messages, optimize missions, monitor fleet health |
| **verifier** | One-shot | Read-write, no push | Exhaustive testing against generated checklists |

See [templates/flat-worker/types/README.md](templates/flat-worker/types/README.md) for details on each archetype.

---

## Data Model

```
~/.claude/fleet/
├── defaults.json                 # Global defaults (model, effort, permissions)
├── {project}/
│   ├── fleet.json                # Fleet-wide config (tmux session, authorities)
│   ├── {worker-name}/
│   │   ├── config.json           # Settings (model, hooks, permissions, meta)
│   │   ├── state.json            # Runtime (status, pane, session, cycles)
│   │   ├── mission.md            # Worker's prompt/purpose
│   │   ├── launch.sh             # Auto-generated restart command
│   │   └── token                 # Fleet Mail auth token
│   └── missions/                 # Symlinks to worker missions

~/.claude-fleet/                  # Infrastructure (this repo)
├── bin/                          # CLI shim + compiled tools
│   ├── fleet                     # CLI entry point (delegates to TypeScript)
│   └── dr-context                # Compiled Rust binary (deep review analysis)
├── cli/                          # TypeScript CLI (citty + Bun)
│   ├── index.ts                  # Entry point
│   ├── commands/                 # Subcommands (create, start, stop, ls, ...)
│   └── lib/                      # Shared modules (config, tmux, paths, fmt)
├── mcp/worker-fleet/             # MCP server (TypeScript, ~4000 lines)
├── hooks/                        # Claude Code hooks
│   ├── gates/                    # PreToolUse blocking gates (tool-policy-gate.sh)
│   ├── interceptors/             # Context injection (pre-tool-context-injector.sh)
│   └── publishers/               # Event publishing (post-tool, prompt)
├── engine/                       # Hook engine + session logger
├── scripts/                      # Launch, watchdog, deep-review, git hooks
├── templates/                    # Worker archetypes + seed templates
│   ├── flat-worker/types/        # 6 worker type templates
│   └── deep-review/              # Review pipeline templates (worker, coordinator, judge)
├── tools/dr-context/             # Rust source for deep review analysis
│   ├── Cargo.toml
│   └── src/                      # dep_graph, test_coverage, blame_context, shuffle
├── lib/                          # Shared bash libraries
├── docs/                         # Documentation
└── tui/                          # Terminal UI (React Ink)
```

---

## Hook System

### Universal Fleet Gates (always active, irremovable)

Enforced by `hooks/gates/tool-policy-gate.sh` — blocks commands that no agent should ever run:

| Category | Blocked commands |
|----------|-----------------|
| **Tmux destruction** | `tmux kill-session`, `tmux kill-window`, `tmux kill-server` |
| **Git destruction** | `git push --force`, `git reset --hard`, `git clean -f`, `git checkout .`, `git branch -D`, `git filter-branch` |
| **Git config** | `git remote set-url/add`, `git config` (except user.name/email) |
| **File destruction** | `rm -rf` |
| **Process killing** | `kill/pkill/killall claude` |
| **System services** | `launchctl unload/bootout`, `osascript`, `crontab -r`, `nohup` |
| **Privilege escalation** | Editing own `permissions.json`, git hooks, shell profiles |
| **Prod access** | Direct prod IP from worktrees |

### Dynamic Hooks (worker self-governance)

Workers register their own hooks at runtime:

```
# Block recycling until TypeScript compiles
add_hook(event="Stop", description="verify TypeScript compiles")

# Inject context when editing ontology files
add_hook(event="PreToolUse", content="Use applyAction() for ontology writes",
  condition={file_glob: "src/ontology/**"})

# Complete a gate after verification
complete_hook("dh-1", result="PASS — no TS errors")
```

Hooks fire on: PreToolUse, PostToolUse, Stop, UserPromptSubmit, PreCompact, SubagentStart/Stop.

---

## Watchdog

The watchdog runs via launchd (every 30s) and keeps workers alive:

1. **Liveness check** — Heartbeat timestamps updated on every prompt/tool use
2. **Stuck detection** — If no activity for 10+ minutes, kill and respawn
3. **Crash-loop protection** — >3 crashes/hour → stop and alert
4. **Memory-leak recycling** — Workers exceeding memory thresholds get gracefully recycled
5. **Perpetual cycles** — Workers call `recycle()` when done; watchdog respawns after `sleep_duration`

Workers don't `sleep` — they exit cleanly, and the watchdog owns the timer.

---

## MCP Tools (inside workers)

| Tool | Description |
|------|-------------|
| `mail_send(to, subject, body)` | Message workers, coordinators, or the operator |
| `mail_inbox(label?)` | Read inbox (UNREAD, TASK, INBOX) |
| `update_state(key, value)` | Persist state across recycles |
| `add_hook(event, ...)` | Register dynamic hooks (gates or injectors) |
| `complete_hook(id)` | Mark a blocking gate as done |
| `create_worker(name, mission)` | Spawn a new worker |
| `recycle(message?)` | Clean restart (blocked until all gates pass) |
| `save_checkpoint(summary)` | Snapshot working state for crash recovery |
| `deep_review(scope, spec)` | Launch multi-pass adversarial review pipeline |
| `get_worker_template(type)` | Preview a worker archetype template |

[Full reference: 20+ tools total](docs/architecture.md)

---

## Fleet Mail

Workers coordinate via a durable mail server (self-hosted, Rust + Dolt):

- **Messaging**: Direct, broadcast, mailing lists
- **Tasks**: LKML model — tasks are mail threads with labels (`[TASK]`, `P1`, `IN_PROGRESS`)
- **Merge requests**: Workers send structured merge requests to the merger
- **Escalation**: `mail_send(to="user")` reaches the human operator

---

## Deep Review

Multi-pass adversarial code review pipeline. Reviews diffs and/or content files using parallel workers with specialized focus areas, confidence-based voting, adversarial judging, and optional end-to-end verification.

### Pipeline

```
Material (diff + content)
    │
    ├── Context pre-pass (Rust: dr-context)
    │   ├── static analysis (tsc --noEmit)
    │   ├── dependency graph (callers, imports, churn)
    │   ├── test coverage (sibling test files)
    │   └── blame context (new vs pre-existing lines)
    │
    ├── N workers × M focus areas (parallel, randomized material order)
    │   ├── Investigation protocol (scan → deep dive → attack vectors)
    │   ├── Path enumeration (every code path through focus area)
    │   └── Findings with chain-of-thought evidence
    │
    ├── Coordinator
    │   ├── Aggregate findings across workers
    │   ├── Graduated voting (≥2 per focus group, confidence thresholds)
    │   ├── Confidence recalibration
    │   ├── Adversarial judge validation
    │   ├── Source verification (read actual code)
    │   ├── Cross-run dedup (history file)
    │   ├── Auto-fix bugs/security issues
    │   ├── Aggregate verification checklist
    │   └── Report generation
    │
    └── Verifier (optional, --verify flag)
        ├── Deploy to test slot
        ├── Walk verification checklist
        ├── Write scripts and tests
        └── Report pass/fail per path
```

### Usage

```bash
# Via MCP tool (preferred)
deep_review(
  scope="v1.1.3..HEAD",
  spec="Review all changes for security and correctness",
  verify=true,
  verify_roles=["admin", "shenlan-pm"]
)

# Via CLI
bash scripts/deep-review.sh \
  --scope "main" \
  --spec "Security audit" \
  --passes 3 \
  --verify \
  --notify user
```

### Focus Areas (auto-detected)

**Code reviews**: security, logic, error-handling, data-integrity, architecture, performance, ux-impact, completeness

**Content reviews**: correctness, completeness, feasibility, risks, clarity, alternatives, priorities

**Smart focus**: Auto-replaces focus areas when patterns are detected (e.g., CLAUDE.md changes → `claude-md` focus, many try/catch → `silent-failure` focus).

### Path Enumeration

Each worker enumerates ALL code paths through their focus area:

- **UI changes**: every page × tab × button × role combination
- **API changes**: every endpoint × method × auth role × error branch
- **Logic changes**: every branch × input class × boundary condition
- **Config changes**: every consumer × migration path

Paths are tagged with a verification method (`chrome`, `curl`, `script`, `test`, `code-review`, `query`). The coordinator aggregates them into a unified `verification-checklist.md`.

### `dr-context` (Rust binary)

The context pre-pass uses a compiled Rust binary (`tools/dr-context/`) for performance:

```bash
dr-context dep-graph <project_root> <changed_files> <output.json>
dr-context test-coverage <project_root> <changed_files> <output.json>
dr-context blame-context <project_root> <material_file> <output.json>
dr-context shuffle <material_file> <session_dir> <num_workers>
```

Build: `cd tools/dr-context && cargo build --release && cp target/release/dr-context ../../bin/`

Test: `cd tools/dr-context && cargo test` (14 tests)

---

## Docs

| Doc | What it covers |
|-----|---------------|
| [Getting Started](docs/getting-started.md) | Installation, first worker, configuration, hooks |
| [Architecture](docs/architecture.md) | Component deep dive, data flow, file ownership |
| [Hooks](docs/hooks.md) | Hook lifecycle, context injection, policy enforcement |
| [Event Bus](docs/event-bus.md) | JSONL event streaming, side-effects |
| [Worker Types](templates/flat-worker/types/README.md) | 6 archetypes with usage and key differences |

## License

Apache 2.0
