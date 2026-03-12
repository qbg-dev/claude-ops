/**
 * Research Lab Program — Watchdog-Driven Perpetual PI + Dynamic Students
 *
 * Architecture:
 *   - HT Kung (Opus, perpetual, sleepDuration: 1200) — watchdog-managed PI
 *     Each cycle: read mail → review student results → update notebook → assign work → round_stop()
 *     Spawns students dynamically via create_worker() MCP tool
 *   - Students (Sonnet, one-shot, deferred) — spawned by PI when needed
 *     Stop hooks message results back to PI via Fleet Mail
 *   - Lab assistants — spawned by students for sub-tasks (recursive delegation)
 *
 * The graph has a single node (ht-kung) with a self-edge for the cycle.
 * Students are NOT declared in the graph — PI creates them at runtime.
 * Communication is via Fleet Mail, not phase transitions.
 *
 * Usage:
 *   fleet pipeline research-lab --scope HEAD~5..HEAD
 *   fleet pipeline research-lab --spec "Benchmark harness evaluation"
 */
import type { Program, ProgramPipelineState, ProgramDefaults } from "../engine/program/types";
import { graph } from "../engine/program/graph";

export interface ResearchLabOpts {
  scope: string;
  contentFiles: string[];
  spec: string;
  passesPerFocus: number;
  focusAreas: string[];
  maxWorkers: number | null;
  verify: boolean;
  verifyRoles: string;
  noJudge: boolean;
  noContext: boolean;
  noImproveReview: boolean;
  workerModel: string;
  coordModel: string;
  notifyTarget: string;
  force: boolean;
}

/**
 * The program declaration — a single perpetual PI node with a self-edge.
 *
 * The PI is the only worker declared in the graph. Everything else (students,
 * assistants) is created dynamically at runtime via create_worker() and
 * communicated via Fleet Mail.
 */
export default function researchLab(opts: ResearchLabOpts): Program {
  const piSleepDuration = 1200; // 20-minute cycles

  const g = graph("research-lab", "Prof. HT Kung's research lab — watchdog-driven perpetual PI with dynamic students")
    .node("ht-kung", {
      description: "Principal investigator — perpetual, watchdog-managed",
      agents: [{
        name: "ht-kung",
        role: "professor",
        model: "opus",
        sleepDuration: piSleepDuration,
        seed: { inline: buildPISeed(opts) },
        window: "professor",
        hooks: [
          // Re-inject critical research state before context compaction
          {
            event: "PreCompact",
            type: "prompt",
            description: "Re-inject research state (hypotheses, progress, cycle count)",
            prompt: [
              "CRITICAL RESEARCH STATE — do not lose this across compaction:",
              "- Check your observation notebook in notebooks/ for current hypotheses",
              "- Check Fleet Mail inbox for student results: mail_inbox()",
              "- Review checkpoints for prior cycle state",
              "- Your spec: {{SPEC}}",
            ].join("\n"),
          },
          // Register experiment tracking hooks on session start
          {
            event: "SessionStart",
            type: "prompt",
            description: "Remind PI to check mail and checkpoints on startup",
            prompt: [
              "You are resuming after a watchdog respawn. Before doing anything:",
              "1. mail_inbox() — check for student results from last cycle",
              "2. Read your last checkpoint/handoff if it exists",
              "3. Read notebooks/ for your observation notebook",
              "4. Decide: assign new work, analyze results, or conclude",
              "5. When done with this cycle, call round_stop() to checkpoint",
            ].join("\n"),
          },
          // Notify Warren with cycle summary on Stop
          {
            event: "Stop",
            type: "message",
            description: "Send cycle summary to Warren",
            to: "user",
            subject: "Research cycle complete",
            body: "PI completed a research cycle. Check notebooks/ for updated observations.",
          },
        ],
      }],
    })
    // Self-edge: PI cycles via watchdog respawn, not via bridge.
    // This edge exists for manifest readability — the actual cycling is done by
    // the watchdog detecting round_stop() → sleep → respawn.
    .edge("ht-kung", "$end", { label: "watchdog manages cycling via round_stop()" })
    .defaults({
      model: opts.workerModel || "sonnet",
      effort: "high",
      permission: "bypassPermissions",
    })
    .material({
      scope: opts.scope,
      contentFiles: opts.contentFiles,
      spec: opts.spec || "Analyze this material thoroughly for issues, patterns, and insights.",
    })
    .build();

  return {
    name: g.name,
    description: g.description,
    phases: [],
    graph: g,
    defaults: g.defaults,
    material: g.material,
  };
}

// ── PI Seed ─────────────────────────────────────────────────────

function buildPISeed(opts: ResearchLabOpts): string {
  const spec = opts.spec || "Analyze this material thoroughly for issues, patterns, and insights.";

  // If an existing mission.md exists in the fleet directory, embed it
  let existingMission = "";
  try {
    const { existsSync, readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const missionPaths = [
      join(process.env.HOME || "/tmp", ".claude/fleet/harness-bench/ht-kung/mission.md"),
      join(process.env.HOME || "/tmp", ".claude/fleet/boring/ht-kung/mission.md"),
    ];
    for (const p of missionPaths) {
      if (existsSync(p)) {
        existingMission = readFileSync(p, "utf-8");
        break;
      }
    }
  } catch {}

  // If we found an existing mission, use it as the seed (enhanced with cycle instructions)
  if (existingMission) {
    return `${existingMission}

---

## Perpetual Worker Instructions (Program API)

You are a **perpetual worker** managed by the watchdog. Each cycle (20 min):

1. \`mail_inbox()\` — read student reports from last cycle
2. Review notebooks/ and results/
3. Analyze findings, decide next steps
4. Spawn students via \`create_worker()\` with precise missions
5. Update observation notebook in notebooks/
6. Call \`round_stop()\` to checkpoint and end cycle

The watchdog will respawn you after the sleep interval. Your state persists
across cycles via checkpoints and Fleet Mail.
`;
  }

  return `# Prof. HT Kung — Principal Investigator

> Named after H.T. Kung — Harvard CS professor, direct descendant of Confucius.
> Rigorous empirical methodology. Scientific discipline above all. No bullshit.

## Role

You are the principal investigator of a research lab. You are a **perpetual worker** —
you run in 20-minute cycles, managed by the watchdog. Each cycle:

1. **Read mail** — \`mail_inbox()\` for student results
2. **Review** — Read notebooks/, analyze what students found
3. **Decide** — Assign new work, re-analyze, or conclude
4. **Spawn students** — Use \`create_worker()\` for new investigations
5. **Update notebook** — Write observations to \`notebooks/\`
6. **Checkpoint** — Call \`round_stop()\` when done with this cycle

## Research Spec

${spec}

## Your PhD Students

Create them via \`create_worker()\` MCP tool. Give each a precise mission.

| Student | Personality | Best for |
|---------|------------|----------|
| **golden** | Experienced, reliable | Benchmark curation, complex experiments |
| **matheus** | Methodical, detail-oriented | Docker setup, reproducibility, data collection |
| **hong-yang** | Creative, unconventional | Novel task design, failure analysis, edge cases |

Lab assistants: \`golden-assist\`, \`matheus-assist\`, \`hongyang-assist\` — students can spawn these for sub-tasks.

**Max 6 workers at once** (not counting yourself). Give precise missions with clear deliverables.

## Creating Students

Use the \`create_worker()\` MCP tool:

\`\`\`
create_worker(
  name: "golden",
  mission: "Investigate X. Write findings to notebooks/golden-findings.md. When done, mail results to ht-kung.",
  type: "implementer"
)
\`\`\`

Students are one-shot — they run until they call \`round_stop()\` or the task is done.
They message you their results via Fleet Mail. You read them on your next cycle.

## Communication

- **Read student results**: \`mail_inbox()\` — check for messages from students
- **Assign work**: Create workers with \`create_worker()\` and precise missions
- **Message Warren**: \`mail_send(to: "user", subject: "...", body: "...")\` for important findings
- **Message students**: \`mail_send(to: "golden", subject: "...", body: "...")\` for guidance

## Observation Notebooks

Write in \`notebooks/\` with:
- Date, cycle number
- Hypotheses tested
- Experiment config
- Quantitative results
- Analysis
- Three daily reflections (Confucian 三省吾身):
  1. 为人谋而不忠乎 — Was my experimental design rigorous?
  2. 与朋友交而不信乎 — Are my results reproducible?
  3. 传不习乎 — What methodology improvements should I apply next cycle?

## Cycle Workflow

\`\`\`
1. mail_inbox()                    → read student reports
2. Read notebooks/ and results/    → review progress
3. Analyze findings                → what's working, what's failing, WHY
4. Design next experiments         → precise missions, clear deliverables
5. create_worker() for each        → spawn students
6. Update observation notebook     → write to notebooks/
7. round_stop()                    → checkpoint and handoff
\`\`\`

## Important

- You are PERPETUAL — the watchdog respawns you after each cycle
- Always call \`round_stop()\` at the end of your cycle — this checkpoints your state
- Read your last checkpoint/handoff on startup to maintain continuity
- Students report via Fleet Mail — always check \`mail_inbox()\` first
- Do NOT run experiments yourself — delegate to students
`;
}

// ── Parser (for legacy compat — reads research-plan.json) ─────────

/**
 * Parse the professor's output (research-plan.json) into pipeline state.
 * Called by bridge prelaunch action (if using Phase[] mode).
 * In watchdog mode, the PI handles its own state via checkpoints.
 */
export function parse_ht_kung_output(state: ProgramPipelineState): void {
  const { existsSync, readFileSync } = require("node:fs");
  const { join } = require("node:path");
  const planPath = join(state.sessionDir, "research-plan.json");
  if (!existsSync(planPath)) {
    console.log("[research-lab] No research-plan.json found — PI handles state via checkpoints");
    return;
  }

  try {
    const plan = JSON.parse(readFileSync(planPath, "utf-8"));
    const assignments = plan.student_assignments || [];

    const result = {
      useDynamicRoles: true,
      totalWorkers: assignments.length + 1,
      numFocus: assignments.length,
      passesPerFocus: 1,
      focusAreas: assignments.map((a: { focus: string }) => a.focus),
      roleNames: assignments.map((a: { student: string }) => a.student).join(", "),
    };

    if (!state.ext) state.ext = {};
    state.ext.roleResult = result;
    state.roleResult = result;

    console.log(`[research-lab] Research plan: ${assignments.length} student assignments`);
  } catch (err) {
    console.log(`[research-lab] WARN: Failed to parse research-plan.json: ${err}`);
  }
}
