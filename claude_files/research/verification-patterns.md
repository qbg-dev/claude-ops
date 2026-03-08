# Verification & Review Patterns for Autonomous Coding Agents

## Key Insight

**Self-validation by LLMs is ineffective** — models "hallucinate correctness" about their own output. The single most important architectural decision is **context swap**: a fresh session with no access to the builder's reasoning prevents echo-chamber validation.

## Practical Patterns (ranked by signal-to-cost)

### 1. Adversarial Code Review (highest ROI)
Fresh LLM session with skeptical constitution reviews diff against spec. The critic evaluates only artifacts (spec + diff), not the builder's reasoning. Output: PASS or structured violation list.

### 2. Spec Compliance Check
Verify changes satisfy acceptance criteria from task description. Single LLM call, no execution needed.

### 3. JiT Testing (Meta, Feb 2026)
Generate throwaway tests for the specific diff, execute, report failures. Zero maintenance — tests are ephemeral. Six-step: detect change → infer intent → generate mutations → generate tests → filter signals → report.

### 4. Property-Based Testing
Agent identifies invariants, round-trips, idempotence in changed functions, generates Hypothesis-style tests. From Agentic PBT paper: 984 bug reports across 100 packages, 56% validity, ~$10/valid bug.

### 5. Mutation Testing
Mutate changed lines (> to >=, flip booleans), check if existing tests catch mutations. Surviving mutants = weak coverage. AgentAssay adds agent-specific mutations: prompt mutations, tool removal, context truncation.

### 6. Behavioral Fingerprinting (AgentAssay)
Extract dense vectors from execution traces. Detect regressions via Hotelling's T-squared test — 86% detection where binary pass/fail has 0%.

## Tools

| Tool | Approach |
|------|----------|
| **Quibbler** | MCP/hooks background critic, learns project rules |
| **Orchestra** | Multi-agent best-of-N with designer agent selecting best |
| **CodeRabbit** | PR-level diff review, GitHub-native |
| **Qodo** | Cross-repo breaking change detection |
| **Kiro** | Spec-driven property test generation |

## Proposed deep_review Modes

| Mode | Pattern | Cost |
|------|---------|------|
| `adversarial` | Fresh skeptical LLM reviews diff vs spec | 1 LLM call |
| `spec-check` | Verify against acceptance criteria | 1 LLM call |
| `jit-test` | Generate + run throwaway tests | 1 call + exec |
| `property` | Find invariants, generate PBT | 1 call + exec |
| `mutation` | Mutate lines, check test coverage | exec only |
| `blast-radius` | Static analysis of file/import impact | static |
| `best-of-n` | N implementations, score + select | N calls |

**Start with**: adversarial + spec-check (2 LLM calls, no execution infra needed).
