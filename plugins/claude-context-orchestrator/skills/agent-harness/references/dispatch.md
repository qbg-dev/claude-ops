# Session-to-Harness Dispatch

## Overview

When a project runs multiple harnesses concurrently (e.g. a feature migration, a UI polish pass, and a codebase optimization all active at once), each Claude session needs to be routed to its assigned harness's stop hook. Without dispatch, every session hits the same generic `stop-check.sh`, which knows nothing about harness-specific progress, steps, or coordination.

The dispatch system solves this with three components:
1. A **registry** mapping session IDs to harness names
2. A **dispatch stop hook** that reads the registry and routes to `block_generic()` (unified for all harnesses)
3. **Start scripts** that register sessions in the registry at activation time

## Registry Format

The registry lives at `~/.claude-ops/state/session-registry.json` (canonical path: `$HARNESS_SESSION_REGISTRY` from `harness-jq.sh`). It is a flat JSON object mapping session IDs to harness names:

```json
{
  "abc-def-123": "tianding",
  "xyz-456-789": "optimize",
  "ghi-012-345": "uifix"
}
```

The harness name is a short slug. All names route through `resolve_progress_file()` → `block_generic()` (one function for all harnesses). Each progress file self-identifies via its `.harness` field.

The registry is initialized as `{}` by the first start script that runs, if the file does not exist.

## The Dispatch Stop Hook

`harness-dispatch.sh` replaces the project's default stop hook. Structure:

```
read stdin → extract session_id
  → check escape hatch (/tmp/claude_allow_stop_{session_id})
  → check echo chain (/tmp/claude_echo_state_{session_id})
  → source harness-jq.sh (shared task graph functions)
  → look up harness name from registry
  → GC expired beads
  → case $HARNESS in
       "")       auto-register if 1 active harness, else fallthrough to stop-check.sh  ;;
       none)     fallthrough to stop-check.sh  ;;
       *)        resolve_progress_file($HARNESS) → block_generic($PFILE)  ;;
     esac
```

Key design choices:

- **Unregistered sessions fall through.** If a session is not in the registry, `HARNESS` is empty and the `""` case pipes input to the project's generic `stop-check.sh`. This means ad-hoc sessions (manual debugging, one-off fixes) get the standard code-review prompts without any harness overhead.
- **Unknown harness names warn but don't block.** A typo in the registry produces a stderr warning and exits with `{}` (allow stop). Failing open prevents a stuck session.
- **Escape hatch checked before dispatch.** `touch /tmp/claude_allow_stop_{session_id}` bypasses all harnesses uniformly.

```bash
source ~/.claude-ops/lib/harness-jq.sh

HARNESS=""
if [ -f "$REGISTRY" ]; then
  HARNESS=$(jq -r --arg sid "$SESSION_ID" '.[$sid] // ""' "$REGISTRY" 2>/dev/null || echo "")
fi

case "$HARNESS" in
  "")    # Auto-register if exactly one active harness, else fallthrough
         PFILE=$(resolve_progress_file "$ACTIVE_HARNESS")
         block_generic "$PFILE" ;;
  none)  echo "$INPUT" | bash "$PROJECT_ROOT/.claude/hooks/stop-check.sh" ;;
  *)     PFILE=$(resolve_progress_file "$HARNESS")
         block_generic "$PFILE" ;;
esac
```

## How Start Scripts Register Sessions

Each harness's start script initializes the registry if missing and prints a registration command. The session registers itself by merging its ID into the registry with `jq`:

```bash
# In the start script (e.g. tianding-start.sh):
source "$HOME/.claude-ops/lib/harness-jq.sh" 2>/dev/null
REGISTRY="$HARNESS_SESSION_REGISTRY"
if [ ! -f "$REGISTRY" ]; then
  echo '{}' > "$REGISTRY"
fi
```

In practice, Claude runs the registration one-liner after the start script activates the harness. The `jq -s 'add'` pattern merges the new entry without clobbering existing registrations from other sessions.

## Block Function: `block_generic()`

A single `block_generic()` function handles ALL harnesses using the unified task graph. No per-harness `block_*()` functions needed.

```bash
# Sources harness-jq.sh at the top of harness-dispatch.sh
source ~/.claude-ops/lib/harness-jq.sh

block_generic() {
  local PROGRESS="$1"
  [ ! -f "$PROGRESS" ] && { echo '{}'; exit 0; }
  local STATUS=$(jq -r '.status // "inactive"' "$PROGRESS")
  [ "$STATUS" != "active" ] && { echo '{}'; exit 0; }

  # Read harness identity from the file itself
  local HNAME=$(harness_name "$PROGRESS")

  # Check rotation thresholds (may exit if rotating)
  check_rotation "$HNAME" "$PROGRESS" "$HNAME" && exit 0 || true

  # Compute task graph state via shared functions
  local CURRENT=$(harness_current_task "$PROGRESS")
  local NEXT=$(harness_next_task "$PROGRESS")
  local DONE_COUNT=$(harness_done_count "$PROGRESS")
  local TOTAL=$(harness_total_count "$PROGRESS")
  local DESCRIPTION=$(harness_task_description "$PROGRESS" "$CURRENT")

  local MSG="## ${HNAME}: ${DONE_COUNT}/${TOTAL} tasks complete.\n\n"
  MSG="${MSG}**Current:** ${CURRENT}\n"
  MSG="${MSG}**Description:** ${DESCRIPTION}\n"
  MSG="${MSG}**Next:** ${NEXT}\n"

  # Show what completing current task would unblock
  local WOULD_UNBLOCK=$(harness_would_unblock "$PROGRESS" "$CURRENT")
  [ -n "$WOULD_UNBLOCK" ] && MSG="${MSG}**Completing ${CURRENT} unblocks:** ${WOULD_UNBLOCK}\n"

  # Show blocked tasks with their specific blockers
  local BLOCKED_INFO=$(jq -r '... blocked tasks query ...' "$PROGRESS")
  [ -n "$BLOCKED_INFO" ] && MSG="${MSG}\n**Blocked tasks:**\n${BLOCKED_INFO}\n"

  # Swarm state from .state.* (if present)
  # ... swarm mode, cycle, pass rate, active agents, pending merges ...

  # Beads + other harnesses + nearby agents (standard sections)
  # ... beads_section(), other_harnesses_info(), discover_agent_panes() ...

  MSG="${MSG}\nEscape: touch /tmp/claude_allow_stop_${SESSION_ID}"
  python3 -c "import json,sys; print(json.dumps({'decision':'block','reason':sys.argv[1]}))" "$(echo -e "$MSG")"
}
```

The key improvement: `block_generic` reads `.harness` from the progress file for identity and uses `harness-jq.sh` functions to compute all task graph state. Adding a new harness only requires adding a case to `resolve_progress_file()` — no custom block function needed.

## Cross-Harness Awareness

Two mechanisms provide cross-harness visibility:

### 1. Other Harnesses Info

`other_harnesses_info()` scans all `*-progress.json` files in `claude_files/`, skips its own harness, and reports any with `"status": "active"`:

```bash
other_harnesses_info() {
  local my_harness="$1"
  for pfile in "$PROJECT_ROOT"/claude_files/*-progress.json; do
    [ -f "$pfile" ] || continue
    local pstatus=$(jq -r '.status // "inactive"' "$pfile")
    [ "$pstatus" != "active" ] && continue
    local pname=$(jq -r '.harness // ""' "$pfile" 2>/dev/null)
    [ -z "$pname" ] && pname=$(basename "$pfile" | sed 's/-progress\.json//')
    [ "$pname" = "$my_harness" ] && continue
    local pcurrent=$(harness_current_task "$pfile" 2>/dev/null || echo "unknown")
    echo "  - ${pname}: working on ${pcurrent}"
  done
}
```

This appears in every block message, so each harness session knows what else is happening.

### 2. Beads Coordination

`beads_section()` reads `claude_files/harness-beads.json` and surfaces three primitives:

| Primitive | Purpose | TTL |
|---|---|---|
| **Wisps** | Ephemeral messages between harnesses | 24h |
| **Claims** | File-level locks ("I'm editing tools.ts, don't touch") | 24h |
| **Gates** | Named blockers ("don't deploy until migration done") | None (manual) |

The block message shows wisps addressed to the current harness, claims held by *other* harnesses (as a warning), and gates set by *other* harnesses. The dispatch hook also runs a lightweight GC on every stop to clean expired wisps and claims:

```bash
if [ -f "$BEADS" ]; then
  NOW=$(date +%s)
  TMP=$(mktemp)
  jq --argjson now "$NOW" '
    .wisps |= [.[] | select(.expires > $now and .read == false)] |
    .claims |= with_entries(select(.value.expires > $now))
  ' "$BEADS" > "$TMP" 2>/dev/null && mv "$TMP" "$BEADS" || rm -f "$TMP"
fi
```

Harnesses manage beads via `harness-bead.sh`:

```bash
bash .claude/scripts/harness-bead.sh wisp optimize "tools.ts refactored, check imports" tianding
bash .claude/scripts/harness-bead.sh claim src/core/tools.ts optimize "refactoring handlers"
bash .claude/scripts/harness-bead.sh gate deploy optimize "performance regression unfixed"
```

## Session Registry

The session registry now lives at `~/.claude-ops/state/session-registry.json` (persists across reboots). The canonical path is `$HARNESS_SESSION_REGISTRY` exported by `harness-jq.sh`. All scripts source `harness-jq.sh` to get this path rather than hardcoding it.

**When to use which:**

- **/tmp registry** when harnesses are session-bound, you don't need to survive reboots, and the mapping is simple (session -> harness name). This is the common case for overnight autonomous runs where the machine stays on.
- **File registry** when you need persistent tracking across reboots, want to commit harness state to git, or need richer metadata (file scope for conflict detection, branch names for worktree isolation, priority ordering).

The dispatch hook can be adapted to read either format. The core pattern (registry lookup -> case switch -> block function) stays the same regardless of where the registry lives.

---

## Naming: `.harness` Field (Self-Identifying)

With the unified task graph, each progress file contains a `.harness` field that serves as the canonical identity. `block_generic()` reads this field — no more name mismatches between dispatch, beads, and filename:

| Where | Source | Example |
|-------|--------|---------|
| Progress file | `.harness` field | `"tianding-miniapp"` |
| Registry value | Maps to `resolve_progress_file()` | `"tianding"` → `tianding-miniapp-progress.json` |
| Beads/other_harnesses | Read from `.harness` field | Automatic — no manual passing |
| Pane metadata | Written by `update_pane_status()` | `/tmp/tmux_pane_meta_{pane_id}` JSON |

The old per-harness naming inconsistency bug is eliminated — identity comes from the file itself.
