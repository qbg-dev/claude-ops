/**
 * Eval Loop Program — cyclic pipeline with convergence (graph-native).
 *
 * 2 nodes that cycle:
 *   generate: produces test scenarios + runs them
 *   evaluate: scores results, writes score.txt
 *   evaluate cycles back to generate until score >= threshold or maxIterations.
 *
 * Demonstrates:
 *   - graph() builder with conditional back-edges
 *   - maxIterations safety valve on back-edges
 *   - $end sentinel for pipeline completion
 *   - prelaunch actions on nodes
 *
 * Usage:
 *   fleet pipeline eval-loop --scope HEAD --spec "test the BI dashboard queries"
 *   fleet pipeline eval-loop --dry-run
 */
import type { Program } from "../engine/program/types";
import { graph } from "../engine/program/graph";

export interface EvalLoopOpts {
  scope?: string;
  spec?: string;
  threshold?: number;
  maxIterations?: number;
  projectRoot?: string;
  force?: boolean;
}

export default function evalLoop(opts: EvalLoopOpts): Program {
  const threshold = opts.threshold || 80;
  const maxIter = opts.maxIterations || 5;

  const g = graph(
    "eval-loop",
    `Iterative test-evaluate loop (converge at score >= ${threshold}, max ${maxIter} cycles)`,
  )
    .node("generate", {
      description: "Produce test scenarios and run them",
      agents: [{
        name: "generator",
        role: "generator",
        model: "sonnet",
        seed: { inline: generatorSeed(opts, threshold) },
        window: "generate",
      }],
    })
    .node("evaluate", {
      description: `Score results, cycle back if score < ${threshold}`,
      agents: [{
        name: "evaluator",
        role: "evaluator",
        model: "opus",
        seed: { inline: evaluatorSeed(opts, threshold) },
        window: "evaluate",
      }],
      prelaunch: [
        { type: "parse-output", agent: "generator", file: "test-results.json" },
      ],
    })
    // generate -> evaluate (always)
    .edge("generate", "evaluate")
    // evaluate -> generate (cycle back if score below threshold)
    .edge("evaluate", "generate", {
      condition: `test $(cat "{{SESSION_DIR}}/score.txt" 2>/dev/null || echo 0) -lt ${threshold}`,
      maxIterations: maxIter,
      label: "score below threshold",
    })
    // evaluate -> $end (converged)
    .edge("evaluate", "$end", {
      label: "converged",
      priority: 1,
    })
    .defaults({
      model: "sonnet",
      effort: "high",
      permission: "bypassPermissions",
    })
    .material({
      scope: opts.scope,
      spec: opts.spec || "Iterative evaluation of test scenarios.",
    })
    .build();

  // Return Program with graph attached (compiler uses graph path)
  return {
    name: g.name,
    description: g.description,
    phases: [], // empty — graph is the source of truth
    defaults: g.defaults,
    material: g.material,
    graph: g,
  };
}

function generatorSeed(opts: EvalLoopOpts, threshold: number): string {
  const spec = opts.spec || "the system under test";
  return `You are a test scenario generator.

## Context
You are part of an iterative eval loop testing: ${spec}
Target score: ${threshold}/100. You may be re-run multiple times with feedback.

## Task
1. Check if {{SESSION_DIR}}/eval-feedback.json exists (from a previous cycle's evaluator)
   - If it exists, read the feedback and adjust your test scenarios accordingly
   - Focus on the areas that scored lowest
2. Generate test scenarios that cover the spec comprehensively
3. Execute each test scenario and record pass/fail + details
4. Write results to {{SESSION_DIR}}/test-results.json as:
   {
     "cycle": <number from SESSION_DIR/cycle-evaluate-to-generate.count or 0>,
     "scenarios": [
       { "name": "...", "description": "...", "passed": bool, "details": "..." }
     ],
     "totalPassed": N,
     "totalFailed": N,
     "coverage": "description of what was tested"
   }

## Guidelines
- Each cycle should improve on the previous one
- Don't re-test things that consistently pass
- Focus on edge cases and failure modes
- Be thorough but efficient`;
}

function evaluatorSeed(opts: EvalLoopOpts, threshold: number): string {
  return `You are a test evaluator (Opus).

## Context
You evaluate test results from the generator and assign a quality score.
The loop continues until score >= ${threshold} or max iterations reached.

## Task
1. Read {{SESSION_DIR}}/test-results.json (generator output)
2. Evaluate the test results on these dimensions:
   - Coverage: are all important scenarios tested? (0-25)
   - Correctness: are the test assertions valid? (0-25)
   - Edge cases: are boundary conditions covered? (0-25)
   - Robustness: do tests handle error cases? (0-25)
3. Calculate total score (0-100)
4. Write the score to {{SESSION_DIR}}/score.txt (just the number, e.g. "75")
5. Write feedback to {{SESSION_DIR}}/eval-feedback.json as:
   {
     "score": N,
     "breakdown": { "coverage": N, "correctness": N, "edge_cases": N, "robustness": N },
     "strengths": ["..."],
     "gaps": ["areas to improve"],
     "suggestions": ["specific next steps"]
   }
6. Write a human-readable summary to {{SESSION_DIR}}/report.md

## Scoring
- Be rigorous but fair
- Score of ${threshold}+ means the tests are production-ready
- Provide actionable feedback so the generator can improve
- Each cycle should see meaningful improvement`;
}
