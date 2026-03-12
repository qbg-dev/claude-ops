/**
 * Research Lab Program — Prof. HT Kung + PhD Students
 *
 * A 2-phase research analysis pipeline:
 *   Phase 0: Professor HT Kung (Opus) analyzes material, designs research questions
 *   Phase 1: PhD students (Golden, Matheus, HongYang) investigate independently,
 *            then HT Kung synthesizes findings into a unified report
 *
 * HT Kung is a Harvard CS professor, direct descendant of Confucius, known for
 * rigorous empirical results and genuine insight without bullshit.
 *
 * Usage:
 *   fleet pipeline research-lab --scope HEAD~5..HEAD
 *   fleet pipeline research-lab --content src/server.ts --spec "Performance analysis"
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Program, AgentSpec, ProgramPipelineState, ProgramDefaults } from "../engine/program/types";

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
 * The program declaration.
 */
export default function researchLab(opts: ResearchLabOpts): Program {
  return {
    name: "research-lab",
    description: "Prof. HT Kung's research lab — rigorous analysis with PhD students",
    phases: [
      // ── Phase 0: Professor Planning ────────────────────────────
      {
        name: "professor",
        description: "Prof. HT Kung analyzes material and assigns research questions",
        agents: [{
          name: "ht-kung",
          role: "professor",
          model: "opus",
          seed: { template: "research-lab/professor-seed.md" },
          window: "professor",
        }],
      },

      // ── Phase 1: PhD Students + Synthesis ──────────────────────
      {
        name: "research",
        description: "PhD students investigate, then professor synthesizes",
        agents: {
          generator: "generateResearchTeam",
          estimate: 4, // 3 students + 1 coordinator
          fallback: defaultTeam(),
        },
        gate: "ht-kung-coordinator",
        prelaunch: [
          { type: "parse-output", agent: "ht-kung", file: "research-plan.json" },
        ],
      },
    ],
    defaults: {
      model: opts.workerModel || "sonnet",
      permission: "bypassPermissions",
    },
    material: {
      scope: opts.scope,
      contentFiles: opts.contentFiles,
      spec: opts.spec || "Analyze this material thoroughly for issues, patterns, and insights.",
    },
  };
}

// ── Dynamic Generator (called at bridge time) ────────────────────

/**
 * Generate the research team from the professor's research plan.
 * Called by bridge.ts when Phase 1 launches.
 */
export function generateResearchTeam(
  state: ProgramPipelineState,
  _defaults: ProgramDefaults,
): AgentSpec[] {
  const agents: AgentSpec[] = [];

  // Try to read the professor's research plan
  let assignments: Array<{
    student: string;
    focus: string;
    approach: string;
    key_files_or_sections: string[];
  }> = [];

  const planPath = join(state.sessionDir, "research-plan.json");
  if (existsSync(planPath)) {
    try {
      const plan = JSON.parse(readFileSync(planPath, "utf-8"));
      assignments = plan.student_assignments || [];
    } catch (err) {
      console.log(`[research-lab] WARN: Failed to parse research-plan.json: ${err}`);
    }
  }

  // Fall back to default assignments if plan not available
  if (assignments.length === 0) {
    assignments = [
      {
        student: "golden",
        focus: "Architectural analysis — system structure, coupling, abstraction quality",
        approach: "Examine module boundaries, dependency patterns, and layering",
        key_files_or_sections: ["all"],
      },
      {
        student: "matheus",
        focus: "Detail analysis — edge cases, error handling, subtle bugs",
        approach: "Line-by-line examination of critical paths and error handling",
        key_files_or_sections: ["all"],
      },
      {
        student: "hong-yang",
        focus: "Creative analysis — alternative approaches, non-obvious implications",
        approach: "Consider what's missing, what could be done differently, future risks",
        key_files_or_sections: ["all"],
      },
    ];
  }

  const today = new Date().toISOString().split("T")[0];

  // Create student agents
  for (const assignment of assignments) {
    const studentName = assignment.student.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const notebookFile = `notebook-${studentName}.md`;

    agents.push({
      name: studentName,
      role: "student",
      seed: { template: "research-lab/student-seed.md" },
      window: "students",
      vars: {
        STUDENT_NAME: assignment.student,
        FOCUS: assignment.focus,
        APPROACH: assignment.approach,
        KEY_AREAS: assignment.key_files_or_sections.join(", "),
        NOTEBOOK_FILE: notebookFile,
        DATE: today,
      },
    });
  }

  // Add coordinator (Prof. Kung synthesizing)
  agents.push({
    name: "ht-kung-coordinator",
    role: "coordinator",
    model: "opus",
    seed: { template: "research-lab/coordinator-seed.md" },
    window: "professor",
  });

  return agents;
}

/**
 * Parse the professor's output (research-plan.json) into pipeline state.
 * Called by bridge prelaunch action.
 */
export function parse_ht_kung_output(state: ProgramPipelineState): void {
  const planPath = join(state.sessionDir, "research-plan.json");
  if (!existsSync(planPath)) {
    console.log("[research-lab] No research-plan.json found — using default assignments");
    return;
  }

  try {
    const plan = JSON.parse(readFileSync(planPath, "utf-8"));
    const assignments = plan.student_assignments || [];

    state.roleResult = {
      useDynamicRoles: true,
      totalWorkers: assignments.length + 1, // students + coordinator
      numFocus: assignments.length,
      passesPerFocus: 1,
      focusAreas: assignments.map((a: { focus: string }) => a.focus),
      roleNames: assignments.map((a: { student: string }) => a.student).join(", "),
    };

    console.log(`[research-lab] Research plan: ${assignments.length} student assignments`);
    for (const a of assignments) {
      console.log(`  ${a.student}: ${a.focus}`);
    }
  } catch (err) {
    console.log(`[research-lab] WARN: Failed to parse research-plan.json: ${err}`);
  }
}

// ── Fallback Team ────────────────────────────────────────────────

function defaultTeam(): AgentSpec[] {
  const today = new Date().toISOString().split("T")[0];

  return [
    {
      name: "golden",
      role: "student",
      seed: { template: "research-lab/student-seed.md" },
      window: "students",
      vars: {
        STUDENT_NAME: "Golden",
        FOCUS: "Architectural analysis — system structure, coupling, abstraction quality",
        APPROACH: "Examine module boundaries, dependency patterns, and layering",
        KEY_AREAS: "all",
        NOTEBOOK_FILE: "notebook-golden.md",
        DATE: today,
      },
    },
    {
      name: "matheus",
      role: "student",
      seed: { template: "research-lab/student-seed.md" },
      window: "students",
      vars: {
        STUDENT_NAME: "Matheus",
        FOCUS: "Detail analysis — edge cases, error handling, subtle bugs",
        APPROACH: "Line-by-line examination of critical paths and error handling",
        KEY_AREAS: "all",
        NOTEBOOK_FILE: "notebook-matheus.md",
        DATE: today,
      },
    },
    {
      name: "hong-yang",
      role: "student",
      seed: { template: "research-lab/student-seed.md" },
      window: "students",
      vars: {
        STUDENT_NAME: "HongYang",
        FOCUS: "Creative analysis — alternative approaches, non-obvious implications",
        APPROACH: "Consider what's missing, what could be done differently, future risks",
        KEY_AREAS: "all",
        NOTEBOOK_FILE: "notebook-hong-yang.md",
        DATE: today,
      },
    },
    {
      name: "ht-kung-coordinator",
      role: "coordinator",
      model: "opus",
      seed: { template: "research-lab/coordinator-seed.md" },
      window: "professor",
    },
  ];
}
