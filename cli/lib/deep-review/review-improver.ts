/**
 * REVIEW.md Improver — Phase 0.5 of deep review pipeline.
 * Runs after role designer, before context pre-pass and worker launch.
 * Split into seed generation (orchestrator) and result parsing (bridge).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeepReviewConfig, MaterialResult, SessionContext, RoleDesignerResult } from "./types";

/**
 * Generate the REVIEW.md improver seed prompt (template-substituted).
 * Returns the seed content string, or null if template not found.
 */
export function generateImproverSeed(
  config: DeepReviewConfig,
  material: MaterialResult,
  ctx: SessionContext,
  roleResult: RoleDesignerResult,
): string | null {
  const templatePath = join(ctx.templateDir, "review-improver-seed.md");
  if (!existsSync(templatePath)) {
    console.log("  WARN: review-improver-seed.md not found, skipping improvement");
    return null;
  }

  const outputFile = join(ctx.sessionDir, "review-md-improved.md");

  // Build role summary for context
  let roleSummary = "";
  if (roleResult.useDynamicRoles) {
    const rolesFile = join(ctx.sessionDir, "roles.json");
    if (existsSync(rolesFile)) {
      try {
        const roles = JSON.parse(readFileSync(rolesFile, "utf-8"));
        for (const role of roles.roles || []) {
          roleSummary += `- **${role.id}** (×${role.passes || 1}): ${role.description || ""}\n`;
          if (role.attack_vectors) {
            roleSummary += `  Attack vectors: ${String(role.attack_vectors).slice(0, 200)}...\n`;
          }
        }
        if (roles.rationale) {
          roleSummary += `\nRationale: ${roles.rationale}\n`;
        }
      } catch {}
    }
  }
  if (!roleSummary) {
    roleSummary = `Focus areas: ${roleResult.focusAreas.join(", ")}\nTotal workers: ${roleResult.totalWorkers}`;
  }

  let template = readFileSync(templatePath, "utf-8");
  const replacements: Record<string, string> = {
    "{{MATERIAL_FILE}}": material.materialFile,
    "{{MATERIAL_TYPE}}": material.materialType,
    "{{MATERIAL_LINES}}": String(material.diffLines),
    "{{ROLE_SUMMARY}}": roleSummary,
    "{{REVIEW_CONFIG}}": ctx.reviewConfig || "(No REVIEW.md found — create one from scratch based on the material)",
    "{{REVIEW_SPEC}}": config.spec || "Review this material thoroughly.",
    "{{OUTPUT_FILE}}": outputFile,
  };

  for (const [k, v] of Object.entries(replacements)) {
    template = template.split(k).join(v);
  }

  const seedPath = join(ctx.sessionDir, "review-improver-seed.md");
  writeFileSync(seedPath, template);
  return template;
}

/**
 * Parse the improved REVIEW.md output.
 * Returns the improved content, or the original on failure.
 */
export function parseImproverResult(
  ctx: SessionContext,
): string {
  const outputFile = join(ctx.sessionDir, "review-md-improved.md");

  if (!existsSync(outputFile)) {
    console.log("  WARN: REVIEW.md improver did not produce output, using original");
    return ctx.reviewConfig;
  }

  const improved = readFileSync(outputFile, "utf-8").trim();
  if (!improved || improved.length < 50) {
    console.log("  WARN: REVIEW.md improver produced empty/short output, using original");
    return ctx.reviewConfig;
  }

  // Save original for comparison
  if (ctx.reviewConfig) {
    writeFileSync(join(ctx.sessionDir, "review-md-original.md"), ctx.reviewConfig);
  }

  const originalLines = (ctx.reviewConfig || "").split("\n").length;
  const improvedLines = improved.split("\n").length;
  const delta = improvedLines - originalLines;
  const deltaStr = delta > 0 ? `+${delta}` : String(delta);

  console.log(`  REVIEW.md improved: ${originalLines} → ${improvedLines} lines (${deltaStr})`);

  return improved;
}
