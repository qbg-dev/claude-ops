/**
 * Greenfield-Bench Perpetual Hardening Pipeline — iterative verifier hardening + complexity expansion.
 *
 * Graph:
 *   attempt → analyze-harden ──→ attempt     (if verifier/task issues found)
 *                              └→ expand      (if converged: 3 clean rounds)
 *                              └→ $end        (if maxIterations hit)
 *
 *   expand → attempt                          (cycle back with new cases)
 *          └→ $end                            (if fully solved)
 *
 * Attempt phase: Sonnet (1M) runs all hotel management cases (cascade mode) with token rotation.
 * Analyze phase: Opus (1M) reviews results, classifies failures, hardens verifiers/checkpoints.
 * Expand phase: Opus (1M) reads Wechat + strategy docs, adds real-world complexity.
 *
 * Usage:
 *   fleet pipeline greenfield-harden --set rounds=15
 *   fleet pipeline greenfield-harden --set rounds=5 --set spec="case_01_complaint_escalation,case_06_parking_flood"
 *   fleet pipeline greenfield-harden --dry-run
 */
import type { Program } from "../engine/program/types";
import { graph } from "../engine/program/graph";

export interface GreenfieldHardenOpts {
  rounds?: number;
  spec?: string; // comma-separated case filter
  scope?: string;
}

const PROJECT_ROOT = "/Users/wz/Desktop/qbg/greenfield-bench";
const WECHAT_ROOT = "/Users/wz/Desktop/zPersonalProjects/Wechat";
const STRATEGY_FILE = "/Users/wz/Desktop/qbg/qbg_benchmark_strategy";

const ALL_CASES = [
  "case_01_complaint_escalation",
  "case_02_fee_collection",
  "case_03_work_order_routing",
  "case_04_lease_renewal",
  "case_05_bi_dashboard",
  "case_06_parking_flood",
  "case_07_billing_dispute",
  "case_08_new_property",
  "case_09_restaurant_conflict",
  "case_10_anomaly_detection",
  "case_11_access_control",
];

// Three OAuth tokens for rate-limit rotation across Max subscriptions
const OAUTH_TOKENS = [
  "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",  // Leyi
  "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",  // zhufuchengwarren
  "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",  // warrenzhu513
];

export default function greenfieldHarden(opts: GreenfieldHardenOpts): Program {
  const rounds = opts.rounds || 15;
  const cases = opts.spec ? opts.spec.split(",").map((s) => s.trim()) : ALL_CASES;

  const g = graph(
    "greenfield-harden",
    `Perpetual verifier hardening + complexity expansion for greenfield-bench (${rounds} max rounds, ${cases.length} cases)`,
  )
    // ── Node 1: attempt — run all benchmark cases ──
    .node("attempt", {
      description: "Run benchmark cases with Sonnet (1M) and collect grade results",
      agents: [
        {
          name: "case-runner",
          role: "executor",
          model: "sonnet[1m]",
          seed: { inline: runnerSeed(cases) },
          window: "attempt",
        },
      ],
    })
    // ── Node 2: analyze-harden — classify failures, fix verifiers ──
    .node("analyze-harden", {
      description: "Analyze failures, classify issues, harden verifiers and checkpoints",
      agents: [{
        name: "hardener",
        role: "analyst",
        model: "opus[1m]",
        seed: { inline: hardenerSeed(cases) },
        window: "analyze",
      }],
      prelaunch: [
        { type: "parse-output", agent: "case-runner", file: "round-results.json" },
      ],
    })
    // ── Node 3: expand — add real-world complexity on convergence ──
    .node("expand", {
      description: "Expand benchmark complexity using Wechat patterns and strategy dimensions",
      agents: [{
        name: "complexity-expander",
        role: "architect",
        model: "opus[1m]",
        seed: { inline: expanderSeed() },
        window: "expand",
      }],
    })
    // ── Edges ──
    // attempt → analyze (always)
    .edge("attempt", "analyze-harden")
    // analyze → attempt (cycle back if NOT converged)
    .edge("analyze-harden", "attempt", {
      condition: `! test -f "{{SESSION_DIR}}/converged.flag"`,
      maxIterations: rounds,
      label: "issues found, more rounds needed",
    })
    // analyze → expand (if converged: 3 consecutive clean rounds)
    .edge("analyze-harden", "expand", {
      condition: `test -f "{{SESSION_DIR}}/converged.flag"`,
      label: "converged — expand complexity",
      priority: 0,
    })
    // expand → attempt (new complexity added, re-harden)
    .edge("expand", "attempt", {
      maxIterations: 3,
      label: "new complexity added, re-harden",
    })
    // expand → $end (fully solved or max expansions)
    .edge("expand", "$end", {
      label: "fully solved or max expansions",
      priority: 1,
    })
    // analyze → $end (max iterations safety valve)
    .edge("analyze-harden", "$end", {
      label: "max iterations safety valve",
      priority: 2,
    })
    .defaults({
      model: "sonnet[1m]",
      effort: "high",
      permission: "bypassPermissions",
    })
    .material({
      scope: opts.scope,
      spec: `Perpetual hardening + expansion for greenfield-bench hotel management (max ${rounds} rounds)`,
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

// ── Parse output handlers ──────────────────────────────────────────────

export function parse_case_runner_output(state: any): void {
  const fs = require("fs");
  const path = require("path");
  const resultsPath = path.join(state.sessionDir, "round-results.json");
  if (fs.existsSync(resultsPath)) {
    state.ext.roundResults = JSON.parse(fs.readFileSync(resultsPath, "utf-8"));
  }
}

// ── Seed generators ────────────────────────────────────────────────────

function runnerSeed(cases: string[]): string {
  // Build case list with token rotation assignments
  const caseEntries = cases.map((c, i) => {
    const tokenIdx = i % OAUTH_TOKENS.length;
    return `  - ${c} (token: ${tokenIdx})`;
  }).join("\n");

  // Build token rotation bash snippet
  const tokenArray = OAUTH_TOKENS.map((t, i) => `TOKENS[${i}]="${t}"`).join("\n");

  return `You are a benchmark executor for the greenfield-bench hotel management benchmark.

## Project
\`${PROJECT_ROOT}\` — a benchmark with ${cases.length} hotel management cases, each with 3 cascading checkpoints. Cases are solved by a Claude Code SDK agent that can only use MCP tools (hotel_db, guest_services, comms, documents, admin).

## Rules
- Run all cases sequentially—each spawns a Claude Code SDK agent internally
- Do NOT modify any benchmark files (cases, verifiers, MCP servers)—only run them
- Each case creates an isolated DB + workspace in results/{case}/{timestamp}/
- **Token rotation**: Set CLAUDE_CODE_OAUTH_TOKEN before each case to distribute API load

## Task

### Step 1: Read round number
\`\`\`bash
ROUND=$(cat "{{SESSION_DIR}}/round.txt" 2>/dev/null || echo 1)
echo "Starting round $ROUND"
\`\`\`

### Step 2: Run each case with token rotation
For each of the following cases, run the benchmark in cascade mode:

${caseEntries}

**Token rotation setup** — set the appropriate token before each case:
\`\`\`bash
# Token array (3 accounts to avoid rate limits)
${tokenArray}
\`\`\`

For case index I (0-based), set the token before running:
\`\`\`bash
export CLAUDE_CODE_OAUTH_TOKEN="\${TOKENS[$((I % 3))]}"
cd ${PROJECT_ROOT}
python -m agents.runner.main --case {CASE_NAME} --cascade --model claude-sonnet-4-20250514 --max-turns 30
\`\`\`

Run them one at a time. After each case completes, note the output directory path printed at the end ("Run complete: {path}").

**Rate limit handling**: If a case fails with a rate_limit error, wait 60 seconds then retry with the next token in rotation:
\`\`\`bash
export CLAUDE_CODE_OAUTH_TOKEN="\${TOKENS[$(((I + 1) % 3))]}"
# retry the same case
\`\`\`

### Step 3: Collect grade results
After all cases finish, for each case find its latest results directory:
\`\`\`bash
LATEST=$(ls -td ${PROJECT_ROOT}/results/{CASE_NAME}/*/ 2>/dev/null | head -1)
\`\`\`

Read the grade.json files from each checkpoint directory (cp1/, cp2/, cp3/).

### Step 4: Write consolidated results
Write a JSON summary to \`{{SESSION_DIR}}/round-results.json\` with this structure:
\`\`\`json
{
  "round": 1,
  "timestamp": "2026-03-15T12:00:00Z",
  "cases": {
    "case_01_complaint_escalation": {
      "pass": true,
      "run_dir": "/path/to/results/...",
      "checkpoints": {
        "1": {"passed": true, "passed_count": 3, "total_count": 3, "results": [...]},
        "2": {"passed": true, "passed_count": 2, "total_count": 2, "results": [...]},
        "3": {"passed": false, "passed_count": 1, "total_count": 3, "results": [...]}
      }
    }
  },
  "summary": {
    "total_cases": 11,
    "passed": 8,
    "failed": 3,
    "failed_cases": ["case_05_bi_dashboard", "case_08_new_property", "case_10_anomaly_detection"]
  }
}
\`\`\`

A case passes only if ALL its checkpoints pass.

Include the full \`results\` array from each grade.json so the hardener can see exactly which verifiers failed and why.

### Step 5: Print summary
Print a pass/fail table showing all cases and their checkpoint results.`;
}

function hardenerSeed(_cases: string[]): string {
  return `You are the benchmark hardener for greenfield-bench, a hotel management benchmark with outcome-only verifiers.

## Project
\`${PROJECT_ROOT}\` — 11 cases × 3 cascading checkpoints. Agent uses 5 MCP servers (hotel_db, guest_services, comms, documents, admin). Verifiers check database state and files—never agent internals.

## Context
A Sonnet agent just ran all benchmark cases. Results are in:
- \`{{SESSION_DIR}}/round-results.json\`

## Known patterns from Rounds 1–3

These are recurring issues discovered in prior hardening rounds. Check for them first:

### Free-form field mismatches
Verifiers that check free-form text fields (report_type, subject, description, recipient_name) with exact string matching will fail when the agent uses reasonable but non-identical wording. **Fix**: Use SQL LIKE patterns instead of exact matches.
- \`report_type = 'legal'\` → \`report_type LIKE '%legal%'\`
- \`recipient_name = 'Smith'\` → \`recipient_name LIKE '%Smith%'\`
- \`subject = 'Complaint Resolution'\` → \`subject LIKE '%complaint%' AND subject LIKE '%resolution%'\`

### SDK rate_limit_event crashes
If the runner reports rate_limit errors, this is an infrastructure issue (not a verifier bug). Note it but don't change verifiers for it. The runner has token rotation to handle this.

### Missing MCP tool operations
Verifiers that check for operations the MCP servers don't support will always fail. Before marking something as a capability failure, verify the required write operation exists:
- Check audit_log action strings match what servers actually write
- Check that the agent has a tool to perform the checked operation

### Underspecified checkpoint context
Checkpoint user_messages that don't explicitly request the output format or deliverable the verifier checks for. **Fix**: Add explicit instructions in user_message (e.g., "generate a CSV report", "send an email to...", "create a document titled...").

### Name variance in recipient/contact fields
Agent may write "John Smith", "J. Smith", "Mr. Smith", or "Smith, John". **Fix**: Use \`%LastName%\` LIKE patterns for name fields.

## Your analysis workflow

### Phase 1: Read results
Read \`{{SESSION_DIR}}/round-results.json\`. Build a matrix:
- Case × Checkpoint → pass/fail
- For each failure, read the \`reason\` field from the verifier result

### Phase 2: Classify each failure

| Category | Meaning | Action |
|----------|---------|--------|
| **capability** | Agent timeout, wrong approach, couldn't figure it out | No action—legitimate difficulty |
| **task_design** | Checkpoint instructions ambiguous, MCP tools don't support required action | Fix checkpoint JSON |
| **verifier_bug** | Wrong conditions, too strict/loose, checks wrong column/table | Fix verifiers.json |
| **reward_hack** | Agent gamed verifiers without doing real work (e.g., inserted matching rows directly) | Harden verifiers |

Guidelines for classification:
- If the verifier reason says "SQL error" or references a non-existent table/column → **verifier_bug**
- If the verifier reason says "No rows matching" but the agent's trajectory shows it did the right thing → **verifier_bug** (conditions too strict)
- If the verifier checks for an action string that no MCP server writes → **verifier_bug**
- If the checkpoint persona or user_message doesn't clearly tell the agent what to do → **task_design**
- If the agent ran out of turns or got confused → **capability**
- If the agent created matching data without actually solving the task → **reward_hack**
- Free-form field exact match failures → **verifier_bug** (apply LIKE patterns)

### Phase 3: Verify MCP server capabilities
For verifiers that check \`audit_log\` actions or specific data patterns, verify the MCP servers actually support those operations:

\`\`\`bash
# Check what actions each server writes to audit_log
grep -rn "action" ${PROJECT_ROOT}/environment/mcp_servers/*/mcp_servers/*/main.py
\`\`\`

Known server audit_log actions:
- **admin**: permission_check, get_access_policy, policy_update, audit_query, get_employee, list_employees
- **guest_services**: CREATE, identity_verification, QUERY
- **documents**: create_report, draft_notice, create_spreadsheet, read_template, list_templates
- **comms**: send_email, send_notice, log_call, get_inbox, get_sent
- **hotel_db**: QUERY, SCHEMA_BROWSE

### Phase 4: Fix issues
For each task_design/verifier_bug/reward_hack issue:

1. Read the verifier file: \`${PROJECT_ROOT}/cases/{case_name}/verifiers.json\`
2. Read the checkpoint file if needed: \`${PROJECT_ROOT}/cases/{case_name}/checkpoint_{N}.json\`
3. Make targeted fixes:
   - For wrong action strings: change to match what server actually writes
   - For overly strict conditions: loosen (use LIKE patterns, accept alternatives)
   - For overly loose conditions: tighten (add more conditions, use data_created instead of data_exists)
   - For free-form field mismatches: switch to LIKE with key substring patterns
   - For reward hacks: add additional verifiers that check related state
   - For ambiguous checkpoints: clarify the user_message or add constraints

4. After fixing, verify the fix makes sense—don't introduce new bugs

### Phase 5: Track convergence
\`\`\`bash
ROUND=$(cat "{{SESSION_DIR}}/round.txt" 2>/dev/null || echo 1)
echo $((ROUND + 1)) > "{{SESSION_DIR}}/round.txt"

# Track consecutive clean rounds (no verifier_bug or task_design fixes needed)
CLEAN=$(cat "{{SESSION_DIR}}/clean-rounds.txt" 2>/dev/null || echo 0)
\`\`\`

If this round required NO verifier_bug or task_design fixes (only capability failures):
\`\`\`bash
echo $((CLEAN + 1)) > "{{SESSION_DIR}}/clean-rounds.txt"
\`\`\`

If this round DID require fixes:
\`\`\`bash
echo 0 > "{{SESSION_DIR}}/clean-rounds.txt"
\`\`\`

**Convergence**: If 3 consecutive clean rounds (clean >= 3), create the convergence flag:
\`\`\`bash
if [ $(cat "{{SESSION_DIR}}/clean-rounds.txt") -ge 3 ]; then
  touch "{{SESSION_DIR}}/converged.flag"
  echo "CONVERGED after $ROUND rounds — 3 consecutive clean rounds"
fi
\`\`\`

### Phase 6: Write report
Write to \`{{SESSION_DIR}}/harden-report-r\${ROUND}.md\`:

\`\`\`markdown
# Hardening Report — Round {N}

## Pass/Fail Matrix
| Case | CP1 | CP2 | CP3 | Overall |
|------|-----|-----|-----|---------|
| case_01 | PASS | PASS | PASS | PASS |
| ... |

## Issues Found
### Verifier Bugs
- case_XX CP2 verifier 1: checked action=EXPORT but docs server writes create_spreadsheet. Fixed.

### Task Design Issues
- case_XX CP3: user_message doesn't mention export format. Added "export as CSV" to instructions.

### Reward Hacks
- (none this round)

### Capability Failures (no action needed)
- case_XX: Agent ran out of turns on complex multi-step task

## Changes Made
- cases/case_XX/verifiers.json: Changed action condition from X to Y
- cases/case_XX/checkpoint_3.json: Clarified user_message

## Convergence Status
- Clean rounds: {N}/3
- Converged: yes/no

## Difficulty Assessment
- Easy (consistently pass): case_01, case_02, ...
- Medium (intermittent): case_06, ...
- Hard (consistent fail): case_10, ...
\`\`\`

### Phase 7: Commit changes
\`\`\`bash
cd ${PROJECT_ROOT}
git add cases/
git commit -m "Round \${ROUND}: harden greenfield-bench verifiers based on agent performance"
\`\`\`

## Key principles
- **Outcome-only**: Verifiers check database state and files, never agent behavior
- A verifier bug means the verifier is wrong, not the agent
- A task_design issue means the checkpoint instructions are unclear
- Don't over-harden—if the agent fails for legitimate capability reasons, that's fine
- Each round should reduce false positives/negatives while maintaining fairness
- Check MCP server source before assuming an action string exists
- **LIKE patterns** for all free-form text field verifiers—never exact match`;
}

function expanderSeed(): string {
  return `You are the complexity expander for greenfield-bench, a hotel management benchmark.

## Context
The benchmark has converged—3 consecutive hardening rounds with no verifier or task design fixes needed. All remaining failures are legitimate capability gaps. Your job is to make the benchmark harder by adding real-world complexity.

## Reference Materials
1. **Current results**: \`{{SESSION_DIR}}/round-results.json\` — understand what's now passing
2. **Wechat deployment**: \`${WECHAT_ROOT}/CLAUDE.md\` — real-world property management patterns from Baozheng (保臻)
3. **Benchmark strategy**: \`${STRATEGY_FILE}\` — target complexity dimensions
4. **Existing cases**: \`${PROJECT_ROOT}/cases/\` — current benchmark structure

## Expansion Strategies

Choose 1–2 strategies per cycle. Read the reference materials first, then apply:

### 1. Multi-tenant stress (from Wechat: cross-property isolation)
- Add cases where the agent must handle multiple properties with different policies
- Test access control boundaries: agent should NOT be able to see/modify data from other properties
- Add scenarios where the agent must check permissions before cross-property operations
- Example: "Guest requests room transfer between two properties with different pricing tiers"

### 2. Long-context pressure (from strategy: Dimension B)
- Add cases that require 50+ tool calls to complete
- Include scenarios where earlier information must be recalled after many intervening operations
- Create cases where compaction would lose critical details
- Example: "Audit all maintenance requests from the past year, cross-reference with vendor invoices, identify discrepancies"

### 3. Noise injection (from strategy: information quality erosion)
- Add misleading data to seed: wrong guest names, deleted/expired records, conflicting entries
- Create scenarios where the agent must distinguish current from stale data
- Add red herrings that make naive approaches fail
- Example: "Guest with similar name to another guest—agent must verify identity before acting"

### 4. State consistency (cascading dependencies)
- Add cases where checkpoint 2 must undo/modify checkpoint 1's work
- Create scenarios where a later step invalidates an earlier step's output
- Test rollback and correction capabilities
- Example: "Complete billing cycle, then handle a retroactive rate change that affects all prior invoices"

### 5. Human handoff simulation (from Wechat: AI↔human handoff)
- Add cases where the agent must recognize when to escalate vs. handle autonomously
- Create boundary scenarios that test judgment about scope of authority
- Example: "Guest threatens legal action—agent must document and escalate, not attempt resolution"

### 6. Free-form ambiguity (from Round 1–3 learnings)
- Add cases where the task description uses natural language that maps to multiple valid interpretations
- Test whether the agent asks for clarification vs. makes assumptions
- Harden verifiers to accept multiple valid approaches

## Implementation

### Reading existing cases
\`\`\`bash
# Understand current case structure
ls ${PROJECT_ROOT}/cases/
cat ${PROJECT_ROOT}/cases/case_01_complaint_escalation/checkpoint_1.json
cat ${PROJECT_ROOT}/cases/case_01_complaint_escalation/verifiers.json
\`\`\`

### Creating new cases
For each new case:
1. Create directory: \`${PROJECT_ROOT}/cases/case_NN_descriptive_name/\`
2. Write \`checkpoint_1.json\`, \`checkpoint_2.json\`, \`checkpoint_3.json\` following existing format
3. Write \`verifiers.json\` with outcome-only checks
4. Use LIKE patterns for all free-form text fields from the start
5. Verify all checked operations have corresponding MCP tool support

### Adding complexity to existing cases
For existing cases that pass easily:
1. Add a 4th checkpoint that introduces one of the complexity dimensions above
2. Or modify existing checkpoints to include noise/ambiguity
3. Update verifiers.json accordingly

### After expansion
\`\`\`bash
# Clear convergence flag so hardening restarts
rm -f "{{SESSION_DIR}}/converged.flag"
echo 0 > "{{SESSION_DIR}}/clean-rounds.txt"

# Commit new/modified cases
cd ${PROJECT_ROOT}
git add cases/
git commit -m "Expand: add real-world complexity ($(date +%Y-%m-%d))"
\`\`\`

### Write expansion report
Write to \`{{SESSION_DIR}}/expansion-report.md\`:
\`\`\`markdown
# Expansion Report

## Strategies Applied
- [strategy name]: [what was added]

## New Cases
- case_NN_name: [description, complexity dimension]

## Modified Cases
- case_XX: [what changed, which dimension]

## Expected Impact
- [which cases should become harder]
- [which failure modes are targeted]
\`\`\`

## Principles
- Real-world grounding: every expansion should map to a pattern from Wechat or strategy doc
- Outcome-only verifiers: never check agent behavior, only state
- LIKE patterns for free-form fields from day one
- Don't make things artificially hard—complexity should reflect genuine business challenges
- Each expansion cycle should target a different dimension to maximize coverage`;
}
