# Worked Example: Overnight Task Build

Real example from the Wechat project (Feb 2026). Goal: build 6 chat-first features in a React SPA overnight while Warren sleeps.

## The Setup (30 minutes of human time)

**1. Harness file** (`claude_files/overnight-harness.md`):
- Goal: "Make the React SPA miniapp able to do EVERYTHING the legacy H5 app can do — through CHAT"
- 6 features in priority order: billing, meter reading, reimbursement, fee waiver, IoT parking, wallet
- Per-feature: 4 steps (backend endpoint, LLM tool, RichCard type, CSS)
- Architecture rules: all forms inline in chat, CSS classes only, Chinese tool descriptions
- If blocked: show empty state with "数据源未接入"
- Key files: exact paths for routes, tools, RichCard, component-extractor, styles

**2. Progress file** (`claude_files/overnight-progress.json`):
- 6 tasks with status/steps/blockedBy
- Tracks tasks, completed steps, commits, session count (current task is derived)

**3. Infinite stop hook** (`.claude/hooks/overnight-stop.sh`):
- Always blocks
- Reads progress file for context
- Shows: current task, next pending, completed list
- Escape: `touch /tmp/claude_allow_stop_{session_id}`

**4. Seed script** (`.claude/scripts/migration-seed.sh`):
- Reads progress file
- Outputs re-orientation prompt with task steps

**5. Start script** (`.claude/scripts/overnight-start.sh`):
- Sets progress to active
- Outputs harness instructions

## The Runtime (8 hours of autonomous work)

```
Warren runs: bash .claude/scripts/overnight-start.sh
  Claude reads instructions, starts Feature 1 (billing)

Claude works on billing:
  1. Adds backend endpoint → miniapp-routes.ts
  2. Adds LLM tool → tools.ts + tools.json
  3. Adds RichCard type → RichCard.tsx + component-extractor.ts
  4. Adds CSS → styles/bills.css
  5. Runs tests + build
  6. git commit -m "feat(miniapp): add billing query via chat"
  7. Updates progress.json (billing → completed)

Claude tries to stop → Stop hook blocks:
  "Keep working. Next pending: meter-reading."

Claude starts Feature 2 (meter-reading)...
  Same 4-step cycle → Commit → Stop hook blocks again

Context gets heavy (3+ features done):
  Claude runs: bash .claude/scripts/migration-continue.sh
  /clear → 3s → seed prompt → new session picks up from progress
  Reads harness → continues next feature

Repeat until all 6 features done or Warren wakes up.
```

## Expected Morning Result

```
git log --oneline
abc1234 feat(miniapp): add billing query via chat
def5678 feat(miniapp): add meter reading via chat
ghi9012 feat(miniapp): add reimbursement/expense via chat
jkl3456 feat(miniapp): add fee waiver via chat
mno7890 feat(miniapp): add IoT parking query via chat
pqr1234 feat(miniapp): add wallet balance query via chat
```

Each commit: 1 backend endpoint, 1 LLM tool, 1 RichCard type, 1 CSS file. All tested, all building.

## What Made It Work

1. **Crystal-clear harness file** — exact file paths, exact steps, exact constraints. No ambiguity.
2. **Infinite stop hook** — Claude literally cannot stop. It finishes a task and immediately starts the next.
3. **Progress file as coordination** — each session reads it, updates it, commits it. No state lost.
4. **Self-continuation** — when context got heavy after 3 tasks, Claude /cleared and reseeded. Session count went from 1 to 3 overnight.
5. **Incremental commits** — if anything broke, easy to `git revert` one task without losing others.

## Also See

**service-miniapp** (`/Users/wz/Desktop/zPersonalProjects/Wechat/miniapps/service-miniapp/`) — a live migration harness with 9 modules, currently active. Same patterns, applied to a uni-app + Vue 2 mini program migration.

---

# Worked Example 2: Tianding Resident Miniapp (Feb 2026)

> The current gold standard. Uses dispatch system, extended progress schema, 6-step cycle, and beads coordination.

Production harness that built 8 features (25 planned) for a resident-facing WeChat miniapp. Uses the dispatch system, 6-step cycle, extended progress schema, and real test evidence tracking.

## The Setup

**1. Progress file** (`claude_files/tianding-miniapp-progress.json`):
- 25 features across 3 phases (Phase 1: core UX, Phase 2: chat features, Phase 3: advanced)
- Extended schema: phase, surface, richcard, description, test_evidence, chrome_verified per task (in metadata)
- 6-step cycle per task: backend → tool → richcard → wire → css → test

**2. Dispatch routing** (`.claude/hooks/harness-dispatch.sh`):
- Session registry at `~/.claude-ops/state/session-registry.json`
- `block_tianding()` function shows current/next task, step name, beads, other harnesses
- Concurrent with optimize and uifix harnesses

**3. Scripts**: tianding-start.sh, tianding-seed.sh, tianding-continue.sh
- Start registers session in registry
- Seed carries forward current task + description + phase + completed list
- Continue does tmux /clear + reseed with 2s pre-sleep for Escape key

## The Progress File Shape (Unified Task Graph)

A completed task looks like this:
```json
{
  "resident-auth": {
    "status": "completed",
    "description": "Resident JWT auth flow (tianding JWT → useAuth → /api/v1/miniapp/resident/auth/me)",
    "blockedBy": [],
    "owner": null,
    "steps": ["backend", "tool", "richcard", "wire", "css", "test"],
    "completed_steps": ["backend", "tool", "richcard", "wire", "css", "test"],
    "team": null,
    "metadata": {
      "phase": 1,
      "surface": "auth",
      "richcard": null,
      "notes": "JWT verification via HMAC-SHA256. Exempt from admin session gate.",
      "test_evidence": "curl 200: {id:'resident_291', displayName:'测试业主'}. curl 401 for invalid tokens.",
      "chrome_verified": false
    }
  }
}
```

Top-level fields:
```json
{
  "harness": "tianding",
  "mission": "Build resident-facing WeChat miniapp features",
  "status": "active",
  "started_at": "...",
  "session_count": 0,
  "tasks": {
    "resident-auth": { "..." : "..." },
    "payment-flow": { "..." : "..." }
  },
  "state": {},
  "learnings": [],
  "commits": ["7309a1a", "08ea204", "..."],
  "eval_scores": {}
}
```

Note: `current_feature`, `current_step`, and `completed` array are no longer stored. The current task is derived at runtime (first `in_progress` task, else first unblocked `pending` task). Use `harness-jq.sh` functions: `harness_current_task()`, `harness_next_task()`, `harness_completed_names()`.

## Results After 8 Features

- 8 features completed: resident-auth, resident-chat-layout, resident-profile-layout, community-selector, house-management, avatar-management, change-password, billing-inquiry
- 8 git commits, each self-contained
- Test evidence recorded for every feature
- Chrome visual verification for 4/8 features
- session_count: 0 (agent never needed /clear — possible because features were well-scoped)

## What Made It Different From the Original

| Aspect | Overnight (v1) | Tianding (v2) |
|--------|----------------|---------------|
| Tasks | 6, flat list | 25, phased (3 phases) |
| Steps per task | 4 (backend/tool/richcard/css) | 6 (+ wire + test) |
| Stop hook | Dedicated per-harness | Dispatch-based (shared with optimize, uifix) |
| Progress schema | Minimal tasks | Extended tasks with metadata |
| Test evidence | None tracked | `test_evidence` + `chrome_verified` per task |
| Coordination | Single harness | Beads (wisps/claims/gates) |
| Task description | In harness.md | In progress.json per task (metadata) |

## Lessons Learned

1. **Put descriptions IN the progress file.** v1 put task details only in harness.md — after /clear, the agent had to re-read a long file. v2 puts a description per task in the JSON, so the seed script can include it directly.

2. **Phase grouping matters for 20+ tasks.** Without phases, the agent has no sense of priority tiers. Phase 1 (core UX) must complete before Phase 2 (chat features).

3. **Test evidence is accountability.** Without `test_evidence`, you trust the agent's word that it tested. With it, you can verify in the morning exactly what was checked.

4. **`chrome_verified: false` happens.** 4/8 completed tasks weren't visually verified. The stop hook could enforce this but currently doesn't. Consider adding a gate.

5. **`learnings: []` is a signal.** The agent never populated learnings despite 8 tasks. The harness says "accumulate learnings" but doesn't enforce it as a step. Make it explicit in the cycle.

---

# Reference Implementation File Manifest

## Wechat Project (3 concurrent harnesses via dispatch)

The Wechat project (`/Users/wz/Desktop/zPersonalProjects/Wechat/`) runs 3 concurrent harnesses via the dispatch system:

### tianding-miniapp (list-driven, 25 tasks, 8 completed)

| File | Role |
|------|------|
| `claude_files/tianding-miniapp-progress.json` | Unified task graph: phases, test evidence, chrome verification |
| `claude_files/tianding-miniapp-harness.md` | Full instructions (6-step cycle, architecture, key files) |
| `.claude/scripts/tianding-start.sh` | Kickoff + session registry |
| `.claude/scripts/tianding-seed.sh` | Context restoration with task + description + phase |
| `.claude/scripts/tianding-continue.sh` | tmux /clear + reseed |

### optimize (exploration-first, 11 targets, 2 completed)

| File | Role |
|------|------|
| `claude_files/optimize-progress.json` | Unified task graph: discovery phase -> dynamic target queue |
| `claude_files/optimize-harness.md` | MEASURE->IMPLEMENT->VERIFY->COMMIT cycle |
| `.claude/scripts/optimize-start.sh` | Kickoff with resume support |
| `.claude/scripts/optimize-seed.sh` | Context restoration with learnings |

### Shared Infrastructure (from `~/.claude-ops/`)

| File | Role |
|------|------|
| `.claude/agent-harness.xml` | XML config (checklist, stop-prompts, sensitive-paths) |
| `.claude/hooks/harness-dispatch.sh` | Project dispatch (imports from `~/.claude-ops/hooks/`) |
| `~/.claude-ops/hooks/stop-check.sh` | Fallback for unregistered sessions |
| `~/.claude-ops/hooks/admission/baseline-init.sh` | Git dirty state snapshot |
| `~/.claude-ops/hooks/operators/write-flag.sh` | File change detection |
| `~/.claude-ops/lib/harness-jq.sh` | Shared task graph query functions |
| `~/.claude-ops/lib/bead.sh` | Cross-harness coordination (wisps, claims, gates) |
| `claude_files/harness-beads.json` | Beads state file |

Study the tianding-miniapp implementation when building new harnesses. See `adding-harness.md` for a step-by-step tutorial.
