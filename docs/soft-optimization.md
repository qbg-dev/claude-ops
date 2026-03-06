# Soft Optimization — A Philosophy for Harness Design

## The Problem with Prescriptive Harnesses

A prescriptive harness says: "Do task 1, then task 2, then task 3." This works when you know exactly what needs doing—build these 25 features, fix these 12 bugs. The agent is an executor. The harness is a checklist.

This breaks down for work that requires judgment about *what* to do, not just *how*. Long-running infrastructure work, security auditing, performance optimization, exploratory research—these need a compass, not a railroad track.

## What Soft Optimization Means

Give the agent three things:

**1. A rich picture of the desired end state.** Not "mission: make monitors stable" but a description of what it *feels like* when this works. What's the operator experience? What disappears from their attention? What stays reliable without intervention?

**2. Constraints with rationale.** Not "No mock data" but "No mock data because property managers in Shenzhen see it immediately and lose trust." The agent can then apply the *spirit* of the constraint in situations the author didn't anticipate.

**3. Suggested paths, not prescribed steps.** "You'll probably want to start with X because Y depends on it, but if you find a better entry point, take it." Tasks exist as waypoints, not a railroad track.

## What Changes

| Aspect | Prescriptive | Soft Optimization |
|--------|-------------|-------------------|
| **Mission** | 1-sentence imperative | Rich paragraph: desired world + why it matters |
| **Tasks** | Pre-enumerated, ordered | Suggested waypoints. Agent reorders, skips, adds |
| **Constraints** | Rules list | Constraints + rationale. Agent applies the spirit |
| **Idle behavior** | "Pick next task" | "Observe, reflect, decide what matters most" |
| **Progress** | Task status (pending/done) | Status + discoveries + evolved understanding |
| **Seed tone** | "Read progress. Pick task." | "Orient yourself. Decide what matters most." |

## What Stays the Same

- progress.json still tracks tasks, status, learnings, commits
- Hooks still enforce quality gates (no mock data, no inline styles, etc.)
- Rotation/handoff works mechanically the same way
- harness-dispatch stop hook still shows task graph status

The change is in the *authoring voice* and the *agent's relationship to the task list*.

## When to Use Which

**Prescriptive** — when the work is well-scoped and the task list IS the value:
- Build these 25 Taro miniapp features
- Fix these 12 bugs from the security audit
- Migrate these 8 SQL queries to StarRocks

**Soft optimization** — when the agent needs judgment about what to do:
- Ongoing security red teaming
- Performance/reliability optimization
- Infrastructure evolution
- Monitor agents watching other agents

## Writing a Soft-Optimization Harness

Use the templates at `~/.claude-ops/templates/harness.md.tmpl` and `goal.md.tmpl`. The scaffold (`~/.claude-ops/scripts/scaffold.sh`) produces them automatically.

Key authoring principles:
- **Paint the picture first.** The "World We Want" section is the most important. If the agent reads nothing else, this should orient it.
- **Explain WHY for every constraint.** "Never do writes" is a rule. "Never do writes because these are production systems with real residents and real money, and a mistaken mutation at 3 AM while you're autonomous could cost the company trust it can't rebuild" is a principle the agent can reason from.
- **Suggest, don't prescribe.** "You'll probably want to..." not "Step 1:". The agent may discover that the terrain doesn't match your map.
- **Name the tensions.** Every system has competing forces (breadth vs. depth, speed vs. rigor). Name them so the agent can navigate tradeoffs rather than blindly optimizing one axis.
- **Give idle guidance.** When the agent finishes a task and nothing obvious remains, what should it do? "Step back and look at the system from the user's perspective" is better than "pick the next task."
