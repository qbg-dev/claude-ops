# Hooks

boring registers four Claude Code hooks that fire at lifecycle points in every session. Together they form the glue between Claude's tool calls and the harness state machine.

## Hook Registration

`install.sh` writes these to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [{
      "hooks": [{"type": "command", "command": "bash ~/.boring/hooks/interceptors/pre-tool-context-injector.sh"}]
    }],
    "PostToolUse": [{
      "hooks": [{"type": "command", "command": "bash ~/.boring/hooks/publishers/post-tool-publisher.sh"}]
    }],
    "Stop": [{
      "hooks": [{"type": "command", "command": "bash ~/.boring/hooks/gates/stop-harness-dispatch.sh"}]
    }],
    "UserPromptSubmit": [{
      "hooks": [{"type": "command", "command": "bash ~/.boring/hooks/publishers/prompt-publisher.sh"}]
    }]
  }
}
```

## PreToolUse — Context Injector

**Script**: `hooks/interceptors/pre-tool-context-injector.sh`

Fires before every tool call. Injects relevant context into the tool call as `additionalContext`.

### What it injects

1. **Policy matches** — reads `policy.json` context-injection rules for the current harness. Rules match on file paths, command patterns, or tool names. The top-N matching snippets are injected.

2. **Phase context** (long-running harnesses only) — if the harness is in a defined cycle phase (`probe`, `reconcile`, `act`, `persist`), injects a reminder of the current phase.

3. **Inbox messages** — scans `agents/module-manager/inbox.jsonl` for unprocessed messages within the last 30 minutes. Injects up to 5 messages as context.

4. **Acceptance summary** — compact pass/fail status from `acceptance.md`.

5. **File-edit warnings** — aggregated from other harnesses' `outbox.jsonl`. Warns the agent if a file it's about to edit was recently modified by another agent.

### Configuration

Environment variables that control injection:

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTEXT_INJECTOR_MAX_MATCHES` | `3` | Max policy rules to inject per tool call |
| `INBOX_ENABLED` | `true` | Enable inbox injection |
| `INBOX_SCAN_WINDOW_SEC` | `1800` | Look back this many seconds for inbox messages |
| `INBOX_MAX_INJECT_MESSAGES` | `5` | Max inbox messages to inject |
| `INBOX_ACCEPTANCE_INJECT` | `true` | Inject acceptance summary |
| `INBOX_FILE_EDIT_TRACKING` | `true` | Inject file-edit warnings |

### Policy rules (policy.json)

```json
{
  "context_injections": [
    {
      "pattern": "auth",
      "match_on": ["file_path", "command"],
      "context": "Auth tokens expire after 1h. Always refresh before use."
    },
    {
      "pattern": "database",
      "match_on": ["file_path"],
      "context": "Use transactions for all multi-table writes."
    }
  ]
}
```

`match_on` can include `file_path`, `command`, `tool_name`, or `any`.

### Cancel graceful-stop

A side-effect of PreToolUse: if the agent resumes after the Stop hook wrote a `graceful-stop` sentinel (operator sent a new message), PreToolUse deletes the sentinel so the watchdog does not rotate the session.

## PostToolUse — Event Publisher

**Script**: `hooks/publishers/post-tool-publisher.sh`

Fires after every tool call. Publishes observability events to the event bus.

- **File edits** (`Write`, `Edit`, `NotebookEdit`): publishes `file-edit` event. Triggers `append_outbox.sh` side-effect, which writes to the harness's `outbox.jsonl`. Other harnesses' PreToolUse scans this to detect cross-harness file conflicts.
- **Tool calls** (`Bash`, `Read`, etc.): publishes `tool-call` event for telemetry.

## Stop — Harness Gate

**Script**: `hooks/gates/stop-harness-dispatch.sh`

The most important hook. Fires when Claude Code is about to stop (session ends, `exit`, or Claude naturally finishes responding).

### Decision tree

```
Stop fires
  │
  ├── No harness registered? → hook_pass (let it stop)
  │
  ├── Harness found
  │     │
  │     ├── Run throttled GC (pane registry cleanup)
  │     │
  │     ├── Lifecycle = long-running?
  │     │     → hook_pass (write graceful-stop sentinel)
  │     │       watchdog reads sleep_duration, respawns after interval
  │     │
  │     └── Lifecycle = bounded
  │           │
  │           ├── All tasks complete?
  │           │     → hook_block: "Update MEMORY.md, run bus_git_checkpoint, then stop"
  │           │       (escape: touch {session_dir}/allow-stop)
  │           │
  │           └── Tasks remaining?
  │                 → hook_block: show current task, next task, blocked tasks
  │                   agent reads this and keeps working
```

### hook_block vs hook_pass

`hook_block "message"` returns a non-zero exit code with the message as `stderr`. Claude Code shows this to the agent as context—the agent reads it and continues working.

`hook_pass` returns exit code 0. Claude Code lets the session stop.

### Escape hatch

If an agent is stuck and you need to manually stop it:

```bash
# Find the session ID from Claude TUI or pane registry
touch ~/.boring/state/sessions/{session_id}/allow-stop
```

Or set a one-time stop flag:

```bash
source ~/.boring/lib/harness-jq.sh
touch "$(harness_runtime my-harness)/stop-flag"
```

### Module dispatch

The dispatcher sources five modules:
- `hooks/dispatch/harness-gates.sh` — core `block_generic` logic
- `hooks/dispatch/harness-gc.sh` — throttled pane registry GC
- `hooks/dispatch/harness-rotation.sh` — session rotation logic
- `hooks/dispatch/harness-discovery.sh` — pane-registry maintenance
- `hooks/dispatch/harness-bg-tasks.sh` — background task health checks

## UserPromptSubmit — Prompt Publisher

**Script**: `hooks/publishers/prompt-publisher.sh`

Fires when the user submits a prompt. Publishes a `prompt` event to the bus with the session ID, harness name, and prompt text.

Side-effects:
- `sync_harness_inbox.sh` — scans all harness outboxes and routes file-edit warnings to affected agents' inboxes
- `worker-prompt-notify.sh` — if this session is a worker (canonical contains `/`), notifies the coordinator

## Authoring Custom Hooks

### Hook contract

Hooks receive a JSON object on `stdin`:

```json
{
  "session_id": "...",
  "tool_name": "Write",
  "tool_input": {"file_path": "...", "content": "..."}
}
```

Hooks must respond with:
- Exit 0 + empty/JSON stdout: allow the tool call (or stop)
- Exit non-zero + message on stderr: block with that message shown to agent

### Shared utilities

Source `lib/pane-resolve.sh` for pane and harness resolution:

```bash
source "$HOME/.boring/lib/pane-resolve.sh"

INPUT=$(cat)
hook_parse_input "$INPUT"          # sets $_HOOK_SESSION_ID, $_HOOK_TOOL_NAME, etc.
resolve_pane_and_harness "$SESSION_ID"  # sets $HARNESS, $OWN_PANE_ID, $CANONICAL

hook_pass                          # allow (exit 0)
hook_block "Your message here"     # block (exit 1, message to agent)
hook_context "Injected context"    # inject additionalContext (exit 0 with JSON)
```

### Example: block writes to production config

```bash
#!/usr/bin/env bash
set -euo pipefail
trap 'echo "{}"; exit 0' ERR

source ~/.boring/lib/pane-resolve.sh

INPUT=$(cat)
hook_parse_input "$INPUT"

if [[ "$_HOOK_TOOL_NAME" == "Write" ]]; then
  FILE_PATH=$(echo "$_HOOK_TOOL_INPUT" | jq -r '.file_path // ""')
  if [[ "$FILE_PATH" == *"/etc/production"* ]]; then
    hook_block "Blocked: do not write to production config directly."
  fi
fi

hook_pass
```

Register it in `settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [{
      "hooks": [{
        "type": "command",
        "command": "bash ~/.my-org/hooks/block-prod-writes.sh"
      }]
    }]
  }
}
```

Multiple PreToolUse hooks run in sequence; any one can block or inject context.
