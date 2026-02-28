# Event Bus

The boring event bus is a JSONL append-log with pluggable side-effects. Agents publish typed events; side-effect scripts run asynchronously for each event type.

## Setup

```bash
source ~/.boring/lib/event-bus.sh
```

The bus resolves its directory from `PROJECT_ROOT` (or `git rev-parse --show-toplevel`). Project buses live at `.claude/bus/`.

## Publishing Events

```bash
bus_publish <event_type> <json_payload>
```

`bus_publish` enriches the payload with `_seq`, `_event_type`, and `_ts`, then appends to `stream.jsonl` and fires side-effects asynchronously.

### Examples

```bash
# Task completed
bus_publish "task.completed" '{"harness":"my-harness","task_id":"T-1","summary":"Wrote the feature"}'

# Agent message to another agent
bus_publish "cell-message" '{"from":"coordinator","to":"worker-1","body":"Focus on T-3 next"}'

# Operator notification
bus_publish "notification" '{"message":"Build failed","title":"CI Alert"}'

# Deploy event
bus_publish "deploy" '{"agent":"coordinator","service":"api","target":"staging"}'
```

### Convenience wrappers

```bash
bus_publish_deploy "agent-name" "service-name" "target"
bus_publish_announcement "sender" "body text" "normal"  # priority: normal|urgent
```

## Event Schema

All events in `stream.jsonl` have these system fields added by `bus_publish`:

| Field | Type | Description |
|-------|------|-------------|
| `_seq` | int | Global monotonic sequence number |
| `_event_type` | string | Event type (e.g. `"task.completed"`) |
| `_ts` | ISO-8601 | UTC timestamp |

Plus your payload fields.

## Side-Effects

Side-effects are declared per event type in `.claude/bus/schema.json` (or `~/.boring/bus/schema.json` as fallback). Scripts live in `~/.boring/bus/side-effects/`.

```json
{
  "event_types": {
    "task.completed": {
      "side_effects": ["update_tasks_json", "notify_assignee"],
      "description": "Worker completed an assigned task."
    }
  }
}
```

When `bus_publish "task.completed" ...` is called, `update_tasks_json.sh` and `notify_assignee.sh` run asynchronously in the background. Errors are logged to `.claude/bus/dlq/side-effect-errors.log`.

### Built-in side-effects

| Script | Triggered by | What it does |
|--------|-------------|--------------|
| `update_tasks_json.sh` | `task.started`, `task.completed` | Updates `tasks.json` status |
| `notify_assignee.sh` | messages, task events | Writes to recipient's `inbox.jsonl` |
| `notify_tmux_if_urgent.sh` | urgent events | Sends tmux notification to agent pane |
| `inject_directive_if_flagged.sh` | `cell-message` | Flags inbox message for PreToolUse injection |
| `append_outbox.sh` | `file-edit`, `agent.policy-appended` | Appends to agent's `outbox.jsonl` |
| `sync_harness_inbox.sh` | `prompt` | Scans outboxes; routes file-edit warnings to affected agents |
| `notify_human_agent.sh` | `notification`, `deploy`, `config-change` | Calls `terminal-notifier` or prints alert |
| `dlq_if_critical.sh` | `error` | Writes to DLQ if `critical: true` |
| `worker-prompt-notify.sh` | `prompt` | Notifies worker harness on user prompt |

## Consumer API

### Subscribe (initialize cursor)

```bash
bus_subscribe "my-consumer"
# Sets cursor to current max _seq — only new events will be read
```

### Read (with auto-cursor advance)

```bash
events=$(bus_read "my-consumer")                      # all new events
events=$(bus_read "my-consumer" --type "task.completed")  # filtered by type
events=$(bus_read "my-consumer" --limit 10)           # cap at 10
```

Returns a JSON array. Cursor advances automatically.

### Acknowledge (manual cursor advance)

```bash
bus_ack "my-consumer" 42  # advance cursor to _seq=42
```

### Query (ad-hoc, no cursor)

```bash
# By type
bus_query --type "task.completed" --limit 20

# By pattern (regex on _event_type)
bus_query --pattern "task\\."

# By sender
bus_query --from "worker-1"

# Since a timestamp
bus_query --since "2026-02-28T00:00:00Z"

# Raw output (one JSON per line, not array)
bus_query --type "cell-message" --raw

# Legacy: bus_query <type> [after_seq]
bus_query "task.completed" 15
```

### Git checkpoint

Commits structural bus files (schema, cursors, tasks.json) without the append-only stream:

```bash
bus_git_checkpoint "checkpoint: after wave 1"
```

### Compact stream

Trim stream to events after the lowest consumer cursor (minus 100-event safety margin):

```bash
bus_compact
```

## Event Type Reference

| Type | Side-effects | Payload fields |
|------|-------------|----------------|
| `cell-message` | notify_assignee, notify_tmux_if_urgent, inject_directive_if_flagged | `from`, `to`, `body` |
| `announcement` | notify_assignee, inject_directive_if_flagged, notify_tmux_if_urgent | `from`, `body`, `priority` |
| `task.started` | update_tasks_json | `harness`, `worker`, `task_id` |
| `task.completed` | update_tasks_json, notify_assignee | `harness`, `worker`, `task_id`, `summary` |
| `worker.started` | notify_assignee | `harness`, `worker`, `task_id` |
| `worker.regression` | notify_assignee, notify_tmux_if_urgent | `harness`, `worker`, `details` |
| `prompt` | sync_harness_inbox, worker-prompt-notify | `session_id`, `harness`, `text` |
| `file-edit` | append_outbox | `agent`, `file`, `harness` |
| `deploy` | notify_human_agent | `agent`, `service`, `target` |
| `error` | dlq_if_critical | `agent`, `message`, `critical?` |
| `notification` | notify_human_agent | `message`, `title?`, `url?` |
| `agent.crash` | notify_assignee | `canonical`, `pane_id` |
| `agent.crash-loop` | notify_assignee, notify_tmux_if_urgent | `canonical` |
| `agent.respawned` | notify_tmux_if_urgent | `canonical`, `pane_id` |

Full reference: `.claude/bus/schema.json` in your project, or `~/.boring/bus/schema.json`.

## Named Filters

Schema defines regex filters for common query patterns:

```bash
# Messages (cell-message, worker.*, sidecar.*, announcement)
bus_query_filter "messages"

# Task events
bus_query_filter "tasks"

# Telemetry (file-edit, tool-call, deploy, error, prompt)
bus_query_filter "telemetry"

# Agent state events
bus_query_filter "agent-state"
```

## Harness Messaging Shorthand

`harness-jq.sh` provides `hq_send` as a shorthand for coordinator→agent messaging:

```bash
source ~/.boring/lib/harness-jq.sh

# Send a directive to a worker
hq_send "my-harness" "my-harness/worker-1" "directive" "Focus on T-3 next"

# Send status update to coordinator
hq_send "my-harness" "my-harness" "status" "T-2 complete, moving to T-3"
```

Message types: `status`, `regression`, `directive`, `task`, `question`.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BUS_DIR` | auto-resolved | Override bus directory location |
| `EVENT_BUS_ENABLED` | `true` | Set to `false` to disable all bus operations |
| `PROJECT_ROOT` | git root | Project root for bus resolution |
