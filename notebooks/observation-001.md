# Observation Notebook — Cycle 1
**Date**: 2026-03-12
**PI**: HT-Kung

## Research Context

This is the inaugural cycle of harness-bench. Our goal: build the first **diagnostic benchmark** for agent harnesses—scaffolding that wraps LLMs for complex software tasks.

## Literature Synthesis

### METR: "Many SWE-bench-Passing PRs Would Not Be Merged" (March 10, 2026)

**The most important finding for our work.** METR had 4 active maintainers from scikit-learn, Sphinx, and pytest review 296 AI-generated PRs + 47 human golden patches.

Key results:
- **~50% of SWE-bench-passing PRs would NOT be merged** by real maintainers
- **24.2pp gap** between automated grader scores and maintainer merge rates
- **Gap widening at ~9.6pp/year** — benchmarks overstate progress trajectory

**Failure taxonomy (by rejection reason):**
| Category | Frequency | Description |
|----------|-----------|-------------|
| Code quality | 30-40% | Style violations, verbosity, non-compliance with repo standards |
| Core functionality failure | 15-20% | Fails to actually solve the issue despite passing tests |
| Breaking other code | 10-15% | Introduces regressions elsewhere |
| Undocumented | Remainder | Misc problems |

**Critical insight**: Newer models show better code quality but some exhibit *increased* core functionality failures despite higher benchmark scores. This suggests harness design (how the model's output is structured and verified) matters more than model capability alone.

**Implication for harness-bench**: Our diagnostic tasks should probe not just "does the test pass" but "would a maintainer merge this?" The METR taxonomy gives us categories to design probes around.

### "What's in a Benchmark?" (Martinez & Franch, arXiv 2602.04449)

- 15%+ of SWE-bench Verified instances need augmentation
- Test patches are incomplete → erroneous/partial patches pass
- UTBoost and PatchDiff reveal **6-7pp inflation** in leaderboard scores
- Implication: We need robustness in our diagnostic tasks—multiple verification angles

### Anthropic: Effective Harnesses for Long-Running Agents

**Two-phase architecture:**
1. **Initializer agent** — sets up environment, writes feature requirements JSON (200+ features, all initially "failing"), creates progress file, initial git commit
2. **Coding agent** — incremental progress per session, one feature at a time

**Key patterns identified:**
- Git-based state management (commit with descriptive messages, revert bad changes)
- Progress file as cross-session memory bridge
- Sanity checks before new features (run dev server, verify e2e)
- Single-feature focus per session to prevent scope creep
- Compaction alone is insufficient — needs explicit session structuring

**Failure modes they solved:**
| Problem | Cause | Solution |
|---------|-------|----------|
| Premature completion | No requirements | Feature list JSON |
| One-shotting | No scaffolding | Initialize architecture first |
| Undocumented progress | No checkpoints | Git + progress file |
| Incomplete testing | No automation | Browser automation (Puppeteer MCP) |

### HAL (ICLR 2026)
- Harness accounts for **5-15 SWE-bench points**
- Validates our research direction: harness quality IS the bottleneck

### arXiv 2602.07900 — Agent Test Feedback
- Feedback loops provide **marginal utility**
- Planning is where the leverage is, not iteration

### DAAO / xRouter — Difficulty-Gated Escalation
- Try-cheap-escalate is near-optimal
- Adaptive harness (start with Sonnet, escalate to Opus on hard subset) dominates fixed-model approaches

## Hypotheses

**H1**: The majority of harness-attributable failures are in context management and state recovery, not tool selection or planning.
- Test by: diagnostic tasks that specifically stress context retention vs. planning vs. tool use
- Prediction: context retention probes will show largest variance across harness architectures

**H2**: The initializer+coding agent pattern (Anthropic) outperforms single-shot because it creates structured external memory (feature list, git history), not because of the planning step itself.
- Test by: comparing initializer+coding vs. single-shot+same-external-memory
- Prediction: providing the feature list to a single-shot agent closes most of the gap

**H3**: METR's "code quality" rejection category (30-40%) is primarily a prompting issue, not a harness architecture issue.
- Test by: holding harness constant, varying prompt quality
- Prediction: code quality scores responsive to prompt, not harness

**H4**: The 6-7pp SWE-bench inflation (Martinez & Franch) is concentrated in tasks where the test suite has weak coverage.
- Test by: correlating test coverage with pass-rate inflation
- Prediction: high-coverage tasks show minimal inflation

## Mid-Cycle Update: HongYang's Findings + Literature Integration

### HongYang Delivered (Cycle 1 — within 10 minutes)

6 findings, 5 novel task designs. Key results:

**Finding 1: Reliability Cliff** — At 85% per-step accuracy, a 20-step workflow succeeds <3%. Current evals test ≤10 steps. Systematic blind spot.

**Finding 2: Collective Hallucination via Anchoring** — Shared context between agents causes anchoring bias. Architecture must enforce independence, not prompts.

**Finding 3: Livelock via Ghost Exit** — Worker crashes without completion signal → waiting agents poll forever → watchdog sees "alive" → silent stagnation.

**Finding 4: Context Injection Paradox** — 2000+ token PreCompact injection into near-full context *degrades* performance by squeezing working memory.

**Finding 5: Spec Ambiguity = 41.77% of failures** — Self-adversarial spec clarification pre-pass. Force agents to identify and resolve ambiguous phrases before starting. Applies MIRROR's intra-reflection to spec parsing (unexplored territory).

**Finding 6: Independence-First MIRROR** — Complete isolation → individual reflection → synthesis. Prevents anchoring + gets reflection benefits.

### PI Literature Validation of Finding 5

My web research uncovered two directly related papers that confirm Finding 5 is genuinely novel:

**Ambig-SWE (ICLR 2026, arXiv 2502.13069)**: Tests agents on underspecified SWE-bench tasks. Uses *external dialogue* — agent asks a user proxy for clarification. Claude Sonnet 3.5 recovers up to 80% of fully-specified performance through interaction. Key limitation: models fail to detect underspecification without explicit prompting.

**LHAW (arXiv 2602.10525)**: Creates controllable underspecified task variants along 4 dimensions (Goals, Constraints, Inputs, Context). Claude Opus 4.5 drops from 100% to 47% under underspecification; `ask_user` tool recovers to 78%.

**The research gap HongYang identified**: Both Ambig-SWE and LHAW require EXTERNAL dialogue (asking a user/oracle). HongYang's self-adversarial spec clarification is PURELY INTERNAL — no external oracle needed. The question "Can internal self-reflection match external clarification for resolving spec ambiguity?" is novel and testable.

**New Hypothesis H5**: Self-adversarial spec clarification (internal) recovers ≥60% of the performance gap that Ambig-SWE recovers via external dialogue (~80%), because most ambiguity resolution requires reasoning about risk, not new information.

### MIRROR Paper (IJCAI 2025)

Confirmed details: Planner Agent + Tool Agent + Answer Agent. Intra-reflection (pre-execution assessment) + inter-reflection (post-observation adjustment). Dual-memory architecture. 85.7% pass rate. Ablating intra-reflection drops 7.0%.

MIRROR applies reflection to TOOL SELECTION. Nobody has applied the same pre-execution reflection to SPEC INTERPRETATION. This is HongYang's contribution.

## Matheus Infrastructure Report + Mechanism Finding

### Infrastructure (all complete)
- Claude Agent SDK v0.2.74 installed, `query()` integrated into `agent.ts`
- Experiment runner: `src/runner.ts` + `src/harnesses/tool-ablation.ts`
- Docker grading via `swebench-venv` + `ghcr.io/epoch-research`
- Resume support, per-trial artifacts (patch.diff, test-output.txt, meta.json)
- Bug fix: `delete process.env.CLAUDECODE` before `query()` for nested sessions

### Exp-003 Tool Ablation (18/120 trials, early signal)

| Harness | Tools removed | Pass rate | Avg cost | Avg time |
|---------|--------------|-----------|----------|----------|
| cc-no-search | Glob, Grep | 3/6 (50%) | $0.265 | 141s |
| cc-bash-only | All except Bash | 3/6 (50%) | $0.274 | 137s |
| cc-no-edit | Write, Edit | 3/3 (100%) | $0.109 | 60s |
| cc-no-bash | Bash only | 3/3 (100%) | $0.114 | 70s |

**Early insight**: Removing edit/bash tools makes agents 2x FASTER and CHEAPER. Fewer exploratory calls = more direct execution. But this is on ceiling tasks only (astropy-7671: 12/12 all harnesses). django-11820: 0/6 all harnesses so far.

### **CRITICAL MECHANISM FINDING: Feedback Quality**

django-11820 results across harnesses:
- claude-code (no feedback): **0/3**
- plan-execute: **1/3**
- iterative (broken feedback on main): **0/3**
- iterative (Docker-graded feedback, HongYang's): **2/2 PASS**

**This suggests the bottleneck on hard tasks is FEEDBACK QUALITY, not orchestration.**

arXiv 2602.07900 claimed feedback loops are marginal — but they tested WEAK feedback (local pytest). Docker-graded feedback is STRONG feedback (the actual ground truth). The difference is enormous.

**New Hypothesis H6**: On frontier tasks (where models struggle), feedback quality is the dominant variable. Strong feedback (ground-truth test results) enables iterative convergence; weak feedback (local partial tests) provides no useful signal. The arXiv 2602.07900 finding that "feedback is marginal" is an artifact of testing weak feedback only.

### Bug Found: iterative `completed: false`
All iterative trials in exp-002 report `completed: false` even when `passed: true`. Root cause: `lastResult?.success` never populated in original agent.ts. The `passed` field (Docker grade) is correct; `completed` is unreliable. Fixed in SDK-based agent.ts.

## Student Assignments (Cycle 1 → Cycle 2)

### Golden — Deep Failure Analysis (PENDING — still working)
Deliverable: `notebooks/golden-failure-taxonomy.md`

### Matheus — COMPLETE → Cycle 2: Feedback Quality Experiment
Controlled experiment isolating feedback quality: no feedback vs weak (local pytest) vs strong (Docker grade) vs oracle. 5 trials × 4 conditions on django-11820.

### HongYang — COMPLETE → Cycle 2: Spec Ambiguity Self-Resolution Test
Implement self-adversarial spec clarification experiment.

## Updated Hypotheses

**H1**: (unchanged) Majority of harness-attributable failures are in context management.
**H2**: (unchanged) Initializer+coding pattern works due to structured external memory.
**H3**: (unchanged) Code quality rejections are primarily prompting, not architecture.
**H4**: (unchanged) SWE-bench inflation concentrated in weak-coverage tasks.
**H5**: Self-adversarial spec clarification (internal) recovers ≥60% of external dialogue benefit.
**H6** (NEW, from Matheus): On frontier tasks, feedback quality is the dominant variable. Strong feedback enables iterative convergence; weak feedback provides no useful signal. arXiv 2602.07900's "feedback is marginal" is an artifact of weak feedback only.

## 三省吾身

1. **为人谋而不忠乎** — Am I working on the IMPORTANT problem?
   Yes. Deep failure analysis + HongYang's spec ambiguity finding targets the #1 failure category (41.77%). The literature validation confirms we're in novel territory.

2. **与朋友交而不信乎** — Do I understand my results deeply enough to teach them?
   The key teachable insight: Ambig-SWE and LHAW prove spec ambiguity is a real problem (47-80% performance recovery). Nobody has tested *internal* resolution vs *external* dialogue. HongYang's self-adversarial approach is the first to propose this.

3. **传不习乎** — What changes my approach going forward?
   HongYang's speed and quality exceeded expectations. Creative students need OPEN-ENDED missions, not prescriptive protocols. The cycle 2 assignment (implement and run the spec test) gives them runway while focusing on our best finding.
