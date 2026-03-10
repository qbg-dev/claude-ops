# Hooks

claude-fleet registers Claude Code hooks in `~/.claude/settings.json`. They fire at lifecycle points in every session.

## Registered Hooks

| Event | Script | What it does |
|-------|--------|-------------|
| PreToolUse | `hooks/interceptors/pre-tool-context-injector.sh` | Inject inbox, policy, dynamic hooks |
| PostToolUse | `hooks/publishers/post-tool-publisher.sh` | Publish events, liveness heartbeat |
| Stop | `hooks/gates/stop-worker-dispatch.sh` | Gate exit, write graceful-stop sentinel |
| UserPromptSubmit | `hooks/publishers/prompt-publisher.sh` | Publish prompt events, liveness |

Install/repair: `bash ~/.claude-fleet/scripts/setup-hooks.sh` or `lint-hooks.sh --fix`.

## PreToolUse — Context Injector

Fires before every tool call. Injects as `additionalContext`:

1. **Dynamic hook matches** — registered via `add_hook(event="PreToolUse", ...)`
2. **Inbox messages** — unprocessed messages from last 30 minutes (up to 5)
3. **Policy context** — rules from `policy.json` matching file paths or commands

Environment config:

| Variable | Default | Description |
|----------|---------|-------------|
| `INBOX_ENABLED` | `true` | Enable inbox injection |
| `INBOX_SCAN_WINDOW_SEC` | `1800` | Lookback window |
| `INBOX_MAX_INJECT_MESSAGES` | `5` | Max messages injected |

## Stop — Gate

The lifecycle controller. Decision tree:

```
Stop fires
  ├── Dynamic hooks pending? → hook_block (show what's unfinished)
  ├── All gates passed? → hook_pass (write graceful-stop for watchdog)
  └── Escape: touch ~/.claude-fleet/state/sessions/{session_id}/allow-stop
```

`hook_block "message"` → exit non-zero, message shown to agent (keeps working).
`hook_pass` → exit 0, session stops.

## Dynamic Hooks

Workers register hooks at runtime via MCP:

```
# Block exit until TypeScript compiles
add_hook(event="Stop", description="verify TypeScript compiles")

# Inject context when editing specific files
add_hook(event="PreToolUse",
  content="Use applyAction() for ontology writes",
  condition={file_glob: "src/ontology/**"})

# Complete a gate
complete_hook("dh-1", result="PASS — no TS errors")
```

### Ownership Tiers

| Tier | Who sets it | Can worker remove? |
|------|------------|-------------------|
| **system** | Fleet infrastructure | No (12 irremovable safety gates) |
| **creator** | `fleet create` or another worker | No |
| **self** | The worker itself | Yes |

### Hook Events

PreToolUse, PostToolUse, Stop, UserPromptSubmit, PreCompact, SubagentStart, SubagentStop.

## Authoring Custom Hooks

Hooks receive JSON on stdin:

```json
{"session_id": "...", "tool_name": "Write", "tool_input": {"file_path": "...", "content": "..."}}
```

Respond with:
- Exit 0 → allow
- Exit non-zero + stderr message → block (message shown to agent)

Utilities:

```bash
source ~/.claude-fleet/lib/pane-resolve.sh
INPUT=$(cat)
hook_parse_input "$INPUT"
hook_pass                          # allow
hook_block "Your message here"     # block
hook_context "Injected context"    # inject additionalContext
```

Register in `~/.claude/settings.json`:

```json
{"hooks": {"PreToolUse": [{"hooks": [{"type": "command", "command": "bash /path/to/hook.sh"}]}]}}
```
