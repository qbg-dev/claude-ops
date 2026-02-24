# Harness-Driven Development: Philosophy & Principles

## The Bayesian Prior Analogy

Think of the harness as a Bayesian prior. Without it, the agent has a flat prior — it drifts. With a well-constructed harness, the agent's posterior converges on what you want, even without you watching.

A flat prior (no harness): agent wastes cycles orienting, stops after one subtask to ask "should I continue?", loses context when session fills, progress lost between sessions.

A strong prior (good harness): agent knows what to build and to what standard, can't stop (infinite stop hook), context exhaustion triggers automatic /clear + reseed, progress file survives across sessions.

## The AWS API Mandate Analogy

Bezos's 2002 mandate eliminated coordination overhead between humans. HDD is the same for human-AI coordination. Instead of watching the agent, answering questions, restarting on context fill, telling it what to do next — build the harness once and the agent runs autonomously.

**The goal: maximize compute, minimize human involvement.** Spend 30 minutes building the harness. Get 8 hours of autonomous work overnight.

## When to Use HDD

| Situation | Approach |
|-----------|----------|
| Quick fix, 1-3 files | Just do it. No harness needed. |
| Feature, 1 session | Standard harness (XML + 3 hooks) |
| Multi-session project | Full HDD: progress file + seed script + stop hooks |
| Overnight/unattended | Full HDD + infinite stop hook + auto-commit + self-continuation |
| Performance / tech debt | Exploration-first harness (profile -> discover targets -> work queue) |
| Multi-agent swarm | Full HDD + team coordination + shared task list |

## Harness Archetypes

Not all harnesses look the same. Three production-proven shapes:

| Archetype | Shape | Progress File | Stop Hook Behavior | Example |
|-----------|-------|---------------|-------------------|---------|
| **List-driven** | Fixed feature list, sequential execution. Each feature follows a repeating N-step cycle. | Features with status/priority, explicit `steps` array per feature | Shows current feature + step, advances to next pending | tianding-miniapp (25 features, 6-step cycle) |
| **Exploration-first** | Discovery phase -> dynamically-generated queue -> work through it -> discover more | `phase: "discovery"` for profiling, then `phase: "performance"/"quality"` for targets | Shows progress count, pushes "propose new targets" when queue empty | optimize (profile -> 11 targets -> work -> find more) |
| **Continuous-loop** | Rolling optimization cycle (PROFILE→IMPROVE→MEASURE→REFLECT). Never "completes" — the final task (`evolve-harness`) resets itself to pending and adds new tasks. | `state.metrics_history` tracks before/after per round. Tasks have phase grouping (baseline→improve→verify→evolve). | Shows current round + metrics delta. On evolve-harness completion, resets it to pending and loops. | bi-opt (BI SQL library + dashboard UX, infinite improvement) |
| **Deadline-driven** | Time-boxed, priority-ranked, cut scope if needed | Priority field determines cut line, `deadline` field in top-level | Warns when time is short, prioritizes highest-impact remaining | (future: demo prep, sprint harnesses) |

**Choosing an archetype:**
- Know all features upfront? -> **List-driven**
- Need to investigate first? -> **Exploration-first**
- Continuous improvement with metrics? -> **Continuous-loop**
- Hard deadline, flexible scope? -> **Deadline-driven**

Each archetype uses the same three-layer architecture (CLAUDE.md -> progress.json -> hooks/scripts) but differs in how the progress file is structured and how "idle" mode works.

### Continuous-Loop Pattern

The key innovation is the `evolve-harness` task:
1. Reviews all learnings and metrics from the current cycle
2. Identifies next highest-impact improvements
3. Adds NEW tasks to the progress file
4. Resets its own status back to `pending`
5. Loop continues indefinitely

This requires:
- **PreCompact hook** (`pre-compact-evolve.sh`) — reminds the agent to persist discoveries before context compaction
- **`state.metrics_history`** — append-only array of before/after measurements per round
- **Meta-monitor** — separate agent that nudges periodic meta-reflection ("What's the bottleneck? Are you measuring before/after?")
- **Browser access** (`cdoc` alias) — for dashboard screenshots and legacy system study

---

## Core Principles

1. **Make the goal crystal clear.** Not documentation — direct instructions. Not just "build X" but the UX vision.

2. **Never let the agent stop.** Infinite stop hook that always blocks, shows progress context, and tells the agent what to do next. Escape hatch for human override.

3. **Always make progress.** If blocked, move to the next thing. If an API doesn't exist, show empty state. Never stop to ask questions.

4. **Survive context limits.** Progress file + seed script + tmux self-continuation. Agent can /clear and pick up exactly where it left off. **Timing:** the continue script must sleep ~90s before `/clear` — Claude may still be mid-response.

5. **Commit incrementally.** After each meaningful unit. Git is also a recovery mechanism.

6. **Encourage multi-agent orchestration.** Spawn agents liberally. The agent's time is cheap; the human's attention is expensive.

7. **Always be thinking ahead.** Launch subagents to scout the next feature while building the current one. If you finish the list, read the codebase and build the next most valuable thing.

8. **Tailor the harness creatively.** Research the domain. A billing migration harness looks nothing like a chat UI harness.

9. **Prompt engineering > infrastructure.** (From Cursor) Clear instructions beat clever automation.

10. **Reduce everything to harnesses.** Setting up feedback loops feels like wasted time, but it's the same shift as setting up optimization conditions and letting the math converge.

11. **Always self-test the harness.** Before going autonomous, run every script, dry-run every hook, validate every JSON file. A broken harness at 3am = 6 hours of wasted compute.

12. **The feature list is a floor, not a ceiling.** Features are a starting point for the mission, not the definition of "done." When the list runs out, Claude explores for more work — reads legacy code, finds integration gaps, polishes UX, discovers uncataloged features. The stop hook enforces this: when idle, it pushes exploration rather than allowing stop. Strive toward the *mission*, not just the exact features.

13. **CLAUDE.md is the single entry point.** Put the mission, architecture rules, and safety constraints in CLAUDE.md. Put the feature list and durable state in a separate progress JSON that CLAUDE.md points to. Features update without editing CLAUDE.md, progress survives `/clear`, stop hooks read it, multiple sessions coordinate through one file.

14. **Accumulate learnings.** The progress file has a `learnings` array — gotchas, patterns, discoveries that Claude appends as it works. The seed script carries recent learnings forward after `/clear` so new sessions don't repeat old mistakes. This is the harness's long-term memory.

---

## The Agent's Mindset

A well-designed harness shapes HOW the agent thinks:

**Think ahead, not just execute.** While building feature N, launch Explore subagents for N+1. Notice patterns that could become shared abstractions.

**UX-first, not wire-first.** What's the delightful version? Smart summaries, contextual actions, inline actions that save taps. Loading skeletons, smooth transitions, helpful empty states.

**Full-stack coherence.** Backend responses structured for immediate rendering. Error states in human language. Cross-feature linking where it makes sense.

**Improve what exists.** Each pass makes the codebase *better*, not just wider. Fix jank, extract patterns, normalize error handling.

**Keep going past the list.** Read legacy source for features not yet listed. Identify integration gaps. Polish UX. Think about what would make a demo go "wow."

**Self-schedule.** Use tmux primitives, `/clear` + reseed, spawn subagents, update progress files for the next session.

---

## Multi-Agent Orchestration

When the task is large enough, spawn a team. 3+ independent features, frontend + backend in parallel, research + implementation in parallel.

**Compute philosophy:** Spawn agents liberally. Run research in background while implementation works in foreground. Use worktree isolation when agents might conflict. The human's job: build the harness, start agents, review results in the morning.

---

## Why Harnesses Exist

Agent sessions are transient — context fills, sessions end, restarts lose state. The harness bridges transient sessions and durable project state.

**From Anthropic:** Progress files externalize state. Startup checklists re-orient. Explicit verification prevents silent failures. One feature per session reduces blast radius.

**From Gas Town:** Hooks are contractual, not advisory. Sessions are cattle, not pets. Git-backed state. Read reports, don't watch workers. Persistent identity via CLAUDE.md + memory files.
