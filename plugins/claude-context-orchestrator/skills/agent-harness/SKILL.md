---
name: "agent-harness"
description: "Build and launch autonomous agent harnesses with worker, monitor, and control plane. Trigger: HARNESSUP."
---

# Agent Harness

A harness is a task graph + hooks that let a Claude agent work autonomously for hours. The agent decides WHAT. The harness tracks WHERE. Hooks enforce HOW.

**Three separations:** Infrastructure (`~/.claude-ops/`, global) | State (`claude_files/{name}-*`, per-harness) | Policy (best-practices/context-injections, monitor-evolvable).

**Trigger: HARNESSUP** — reflect, evolve, continue.

---

## Two Paths to a Running Harness

### Fast Path: Populate from Plan (common case)

You already have a plan or know exactly what tasks to create. This is the 80% case — skip exploration, go straight to file creation.

```
1. Scaffold          bash ~/.claude-ops/scripts/scaffold.sh my-feature /path/to/project
2. Read scaffolds    Read all 9 generated template files + manifest
3. Read a reference  Read an existing harness (e.g., bi-opt-progress.json) for patterns
4. Write all files   Write all 10 files in parallel (9 scaffold + journal)
5. Post-scaffold     Update manifest status, agent-harness.xml, verify
6. Launch            bash .claude/scripts/my-feature-start.sh --monitor
```

**Step 4 checklist — 10 files to populate:**

| # | File | Key fields |
|---|------|-----------|
| 1 | `claude_files/{name}-progress.json` | `status: "active"`, `mission`, `started_at`, 10-25 tasks with `blockedBy` DAG |
| 2 | `claude_files/{name}-harness.md` | The World We Want, Why This Matters, Constraints, Terrain Map, Deploy Commands, Safety |
| 3 | `claude_files/{name}-goal.md` | North Star, Success Looks Like, Tensions to Navigate |
| 4 | `claude_files/{name}-best-practices.json` | verification, deploy, code_quality, rotation sections |
| 5 | `claude_files/{name}-context-injections.json` | file_context, command_context, tool_context |
| 6 | `claude_files/{name}-journal.md` | **Not scaffolded — create manually.** Session 0 retrospective if prior work exists |
| 7 | `.claude/scripts/{name}-seed.sh` | Enhance with team mandate, file paths, domain-specific tables |
| 8 | `.claude/scripts/{name}-start.sh` | Usually fine as-is from scaffold |
| 9 | `.claude/scripts/{name}-continue.sh` | Usually fine as-is from scaffold |
| 10 | `~/.claude-ops/harness/manifests/{name}/manifest.json` | **Set `status: "active"`** (scaffold defaults to "done") |

**Step 5 — post-scaffold fixups (easy to forget):**
- Update manifest `status` from `"done"` to `"active"`
- Add `goal` and `journal` paths to manifest `files` object
- Add entry to `agent-harness.xml` `<available-harnesses>` table
- Run `jq '.tasks | keys | length' claude_files/{name}-progress.json` to verify task count
- Run `bash .claude/scripts/{name}-seed.sh` to verify seed generates correctly

### Full Path: Explore → Design → Build (new domain)

You don't know the codebase yet. Need to explore before designing tasks.

```
1. Scaffold          bash ~/.claude-ops/scripts/scaffold.sh my-feature /path/to/project
2. Explore           Read CLAUDE.md, Glob for key dirs, Grep for patterns
3. Design            Choose archetype, identify tasks, map dependencies
4. Populate          Write all 10 files (same as Fast Path step 4)
5. Post-scaffold     Same fixups as Fast Path
6. Self-test         JSON validation, script syntax, seed dry-run, hook tests
7. Launch            bash .claude/scripts/my-feature-start.sh --monitor
```

---

## Archetypes

| Archetype | When | Example | Key trait |
|-----------|------|---------|-----------|
| **List-driven** | Tasks enumerable upfront | Miniapp migration (known pages) | Static DAG |
| **Exploration-first** | Must profile before planning | Performance optimization | `state.phase: "discovery"` |
| **Continuous-loop** | Metric can always improve | Eval pass rate, BI quality | Self-resetting `evolve-harness` task |
| **Deadline-driven** | Hard deadline, ruthless priority | Demo prep, sprint | Phases tied to dates |

---

## Critical Lessons (Hard-Won)

### Team Mandates Go in the Seed, Not the Harness

**The seed prompt is what forces agent behavior.** Agents read the seed first and follow it mechanically; the harness.md is read second and interpreted loosely.

Three failed attempts taught this:
1. Harness suggestion ("use subagents aggressively") → ignored
2. Harness + monitor nudge → premature completion
3. **Seed mandate + "REQUIRES TEAM" in task descriptions → success** (4 agents spawned in parallel)

**Pattern for team-mandatory tasks:**
```bash
# In seed.sh — near the top, impossible to miss:
cat <<EOF
## CRITICAL: Team Mandate for Phase A
**For tasks marked REQUIRES TEAM, you MUST use TeamCreate to spawn 2-3 agents.**
Do NOT attempt these tasks solo.
EOF
```

```json
// In progress.json — task description starts with REQUIRES TEAM:
"pillar-components": {
  "description": "REQUIRES TEAM (frontend-agent). Create PillarSection.tsx...",
  "team": "frontend-agent"
}
```

### Manifest Status Bug

`scaffold.sh` creates the manifest with `"status": "done"`. You MUST update it to `"active"` when populating. The start.sh script updates progress.json status but NOT the manifest.

### Journal Is Not Scaffolded

The scaffold creates 9 files. The journal (`claude_files/{name}-journal.md`) is NOT one of them. Always create it manually — it's the human-readable briefing Warren reads.

### Available-Harnesses Table

After creating a harness, add it to `agent-harness.xml`'s `<available-harnesses>` table. This is how other agents (and the dispatch hook) discover harnesses.

### Task Descriptions Are the Real Instructions

Put enough context per task that the seed script can include it directly. Don't force the agent to re-read a 200-line harness.md after every `/clear`. The description + steps should be self-contained.

### Phase Grouping for 10+ Tasks

Without phases, agents work on polish before core. Use `metadata.phase` to tag tasks. Phase A (foundations) must complete before Phase B (features). The blockedBy DAG enforces this.

---

## Progress Schema

```json
{
  "harness": "name", "mission": "...", "status": "active|done",
  "started_at": "ISO", "session_count": 0,
  "tasks": {
    "task-id": {
      "status": "pending|in_progress|completed",
      "description": "What to do. Start with REQUIRES TEAM if team-mandatory.",
      "blockedBy": [],
      "owner": null,
      "steps": ["step1", "step2"],
      "completed_steps": [],
      "team": null,
      "metadata": { "phase": "A" }
    }
  },
  "state": {},
  "rotation": { "max_rounds": 20, "claude_command": "cdo" },
  "current_session": { "started_at": null, "round_count": 0, "tasks_completed": 0 },
  "commits": [], "learnings": []
}
```

Derived fields (via `harness-jq.sh`, never stored): `current_task`, `done_count`, `pending_names`.

---

## Seed Script Anatomy

The seed is the most important file. It's what the agent reads first and follows mechanically. Structure:

```bash
#!/usr/bin/env bash
set -euo pipefail
HARNESS="my-feature"
PROJECT_ROOT="/path/to/project"
PROGRESS="$PROJECT_ROOT/claude_files/${HARNESS}-progress.json"

# Source harness-jq for progress queries
source "$HOME/.claude-ops/lib/harness-jq.sh" 2>/dev/null || true

# Compute progress summary
TOTAL=$(jq '.tasks | length' "$PROGRESS")
DONE=$(jq '[.tasks[] | select(.status == "completed")] | length' "$PROGRESS")
PENDING=$(jq '[.tasks[] | select(.status == "pending") | select(.blockedBy == [] or .blockedBy == null)] | length' "$PROGRESS")
CURRENT=$(jq -r '[.tasks | to_entries[] | select(.value.status == "in_progress") | .key] | first // "none"' "$PROGRESS")

cat <<EOF
run HARNESSUP

You are the **${HARNESS}** agent.

## Where We Are
- $DONE/$TOTAL waypoints, $PENDING unblocked
- Currently: ${CURRENT:-orienting}

## [TEAM MANDATE — if applicable]
**For tasks marked REQUIRES TEAM, you MUST use TeamCreate.**

## [DOMAIN-SPECIFIC TABLES — pillar mappings, module IDs, etc.]

## [KEY FILES — what to create, what NOT to modify]

## Orient Yourself
1. Read claude_files/${HARNESS}-harness.md
2. Read claude_files/${HARNESS}-progress.json
3. Decide what matters most right now
4. Work on it. Update progress + journal with what you learn.
EOF
```

**Tips:**
- Put the team mandate BEFORE "Orient Yourself" — it's read first
- Include concrete file paths, not vague descriptions
- Include domain-specific reference tables (module IDs, SQL prefixes, etc.)
- Compute `TEAM_TASKS` from progress.json to show pending team-mandatory work

---

## Hook Layers

Three layers, all at `~/.claude-ops/hooks/`, symlinked from project:

| Layer | Event | Hooks |
|-------|-------|-------|
| **Admission** | PreToolUse | `deploy-mutator.sh` (auto-injects flags), `context-injector.sh` (knowledge injection) |
| **Operators** | PostToolUse | `progress-validator.sh` (quality checks), `activity-logger.sh` (tool use log) |
| **Probes** | Stop | `harness-dispatch.sh` (blocks stop, shows task graph), `task-readiness.sh` (verification gate) |

Three monitor-evolvable surfaces (instant, no restart):
- `claude_files/{name}-best-practices.json` — thresholds, rules
- `claude_files/{name}-context-injections.json` — knowledge for tool calls
- `~/.claude-ops/hooks/operators/checks.d/*.sh` — drop-in quality checks

### Hook Setup (symlinks + settings)

```bash
mkdir -p .claude/hooks/admission .claude/hooks/operators
ln -sf ~/.claude-ops/hooks/harness-dispatch.sh .claude/hooks/
ln -sf ~/.claude-ops/hooks/admission/deploy-mutator.sh .claude/hooks/admission/
ln -sf ~/.claude-ops/hooks/admission/context-injector.sh .claude/hooks/admission/
ln -sf ~/.claude-ops/hooks/operators/progress-validator.sh .claude/hooks/operators/
ln -sf ~/.claude-ops/hooks/operators/activity-logger.sh .claude/hooks/operators/
```

Register in `.claude/settings.local.json`:
```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [
        { "type": "command", "command": "bash .claude/hooks/admission/deploy-mutator.sh" },
        { "type": "command", "command": "bash .claude/hooks/admission/context-injector.sh" }
      ]},
      { "matcher": "Write|Edit|Read", "hooks": [
        { "type": "command", "command": "bash .claude/hooks/admission/context-injector.sh" }
      ]}
    ],
    "PostToolUse": [
      { "matcher": "Write|Edit|NotebookEdit", "hooks": [
        { "type": "command", "command": "bash .claude/hooks/operators/progress-validator.sh" },
        { "type": "command", "command": "bash .claude/hooks/operators/activity-logger.sh" }
      ]},
      { "matcher": "Bash", "hooks": [
        { "type": "command", "command": "bash .claude/hooks/operators/activity-logger.sh" }
      ]}
    ],
    "Stop": [
      { "matcher": "", "hooks": [
        { "type": "command", "command": "bash .claude/hooks/harness-dispatch.sh" }
      ]}
    ]
  }
}
```

---

## Launch & Lifecycle

```bash
# Launch worker + monitor
bash .claude/scripts/my-feature-start.sh --monitor

# Worker only
bash .claude/scripts/my-feature-start.sh

# Specific task
bash .claude/scripts/my-feature-start.sh --task first-task

# Check status
bash .claude/scripts/my-feature-start.sh --status

# Print seed only (for piping into existing session)
bash .claude/scripts/my-feature-start.sh --seed-only

# Context reset (clear + reseed)
bash .claude/scripts/my-feature-continue.sh

# Rotation (new session, same pane)
bash ~/.claude-ops/lib/handoff.sh --harness my-feature --model opus

# Deactivate
jq '.status = "done"' progress.json > /tmp/p.json && mv /tmp/p.json progress.json

# Escape hatch (let agent stop once)
touch /tmp/claude_allow_stop_{session_id}
```

Aliases: `cdo` (Opus), `cds` (Sonnet), `cdh` (Haiku), `cdoc` (Opus+Chrome), `cdo1m` (1M context).

### Monitor Agent

Captures target pane every N seconds, diffs, sends events. Every 6 captures: META-REFLECTION.

State dirs keyed by stable pane IDs (`/tmp/monitor-agent-pid413/`), not tmux targets — survives window reorders.

```bash
# Manual launch (--pane required):
bash ~/.claude-ops/scripts/monitor-agent.sh --pane h:my-feature.1 h:my-feature.0 120 "mission"
# Stop:
bash ~/.claude-ops/scripts/monitor-agent.sh --stop h:my-feature.0
```

**Critical: `--pane` must match where the monitor Claude session actually runs.** The `--pane` argument tells the daemon where to send POLL/IDLE/REFLECT events. If it points at the wrong pane, events go nowhere and the monitor never gets nudged.

> **WARNING:** `tmux display-message -p` returns the **focused** pane, not the caller's. Use process-tree tracing instead.

```bash
# Walk process tree to find own pane (correct)
OWN_PANE_ID=$(tmux list-panes -a -F '#{pane_pid} #{pane_id}' | while read pid id; do
  p=$PPID; while [ "$p" -gt 1 ]; do
    [ "$p" = "$pid" ] && echo "$id" && break 2
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
  done
done)
MY_PANE=$(tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' | awk -v id="$OWN_PANE_ID" '$1 == id {print $2; exit}')
bash ~/.claude-ops/scripts/monitor-agent.sh --pane "$MY_PANE" h:target.0 120 "mission" &
```
Do NOT cache the pane ID from a different context (e.g., the start script or a parent shell) — pane indices shift when tmux splits/closes windows.

### Control Plane (overnight runs)

```bash
nohup bash ~/.claude-ops/scripts/control-plane.sh &
```

Auto-restarts dead agents, runs maintenance sweeps. Config: `~/.claude-ops/control-plane.conf` (hot-reloaded). Stop: `--stop`. Health: `cat /tmp/harness_health.json | jq .`

---

## Converting to Continuous-Loop

When a list-driven harness finishes but the domain is never "done":

```json
"evolve-harness": {
  "status": "pending",
  "description": "Cycle boundary. Run eval, analyze failures, write 3-5 NEW tasks, reset to pending, increment cycle_count.",
  "blockedBy": []
}
```

**Critical:** Update `status=pending` AND `blockedBy=[new IDs]` in a single `jq` write. Two writes = self-selection loop.

3 consecutive cycles with no metric improvement → test-hardening-only mode.

---

## tmux Gotchas (Must-Know)

These caused real production bugs. `harness_launch()` handles them — but for manual tmux ops:

1. **`tmux display-message -p` returns the FOCUSED pane**, not the caller's. Use `find_own_pane()` (process-tree walk via `$$` → `pane_pid`) — see harness-dispatch.sh:44.
2. **`split-window` without `-t` splits the ACTIVE pane.** Always: `tmux split-window -d -t $TARGET_PANE`.
3. **Always `-d`** on `new-window`/`split-window` to avoid stealing focus.
4. **Use `-H 0d` for Enter**, not the literal string `Enter`.
5. **Never `cdo -p "prompt"`** — shell escaping breaks. Launch bare, wait for load, send seed via `send-keys -l`.

---

## Debugging

| Symptom | Fix |
|---------|-----|
| Agent keeps stopping | `ls /tmp/claude_allow_stop_*` (escape hatch?), check dispatch hook |
| Hook doesn't fire | `jq '.hooks' .claude/settings.local.json` |
| Agent repeats done work | Seed script not reading progress |
| Monitor in wrong pane | `--pane` must be resolved from the monitor's own pane at start time (not cached from parent). Pane indices shift on split/close. |
| Ghost notifications | Delete stale `/tmp/monitor-agent-*` dirs |
| Stale status bar | Use `#(bash script)` not `#(cat file)` in tmux.conf |
| Agent ignores team mandate | Mandate in harness.md? Move to seed.sh. Add "REQUIRES TEAM" to task descriptions |
| Manifest shows "done" after scaffold | Scaffold defaults to "done" — update to "active" |

Quick all-harness status:
```bash
source ~/.claude-ops/lib/harness-jq.sh
for f in claude_files/*-progress.json; do
  echo "$(harness_name "$f"): $(harness_done_count "$f")/$(harness_total_count "$f") current=$(harness_current_task "$f")"
done
```

---

## File Map

```
~/.claude-ops/
├── lib/harness-launch.sh          # Core: tmux launch orchestration
├── lib/harness-jq.sh              # Task graph queries
├── lib/handoff.sh                 # Session rotation
├── lib/bead.sh                    # Cross-harness coordination
├── scripts/scaffold.sh            # Create harness from templates
├── scripts/control-plane.sh       # Daemon (health + sweeps)
├── scripts/monitor-agent.sh       # Polling monitor + REFLECT
├── scripts/tmux-harness-summary.sh
├── hooks/{admission,operators}/   # All hook scripts (project symlinks here)
├── templates/*.tmpl               # 7 scaffold templates
├── harness/manifests/             # Per-harness registry
├── sweeps.d/                      # Cron maintenance scripts
├── control-plane.conf             # Daemon config
├── tests/run-all.sh               # 181 tests, 9 suites
└── plugins/                       # Skills including this one

Per-project (in repo):
├── .claude/hooks/                 # Symlinks to ~/.claude-ops/hooks/
├── .claude/scripts/{name}-*.sh    # start, seed, continue
├── .claude/agent-harness.xml      # Available-harnesses table (update when adding!)
└── claude_files/{name}-*          # progress.json, harness.md, goal.md, journal.md,
                                   # best-practices.json, context-injections.json
```

---

## References

| File | Topic |
|------|-------|
| `references/adding-harness.md` | Step-by-step tutorial + pre-launch checklist |
| `references/hooks.md` | Hook templates, debugging |
| `references/dispatch.md` | Session routing, registry, rotation |
| `references/teams.md` | Swarm patterns, worker spawn |
| `references/beads.md` | Cross-harness wisps, claims, gates |
| `references/failure-modes.md` | Antipatterns, production insights |
| `references/philosophy.md` | HDD principles, 4 archetypes |
| `references/worked-example.md` | Real walkthroughs |
| `agents/harness-builder.md` | Spawnable builder agent |
