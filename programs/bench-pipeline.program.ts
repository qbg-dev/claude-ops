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
 *   fleet pipeline bench-pipeline --set conventionsDir=/path/to/conventions
 *   fleet pipeline bench-pipeline --dry-run
 *
 * Pause/resume:
 *   touch {{SESSION_DIR}}/paused.flag    # pause after current harden cycle
 *   rm {{SESSION_DIR}}/paused.flag       # resume (relaunch pipeline)
 */
import type { Program } from "../engine/program/types";
import { graph } from "../engine/program/graph";

export interface BenchPipelineOpts {
  benchmark?: string;       // benchmark name (for display/commits)
  benchDir?: string;        // absolute path to benchmark directory
  runCmd?: string;          // command template to run a case ({CASE} placeholder)
  model?: string;           // executor model (default: sonnet)
  runtime?: string;         // "claude" | "codex" (default: claude)
  maxRounds?: number;       // max harden→execute cycles (default: 50)
  conventionsDir?: string;  // path to conventions repo (default: read from env or skip)
  tokenFile?: string;       // path to OAuth tokens file (default: ~/.claude/sensitive/oauth-tokens.md)
  scope?: string;
  spec?: string;
  resume?: boolean;         // skip setup if resuming
}

// Model fallback order for rate limits
const MODEL_FALLBACK = ["sonnet", "opus[1m]", "opus"];

export default function benchPipeline(opts: BenchPipelineOpts): Program {
  const benchmark = opts.benchmark || "benchmark";
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
  // Each case launches as a separate agent process with a rotated token.
  // The executor is the orchestrator that spawns per-case agents.
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

// ── Seed generators ────────────────────────────────────────────────────

function setupSeed(opts: BenchPipelineOpts): string {
  const benchmark = opts.benchmark || "benchmark";
  const benchDir = opts.benchDir || ".";
  const runtime = opts.runtime || "claude";
  const conventionsDir = opts.conventionsDir || "";
  const tokenFile = opts.tokenFile || "~/.claude/sensitive/oauth-tokens.md";

  return `You are the setup agent for the **${benchmark}** benchmark pipeline.

## Goal
Validate that the benchmark environment at \`${benchDir}\` is ready to run. Do NOT run any benchmark cases.

## What to check
1. **Benchmark directory exists** and contains cases/problems/tasks
2. **Dependencies**: install from requirements.txt, pyproject.toml, or package.json if present
3. **Runtime**: verify \`${runtime === "codex" ? "codex" : "claude"}\` CLI is available
4. **OAuth tokens**: verify \`${tokenFile}\` exists and contains tokens (needed for per-case agent launches)
${conventionsDir ? `5. **Conventions**: verify \`${conventionsDir}\` exists` : ""}

## On completion
Write \`{{SESSION_DIR}}/setup-complete.flag\` with the timestamp.
If a critical dependency can't be resolved, write the error to \`{{SESSION_DIR}}/setup-error.txt\` instead.`;
}

function executorSeed(opts: BenchPipelineOpts): string {
  const benchmark = opts.benchmark || "benchmark";
  const benchDir = opts.benchDir || ".";
  const runCmd = opts.runCmd || "";
  const runtime = opts.runtime || "claude";
  const tokenFile = opts.tokenFile || "~/.claude/sensitive/oauth-tokens.md";

  const runtimeInstructions = runtime === "codex"
    ? `Launch each case with \`codex exec\`:
\`\`\`bash
CLAUDE_CODE_OAUTH_TOKEN="$TOKEN" codex exec -p "$CASE_PROMPT" --model gpt-5.4
\`\`\``
    : `Launch each case as a separate \`claude\` subprocess:
\`\`\`bash
CLAUDE_CODE_OAUTH_TOKEN="$TOKEN" claude --model ${opts.model || "sonnet"} --dangerously-skip-permissions -p "$CASE_PROMPT"
\`\`\``;

  return `You are the benchmark executor for **${benchmark}**.

## Goal
Run each benchmark case and collect pass/fail results into \`{{SESSION_DIR}}/round-results.json\`.

## Project directory
\`${benchDir}\`

## How to discover cases
Look for subdirectories under \`cases/\`, \`problems/\`, or \`tasks/\` in the benchmark directory.

## How to run each case
${runCmd
    ? `Use the provided command (substitute the case name for {CASE}):\n\`\`\`\n${runCmd}\n\`\`\``
    : `Read the benchmark's CLAUDE.md or README for the run command.`}

## Token rotation (critical)
Read OAuth tokens from \`${tokenFile}\` at runtime. Parse out the \`sk-ant-oat01-...\` lines.

**Each case must launch as a separate agent process** with a rotated token. You cannot change your own auth token mid-session—token rotation happens by setting \`CLAUDE_CODE_OAUTH_TOKEN\` in the environment of each spawned subprocess.

${runtimeInstructions}

Rotate tokens round-robin: case 0 gets token 0, case 1 gets token 1, etc.

## Rate limit handling
If a case fails with a rate_limit error:
1. Retry with the next token
2. If all tokens exhausted, try model fallback: ${MODEL_FALLBACK.join(" → ")}

## Cross-round memory
Read \`{{SESSION_DIR}}/stable-passes.json\` if it exists. Cases listed there passed in the last 2+ consecutive rounds—**skip them** unless the hardener reset their status. This avoids wasting tokens re-running cases that consistently pass.

## Output
Write \`{{SESSION_DIR}}/round-results.json\`:
\`\`\`json
{
  "round": N,
  "benchmark": "${benchmark}",
  "timestamp": "ISO8601",
  "cases": {
    "case_name": { "pass": true, "skipped": false, "details": "..." },
    "case_name": { "pass": false, "skipped": false, "error": "...", "category": "capability|infra" }
  },
  "summary": { "total": N, "passed": N, "failed": N, "skipped": N }
}
\`\`\`

## Rules
- Do NOT modify benchmark files (cases, verifiers, tests)—only run them
- Each case runs as its own subprocess with its own token
- Record results even for skipped cases`;
}

function hardenerSeed(opts: BenchPipelineOpts): string {
  const benchmark = opts.benchmark || "benchmark";
  const benchDir = opts.benchDir || ".";
  const conventionsDir = opts.conventionsDir || "";

  return `You are the benchmark hardener for **${benchmark}**.

## Goal
Analyze executor results and fix verifier/test/task issues. Your output: targeted fixes + a hardening report.

## Project
\`${benchDir}\`

## Input
Results are in \`{{SESSION_DIR}}/round-results.json\`.

## Failure taxonomy

| Category | Meaning | Action |
|----------|---------|--------|
| **capability** | Agent couldn't do it | No action—legitimate difficulty |
| **task_design** | Instructions unclear/ambiguous | Fix task description |
| **verifier_bug** | Wrong/strict/loose checks | Fix verifier/test |
| **reward_hack** | Agent gamed the test | Harden verifier |
| **infra** | Rate limit, crash, timeout | Note, don't fix |

## Known patterns from prior hardening

- **Free-form field mismatches**: Verifiers checking free-form text with exact matching will fail. Fix with LIKE/regex patterns.
- **Rate limit infrastructure issues**: Not a verifier bug—note but don't fix.
- **Missing tool operations**: Verify the required MCP operation exists before marking as capability failure.
- **Underspecified task context**: If the task doesn't clearly request what the verifier checks, add explicit instructions.

## Workflow
1. **Read** \`{{SESSION_DIR}}/round-results.json\` and build a pass/fail matrix
2. **Classify** each failure into the taxonomy above
3. **Fix** task_design/verifier_bug/reward_hack issues with targeted edits
${conventionsDir ? `4. **Check conventions** at \`${conventionsDir}\` for applicable checklists` : ""}
4. **Update stable-passes tracking**: Write \`{{SESSION_DIR}}/stable-passes.json\` listing cases that passed this round AND the previous round. The executor will skip these next round.
5. **Track convergence**: Increment round in \`{{SESSION_DIR}}/round.txt\`. Track consecutive clean rounds in \`{{SESSION_DIR}}/clean-rounds.txt\`. If 3 clean rounds, notify.
6. **Write report** to \`{{SESSION_DIR}}/harden-report-r{N}.md\`
7. **Commit** fixes to the benchmark repo

## Principles
- **Outcome-only**: Check final state, not agent behavior
- Verifier bug = verifier is wrong, not agent
- Don't over-harden—capability failures are fine
- LIKE patterns for all free-form text matching
- Write analysis scripts to explore results efficiently`;
}
