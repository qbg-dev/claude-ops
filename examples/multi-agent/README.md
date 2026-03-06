# Multi-Agent Harness Example

A coordinator that spawns two workers, assigns tasks to each, and collects results when both are done.

## What this demonstrates

- Coordinator–worker pattern: one coordinator, two workers
- Task ownership: coordinator assigns `owner` fields, workers claim tasks
- Dependency coordination: T-4 (collect results) is blocked on both T-2 and T-3
- Inter-agent messaging: workers publish `task.completed` events; `update_tasks_json` side-effect propagates status back
- Bus-based communication: `hq_send` from coordinator to workers; workers reply via `cell-message`

## Architecture

```
code-review (coordinator)
    │
    ├── assigns batch 1 → code-review/worker-alpha  (reviews src/api/)
    ├── assigns batch 2 → code-review/worker-beta   (reviews src/ui/)
    │
    └── waits on T-4 (blocked by T-2 + T-3)
          → writes REVIEW.md when both workers finish
```

## Running

```bash
bash examples/multi-agent/run.sh
```

## How the coordinator launches workers

```bash
# In coordinator's session:
source ~/.claude-ops/lib/harness-jq.sh

# Launch a worker in a new tmux pane + git worktree
bash ~/.claude-ops/scripts/launch-worker.sh code-review worker-alpha

# Send a directive via event bus
hq_send "code-review" "code-review/worker-alpha" "directive" \
  "Review all files in src/api/. Write findings to claude_files/review-api.md."
```

## How workers signal completion

```bash
# Worker publishes completion:
source ~/.claude-ops/lib/event-bus.sh
bus_publish "task.completed" '{"harness":"code-review","worker":"code-review/worker-alpha","task_id":"W-3","summary":"Found 2 auth bugs, 1 injection risk"}'

# update_tasks_json.sh side-effect marks T-2 as completed in coordinator's tasks.json
# notify_assignee.sh delivers a message to coordinator's inbox
# PreToolUse hook injects the inbox message on coordinator's next tool call
```
