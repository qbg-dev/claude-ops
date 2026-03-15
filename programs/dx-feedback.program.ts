/**
 * DX Feedback Program — lightweight pre-push developer experience check.
 *
 * Single phase, 1 agent (Sonnet). Analyzes the diff for DX impact
 * against REVIEW.md (28+ rules), README-CONVENTIONS.md (100 rules),
 * and hook-orchestration.md patterns.
 *
 * Non-blocking — produces advisory feedback, never blocks the push.
 * Designed to complete in 1-3 minutes.
 *
 * Usage:
 *   fleet pipeline dx-feedback --scope HEAD
 *   fleet pipeline dx-feedback --scope HEAD~3..HEAD
 *   fleet pipeline dx-feedback --dry-run
 */
import type { Program } from "../engine/program/types";

export interface DxFeedbackOpts {
  scope: string;
  projectRoot?: string;
  spec?: string;
  force?: boolean;
}

export default function dxFeedback(opts: DxFeedbackOpts): Program {
  return {
    name: "dx-feedback",
    description: "Pre-push DX feedback: conventions + review rules",
    phases: [
      {
        name: "analyze",
        description: "Analyze diff for DX impact against conventions and review rules",
        agents: [{
          name: "dx-analyst",
          role: "analyst",
          model: "sonnet",
          seed: { template: "dx-feedback/analyst-seed.md" },
          window: "analyze",
        }],
      },
    ],
    defaults: {
      model: "sonnet",
      effort: "high",
      permission: "bypassPermissions",
    },
    material: {
      scope: opts.scope || "HEAD",
      spec: opts.spec || "Analyze this diff for developer experience impact.",
    },
  };
}
