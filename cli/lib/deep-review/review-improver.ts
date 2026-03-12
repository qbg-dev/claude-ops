/**
 * REVIEW.md Improver — Phase 0.5 of deep review pipeline.
 * Runs after role designer, before context pre-pass and worker launch.
 * Generates an improved REVIEW.md tuned for the specific material being reviewed.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeepReviewConfig, MaterialResult, SessionContext, RoleDesignerResult } from "./types";

/**
 * Improve REVIEW.md before review workers launch.
 * Uses Sonnet to analyze material + roles and produce better review rules.
 * Returns updated reviewConfig content (or original on failure).
 */
export function improveReviewMd(
  config: DeepReviewConfig,
  material: MaterialResult,
  ctx: SessionContext,
  roleResult: RoleDesignerResult,
): string {
  const templatePath = join(ctx.templateDir, "review-improver-seed.md");
  if (!existsSync(templatePath)) {
    console.log("  WARN: review-improver-seed.md not found, skipping improvement");
    return ctx.reviewConfig;
  }

  console.log("Phase 0.5: Improving REVIEW.md for this review...");

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

  // Build seed from template
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

  // Run Opus non-interactively (180s timeout — needs to read material + produce full REVIEW.md)
  const result = Bun.spawnSync(
    ["claude", "-p", "--model", "opus", "--dangerously-skip-permissions", readFileSync(seedPath, "utf-8")],
    { cwd: ctx.projectRoot, stderr: "pipe", stdout: "pipe", timeout: 180_000 },
  );

  if (result.exitCode !== 0 || !existsSync(outputFile)) {
    const stderr = result.stderr?.toString().trim() || "";
    console.log(`  WARN: REVIEW.md improver failed (${stderr || "timeout"}), using original`);
    return ctx.reviewConfig;
  }

  const improved = readFileSync(outputFile, "utf-8").trim();
  if (!improved || improved.length < 50) {
    console.log("  WARN: REVIEW.md improver produced empty/short output, using original");
    return ctx.reviewConfig;
  }

  // Save both versions for comparison
  if (ctx.reviewConfig) {
    writeFileSync(join(ctx.sessionDir, "review-md-original.md"), ctx.reviewConfig);
  }

  const originalLines = (ctx.reviewConfig || "").split("\n").length;
  const improvedLines = improved.split("\n").length;
  const delta = improvedLines - originalLines;
  const deltaStr = delta > 0 ? `+${delta}` : String(delta);

  console.log(`  REVIEW.md improved: ${originalLines} → ${improvedLines} lines (${deltaStr})`);
  console.log(`  Saved: ${outputFile}`);

  return improved;
}
