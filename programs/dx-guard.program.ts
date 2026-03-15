/**
 * DX Guard Program — lightweight pre-push developer experience check.
 *
 * Single phase, 1 agent (Sonnet). Analyzes the diff for DX impact
 * against REVIEW.md (28+ rules), README-CONVENTIONS.md (100 rules),
 * and hook-orchestration.md patterns.
 *
 * Non-blocking — produces advisory feedback, never blocks the push.
 * Designed to complete in 1-3 minutes.
 *
 * Usage:
 *   fleet pipeline dx-guard --scope HEAD
 *   fleet pipeline dx-guard --scope HEAD~3..HEAD
 *   fleet pipeline dx-guard --dry-run
 */
import type { Program } from "../engine/program/types";

export interface DxGuardOpts {
  scope: string;
  projectRoot?: string;
  spec?: string;
  force?: boolean;
}

export default function dxGuard(opts: DxGuardOpts): Program {
  return {
    name: "dx-guard",
    description: "Pre-push DX quality guard: conventions + review rules",
    phases: [
      {
        name: "guard",
        description: "Analyze diff for DX impact against conventions and review rules",
        agents: [{
          name: "dx-guard",
          role: "analyst",
          model: "sonnet",
          seed: { template: "dx-guard/guard-seed.md" },
          window: "guard",
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
