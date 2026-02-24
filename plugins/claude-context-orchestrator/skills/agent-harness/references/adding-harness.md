# Adding a New Harness

Step-by-step guide for adding an autonomous agent harness to a project. Based on the tianding-miniapp, optimize, and uifix harnesses in the Wechat project.

---

## Prerequisites

Before you start, confirm these exist:

- `claude_files/` directory (for progress + harness instructions)
- `.claude/scripts/` directory (for start/seed/continue scripts)
- `.claude/hooks/harness-dispatch.sh` (unified stop hook dispatcher — can import from `~/.claude-ops/hooks/`)
- `~/.claude-ops/state/session-registry.json` pattern (multi-harness session routing)
- `jq` installed (all scripts depend on it)
- `~/.claude-ops/` infrastructure (scaffold, lib, hooks, templates)

---

## Step 1: Scaffold

The fastest path — generates all files from templates:

```bash
bash ~/.claude-ops/scripts/scaffold.sh my-feature /path/to/project
```

This creates 7 files with `{{HARNESS}}` replaced:

| File | Purpose |
|------|---------|
| `claude_files/{name}-progress.json` | Task DAG, learnings, state |
| `claude_files/{name}-harness.md` | Session instructions (mission, rules, key files) |
| `claude_files/{name}-best-practices.json` | Monitor-evolvable quality policy |
| `.claude/scripts/{name}-start.sh` | Activate harness, register session |
| `.claude/scripts/{name}-seed.sh` | Compact reseed prompt after /clear |
| `.claude/scripts/{name}-continue.sh` | Tmux context reset (/clear + reseed) |

Edit the generated TODO placeholders with real tasks and mission.

---

## Step 2: Customize Progress File

Edit `claude_files/{name}-progress.json`. Two schemas depending on complexity:

### Minimal (optimization-style)

```json
{
  "harness": "{name}",
  "mission": "Brief mission statement",
  "status": "active",
  "started_at": "2026-02-21T00:00:00Z",
  "session_count": 0,
  "tasks": {
    "first-task": {
      "status": "pending",
      "description": "What this task does.",
      "blockedBy": [],
      "owner": null,
      "steps": ["identify", "implement", "verify"],
      "completed_steps": [],
      "team": null,
      "metadata": {}
    }
  },
  "state": {},
  "learnings": [],
  "commits": []
}
```

### Extended (miniapp-style, with phases + test evidence)

```json
{
  "harness": "{name}",
  "mission": "Brief mission statement",
  "status": "active",
  "started_at": "2026-02-21T00:00:00Z",
  "session_count": 0,
  "tasks": {
    "first-task": {
      "status": "pending",
      "description": "What this task does.",
      "blockedBy": [],
      "owner": null,
      "steps": ["backend", "tool", "richcard", "wire", "css", "test"],
      "completed_steps": [],
      "team": null,
      "metadata": {
        "phase": 1,
        "surface": "chat",
        "richcard": "bill-card",
        "notes": "",
        "test_evidence": "",
        "chrome_verified": false
      }
    }
  },
  "state": {},
  "learnings": [],
  "commits": [],
  "rotation": {
    "max_rounds": 20,
    "max_features_per_session": 3,
    "mode": "new_session",
    "claude_command": "cdo"
  },
  "current_session": {
    "round_count": 0,
    "tasks_completed": 0,
    "started_at": "2026-02-21T00:00:00Z"
  }
}
```

**Key rules:**
- `status` is `"active"` when running, `"done"` when finished
- Task statuses: `"pending"` | `"in_progress"` | `"completed"`
- `steps` array names must match what the stop hook displays
- `learnings` is append-only: things Claude discovers that survive /clear
- `blockedBy` creates a DAG — tasks with unresolved deps cannot start
- `owner` and `team` are used for multi-agent/swarm harnesses
- Current task is derived (first `in_progress`, else first unblocked `pending`), never stored as a top-level field
- Source `~/.claude-ops/lib/harness-jq.sh` in all scripts for shared query functions

---

## Step 3: Customize Harness Instructions

Edit `claude_files/{name}-harness.md`. Claude reads this at every session start and after every context reset. Include:

```markdown
# {Name} Harness -- {One-Line Mission}

## Mission
{What Claude is trying to accomplish. Be specific and motivating.}

## Core Principles
{3-5 rules that govern Claude's behavior. Examples:}
- Never stop. The stop hook blocks you. Keep working.
- Zero mock data. Show empty states with error messages.
- Commit after each feature. Don't batch.
- Update progress.json after every feature.

## Progress File
`claude_files/{name}-progress.json` -- read first every session.

## Workflow Per Feature
{Numbered steps Claude follows for each feature. Examples:}
1. BACKEND -- endpoint in routes file
2. TOOL -- LLM tool definition + handler
3. TEST -- bun test + verify
4. COMMIT -- git commit with evidence

## Key Files
| File | Purpose |
|------|---------|
| `src/...` | Where code goes |
| `data/...` | Where config goes |

## Constraints
- Do NOT send messages (WhatsApp, Discord, Nexus, email)
- Do NOT modify security policies
- Test before deploying: `bun test`

## Context Reset
When context gets heavy: `bash .claude/scripts/{name}-continue.sh`
```

**Sizing:** 100-250 lines. Dense enough to reorient Claude from zero context. No filler.

---

## Step 4: Register in Dispatch

### 4a. Register in progress file

Ensure your progress file has the `"harness": "{name}"` field. `harness-dispatch.sh` reads this to identify which harness a progress file belongs to. The `resolve_progress_file()` function finds the right file automatically.

### 4b. No per-harness block function needed

The dispatch system uses a single `block_generic()` function for all harnesses. It reads the task graph from the progress file and generates the block message automatically. You do NOT need to write a `block_{name}()` function.

No case entry in the dispatch switch is needed — `block_generic()` handles all harnesses via the `.harness` field in the progress file.

---

## Step 5: Self-Test

Run this verification sequence before going autonomous:

```bash
# 1. Validate progress JSON and verify required fields
jq '.harness, .mission, .status, .tasks | keys' claude_files/{name}-progress.json && echo "JSON valid"

# 2. Test start script
bash .claude/scripts/{name}-start.sh
# Should print harness instructions and set status=active

# 3. Test seed script
bash .claude/scripts/{name}-seed.sh
# Should output compact reorientation prompt

# 4. Verify shared library integration
source ~/.claude-ops/lib/harness-jq.sh && harness_current_task claude_files/{name}-progress.json

# 5. Verify dispatch integration
echo '{"session_id":"test-123"}' | bash .claude/hooks/harness-dispatch.sh
# Without registry entry: falls through to stop-check.sh
# With registry entry: blocks with harness message via block_generic()

# 6. Test escape hatch
touch /tmp/claude_allow_stop_test-123
echo '{"session_id":"test-123"}' | bash .claude/hooks/harness-dispatch.sh
# Should output {} (pass through)
rm /tmp/claude_allow_stop_test-123

# 7. Clean up
rm ~/.claude-ops/state/session-registry.json
jq '.status = "done"' claude_files/{name}-progress.json > /tmp/p.json && mv /tmp/p.json claude_files/{name}-progress.json
```

---

## Step 6: Launch with Monitor (recommended)

The simplest approach — `harness-launch.sh` handles all tmux operations correctly:

```bash
# One command does everything: tmux window, Claude, seed prompt, monitor
bash .claude/scripts/myharness-start.sh --monitor
```

This creates `h:myharness` window with worker (left pane) + monitor (right pane). Uses `harness_launch()` from `~/.claude-ops/lib/harness-launch.sh` which handles all the tmux gotchas (explicit `-t`, `-d` flags, correct pane targeting).

**Manual launch** (if you need more control):

```bash
# Create window with 2 panes side-by-side (use -d to avoid focus switch!)
tmux new-window -d -t h -n myharness -c "$PROJECT_ROOT"

# Get the actual pane ID (never use display-message -p from a script!)
WORKER_PANE=$(tmux list-panes -t h:myharness -F '#{session_name}:#{window_index}.#{pane_index}' | head -1)

# Launch agent in worker pane
tmux send-keys -t "$WORKER_PANE" "cdo" Enter
# Wait for "bypass permissions" to appear, then:
SEED=$(bash .claude/scripts/myharness-seed.sh)
tmux send-keys -t "$WORKER_PANE" -l "$SEED"
sleep 0.5
tmux send-keys -t "$WORKER_PANE" Enter

# Split for monitor — MUST pass explicit -t to target the correct pane
tmux split-window -d -t "$WORKER_PANE" -h -c "$PROJECT_ROOT"
MONITOR_PANE=$(tmux list-panes -t h:myharness -F '#{session_name}:#{window_index}.#{pane_index}' | tail -1)

# Launch monitor with explicit --pane
bash ~/.claude-ops/scripts/monitor-agent.sh --pane "$MONITOR_PANE" "$WORKER_PANE" 120 "Your monitor mission"
```

---

## Pre-Launch Checklist

- [ ] Progress JSON is valid (`jq . {name}-progress.json`)
- [ ] Progress file has `"harness"` field matching dispatch expectations
- [ ] Harness instructions exist and are <250 lines
- [ ] All 3 scripts are executable (`chmod +x .claude/scripts/{name}-*.sh`)
- [ ] `~/.claude-ops/lib/harness-jq.sh` is sourced in all scripts
- [ ] Escape hatch works (`touch /tmp/claude_allow_stop_<id>`)
- [ ] Seed output is <40 lines (fits in a single Claude prompt)
- [ ] Deactivation works (`jq '.status = "done"' ... > /tmp/p.json && mv ...`)
- [ ] If continuous-loop: PreCompact hook registered in `settings.local.json`
- [ ] Hook tests pass: `bash ~/.claude-ops/tests/test-hooks.sh`
