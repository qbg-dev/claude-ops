/**
 * Unified Benchmark Pipeline — generic execute→harden loop for any benchmark.
 *
 * Graph:
 *   setup → execute → harden ──→ execute   (if NOT paused, maxIterations=50)
 *                              └→ $end      (if paused or user stop)
 *
 * Works with greenfield-bench, slop-code-bench, terminal-bench-3, or any benchmark
 * that follows case/problem structure. Supports Claude and Codex runtimes.
 *
 * Usage:
 *   fleet pipeline bench-pipeline --set benchmark=greenfield-bench --set benchDir=/path/to/bench
 *   fleet pipeline bench-pipeline --set benchmark=slop-code-bench --set benchDir=/path/to/bench --set runtime=codex
 *   fleet pipeline bench-pipeline --set model=opus --set maxRounds=10
 *   fleet pipeline bench-pipeline --dry-run
 *
 * Pause/resume:
 *   touch {{SESSION_DIR}}/paused.flag    # pause after current harden cycle
 *   rm {{SESSION_DIR}}/paused.flag       # resume (relaunch pipeline)
 */
import type { Program } from "../engine/program/types";
import { graph } from "../engine/program/graph";

export interface BenchPipelineOpts {
  benchmark?: string;     // benchmark name (for display/commits)
  benchDir?: string;      // absolute path to benchmark directory
  runCmd?: string;        // command template to run a case ({CASE} placeholder)
  model?: string;         // executor model (default: sonnet)
  runtime?: string;       // "claude" | "codex" (default: claude)
  maxRounds?: number;     // max harden→execute cycles (default: 50)
  scope?: string;
  spec?: string;
  resume?: boolean;       // skip setup if resuming
}

const CONVENTIONS_DIR = "/Users/wz/Desktop/qbg/conventions";

// 5 OAuth tokens for rate-limit rotation
const OAUTH_TOKENS = [
  "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",
  "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",
  "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",
  "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",
  "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",
];

// Model fallback order for rate limits
const MODEL_FALLBACK = ["sonnet", "opus[1m]", "opus"];

export default function benchPipeline(opts: BenchPipelineOpts): Program {
  const benchmark = opts.benchmark || "benchmark";
  const benchDir = opts.benchDir || ".";
  const model = opts.model || "sonnet";
  const maxRounds = opts.maxRounds || 50;
  const skipSetup = opts.resume === true;

  const builder = graph(
    "bench-pipeline",
    `Unified benchmark pipeline for ${benchmark} — execute→harden loop (max ${maxRounds} rounds)`,
  );

  // ── Node 1: setup (skip if resuming) ──
  if (!skipSetup) {
    builder.node("setup", {
      description: `Validate ${benchmark} environment and dependencies`,
      agents: [{
        name: "setup-agent",
        role: "validator",
        model: "sonnet",
        seed: { inline: setupSeed(opts) },
        window: "setup",
      }],
    });
  }

  // ── Node 2: execute — run benchmark cases ──
  builder.node("execute", {
    description: `Run ${benchmark} cases with ${model}`,
    agents: [{
      name: "executor",
      role: "executor",
      model: model,
      seed: { inline: executorSeed(opts) },
      window: "execute",
    }],
  });

  // ── Node 3: harden — analyze and fix ──
  builder.node("harden", {
    description: `Analyze results and harden ${benchmark} verifiers/tests`,
    agents: [{
      name: "hardener",
      role: "analyst",
      model: "opus[1m]",
      seed: { inline: hardenerSeed(opts) },
      window: "harden",
    }],
    prelaunch: [
      { type: "parse-output", agent: "executor", file: "round-results.json" },
    ],
  });

  // ── Edges ──
  if (!skipSetup) {
    builder.edge("setup", "execute");
  }
  builder
    .edge("execute", "harden")
    // harden → execute (cycle back if NOT paused)
    .edge("harden", "execute", {
      condition: `! test -f "{{SESSION_DIR}}/paused.flag"`,
      maxIterations: maxRounds,
      label: "continue hardening",
    })
    // harden → $end (paused or max rounds)
    .edge("harden", "$end", {
      label: "paused or max rounds reached",
      priority: 1,
    });

  if (!skipSetup) {
    builder.entry("setup");
  } else {
    builder.entry("execute");
  }

  const g = builder
    .defaults({
      model: model,
      effort: "high",
      permission: "bypassPermissions",
    })
    .material({
      scope: opts.scope,
      spec: opts.spec || `Execute and harden ${benchmark} benchmark`,
    })
    .build();

  return {
    name: g.name,
    description: g.description,
    phases: [],
    defaults: g.defaults,
    material: g.material,
    graph: g,
  };
}

// ── Parse output handler ──────────────────────────────────────────────

export function parse_executor_output(state: any): void {
  const fs = require("fs");
  const path = require("path");
  const resultsPath = path.join(state.sessionDir, "round-results.json");
  if (fs.existsSync(resultsPath)) {
    state.ext.roundResults = JSON.parse(fs.readFileSync(resultsPath, "utf-8"));
  }
}

// ── Seed generators ────────────────────────────────────────────────────

function setupSeed(opts: BenchPipelineOpts): string {
  const benchmark = opts.benchmark || "benchmark";
  const benchDir = opts.benchDir || ".";
  const runtime = opts.runtime || "claude";

  return `You are the setup agent for the ${benchmark} benchmark pipeline.

## Task
Validate that the benchmark environment is ready to run. Do NOT run any benchmark cases—just verify everything works.

### Step 1: Verify benchmark directory
\`\`\`bash
ls "${benchDir}" || { echo "FATAL: benchmark dir not found"; exit 1; }
\`\`\`

### Step 2: Check dependencies
\`\`\`bash
cd "${benchDir}"
# Python dependencies
if [ -f requirements.txt ]; then
  pip install -r requirements.txt 2>&1 | tail -5
fi
if [ -f pyproject.toml ]; then
  pip install -e . 2>&1 | tail -5
fi
# Node dependencies
if [ -f package.json ]; then
  npm install 2>&1 | tail -5
fi
\`\`\`

### Step 3: Validate benchmark structure
\`\`\`bash
cd "${benchDir}"
# List cases/problems
ls cases/ 2>/dev/null || ls problems/ 2>/dev/null || ls tasks/ 2>/dev/null || echo "No standard case directory found"
\`\`\`

### Step 4: Check conventions (if available)
\`\`\`bash
if [ -d "${CONVENTIONS_DIR}" ]; then
  echo "Conventions repo found"
  ls "${CONVENTIONS_DIR}"
fi
\`\`\`

### Step 5: Verify runtime
${runtime === "codex" ? `\`\`\`bash
which codex || { echo "WARN: codex not found in PATH"; }
\`\`\`` : `\`\`\`bash
which claude || { echo "WARN: claude not found in PATH"; }
\`\`\``}

### Step 6: Write setup flag
\`\`\`bash
echo "setup complete at $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "{{SESSION_DIR}}/setup-complete.flag"
echo "SETUP COMPLETE — ready to execute"
\`\`\`

## Rules
- Do NOT run benchmark cases
- If something is missing, try to install/fix it
- If a critical dependency can't be resolved, write an error to {{SESSION_DIR}}/setup-error.txt`;
}

function executorSeed(opts: BenchPipelineOpts): string {
  const benchmark = opts.benchmark || "benchmark";
  const benchDir = opts.benchDir || ".";
  const runCmd = opts.runCmd || `echo "No runCmd specified for {CASE}"`;
  const runtime = opts.runtime || "claude";

  // Build token array for rotation
  const tokenArray = OAUTH_TOKENS.map((t, i) => `TOKENS[${i}]="${t}"`).join("\n");
  const fallbackStr = MODEL_FALLBACK.join(" → ");

  return `You are the benchmark executor for ${benchmark}.

## Project
\`${benchDir}\` — run each case/problem and collect results.

## Rules
- Run cases sequentially
- Do NOT modify benchmark files (cases, verifiers, tests)—only run them
- Use token rotation to avoid rate limits
- If a case hits a rate limit, try the next token, then fall back to a different model (${fallbackStr})

## Task

### Step 1: Read round number
\`\`\`bash
ROUND=$(cat "{{SESSION_DIR}}/round.txt" 2>/dev/null || echo 1)
echo "Starting round $ROUND"
\`\`\`

### Step 2: Discover cases
\`\`\`bash
cd "${benchDir}"
# Try standard directories
if [ -d cases ]; then
  CASES=$(ls -d cases/*/ 2>/dev/null | xargs -I{} basename {})
elif [ -d problems ]; then
  CASES=$(ls -d problems/*/ 2>/dev/null | xargs -I{} basename {})
elif [ -d tasks ]; then
  CASES=$(ls -d tasks/*/ 2>/dev/null | xargs -I{} basename {})
else
  echo "ERROR: No cases/problems/tasks directory found"
  exit 1
fi
echo "Found cases: $CASES"
\`\`\`

### Step 3: Run each case with token rotation
Token rotation setup (5 accounts to avoid rate limits):
\`\`\`bash
${tokenArray}
\`\`\`

For each case (index I, 0-based):
\`\`\`bash
export CLAUDE_CODE_OAUTH_TOKEN="\${TOKENS[$((I % 5))]}"
cd "${benchDir}"
${runCmd.replace("{CASE}", "{CASE_NAME}")}
\`\`\`

**Rate limit handling**: If a case fails with a rate_limit error:
1. Wait 30 seconds
2. Try the next token: \`export CLAUDE_CODE_OAUTH_TOKEN="\${TOKENS[$(((I + 1) % 5))]}"\`
3. Retry
4. If still failing, try model fallback: ${fallbackStr}

### Step 4: Collect results
After all cases finish, collect results into \`{{SESSION_DIR}}/round-results.json\`:
\`\`\`json
{
  "round": 1,
  "benchmark": "${benchmark}",
  "timestamp": "2026-03-16T12:00:00Z",
  "cases": {
    "case_name": {
      "pass": true,
      "run_dir": "/path/to/results/...",
      "details": "..."
    }
  },
  "summary": {
    "total_cases": 11,
    "passed": 8,
    "failed": 3,
    "failed_cases": ["..."]
  }
}
\`\`\`

### Step 5: Print summary
Print a pass/fail table showing all cases and their results.`;
}

function hardenerSeed(opts: BenchPipelineOpts): string {
  const benchmark = opts.benchmark || "benchmark";
  const benchDir = opts.benchDir || ".";

  return `You are the benchmark hardener for ${benchmark}.

## Project
\`${benchDir}\` — analyze executor results and fix verifier/test/task issues.

## Context
An agent just ran all benchmark cases. Results are in:
- \`{{SESSION_DIR}}/round-results.json\`

## Known patterns from prior hardening

### Free-form field mismatches
Verifiers that check free-form text with exact matching will fail. **Fix**: Use LIKE/regex patterns.
- \`report_type = 'legal'\` → \`report_type LIKE '%legal%'\`
- \`subject = 'Complaint'\` → \`subject LIKE '%complaint%'\`

### Rate limit infrastructure issues
Not a verifier bug — note but don't fix. The executor handles token rotation.

### Missing tool operations
Verify the required operation exists before marking as capability failure.

### Underspecified task context
If the task doesn't clearly request what the verifier checks, add explicit instructions.

## Workflow

### Phase 1: Read results
Read \`{{SESSION_DIR}}/round-results.json\`. Build a pass/fail matrix.

### Phase 2: Classify failures

| Category | Meaning | Action |
|----------|---------|--------|
| **capability** | Agent couldn't do it | No action—legitimate difficulty |
| **task_design** | Instructions unclear | Fix task description |
| **verifier_bug** | Wrong/strict/loose checks | Fix verifier/test |
| **reward_hack** | Agent gamed the test | Harden verifier |
| **infra** | Rate limit, crash, timeout | Note, don't fix |

### Phase 3: Read conventions
\`\`\`bash
if [ -d "${CONVENTIONS_DIR}" ]; then
  cat "${CONVENTIONS_DIR}/README.md" 2>/dev/null | head -100
  ls "${CONVENTIONS_DIR}/"
fi
\`\`\`
Use convention checklists to guide fixes.

### Phase 4: Fix issues
For each task_design/verifier_bug/reward_hack:
1. Read the relevant file
2. Make targeted fixes
3. Verify the fix makes sense

**Explore in parallel** — write and run scripts to quickly analyze results:
\`\`\`bash
# Example: find all failing verifiers
cd "${benchDir}"
find . -name "grade.json" -exec grep -l '"passed": false' {} \\;
\`\`\`

### Phase 5: Track convergence
\`\`\`bash
ROUND=$(cat "{{SESSION_DIR}}/round.txt" 2>/dev/null || echo 1)
echo $((ROUND + 1)) > "{{SESSION_DIR}}/round.txt"

# Track clean rounds
CLEAN=$(cat "{{SESSION_DIR}}/clean-rounds.txt" 2>/dev/null || echo 0)
# If no fixes needed this round:
echo $((CLEAN + 1)) > "{{SESSION_DIR}}/clean-rounds.txt"
# If fixes were needed:
# echo 0 > "{{SESSION_DIR}}/clean-rounds.txt"
\`\`\`

If 3 consecutive clean rounds, notify (but don't stop—pipeline continues until user pauses):
\`\`\`bash
if [ $(cat "{{SESSION_DIR}}/clean-rounds.txt") -ge 3 ]; then
  notify "Benchmark ${benchmark} converged after $ROUND rounds (3 clean). Consider pausing." "Benchmark Converged"
fi
\`\`\`

### Phase 6: Write report
Write to \`{{SESSION_DIR}}/harden-report-r\${ROUND}.md\`:
\`\`\`markdown
# Hardening Report — Round {N}

## Pass/Fail Matrix
| Case | Result | Category |
|------|--------|----------|

## Issues Found
### Verifier Bugs
### Task Design Issues
### Reward Hacks
### Capability Failures (no action)
### Infrastructure (no action)

## Changes Made
## Convergence: clean rounds X/3
\`\`\`

### Phase 7: Commit
\`\`\`bash
cd "${benchDir}"
git add -A
git commit -m "Round \${ROUND}: harden ${benchmark} based on agent performance"
\`\`\`

## Principles
- **Outcome-only**: Check state, not agent behavior
- Verifier bug = verifier is wrong, not agent
- Don't over-harden—capability failures are fine
- LIKE patterns for all free-form text
- Write analysis scripts to explore results efficiently
- Check convention checklists before committing`;
}
