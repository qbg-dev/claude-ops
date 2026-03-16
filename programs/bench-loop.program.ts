/**
 * Bench Loop — indefinite execute→harden cycle for any benchmark.
 *
 * ALL execution happens in Docker containers on EC2 (or Hetzner).
 * Agents run locally via Claude Agent SDK or Codex SDK, executing commands
 * remotely via `ssh host docker exec`.
 *
 * Graph:
 *   execute → harden → execute   (loop until paused.flag or user says stop)
 *
 * Features:
 *   - Docker on EC2 by default (scripts/bench-ec2-launch.sh for lifecycle)
 *   - Codex SDK (@openai/codex-sdk) or Claude Agent SDK solver
 *   - Token rotation (5 OAuth accounts from ~/.claude/sensitive/oauth-tokens.md)
 *   - Model fallback on rate limits: sonnet → sonnet[1m] → opus[1m] → opus
 *   - Convention CI checks (qbg-dev/conventions ci_checks/ + BENCHMARK-CREATION.md)
 *   - Hardener explores in parallel, writes analysis scripts
 *   - Cross-round memory (stable-passes.json)
 *   - Prior learnings from 6 rounds greenfield + 3 rounds slop-code + 4 rounds tb3
 *   - Runs indefinitely — touch paused.flag to stop
 *
 * Usage:
 *   # Greenfield on EC2 (t3.xlarge already running at 18.236.183.103):
 *   fleet pipeline bench-loop --set benchDir=/Users/wz/Desktop/qbg/greenfield-bench --set host=18.236.183.103
 *
 *   # With Codex SDK:
 *   fleet pipeline bench-loop --set benchDir=/path/to/bench --set host=1.2.3.4 --set runtime=codex
 *
 *   # On Hetzner (root@5.161.107.142):
 *   fleet pipeline bench-loop --set benchDir=/path/to/bench --set host=5.161.107.142
 *
 *   # Launch new EC2 first:
 *   bash scripts/bench-ec2-launch.sh c5.2xlarge greenfield
 *   fleet pipeline bench-loop --set benchDir=... --set host=$BENCH_EC2_IP --set sshUser=ec2-user
 *
 * Pause/resume:
 *   touch {{SESSION_DIR}}/paused.flag    # pause after current harden cycle
 *   rm {{SESSION_DIR}}/paused.flag       # resume
 */
import type { Program, PipelineHook } from "../engine/program/types";
import { graph } from "../engine/program/graph";

export interface BenchLoopOpts {
  benchDir?: string;        // absolute path to benchmark directory (required)
  benchmark?: string;       // display name (auto-detected from benchDir basename if omitted)
  runtime?: string;         // "claude" | "codex" (default: "claude")
  model?: string;           // executor model (default: "sonnet")
  conventionsDir?: string;  // path to conventions repo (default: /Users/wz/Desktop/qbg/conventions)
  tokenFile?: string;       // OAuth tokens file
  host?: string;            // EC2/Hetzner IP for Docker (REQUIRED — no local Docker)
  sshUser?: string;         // SSH user (default: "ec2-user" for EC2, "root" for Hetzner)
  scope?: string;
  spec?: string;
}

const MODEL_FALLBACK = ["sonnet", "sonnet[1m]", "opus[1m]", "opus"];
const TOKEN_FILE_DEFAULT = `${process.env.HOME}/.claude/sensitive/oauth-tokens.md`;

function readOAuthTokens(tokenFile: string): string[] {
  const fs = require("fs");
  try {
    const content = fs.readFileSync(tokenFile, "utf-8");
    return content.split("\n").filter((l: string) => l.trim().startsWith("sk-ant-oat01-")).map((l: string) => l.trim());
  } catch {
    return [];
  }
}

export default function benchLoop(opts: BenchLoopOpts): Program {
  if (!opts.host) throw new Error("--set host=<IP> is required (EC2 or Hetzner IP for Docker)");
  if (!opts.benchDir) throw new Error("--set benchDir=<path> is required");

  const benchDir = opts.benchDir;
  const benchmark = opts.benchmark || require("path").basename(benchDir);
  const runtime = opts.runtime || "claude";
  const model = opts.model || "opus[1m]";
  const conventionsDir = opts.conventionsDir || "/Users/wz/Desktop/qbg/conventions";
  const tokenFile = opts.tokenFile || TOKEN_FILE_DEFAULT;
  const tokens = readOAuthTokens(tokenFile);
  const host = opts.host;
  // Auto-detect SSH user: IPs starting with 5.161 = Hetzner (root), else EC2 (ec2-user)
  const sshUser = opts.sshUser || (host.startsWith("5.161") ? "root" : "ec2-user");
  const sshPrefix = `ssh -o StrictHostKeyChecking=no ${sshUser}@${host}`;
  const dockerCmd = sshUser === "root" ? `${sshPrefix} docker` : `${sshPrefix} sudo docker`;

  const g = graph(
    `bench-loop-${benchmark}`,
    `Indefinite execute→harden loop for ${benchmark} on ${host} (${runtime}/${model})`,
  )
    .node("execute", {
      description: `Run ${benchmark} in Docker on ${host} with ${runtime}/${model}`,
      agents: [{
        name: "executor",
        role: "executor",
        model: model,
        seed: { inline: executorSeed({ benchDir, benchmark, runtime, model, tokens, host, sshUser, sshPrefix, dockerCmd, conventionsDir }) },
        window: "execute",
        hooks: [
          ...compactionSurvivalHooks({ benchDir, benchmark, conventionsDir, role: "executor" }),
          ...safetyHooks(),
        ],
      }],
    })
    .node("harden", {
      description: `Analyze results and harden ${benchmark}`,
      agents: [{
        name: "hardener",
        role: "analyst",
        model: "opus[1m]",
        seed: { inline: hardenerSeed({ benchDir, benchmark, conventionsDir, host, sshUser, sshPrefix, dockerCmd }) },
        window: "harden",
        hooks: [
          ...compactionSurvivalHooks({ benchDir, benchmark, conventionsDir, role: "hardener" }),
          ...safetyHooks(),
          {
            event: "PreToolUse",
            type: "prompt",
            matcher: "Bash",
            description: "Remind hardener to run conventions CI before git commit",
            prompt: `⚠️ CONVENTIONS CI REMINDER: If you are about to commit, verify ALL 7 checks passed first:\n\`\`\`bash\nFAILED=0; for s in ${conventionsDir}/ci_checks/*.sh; do bash "$s" ${benchDir}/ 2>&1 || FAILED=1; done; [ $FAILED -eq 0 ] && echo "✅ PASS" || echo "❌ FAIL"\n\`\`\`\nDo NOT commit with failing checks. Also verify: LIKE/regex patterns (never exact match), oracle still passes.`,
          },
        ],
      }],
      prelaunch: [
        { type: "parse-output", agent: "executor", file: "round-results.json" },
      ],
    })
    .edge("execute", "harden")
    .edge("harden", "execute", {
      condition: `! test -f "{{SESSION_DIR}}/paused.flag"`,
      maxIterations: 999,
      label: "continue loop",
    })
    .edge("harden", "$end", {
      label: "paused by user",
      priority: 1,
    })
    .defaults({
      model: model,
      effort: "high",
      permission: "bypassPermissions",
    })
    .material({
      scope: opts.scope,
      spec: opts.spec || `Execute and harden ${benchmark} on EC2 ${host} indefinitely`,
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

// ── Per-agent hooks (installed into each agent's hooks dir) ──────

/** PreCompact inject hooks that re-inject critical rules on context compaction */
function compactionSurvivalHooks({ benchDir, benchmark, conventionsDir, role }: {
  benchDir: string; benchmark: string; conventionsDir: string; role: string;
}): PipelineHook[] {
  return [{
    event: "PreCompact",
    type: "prompt",
    description: `Re-inject critical ${benchmark} rules for ${role} on compaction`,
    prompt: `## ⚠️ COMPACTION SURVIVAL — Critical Rules for ${role} (${benchmark})

### You MUST re-read these files before continuing:
1. \`${benchDir}/HARDENING-LEARNINGS.md\` — 13 rounds of compiled failure patterns
2. Your round: \`cat "{{SESSION_DIR}}/round.txt"\`
3. Stable passes: \`cat "{{SESSION_DIR}}/stable-passes.json"\`

### Non-negotiable rules:
- **All execution in Docker on EC2** — NEVER run benchmark code locally
- **NEVER git push** — only the coordinator pushes
- **Free-form text**: NEVER exact match. Use LIKE '%keyword%' or regex.
- **MCP action strings**: Audit server source before writing verifiers
- **Name variance**: Use %LastName% LIKE patterns
- **Oracle first**: Verify reference solution passes before blaming agents
- **rsync before every Docker build** — stale files cause subtle failures

### Conventions CI (7 checks) — run BEFORE and AFTER changes:
\`\`\`bash
FAILED=0; for s in ${conventionsDir}/ci_checks/*.sh; do echo "--- $(basename $s) ---"; bash "$s" ${benchDir}/ 2>&1 || FAILED=1; done
[ $FAILED -eq 0 ] && echo "✅ ALL PASSED" || echo "❌ FIX BEFORE COMMITTING"
\`\`\`

### References:
- \`${conventionsDir}/BENCHMARK-CREATION.md\` — TB3 rubric (13 criteria)
- \`${conventionsDir}/AGENT-REPRODUCIBILITY.md\` — 40 conventions
- \`${conventionsDir}/AGENT-SETUP-VERIFICATION.md\` — two-agent setup test`,
  }];
}

/** Safety hooks: block git push, block rm -rf on benchmark dirs */
function safetyHooks(): PipelineHook[] {
  return [{
    event: "PreToolUse",
    type: "command",
    matcher: "Bash",
    description: "Block git push — only coordinator pushes",
    blocking: true,
    check: `echo "$TOOL_INPUT" | grep -qv "git push"`,
  }];
}

// ── Seed context ──────────────────────────────────────────────────

interface SeedContext {
  benchDir: string;
  benchmark: string;
  runtime: string;
  model: string;
  tokens: string[];
  host: string;
  sshUser: string;
  sshPrefix: string;
  dockerCmd: string;
  conventionsDir: string;
}

// ── Executor seed ─────────────────────────────────────────────────

function executorSeed(ctx: SeedContext): string {
  const { benchDir, benchmark, runtime, model, tokens, host, sshUser, sshPrefix, dockerCmd } = ctx;
  const tokenCount = tokens.length || 1;
  const remoteBenchDir = `/tmp/${benchmark}`;

  const tokenArrayBash = tokens.length > 0
    ? tokens.map((t, i) => `TOKENS[${i}]="${t}"`).join("\n")
    : `TOKENS[0]="$CLAUDE_CODE_OAUTH_TOKEN"`;

  const runtimeInstructions = runtime === "codex"
    ? `## Agent runtime: Codex SDK
Write a TypeScript runner using \`@openai/codex-sdk\`:

\`\`\`typescript
import Codex from "@openai/codex-sdk";
const codex = new Codex();
const thread = codex.startThread();
const result = await thread.run(\`<task prompt with docker exec instructions>\`);
\`\`\`

Run with: \`bun /tmp/case-runner.ts\`

The Codex agent's prompt must include the docker exec prefix so it runs commands inside the container.`
    : `## Agent runtime: Claude Agent SDK
Launch each case as a subprocess:

\`\`\`bash
CLAUDE_CODE_OAUTH_TOKEN="$TOKEN" claude \\
  --model claude-sonnet-4-20250514 \\
  --dangerously-skip-permissions \\
  --allowedTools bash,read,write,edit \\
  --max-turns 100 \\
  --output-format json \\
  -p "$CASE_PROMPT"
\`\`\`

Or via the Agent SDK (\`@anthropic-ai/claude-code\`):
\`\`\`typescript
import { query } from "@anthropic-ai/claude-code";
for await (const msg of query({
  prompt: taskPrompt,
  options: { model: "claude-sonnet-4-20250514", permissionMode: "bypassPermissions", maxTurns: 100 }
})) { /* handle */ }
\`\`\`

**Critical**: The agent's prompt must tell it to run ALL commands via:
\`${dockerCmd} exec <container> bash -c '<command>'\``;

  return `You are the benchmark executor for **${benchmark}**.

## Goal
Run each benchmark case in Docker on EC2 (\`${host}\`) and collect pass/fail results into \`{{SESSION_DIR}}/round-results.json\`.

## Prior learnings (READ THIS FIRST)
Read \`${benchDir}/HARDENING-LEARNINGS.md\` if it exists — compiled learnings from 6 rounds greenfield, 3 rounds slop-code-bench, 4 rounds tb3-ranger. Key takeaways:
- Sonnet skips communication steps in multi-step tasks (legitimate difficulty)
- Use LIKE patterns for free-form text, never exact match
- Model fallback: ${MODEL_FALLBACK.join(" → ")}
- Token rotation across ${tokenCount} OAuth accounts
- Always rsync before Docker build (stale files cause subtle failures)
- CPU-only PyTorch saves ~2 min build time

## Project directory (local)
\`${benchDir}\`

## Docker on EC2
**All benchmark execution happens in Docker containers on \`${host}\`.**

SSH: \`${sshPrefix}\`
Docker: \`${dockerCmd}\`

### Step 1: Sync benchmark to remote
\`\`\`bash
rsync -az --delete ${benchDir}/ ${sshUser}@${host}:${remoteBenchDir}/
\`\`\`

### Step 2: Build Docker image
\`\`\`bash
${dockerCmd} build -t ${benchmark} ${remoteBenchDir}/ 2>&1 | tail -10
\`\`\`

If build fails, check if Dockerfile exists. Some benchmarks use docker-compose:
\`\`\`bash
${sshPrefix} "cd ${remoteBenchDir} && sudo docker-compose build" 2>&1
\`\`\`

### Step 3: For each case, start a fresh container
\`\`\`bash
ROUND=$(cat "{{SESSION_DIR}}/round.txt" 2>/dev/null || echo 1)
CONTAINER="${benchmark}-r\${ROUND}-case\${I}"
${dockerCmd} rm -f $CONTAINER 2>/dev/null || true
${dockerCmd} run -d --name $CONTAINER --cpus=2 --memory=4g ${benchmark} sleep infinity
\`\`\`

## How to discover cases
Look for subdirectories under \`cases/\`, \`problems/\`, or \`tasks/\` in \`${benchDir}\`.

## TB3-style benchmarks (tasks/ with task.toml)
If \`${benchDir}/tasks/\` exists with subdirectories containing \`task.toml\`:
- Each subdirectory is a **separate task** with its own Docker environment and test suite
- Enumerate tasks: \`ls ${benchDir}/tasks/\`
- For each task TASKNAME:
  - **Sync**: \`rsync -az --delete ${benchDir}/ ${sshUser}@${host}:${remoteBenchDir}/\`
  - **Build**: \`${dockerCmd} build -t ${benchmark}-TASKNAME ${remoteBenchDir}/tasks/TASKNAME/environment/\`
  - **Container**: \`${dockerCmd} run -d --name ${benchmark}-TASKNAME-r\${ROUND} --cpus=2 --memory=4g ${benchmark}-TASKNAME sleep infinity\`
  - **Copy tests into container**: \`${dockerCmd} cp ${remoteBenchDir}/tasks/TASKNAME/tests/. ${benchmark}-TASKNAME-r\${ROUND}:/tests/\`
  - **Agent prompt**: contents of \`tasks/TASKNAME/instruction.md\` — agent runs commands via \`${dockerCmd} exec ${benchmark}-TASKNAME-r\${ROUND} bash -c '...'\`
  - **Test**: \`${dockerCmd} exec ${benchmark}-TASKNAME-r\${ROUND} bash /tests/test.sh\` (runs pytest on test_state.py)
  - **Results**: parse pytest output for pass/fail counts per test function
- In round-results.json, use task name as case key, with per-test pass/fail details:
  \`"ranger": { "pass": false, "tests_passed": 45, "tests_total": 50, "details": "45/50 pytest tests passed" }\`
- **Important**: Each task may have many pytest tests (ranger=50, torchft-cifar10=9, hello-world=2). Report individual test counts, not just task pass/fail.

## Slop-code-bench (native runner)
If \`${benchDir}/pyproject.toml\` exists and contains \`[tool.slop-code]\` or a \`slop_code\` section:
- **Use the native runner** instead of manual case-by-case execution:
  \`\`\`bash
  cd ${benchDir}
  uv run slop-code run --num-workers 4 --no-live-progress
  \`\`\`
- The native runner handles all 21 problems in parallel — do NOT batch manually
- Results are written to: \`outputs/{run_name}/checkpoint_results.jsonl\` and \`outputs/{run_name}/result.json\`
- Convert native output to round-results.json format by reading the result files
- The agent subprocess is launched by the native runner — you just need to configure it
- Check \`slop-code --help\` or \`uv run slop-code run --help\` for available flags

${runtimeInstructions}

## Token rotation (critical)
Each case must launch as a **separate agent process** with a rotated token.

\`\`\`bash
${tokenArrayBash}
\`\`\`

For case index I: \`export CLAUDE_CODE_OAUTH_TOKEN="\${TOKENS[$((I % ${tokenCount}))]}\`

## Rate limit handling — MODEL FALLBACK ORDER
1. Retry with the next token
2. If all tokens exhausted, try next model: **${MODEL_FALLBACK.join(" → ")}**
3. If all models exhausted, wait 120s and retry

## Cross-round memory
Read \`{{SESSION_DIR}}/stable-passes.json\` — skip cases that passed in 2+ consecutive rounds.

## Round tracking
\`\`\`bash
ROUND=$(cat "{{SESSION_DIR}}/round.txt" 2>/dev/null || echo 1)
echo "Starting round $ROUND"
\`\`\`

## Output — CRITICAL: Read grade.json, NEVER grep logs
Write \`{{SESSION_DIR}}/round-results.json\` based on **actual grade.json files**, NOT stdout/log grep.

### How to collect results (MANDATORY process):
\`\`\`bash
# For each case, find the LATEST run directory and read grade.json
for case_dir in ${remoteBenchDir}/results/case_*/; do
  CASE=$(basename "$case_dir")
  LATEST_RUN=$(ls -t "$case_dir" | head -1)
  for cp in 1 2 3; do
    GRADE="$case_dir/$LATEST_RUN/cp$cp/grade.json"
    if [ -f "$GRADE" ]; then
      python3 -c "import json; d=json.load(open('$GRADE')); print(f'$CASE CP$cp: {\"PASS\" if d[\"passed\"] else \"FAIL\"} ({d[\"passed_count\"]}/{d[\"total_count\"]})')"
    else
      echo "$CASE CP$cp: MISSING (count as FAIL)"
    fi
  done
done
\`\`\`

### NEVER do this:
- Do NOT \`grep "Grade" /tmp/result_*.log\` — logs may contain results from prior runs
- Do NOT assume a case passed because the log says "Run complete"
- Do NOT count regression check passes as checkpoint passes

### A case passes ONLY if ALL its checkpoint grade.json files show \`"passed": true\`.
If any CP grade.json is missing or shows \`"passed": false\`, the case FAILS.

\`\`\`json
{
  "round": 1,
  "benchmark": "${benchmark}",
  "host": "${host}",
  "timestamp": "ISO8601",
  "runtime": "${runtime}",
  "model": "${model}",
  "cases": {
    "case_name": { "pass": true, "skipped": false, "details": "CP1: 3/3, CP2: 2/2, CP3: 3/3" },
    "case_name": { "pass": false, "skipped": false, "error": "CP3 FAIL: 0/3 — inspection report not created", "category": "capability|infra|verifier_bug" }
  },
  "summary": { "total": 0, "passed": 0, "failed": 0, "skipped": 0 }
}
\`\`\`

## Cleanup
After all cases finish:
\`\`\`bash
${dockerCmd} ps -aq --filter name=${benchmark}-r | xargs -r ${dockerCmd} rm -f
\`\`\`

## Rules (PERSISTENT — re-read after every compaction)
- Do NOT modify benchmark files — only run them
- **All execution in Docker on EC2** — never run benchmark code locally
- Each case = fresh container + separate agent process with rotated token
- **NEVER git push** — only the coordinator/merger pushes. Commit locally and stop.
- Keep things simple — note errors and move on
- **Per-task timeout**: If a task takes more than 60 minutes of your time, stop, record partial results (what tests passed/failed so far), and move to the next task.
- **Write results incrementally**: After completing EACH case/task, update {{SESSION_DIR}}/round-results.json with results so far. Don't wait until all cases finish.
- Print summary table at the end

## ⚠️ COMPACTION SURVIVAL NOTICE
If your context was just compacted, re-read these before continuing:
1. \`${benchDir}/HARDENING-LEARNINGS.md\` — 13 rounds of compiled failure patterns
2. Your round number: \`cat "{{SESSION_DIR}}/round.txt"\`
3. Stable passes: \`cat "{{SESSION_DIR}}/stable-passes.json"\`
4. This entire seed prompt — it contains your Docker commands, token rotation, and output format`;
}

// ── Hardener seed ─────────────────────────────────────────────────

interface HardenerContext {
  benchDir: string;
  benchmark: string;
  conventionsDir: string;
  host: string;
  sshUser: string;
  sshPrefix: string;
  dockerCmd: string;
}

function hardenerSeed(ctx: HardenerContext): string {
  const { benchDir, benchmark, conventionsDir, host, sshUser, dockerCmd } = ctx;
  const remoteBenchDir = `/tmp/${benchmark}`;

  return `You are the benchmark hardener for **${benchmark}**.

## Goal
Analyze executor results and fix verifier/test/task issues. Explore aggressively—write scripts, run in parallel, get at the important information fast.

## Prior learnings (READ THIS FIRST)
Read \`${benchDir}/HARDENING-LEARNINGS.md\` — compiled from 13 rounds across 3 benchmarks.

## Project (local)
\`${benchDir}\`

## Docker on EC2
Remote host: \`${host}\` (SSH user: ${sshUser})
Docker: \`${dockerCmd}\`

When you need to test verifier changes, rebuild + re-run on EC2:
\`\`\`bash
rsync -az --delete ${benchDir}/ ${sshUser}@${host}:${remoteBenchDir}/
${dockerCmd} build -t ${benchmark} ${remoteBenchDir}/
\`\`\`

## Input
Results from the executor: \`{{SESSION_DIR}}/round-results.json\`

## Convention checks (qbg-dev/conventions) — MANDATORY, NON-NEGOTIABLE
You MUST run ALL 7 CI checks BEFORE and AFTER every change. Do NOT commit without passing CI.

\`\`\`bash
echo "=== CONVENTIONS CI (7 checks) ==="
FAILED=0
for script in ${conventionsDir}/ci_checks/*.sh; do
  echo "--- $(basename $script) ---"
  if ! bash "$script" ${benchDir}/ 2>&1; then FAILED=1; fi
done
[ $FAILED -eq 0 ] && echo "✅ ALL CHECKS PASSED" || echo "❌ CHECKS FAILED — FIX BEFORE COMMITTING"
\`\`\`

The 7 checks: canary strings, Dockerfile references, Dockerfile sanity, absolute paths, test file references, test.sh sanity, task field validation.

Also reference (read at least once per session):
- \`${conventionsDir}/BENCHMARK-CREATION.md\` — full benchmark creation guide with TB3 rubric (13 criteria)
- \`${conventionsDir}/AGENT-REPRODUCIBILITY.md\` — 40 conventions for agent-reproducible repos
- \`${conventionsDir}/AGENT-SETUP-VERIFICATION.md\` — two-agent setup test requirement

## Failure taxonomy

| Category | Meaning | Action |
|----------|---------|--------|
| **capability** | Agent couldn't do it — legitimate difficulty | No action |
| **task_design** | Instructions unclear/ambiguous | Fix task description |
| **verifier_bug** | Wrong/strict/loose checks | Fix verifier/test |
| **reward_hack** | Agent gamed the test without solving the real problem | Harden verifier |
| **infra** | Rate limit, Docker crash, timeout, SSH issue | Note for executor fixes |

## Known hardening patterns (from 13 prior rounds)

**Free-form text**: Never exact match. Use LIKE '%keyword%' or regex.
**MCP action strings**: Audit server source before writing verifiers. Don't assume action names.
**Underspecified tasks**: If verifier checks for X but task doesn't mention X, add explicit instruction.
**Name variance**: Use %LastName% LIKE patterns for all name fields.
**Oracle first**: Always verify reference solution passes before blaming agents.
**Docker env**: Pin deps, add health checks, rsync before build. CPU-only PyTorch when possible.

## Workflow

### Phase 1: Read results + build matrix
\`\`\`bash
cat "{{SESSION_DIR}}/round-results.json" | python3 -c "
import json, sys
data = json.load(sys.stdin)
print(f'Round {data[\"round\"]}: {data[\"summary\"][\"passed\"]}/{data[\"summary\"][\"total\"]} passed')
for name, result in data['cases'].items():
    status = 'PASS' if result['pass'] else 'FAIL'
    detail = result.get('error', result.get('details', ''))[:80]
    print(f'  {status} {name}: {detail}')
"
\`\`\`

### Phase 2: Classify failures
**Explore in parallel**: Write bash scripts to extract patterns across multiple failures. Don't read files one by one.

\`\`\`bash
# Example: grep all verifier files for exact match patterns
grep -rn "= '" ${benchDir}/cases/*/verifiers.json | grep -v LIKE
\`\`\`

### Phase 3: Fix issues
For each task_design/verifier_bug/reward_hack: read source, make targeted fix, verify correctness.

### Phase 4: Verify oracle still passes (if solution exists)
\`\`\`bash
rsync -az --delete ${benchDir}/ ${sshUser}@${host}:${remoteBenchDir}/
${dockerCmd} build -t ${benchmark}-oracle ${remoteBenchDir}/
${dockerCmd} run --rm -v ${remoteBenchDir}/solution:/solution:ro -v ${remoteBenchDir}/tests:/tests:ro \\
  ${benchmark}-oracle bash -c "bash /solution/solve.sh && bash /tests/test.sh && cat /logs/verifier/reward.txt"
\`\`\`

### Phase 5: Run convention CI
\`\`\`bash
for script in ${conventionsDir}/ci_checks/*.sh; do
  bash "$script" ${benchDir}/ 2>&1
done
\`\`\`

### Phase 6: Update cross-round memory
\`\`\`bash
ROUND=$(cat "{{SESSION_DIR}}/round.txt" 2>/dev/null || echo 1)
echo $((ROUND + 1)) > "{{SESSION_DIR}}/round.txt"
\`\`\`

Update \`{{SESSION_DIR}}/stable-passes.json\`.

### Phase 7: Write report
Write \`{{SESSION_DIR}}/harden-report-r\${ROUND}.md\` with pass/fail matrix, classified issues, changes, CI results.

### Phase 8: Commit changes
\`\`\`bash
cd ${benchDir} && git add -A && git commit -m "Round \${ROUND}: harden ${benchmark}"
\`\`\`

## Key principles (PERSISTENT — re-read after every compaction)
- **Outcome-only**: Check final state, not agent behavior
- **Docker on EC2**: All verification runs remotely
- **LIKE/regex** for all free-form text — NEVER exact match for free-form content
- **Explore aggressively** — write scripts, grep across files, parallelize
- **Keep fixes simple** — the simplest fix is usually right
- **Conventions CI** before AND after changes — all 7 checks must pass before commit
- **NEVER git push** — only the coordinator/merger pushes
- **Oracle first** — always verify reference solution still passes after your changes

## ⚠️ COMPACTION SURVIVAL NOTICE
If your context was just compacted, re-read these before continuing:
1. \`${benchDir}/HARDENING-LEARNINGS.md\` — 13 rounds of compiled failure patterns
2. \`{{SESSION_DIR}}/round-results.json\` — current round's executor results
3. \`{{SESSION_DIR}}/round.txt\` — current round number
4. \`${conventionsDir}/BENCHMARK-CREATION.md\` — TB3 rubric (13 criteria)
5. This entire seed prompt — it contains your Docker commands, conventions CI, and workflow phases`;
}
