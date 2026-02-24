# ~/.claude-ops — Agent Operations Infrastructure

Shared, tested scripts for autonomous Claude Code agent sessions.
**Every agent should source from here instead of copying scripts into project repos.**

## Directory Structure

```
~/.claude-ops/
├── bin/                          # CLI tools
│   ├── claude-mux.py             # Multi-agent multiplexer
│   ├── codex-async.sh            # Async Codex launcher
│   └── daily-harness-audit.py    # Daily harness health audit
├── harness/
│   ├── manifests/{name}/         # Per-harness persistent registry
│   │   └── manifest.json         # project_root, status, file paths
│   └── templates/                # Scaffold templates (.tmpl)
│       ├── start.sh.tmpl
│       ├── seed.sh.tmpl
│       ├── continue.sh.tmpl
│       ├── progress.json.tmpl
│       ├── harness.md.tmpl
│       ├── best-practices.json.tmpl
│       └── goal.md.tmpl
├── hooks/
│   ├── admission/
│   │   ├── deploy-mutator.sh     # Auto-inject deploy flags
│   │   ├── context-injector.sh   # RAG-like context injection before tool calls
│   │   └── task-readiness.sh     # Verification gate for task completion
│   ├── operators/
│   │   ├── progress-validator.sh # Validate progress.json + run checks.d/
│   │   ├── activity-logger.sh    # Log all tool use to JSONL
│   │   └── checks.d/
│   │       ├── 01-no-inline-styles.sh
│   │       ├── 02-no-mock-data.sh
│   │       └── 03-no-hardcoded-ids.sh
│   ├── harness-dispatch.sh       # Main stop hook dispatcher
│   └── stop-check.sh             # General code-review stop hook
├── lib/
│   ├── harness-jq.sh             # Task graph queries (source in scripts)
│   ├── handoff.sh                # Session rotation/replacement
│   ├── bead.sh                   # Cross-harness coordination
│   ├── spawn-sweep-agent.sh      # Least-privilege sweep agent spawner
│   └── session-reader.sh         # Session transcript reader
├── scripts/
│   ├── scaffold.sh               # Create new harness from templates
│   ├── control-plane.sh          # K8s-inspired daemon
│   ├── monitor-agent.sh          # Polling monitor + Claude session
│   └── tmux-harness-summary.sh   # Tmux status bar summary
├── sweeps.d/
│   ├── 01-claude-md-cleanup.sh
│   ├── 02-file-index.sh
│   ├── 03-stale-cleanup.sh
│   ├── 04-progress-reconcile.sh
│   ├── 05-commit-reminder.sh
│   ├── 07-dead-agent-detector.sh
│   ├── 08-meta-reflect.sh
│   └── permissions/              # Per-sweep RBAC manifests
│       ├── 01-claude-md-cleanup.json
│       ├── 02-file-index.json
│       ├── 04-progress-reconcile.json
│       └── 08-meta-reflect.json
├── tests/
│   ├── run-all.sh                # 168 tests, 9 suites
│   ├── test-hooks.sh
│   ├── test-harness-jq.sh
│   ├── test-context-injector.sh
│   ├── test-progress-validator.sh
│   ├── test-scaffold.sh
│   ├── test-registry.sh
│   ├── test-sweeps.sh
│   ├── test-monitor-reflect.sh
│   ├── test-session-reader.sh
│   ├── helpers.sh
│   └── fixtures/
├── plugins/                      # Migrated marketplace plugins
│   └── claude-context-orchestrator/
├── control-plane.conf            # Daemon config (re-sourced every tick)
└── README.md
```

## Quick Start

```bash
# Scaffold a new harness
bash ~/.claude-ops/scripts/scaffold.sh my-feature /path/to/project

# Source shared libraries
source ~/.claude-ops/lib/harness-jq.sh
CURRENT=$(harness_current_task "$PROGRESS_FILE")

# Run tests
bash ~/.claude-ops/tests/run-all.sh

# Start control plane
nohup bash ~/.claude-ops/scripts/control-plane.sh --project /path/to/project &
```

## Philosophy

Harnesses are disposable task graphs that agents evolve through.
Infrastructure lives here (`~/.claude-ops/`). State lives in the project (`claude_files/`).
See the agent-harness skill for the full protocol.
