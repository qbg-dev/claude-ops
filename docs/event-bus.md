# Event Bus

JSONL append-log with pluggable side-effects. Agents publish typed events; side-effect scripts run asynchronously.

> **Note**: The event bus is legacy infrastructure from the harness system. Flat workers primarily use Fleet Mail for coordination. The bus is still available for side-effect-driven workflows.

## Usage

```bash
source ~/.claude-fleet/lib/event-bus.sh

# Publish
bus_publish "task.completed" '{"worker":"my-worker","task_id":"T-1","summary":"Done"}'
bus_publish "notification" '{"message":"Build failed","title":"CI Alert"}'

# Subscribe + read
bus_subscribe "my-consumer"
events=$(bus_read "my-consumer" --type "task.completed" --limit 10)

# Query (ad-hoc, no cursor)
bus_query --type "task.completed" --limit 20
bus_query --since "2026-02-28T00:00:00Z"
```

## Event Types

| Type | Side-effects | Key fields |
|------|-------------|------------|
| `task.completed` | update_tasks_json, notify_assignee | `worker`, `task_id`, `summary` |
| `worker.commit` | notify_chief_of_staff | `worker`, `sha`, `message` |
| `notification` | notify_human_agent | `message`, `title?` |
| `deploy` | notify_human_agent | `agent`, `service`, `target` |
| `error` | dlq_if_critical | `agent`, `message`, `critical?` |

All events get `_seq`, `_event_type`, `_ts` added automatically.

## Side-Effects

Declared in `.claude/bus/schema.json`. Scripts at `~/.claude-fleet/bus/side-effects/`. Errors logged to `.claude/bus/dlq/side-effect-errors.log`.

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `EVENT_BUS_ENABLED` | `true` | Disable all bus operations |
| `PROJECT_ROOT` | git root | Project root for bus resolution |
