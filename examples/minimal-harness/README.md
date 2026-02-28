# Minimal Harness Example

A single self-managing agent that works through a bounded task graph and stops cleanly when done.

## What this demonstrates

- Bounded lifecycle: agent works until all tasks are `"completed"`, then stops
- Self-manager pattern: one agent reads harness context, picks tasks, executes, marks done
- Stop hook gate: session is blocked from stopping while tasks remain

## Structure

```
examples/minimal-harness/
└── run.sh    ← scaffold + verify (no agent launched; safe for CI)
```

The `run.sh` script:
1. Scaffolds a `hello-world` harness in a temp directory
2. Populates the task graph with 3 sequential tasks
3. Writes harness context (`harness.md`)
4. Verifies all expected files exist
5. Generates the seed prompt (preview)

## Running

```bash
bash examples/minimal-harness/run.sh
```

## To actually run the agent

```bash
WORKDIR=$(mktemp -d)
bash ~/.boring/scripts/scaffold.sh hello-world "$WORKDIR"
bash "$WORKDIR/.claude/scripts/hello-world-seed.sh" > /tmp/seed.txt
cat /tmp/seed.txt | claude --dangerously-skip-permissions --model claude-sonnet-4-6
```

The Stop hook will keep the agent working until all 3 tasks are marked `"completed"`.
