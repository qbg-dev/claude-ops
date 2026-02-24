# Harness Architecture

## Three-Separation Architecture

| Concern | Location | Shared? | What lives here |
|---------|----------|---------|-----------------|
| **Infrastructure** | `~/.claude-ops/` | Global — all projects | Scripts, hooks, templates, tests |
| **State** | `claude_files/{name}-*` | Per-harness | Progress, harness.md, journal |
| **Policy** | `claude_files/{name}-*` | Per-harness | best-practices.json, context-injections.json |
| **Execution** | `TeamCreate` + `Task` tool | Ephemeral | Worker spawn, messaging, task delegation |

---

## Infrastructure Layer (`~/.claude-ops/`)

Shared across all projects. Agents source directly — never copy into projects.

| Path | What |
|------|------|
| `~/.claude-ops/scaffold.sh` | Create new harness from 7 templates |
| `~/.claude-ops/lib/harness-jq.sh` | Task graph queries (source in all scripts) |
| `~/.claude-ops/lib/handoff.sh` | Session rotation/replacement |
| `~/.claude-ops/lib/bead.sh` | Cross-harness coordination (wisps, claims, gates) |
| `~/.claude-ops/hooks/harness-dispatch.sh` | Stop hook: session->harness routing |
| `~/.claude-ops/hooks/stop-check.sh` | General code-review for non-harness sessions |
| `~/.claude-ops/hooks/admission/deploy-mutator.sh` | PreToolUse: auto-injects deploy flags |
| `~/.claude-ops/hooks/admission/context-injector.sh` | PreToolUse: injects knowledge before tool calls |
| `~/.claude-ops/hooks/operators/progress-validator.sh` | PostToolUse: runs checks.d/ + validates progress |
| `~/.claude-ops/hooks/operators/activity-logger.sh` | PostToolUse: logs tool use to activity JSONL |
| `~/.claude-ops/hooks/operators/checks.d/` | Modular code quality checks (drop files in/out) |
| `~/.claude-ops/templates/*.tmpl` | 7 scaffold templates |
| `~/.claude-ops/tests/run-all.sh` | 181 tests, 9 suites |

---

## State Layer: CLAUDE.md (the entry point)

CLAUDE.md holds stable things — mission, architecture rules, safety. It *points to* the progress file but doesn't contain the feature list.

**Why separate?** Goals are stable (mission doesn't change session to session). Features are dynamic (status changes every commit). Mixing them causes drift.

```markdown
## Autonomous Harness

**Mission:** [One paragraph — what we're building and *why*.]

**Progress file:** `claude_files/{name}-progress.json` — read this first every session.

**Architecture rules:**
- [Framework/pattern constraints]
- [No mock data — empty state with error message if API missing]
- [Commit after each meaningful unit]

**Safety:**
- Do NOT send messages (WhatsApp, Discord, Nexus, email)
- Do NOT deploy to production
- Do NOT run destructive git commands

**Self-clear:** When context feels heavy, run `bash .claude/scripts/{name}-continue.sh`
```

---

## State Layer: Progress File (durable memory)

JSON file that survives across sessions. Agent reads it at start, updates after each unit of work.

### Unified Task Graph Schema

All harnesses use this schema. Tasks form a DAG via `blockedBy` — the current task is derived at query time (first `in_progress`, else first unblocked `pending`), never stored as a top-level field.

```json
{
  "harness": "billing-migration",
  "mission": "Brief mission statement — carried into seed prompts after /clear",
  "status": "active",
  "started_at": "2026-02-21T22:27:47Z",
  "session_count": 1,
  "tasks": {
    "billing": {
      "status": "in_progress",
      "description": "Query property bills via chat -> bill-card RichCard",
      "blockedBy": [],
      "owner": null,
      "steps": ["backend", "tool", "richcard", "wire", "css", "test"],
      "completed_steps": ["backend", "tool"],
      "team": null,
      "metadata": {
        "notes": "API returns paginated results, need scroll handler",
        "test_evidence": "",
        "chrome_verified": false
      }
    },
    "meter-reading": {
      "status": "pending",
      "description": "Meter reading submission via chat",
      "blockedBy": ["billing"],
      "owner": null,
      "steps": ["backend", "tool", "richcard", "wire", "css", "test"],
      "completed_steps": [],
      "team": null,
      "metadata": {}
    }
  },
  "state": {},
  "learnings": [
    "uview-ui u-form needs :model not v-model for nested objects",
    "WeChat pages.json subpackages must have unique root paths"
  ],
  "commits": ["abc1234 feat: add billing query"],
  "rotation": {
    "max_rounds": 20,
    "max_features_per_session": 3,
    "mode": "new_session",
    "claude_command": "cdo"
  },
  "current_session": {
    "round_count": 0,
    "tasks_completed": 0,
    "started_at": "2026-02-21T22:27:47Z"
  }
}
```

### Shared jq Functions (`~/.claude-ops/lib/harness-jq.sh`)

Source in any harness script: `source ~/.claude-ops/lib/harness-jq.sh`

| Function | Returns |
|----------|---------|
| `harness_current_task $PF` | First in_progress task, else first unblocked pending, else "ALL_DONE" |
| `harness_next_task $PF` | Next unblocked pending (skipping in_progress) |
| `harness_done_count $PF` | Count of completed tasks |
| `harness_total_count $PF` | Total task count |
| `harness_completed_names $PF` | Comma-separated completed task IDs |
| `harness_pending_names $PF` | Comma-separated pending task IDs |
| `harness_task_description $PF $TASK` | Description of a specific task |
| `harness_name $PF` / `harness_mission $PF` | Read `.harness` / `.mission` |
| `harness_check_blocked $PF $TASK` | JSON blocker details or "null" if unblocked |
| `harness_set_in_progress $PF $TASK` | Set status (validates deps — refuses if blocked, returns exit 1 with blocker details) |
| `harness_set_completed $PF $TASK` | Set status to completed |
| `harness_would_unblock $PF $TASK` | Tasks that become runnable when this task completes |
| `harness_state $PF $KEY` | Read `.state.*` (harness-specific fields) |

**Dependency enforcement:** `harness_set_in_progress` validates blockedBy at write time. If blocked, it prints exactly what's blocking to stderr and returns exit 1.

### Derived Fields (computed, never stored)

```bash
source ~/.claude-ops/lib/harness-jq.sh
CURRENT=$(harness_current_task "$PROGRESS")    # first in_progress or first unblocked pending
NEXT=$(harness_next_task "$PROGRESS")          # next unblocked pending
DONE=$(harness_done_count "$PROGRESS")         # count of completed
TOTAL=$(harness_total_count "$PROGRESS")       # total tasks
```

### Field Glossary

| Field | Level | Purpose |
|-------|-------|---------|
| `harness` | Top | Self-identifying slug — dispatch reads this instead of parsing filename |
| `mission` | Top | One-liner for seed prompts. Reminds the agent *why*. |
| `status` | Top | `"active"` or `"done"`. Hooks check this. |
| `tasks` | Top | DAG of tasks with `blockedBy` dependency edges |
| `state` | Top | Harness-specific data (swarm fields, pass rate history, etc.) |
| `learnings` | Top | Persistent memory. Seed script carries last 5 forward. Terse bullet points. |
| `session_count` | Top | Bumped on each `/clear` + reseed. |
| `rotation` | Top | Session rotation config (max_rounds, claude_command, mode) |
| `current_session` | Top | Per-session counters (round_count, tasks_completed) |
| `blockedBy` | Task | Array of task IDs that must complete before this task can start |
| `owner` | Task | Agent name if claimed (for multi-agent/swarm harnesses) |
| `team` | Task | Claude Code sub-team name if spawned for this task |
| `description` | Task | Enough context to start work without reading harness.md. Carried into seed prompts. |
| `steps` | Task | Explicit step array. Allows per-task cycle customization. |
| `metadata` | Task | Harness-specific per-task data (test_evidence, chrome_verified, findings, notes) |

### Journal File (`claude_files/{name}-journal.md`)

Human-readable briefing that accumulates over the harness lifetime. The agent appends a section after each task or round. Unlike `learnings` (terse bullets for machine consumption in seed prompts), the journal is for **humans** — Warren reads this to understand:

1. **What the agent did** and what worked
2. **Difficulties and dead ends** — what approaches failed and why
3. **Blocked on external action** — checkboxed items that need a human
4. **Key metrics** — before/after numbers for the round
5. **Next priorities** — what the agent plans to tackle next

**Format:** Each entry is a Markdown section with timestamp and task name. Use `[ ]` checkboxes for blocked items.

---

## Policy Layer: Hook Architecture

K8s-inspired three-layer enforcement. All hooks at `~/.claude-ops/hooks/`, shared across projects.

```
+------------------------------------------------------------+
|                  HOOK CONTROL PLANE                         |
|                                                             |
|  Admission Controllers   Operators       Probes             |
|  (PreToolUse gates)      (PostToolUse)   (Stop checks)      |
|                                                             |
|  deploy-mutator.sh       progress-       task-readiness.sh  |
|  context-injector.sh     validator.sh    harness-dispatch.sh |
|                          activity-                           |
|                          logger.sh                           |
|                                                             |
|  Config: best-practices.json (monitor-evolvable)            |
|  Knowledge: context-injections.json (monitor-evolvable)     |
|  Checks: checks.d/*.sh (monitor adds/removes files)        |
+------------------------------------------------------------+
```

### Three evolvable surfaces

All take effect instantly — no restart needed:

| Surface | Per-harness file | What it controls |
|---------|-----------------|-----------------|
| **best-practices.json** | `claude_files/{name}-best-practices.json` | Thresholds, deploy rules, verification standards |
| **context-injections.json** | `claude_files/{name}-context-injections.json` | Knowledge injected before tool calls |
| **checks.d/*.sh** | `~/.claude-ops/hooks/operators/checks.d/` | Modular code quality checks |

### Hooks inventory

| Hook | Type | What it does |
|------|------|-------------|
| `harness-dispatch.sh` | Stop | Routes sessions to `block_generic()` via registry |
| `stop-check.sh` | Stop | General code-review for non-harness sessions |
| `admission/deploy-mutator.sh` | PreToolUse (Bash) | Auto-injects --fast --skip-langfuse, blocks test deploy |
| `admission/context-injector.sh` | PreToolUse (all) | Injects relevant knowledge before tool calls |
| `operators/progress-validator.sh` | PostToolUse (Write/Edit) | Runs checks.d/ modules + validates progress changes |
| `operators/activity-logger.sh` | PostToolUse (all) | Logs tool use to `/tmp/claude_activity_{harness}.jsonl` |

### PreCompact hook

Critical for continuous-loop harnesses. Fires before Claude compacts context, giving the agent one last chance to persist discoveries. Six preservation layers: (1) uncommitted work guard, (2) journal entry, (3) progress update, (4) session decision log, (5) draft preservation, (6) active file bookmark.

### Project-level dispatch

Each project has `.claude/hooks/harness-dispatch.sh` that imports from `~/.claude-ops/hooks/`:

```bash
#!/usr/bin/env bash
# Project dispatch — delegates to shared infrastructure
source ~/.claude-ops/hooks/harness-dispatch.sh "$@"
```

---

## Execution Layer: Teams

Default execution layer for all harnesses. Uses Claude Code's native team primitives as the ephemeral execution runtime. Only omit for fully sequential task chains.

```
Harness starts -> Lead creates TeamCreate("harness-{name}")
              -> TaskCreate for each pending task
              -> Task(subagent) spawns workers
              -> Workers complete tasks -> Lead syncs to progress.json
              -> Rotation/shutdown -> TeamDelete
              -> Next session recreates from progress.json
```

**Sync protocol:** progress.json -> TaskCreate on start; TaskUpdate -> progress.json on complete. Progress.json is always the source of truth.

Full documentation: see `teams.md`.

---

## Two-Layer Config Architecture

**Layer 1: XML config** (`{project}/.claude/agent-harness.xml`)
Per-project. Claude reads via `@include` in CLAUDE.md. Stop hook extracts subset at runtime.

**Layer 2: Shell hooks** enforce the XML at lifecycle boundaries.

Required XML sections: `<project>` (orientation), `<checklist>` (quality gates), `<stop-prompts>` (accountability).

Optional: gated `<item>` elements, `<workflow>`, `<sensitive-paths>`, `<progress-file>`.

### Minimal Harness XML

```xml
<agent-harness>
  <project>
    <name>My Project</name>
    <purpose>What this codebase does, in one line</purpose>
  </project>
  <checklist>
    <item>No mock/placeholder data introduced</item>
    <item>Changes follow existing patterns</item>
    <item>Git diff reviewed — no accidental files</item>
    <item>Feature summary provided (Before/After/How to test/Expected)</item>
  </checklist>
  <stop-prompts>
    <code-changes>
      <question>What does it do now?</question>
      <question>How did you verify it works?</question>
    </code-changes>
  </stop-prompts>
</agent-harness>
```

---

## Safety

### Threat Model

| Risk | Example | Mitigation |
|------|---------|------------|
| **Outbound comms** | Agent sends WhatsApp/email | Block unless harness explicitly enables |
| **Destructive git** | `git push --force` | Block in PostToolUse hook |
| **Production access** | SSH to prod, deploy scripts | Block unless harness explicitly enables |
| **Credential exposure** | Committing .env | Block in PostToolUse + checklist |
| **Runaway costs** | Infinite API calls | Rate limit in hooks |
| **Data destruction** | `rm -rf`, DROP TABLE | Block destructive patterns |

**Principle: whitelist over blacklist.** For overnight harnesses, prefer listing what the agent CAN do.

| Harness Type | Safety Level |
|---|---|
| **Interactive** (human watching) | Low — just the obvious |
| **Overnight** (unattended) | Medium — + outbound comms, + prod access |
| **Multi-agent swarm** | High — + messaging limits, + file scope |
| **Production-touching** | Maximum — whitelist only |

---

## Self-Regulation

The harness isn't static. Claude tightens constraints when in dangerous territory, relaxes for routine work.

- **Sensitive path detection:** Stop hook cross-references changed files against `<sensitive-paths>`. If matched: CAUTION prepended, extra questions added.
- **Dynamic guardrails:** Claude can create temporary PostToolUse hooks for risky operations (DB migrations, auth changes).
- **Blast radius awareness:** 1-3 files = routine. 10+ files = sweeping, consider splitting. Deploy/DB/auth = add guardrails.
