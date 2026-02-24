---
name: "Deferred Hooks"
description: "Guide for building deferred context injection hooks in Claude Code using UserPromptSubmit and Stop hook events. Covers ECHO<content> immediate-after-response injection with repeat count (ECHO{N}<content>) and chain syntax (ECHO<A && B && C>), CHECKEND deferred-to-next-prompt injection, per-session JSON state files, and state-depletion loop prevention."
pattern: "\\b(DEFERREDHOOKS)\\b[.,;:!?]?"
---

# Deferred Hooks for Claude Code

## Overview

Two patterns for injecting context at different points in the conversation:

| Pattern       | Trigger        | When Injected           | Hook Events Used        |
| ------------- | -------------- | ----------------------- | ----------------------- |
| ECHO<content> | Same message   | After Claude's response | UserPromptSubmit + Stop |
| CHECKEND      | End of message | On next user prompt     | UserPromptSubmit only   |

## ECHO Pattern Syntax (v2)

| Syntax              | Meaning                         | Example                       |
| ------------------- | ------------------------------- | ----------------------------- |
| `ECHO<X>`           | Inject X once after response    | `ECHO<CHECK>` → 1 injection   |
| `ECHO{N}<X>`        | Inject X N times                | `ECHO3<CHECK>` → 3 injections |
| `ECHO<A && B && C>` | Chain: inject A, then B, then C | 3 injections in sequence      |
| `ECHO{N}<A && B>`   | Repeat chain N times            | `ECHO2<A && B>` → A, B, A, B  |
| `ECHO0<X>`          | No-op (zero repeat)             | No state file written         |

**Caps:** Repeat ≤ 10, total chain items ≤ 10.

## Architecture

### ECHO Pattern (Post-Response Injection)

```
User: "do something ECHO2<A && B>"
  → UserPromptSubmit hook: regex captures repeat=2, content="A && B"
  → Splits on " && " → base chain: ["A", "B"]
  → Tiles repeat × base → full chain: ["A", "B", "A", "B"]
  → Writes JSON state: {"chain": ["A","B","A","B"], "iteration": 0, "max": 4}
  → Claude responds normally
  → Stop hook fires: pops "A", returns {"decision": "block", "reason": "A"}
  → Claude continues with "A" as context
  → Stop hook fires: pops "B", blocks again
  → Stop hook fires: pops "A", blocks again
  → Stop hook fires: pops "B", blocks again (last item, state file removed)
  → Stop hook fires: no state file → allows stop
```

**Files:**

- `~/.claude/hooks/echo-deferred.sh` — UserPromptSubmit: parses ECHO syntax, writes JSON state
- `~/.claude/hooks/echo-stop.sh` — Stop: pops chain items, injects via block

### Loop Prevention

v2 uses **state depletion** instead of `stop_hook_active`. The stop hook terminates when:

1. State file missing → allow stop
2. JSON invalid → delete + allow stop
3. `iteration >= max` → delete + allow stop
4. Chain empty → delete + allow stop

This allows multi-block chains to work (the old `stop_hook_active` guard prevented any second block).

### CHECKEND Pattern (Next-Prompt Injection)

```
User: "do something CHECKEND"
  → UserPromptSubmit hook: detects CHECKEND, stores state=1
  → Claude responds normally, stops
User: "anything"
  → UserPromptSubmit hook: sees state=1, outputs CHECK as stdout
  → Claude sees CHECK context
```

**File:** `~/.claude/hooks/checkend-deferred.sh`

## Key Implementation Details

### Per-Session State Files

State files MUST be keyed by `session_id`, not project path:

```bash
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
STATE_FILE="/tmp/claude_echo_state_${SESSION_ID}"
```

**Why:** Multiple Claude sessions in the same project share the same working directory. Per-project state files cause race conditions where one session consumes another's state.

### JSON State Format (v2)

```json
{ "chain": ["A", "B", "A", "B"], "iteration": 0, "max": 4 }
```

- `chain`: remaining items to inject (popped from front)
- `iteration`: how many items have been injected so far
- `max`: hard cap on total injections (≤ 10)

### Atomic Writes

Use temp file + mv to prevent partial reads:

```bash
temp_file="${STATE_FILE}.$$"
echo "$STATE_JSON" > "$temp_file"
mv "$temp_file" "$STATE_FILE"
```

### Hook Output Formats

| Format                                        | Visibility                                                              | Use Case                |
| --------------------------------------------- | ----------------------------------------------------------------------- | ----------------------- |
| Plain stdout                                  | `<system-reminder>UserPromptSubmit hook success: ...</system-reminder>` | Context injection       |
| JSON `{"additionalContext": "..."}`           | Discrete, not labeled                                                   | Subtle injection        |
| JSON `{"decision": "block", "reason": "..."}` | Stop hook only                                                          | Post-response injection |

### settings.json Configuration

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.claude/hooks/echo-deferred.sh"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "bash ~/.claude/hooks/echo-stop.sh" }
        ]
      }
    ]
  }
}
```

## Safety Mechanisms

| Mechanism                       | Protects Against                     |
| ------------------------------- | ------------------------------------ |
| Max iterations hard cap (10)    | Infinite loops from bugs             |
| State file absence = allow stop | Missing/deleted state                |
| JSON validation + cleanup       | Corrupted state files                |
| Atomic writes (temp+mv)         | Partial reads from concurrent access |
| 2-hour TTL cleanup              | Stale state from crashed sessions    |
| ECHO0 no-op                     | Zero-repeat edge case                |
| Empty segment filtering         | Malformed `&&` chains                |
| Repeat cap (10)                 | `ECHO9999<X>` abuse                  |

## Chaining with Snippets

ECHO and CHECKEND are primitives. They become powerful when the injected content triggers snippet patterns:

```
ECHO<CHECK> → Stop hook injects "CHECK" → snippet_injector matches CHECK → loads Paranoid Checker skill
ECHO<CHECK && JOURNEY> → First injects CHECK, then JOURNEY on the result
ECHO3<CHECK> → Three rounds of CHECK for thorough review
```

Any snippet trigger keyword can be used: `ECHO<DOCKER>`, `ECHO<GMAIL>`, etc.

## Limitations

- Content cannot contain `>` (terminates regex match)
- Only the first ECHO match is captured if multiple appear in one prompt
- Chain segments are split on `&&` (with spaces)—bare `&&` without spaces is treated as literal

## Debugging

Debug logs at:

- `/tmp/echo_hook_debug.log`
- `/tmp/checkend_debug.log`

State files at:

- `/tmp/claude_echo_state_{session_id}`
- `/tmp/claude_checkend_state_{session_id}`

Cleanup: state files auto-purge after 2 hours.

### Smoke Test

```bash
# Simulate capture
echo '{"session_id":"test","prompt":"do X ECHO2<A && B>"}' | bash ~/.claude/hooks/echo-deferred.sh
cat /tmp/claude_echo_state_test
# expect: {"chain":["A","B","A","B"],"iteration":0,"max":4}

# Simulate first pop
echo '{"session_id":"test"}' | bash ~/.claude/hooks/echo-stop.sh
# expect: {"decision":"block","reason":"A"}
cat /tmp/claude_echo_state_test
# expect: {"chain":["B","A","B"],"iteration":1,"max":4}

# Cleanup
rm -f /tmp/claude_echo_state_test
```