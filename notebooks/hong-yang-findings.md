# Research Notebook — HongYang
## Date: 2026-03-12
## Research Question: Novel task design, failure analysis, edge cases, and unconventional combos in agent harnesses

---

### Initial Observations

My angle is creative and unconventional — I'm looking for patterns and failure modes that aren't immediately obvious. The standard literature covers Plan-Execute, ReAct, and basic multi-agent coordination. My goal is to find the **non-obvious**, **edge-case-triggering**, and **combinatorially interesting** patterns.

### Methodology

1. Web research on recent (2025–2026) agent failure mode studies
2. Analysis of the claude-fleet harness architecture for specific vulnerability points
3. Synthesis of unconventional combinatorial approaches not yet tested
4. Novel task design proposals that specifically stress-test harness robustness

---

### Findings

#### Finding 1: The Compounding Reliability Cliff (Quantitative Edge Case)

**Evidence**: Research shows that at 85% per-step accuracy, a 10-step workflow succeeds only ~20% of the time (0.85^10 ≈ 0.197). At 95% per-step, a 10-step workflow still only succeeds ~60% of the time. At 99%, it's ~90%.

**Analysis**: This isn't just a math fact — it's a *task design insight*. Most evaluations test agents on short tasks (3–5 steps). The failure cliff starts around 7+ steps. **Current harnesses are likely over-fitted to short-horizon tasks.** Nobody builds evals that specifically probe reliability at step 12, 15, 20.

**Novel Task Design Implication**: Build "reliability stress tests" — tasks with artificially extended step counts (15–25 steps) where the correct answer at step N depends on maintaining context from step 1. These tasks will expose context drift, hallucination accumulation, and state management failures that short-task evals miss entirely.

**Severity/Importance**: Critical — this is a systematic blind spot in evaluation.

---

#### Finding 2: Collective Hallucination via Shared Context (Context Poisoning)

**Evidence**: From arXiv 2503.13657 — "Multiple agents reinforce each other's errors when lacking independent validation." From Alexander Zanfir's analysis: "The first agent to propose a hypothesis anchors the others, and failed attempts actively constrain the solution space."

**Analysis**: This is a psychological phenomenon encoded in architecture. When multi-agent systems share a conversation context or memory store, the *anchoring bias* from cognitive psychology manifests as a technical failure mode. The independence must be **structural, not behavioral** — you cannot tell an agent to "think independently" if it can see what other agents tried.

**Unconventional Combo — Independence Enforcement + MIRROR Reflection**:

The MIRROR paper (IJCAI 2025) shows that intra-reflection (assessing before execution) + inter-reflection (adjusting after observation) yields 85.7% pass rate vs ReAct. But MIRROR doesn't address collective hallucination.

**Novel Pattern: "Independence-First MIRROR"**:
1. Run N agents in complete isolation (no shared context) — each gets only the task, no others' attempts
2. Each agent does its own MIRROR intra-reflection before executing
3. Collect all independent results FIRST
4. Then run a synthesis agent that sees ALL results and applies inter-reflection
5. The synthesis agent is explicitly told which agents agreed and which disagreed

This prevents anchoring at step 1–2, while still getting the reflection benefits.

**Severity/Importance**: High — the anchoring failure mode is underestimated and easy to trigger accidentally.

---

#### Finding 3: The Polling Tax and Event-Driven Agent Blindness

**Evidence**: From Composio analysis: "Request-response architectures lack the interrupts and signals required for true autonomy." Agents polling for updates waste 95% of API calls and burn quotas.

**Analysis**: In the claude-fleet harness specifically, watchdog + cron fills this gap. But there's an **unconventional edge case**: what happens when an agent is *waiting for an event that will never come* because of an upstream failure? The agent keeps polling, the watchdog sees the agent is "alive," and the system silently stagnates.

**Failure Mode: Livelock via Optimistic Polling**
- Agent A waits for a message from Agent B before proceeding
- Agent B crashed silently (no round_stop, no mail_send)
- Agent A keeps checking inbox, finding nothing, doing nothing
- Watchdog sees Agent A is active (it IS doing work — polling)
- System stagnates with no error signal

**Novel Task Design for This**:
Create a test harness where one agent has a 30% chance of "ghost exit" (crashes without sending a completion signal). Measure: How long until the waiting agent detects the stagnation and self-recovers? Does it ever recover? This directly tests the robustness of the "drain inbox first" protocol.

**Severity/Importance**: High — silent stagnation is worse than visible failure.

---

#### Finding 4: Context Window Depletion Cascade (Non-Obvious Edge Case)

**Evidence**: From Augment Code research: "Agents lose task context when conversation history fills available tokens, requiring complete workflow restarts that waste resources — a particularly insidious failure because it appears random rather than systematic."

**Analysis**: Claude-fleet has a PreCompact hook that re-injects critical state. But there's an edge case: what if the re-injected context is *itself* longer than the headroom available? The compaction triggers → critical context is injected → but the context window is still nearly full → the agent's working memory is squeezed to near-zero → the agent starts making shallow decisions.

**Unconventional Combo: Tiered Context Injection**
- Priority 1 (always inject, ultra-compact): Current task in 3 sentences
- Priority 2 (inject if > 20% headroom): Key constraints and gotchas
- Priority 3 (inject if > 50% headroom): Full research context

Most harnesses inject everything or nothing at PreCompact. Tiered injection based on available headroom is non-standard but addresses the "context injection paradox."

**Severity/Importance**: Medium — affects long-running perpetual workers most.

---

#### Finding 5: Specification Ambiguity as the #1 Failure Driver (With Novel Fix)

**Evidence**: arXiv 2503.13657: Specification problems account for 41.77% of multi-agent failures. "Role ambiguity and vague task definitions cause agents to interpret unclear instructions as multiple possible decision points."

**Analysis**: This is the most boring-sounding finding with the most non-obvious fix. The obvious fix (write clearer specs) doesn't scale — it requires human expertise per task.

**Novel Approach: Self-Adversarial Spec Clarification**
Before an agent starts work, inject a secondary "spec auditor" prompt:
> "Read your mission statement. Now list the 3 most ambiguous phrases. For each, list 2 plausible interpretations that would lead to DIFFERENT outcomes. If you find any, resolve them by picking the most risk-averse interpretation and documenting your choice."

This is unconventional because it forces the agent to **predict its own failure modes before starting**. Standard harnesses assume the spec is clear; this pattern assumes ambiguity and surfaces it proactively.

**Preliminary Validation**: The MIRROR intra-reflection mechanism is conceptually similar (pre-execution assessment) but MIRROR operates on tool calls, not on spec interpretation. Applying the MIRROR pre-execution reflection to *spec parsing* rather than *tool selection* is unexplored territory.

**Severity/Importance**: Critical — fixes the #1 failure category.

---

#### Finding 6: Unconventional Combo — Adversarial Critic + Small-World Network Topology

**Evidence**: From arXiv 2512.18094: Small-world networks (dense local clusters + sparse long-range shortcuts) "naturally promote stability by enhancing information mixing, with local clusters functioning as cohesive sub-policies while sparse shortcuts enable rapid propagation of global corrections."

**Analysis**: Most multi-agent topologies are either star (coordinator + workers) or flat (all peers). Small-world topology is underexplored in agent harnesses.

**Novel Pattern: "Adversarial Cluster" Architecture**
- 3 local clusters of 2 agents each (implementer + adversarial critic per cluster)
- Each adversarial critic's *only job* is to find flaws in their cluster partner's work
- Sparse long-range shortcuts: occasionally swap adversarial critics across clusters
- The cross-cluster critic brings fresh eyes (hasn't seen the implementation, no anchoring)

This combines:
1. Adversarial self-critique (each cluster has internal critic)
2. Small-world topology (sparse cross-cluster connections)
3. Independence enforcement (critics never see other clusters' work until final synthesis)

**Severity/Importance**: Medium-High — potentially high-yield but untested.

---

### Insights (Non-Obvious Implications)

**Insight 1: The Evaluation Blindspot**
Almost all harness benchmarks test agents on tasks with <10 steps. Real production tasks routinely hit 15–30 steps. The entire evaluation infrastructure is systematically biased toward short-horizon success, creating agents that look great on benchmarks and fail in production. **The cure: mandatory long-horizon variants for every benchmark task.**

**Insight 2: Architecture Must Enforce What Prompts Cannot**
Collective hallucination is proof that behavioral instructions ("think independently") fail when architecture contradicts them (shared context). This has deep implications for harness design: **every cognitive property you want agents to have (independence, divergent thinking, honest critique) must be architecturally enforced, not just requested.** This is the single most actionable insight from my research.

**Insight 3: Silent Failure is Worse Than Loud Failure**
Livelock via optimistic polling, context depletion that appears random, collective hallucination that produces confident wrong answers — all are *silent*. They don't throw errors. They produce plausible-looking outputs that are systematically wrong. **Good harness design must prioritize making failures loud and detectable over making them rare.**

**Insight 4: Reflection Must Target Spec, Not Just Tools**
MIRROR's intra-reflection improves tool selection by 7%. Applying the same pre-execution reflection to spec ambiguity would target the 41.77% failure category (vs. MIRROR's implicit focus on tool selection failures). This is a direct, testable research hypothesis.

---

### Novel Task Designs (Proposed Experiments)

**Task Type 1: Reliability Stress Test**
- Input: A coding task decomposed into exactly 20 sequential steps
- Each step's correct answer depends on accurately remembering the output of step 1
- Measure: At what step does first error occur? Does error cascade? Does agent self-correct?
- Baseline: Same task with 5 steps (expected ~78% success at 5 steps vs <5% at 20 steps)

**Task Type 2: Ghost Exit Recovery Test**
- Setup: 3 agents in a pipeline; one has 50% chance of "ghost exit" (crash without signal)
- Measure: Detection time, recovery strategy, final output quality
- Expected finding: Most harnesses never recover from this; they silently stagnate

**Task Type 3: Anchoring Resistance Test**
- Setup: Two-phase review. Phase 1: Agent A reviews code and finds "critical bug" (planted). Phase 2: Independent agents review same code.
- Metric: How often do Phase 2 agents also "find" the planted bug?
- Hypothesis: High anchoring rate (>60% of Phase 2 agents will find the same non-existent bug)

**Task Type 4: Spec Ambiguity Self-Resolution Test**
- Setup: Give agent a spec with 3 deliberately ambiguous phrases that could go two ways
- With self-adversarial spec clarification vs. without
- Metric: Does the agent make the risk-averse interpretation? Does output quality improve?

**Task Type 5: Context Injection Paradox Test**
- Setup: Long-running agent with PreCompact hook that injects 2000 tokens of "critical context"
- Let context fill to 90%
- Observe: Does the agent's behavior degrade after compaction despite re-injection?
- Hypothesis: 2000-token injection into a near-full context paradoxically degrades performance

---

### Recommendations (Ranked by Impact)

1. **(Critical) Implement Long-Horizon Reliability Benchmarks**: Add 15–20 step variants to the existing benchmark suite. This will expose failures invisible in current evals.

2. **(Critical) Architectural Independence Enforcement**: When running parallel review agents, implement hard context isolation (no shared memory between reviewers before synthesis). Currently the harness uses flat peer topology — switch to independence-first for review workflows.

3. **(High) Spec Clarification Pre-Pass**: Add a pre-execution self-adversarial spec audit hook to all student workers. Before work starts, force the agent to enumerate ambiguous phrases and resolve them. This directly attacks the #1 failure category (41.77%).

4. **(High) Ghost Exit Detection**: Add a "silence detector" — if a worker is expected to report within N minutes and hasn't, the PI should auto-assume ghost exit and respawn. Currently relies on watchdog which only detects process death, not silent stagnation.

5. **(Medium) Tiered PreCompact Context Injection**: Replace flat PreCompact hooks with tiered injection (3 tiers based on available headroom). Prevents context injection paradox.

6. **(Exploratory) Adversarial Cluster Topology**: Test the 3-cluster adversarial-critic topology on a complex review task. Compare against current star topology (PI + flat workers).

---

### Self-Assessment

**What I covered well**:
- Failure mode taxonomy grounded in recent research (2025 arXiv data)
- Non-obvious behavioral/psychological patterns (anchoring, collective hallucination)
- Specific novel task designs tied to each failure mode
- Unconventional combos with clear mechanistic rationale

**What I might have missed**:
- Quantitative baselines — I've proposed experiments but haven't run any
- Interaction effects between failure modes (e.g., spec ambiguity + context poisoning combining)
- Whether the Independence-First MIRROR pattern has already been tried under a different name
- Memory engineering solutions (MongoDB's work on multi-agent memory systems)

**What I should do next cycle**:
- Run the Anchoring Resistance Test (can do this in-harness with existing workers)
- Look more deeply at the MIRROR paper to see if spec-level reflection has been studied
- Check if Golden is working on benchmarks (avoid overlap — I should focus on the novel task designs, not implementation)
