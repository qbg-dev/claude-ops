---
name: "hook-setup"
description: "Design and implement Claude Code hooks. Covers the hook protocol (stdin JSON, block/allow output), all five hook types (Stop, UserPromptSubmit, PostToolUse, SubagentStart/Stop), best practices for state management and idempotency, the two-phase state machine pattern for Stop hooks, and how to use prompt logs and tool logs to understand workflow patterns before deciding what to build. Use when setting up new hooks, debugging existing hooks, or when the user says HOOKSETUP. For project-specific hook config (checklists, stop prompts, workflow steps), see the project's feature_dev_guide.xml — hooks parse it at runtime."
---

## Source of Truth

Project-level hook behavior is configured in `{project}/.claude/feature_dev_guide.xml`. Hooks parse this XML at runtime to extract checklists, stop prompts, and gated questions. Edit the XML to change what hooks say — no need to touch shell scripts.

Key XML sections: `<pre-completion-checklist>` (items shown on every stop), `<stop-prompts>` (contextual messages by change type), `<hook-best-practices>` (this skill's content, co-located for reference).

## Protocol

Hooks are shell commands that receive JSON on stdin and control Claude's behavior through exit code + stdout.

**Input** (all hook types):
```json
{
  "session_id": "uuid",
  "cwd": "/path/to/project"
}
```

PostToolUse adds: `tool_name`, `tool_input`, `tool_use_id`, `transcript_path`.

**Output:**
- Exit 0, no stdout → **allow**
- Exit 0, `{"decision": "block", "reason": "..."}` → **block** (reason injected as user message)
- Exit non-zero → error (logged, doesn't block)

## Hook Types

| Type | Fires | Supports block? |
|---|---|---|
| `UserPromptSubmit` | User sends a prompt | Yes |
| `PostToolUse` | After a tool call completes | Yes |
| `Stop` | Claude is about to stop responding | Yes |
| `SubagentStart` | Task tool spawns a subagent | No (logging only) |
| `SubagentStop` | Subagent completes | No (logging only) |

## Best Practices

### 1. Hooks must be fast and side-effect-safe

Every hook runs synchronously in Claude's event loop. A slow hook (>2s) degrades the experience. A hook that crashes or hangs blocks the entire session.

- **No network calls.** Read local files, write local files. If you need to call an API, write a marker file and have a separate daemon process it.
- **Fail open.** If your hook can't determine what to do, `exit 0` (allow). Never block on ambiguity.
- **No interactive prompts.** Hooks run headless. No `read`, no `select`, no `fzf`.

### 2. State goes in `/tmp/` with session_id isolation

```bash
FLAG="/tmp/claude_myhook_${SESSION_ID}"
```

- Always suffix with `$SESSION_ID` — multiple sessions can run concurrently.
- Clean up stale flags: `find /tmp -name "claude_myhook_*" -mmin +120 -delete 2>/dev/null`
- Don't use persistent storage (dotfiles, databases) for per-session state.

### 3. Stop hooks need a two-phase state machine

A Stop hook that blocks will fire again when Claude tries to stop a second time. Without a state machine, it blocks forever.

```
Phase 1: No flag → evaluate → if needs attention → create flag → block
Phase 2: Flag exists → clean up → exit 0 (allow)
```

Phase 2 must ALWAYS allow. No conditions, no exceptions. Otherwise: infinite loop.

### 4. Gate on significance

Don't fire on trivial sessions. Count tool calls, check for file changes, or look at session duration before blocking. A hook that fires every time teaches Claude (and the user) to ignore it.

### 5. Multiple Stop hooks fire simultaneously

All Stop hooks in the settings array fire on the same stop event. If three hooks block, Claude sees all three block messages at once. Design hooks to be independent — don't assume ordering or that another hook's block was seen first.

### 6. PostToolUse matcher filters which tools trigger the hook

```json
{
  "matcher": "Bash|Write|Edit",
  "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/my-hook.sh" }]
}
```

`matcher` is a regex against the tool name. Only available for PostToolUse. Omit it to fire on every tool.

### 7. Defer to echo chains

If using the ECHO system (deferred prompt injection), Stop hooks should check for an active echo chain and skip if one exists:

```bash
ECHO_STATE="/tmp/claude_echo_state_${SESSION_ID}"
[ -f "$ECHO_STATE" ] && exit 0
```

This prevents hooks from interrupting a multi-step echo chain.

## Template: Stop Hook (Two-Phase)

```bash
#!/bin/bash
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')
[ -z "$SESSION_ID" ] && exit 0

find /tmp -name "claude_myhook_asked_*" -mmin +120 -delete 2>/dev/null
ASKED_FLAG="/tmp/claude_myhook_asked_${SESSION_ID}"

# --- Phase 2: Already asked → always allow ---
if [ -f "$ASKED_FLAG" ]; then
  rm -f "$ASKED_FLAG"
  exit 0
fi

# --- Phase 1: Evaluate ---

# Skip if echo chain active
[ -f "/tmp/claude_echo_state_${SESSION_ID}" ] && exit 0

# Your significance check here (tool count, file changes, etc.)
# If nothing worth blocking for → exit 0

touch "$ASKED_FLAG"
jq -n --arg reason "Your block message" '{"decision": "block", "reason": $reason}'
exit 0
```

## Template: PostToolUse Logger

```bash
#!/bin/bash
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')
[ -z "$TOOL_NAME" ] && exit 0

PROJECT=$(basename "${CWD:-_unknown}")
OUTPUT_DIR="$HOME/.claude/tool-logs/$PROJECT"
mkdir -p "$OUTPUT_DIR"

# Extract tool-specific fields, write JSONL
# (see tool_logger.sh for full Bash/Write/Edit field extraction)
exit 0
```

## Template: UserPromptSubmit Injector

```bash
#!/bin/bash
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
PROMPT=$(echo "$INPUT" | jq -r '.prompt // ""')

# Pattern match on prompt content
if echo "$PROMPT" | grep -qi "deploy"; then
  jq -n --arg reason "Deploy checklist: ..." '{"decision": "block", "reason": $reason}'
  exit 0
fi

# No match → allow
exit 0
```

## Using Logs to Inform Hook Design

Before building a hook, understand the actual workflow. Two log sources exist:

**Prompt logs** (`~/.claude/prompts/{project}/prompts.jsonl`):
```bash
PROMPT_LOG="$HOME/.claude/prompts/$PROJECT/prompts.jsonl"
jq -r '.hour' "$PROMPT_LOG" | sort -n | uniq -c | sort -rn          # Activity by hour
jq -r '.git_branch' "$PROMPT_LOG" | sort | uniq -c | sort -rn       # Branch patterns
jq -r 'select(.is_question) | .prompt[:60]' "$PROMPT_LOG" | head -20 # Common questions
```

**Tool logs** (`~/.claude/tool-logs/{project}/tools.jsonl`):
```bash
TOOL_LOG="$HOME/.claude/tool-logs/$PROJECT/tools.jsonl"
jq -r '.tool' "$TOOL_LOG" | sort | uniq -c | sort -rn                              # Tool frequency
jq -r 'select(.tool=="Edit" or .tool=="Write") | .file_path' "$TOOL_LOG" | sort | uniq -c | sort -rn | head -20  # Hot files
jq -r '.session_id' "$TOOL_LOG" | sort | uniq -c | sort -rn | head -10             # Session sizes
jq -r 'select(.tool=="Bash") | .description // .command[:60]' "$TOOL_LOG" | sort | uniq -c | sort -rn | head -20 # Common commands
```

**Session logs** (`~/.claude/tool-logs/{project}/sessions.jsonl`):
```bash
SESSIONS_LOG="$HOME/.claude/tool-logs/$PROJECT/sessions.jsonl"
jq -r '"\(.tool_calls)\t\(.name)"' "$SESSIONS_LOG" | sort -rn | head -20  # Sessions by size
```

The point isn't to follow a rigid process—it's to look at what's actually happening before building automation around it. A hook that doesn't match real usage patterns is worse than no hook.

## Registration

In `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/my-hook.sh" }] }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash|Write|Edit",
        "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/my-logger.sh" }]
      }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/my-injector.sh" }] }
    ]
  }
}
```

Project-specific hooks go in `{project}/.claude/settings.json` (same format, scoped to that project).

## Debugging

```bash
# Syntax check
bash -n ~/.claude/hooks/my-hook.sh

# Dry run with simulated input
echo '{"session_id":"test-123","cwd":"/path/to/project"}' | bash ~/.claude/hooks/my-hook.sh

# See what state files exist
ls /tmp/claude_*

# Clean up all hook state
find /tmp -name "claude_*" -mmin +120 -delete

# Add debug logging inside hooks
log() { echo "[$(date -Iseconds)] $1" >> /tmp/myhook_debug.log; }
```

## Existing Hooks Reference

| File | Type | What it does |
|---|---|---|
| `echo-stop.sh` | Stop | Replays deferred ECHO chain items |
| `echo-deferred.sh` | UserPromptSubmit | Captures `ECHO<content>` directives into state |
| `implementation-check.sh` | Stop | Shows changed files + pre-completion checklist |
| `session_namer.sh` | Stop | Asks Claude to name the session in 3-5 words |
| `tool_logger.sh` | PostToolUse | Logs Bash/Write/Edit calls to JSONL with agent attribution |
| `subagent_lifecycle.sh` | SubagentStart/Stop | Tracks active subagents via marker files |
| `prompt_logger.sh` | UserPromptSubmit | Logs prompts with metadata (hour, branch, flags) |
| `snippet_injector.py` | UserPromptSubmit | Pattern-matches keywords → injects snippet context |

All live in `~/.claude/hooks/`. Read any of them for working examples of the patterns described above.
