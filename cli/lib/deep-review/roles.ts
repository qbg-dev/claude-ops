/**
 * V2 dynamic role designer — spawns Sonnet to design optimal team composition.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeepReviewConfig, MaterialResult, SessionContext, RoleDesignerResult } from "./types";

/** Design roles using Sonnet (v2 only). Falls back to v1 static focus on failure. */
export function designRoles(
  config: DeepReviewConfig,
  material: MaterialResult,
  ctx: SessionContext,
): RoleDesignerResult {
  const rolesFile = join(ctx.sessionDir, "roles.json");
  const maxW = config.maxWorkers ?? config.passesPerFocus * 8;

  console.log("");
  console.log("Phase 0: Designing review team (Sonnet)...");

  // Generate role designer seed from template
  const templatePath = join(ctx.templateDir, "role-designer-seed.md");
  if (!existsSync(templatePath)) {
    console.log("  WARN: role-designer-seed.md not found, falling back to v1");
    return fallbackResult(config);
  }

  let template = readFileSync(templatePath, "utf-8");
  const replacements: Record<string, string> = {
    "{{MATERIAL_FILE}}": material.materialFile,
    "{{MATERIAL_TYPE}}": material.materialType,
    "{{MATERIAL_LINES}}": String(material.diffLines),
    "{{MAX_WORKERS}}": String(maxW),
    "{{ROLES_FILE}}": rolesFile,
    "{{REVIEW_CONFIG}}": ctx.reviewConfig,
    "{{REVIEW_SPEC}}": config.spec || "Review this material thoroughly.",
  };
  for (const [k, v] of Object.entries(replacements)) {
    template = template.split(k).join(v);
  }

  const seedPath = join(ctx.sessionDir, "role-designer-seed.md");
  writeFileSync(seedPath, template);

  // Run Opus non-interactively (180s timeout)
  const result = Bun.spawnSync(
    ["claude", "-p", "--model", "opus", "--dangerously-skip-permissions", readFileSync(seedPath, "utf-8")],
    { cwd: ctx.projectRoot, stderr: "pipe", stdout: "pipe", timeout: 180_000 },
  );

  if (result.exitCode !== 0 || !existsSync(rolesFile)) {
    console.log("  WARN: Role designer failed (timeout or error), falling back to v1");
    return fallbackResult(config);
  }

  // Validate JSON
  let roles: any;
  try {
    roles = JSON.parse(readFileSync(rolesFile, "utf-8"));
    if (!roles.roles || !Array.isArray(roles.roles)) throw new Error("missing roles array");
  } catch {
    console.log("  WARN: Role designer produced invalid roles.json, falling back to v1");
    return fallbackResult(config);
  }

  const roleCount = roles.roles.length;
  const totalFromRoles = roles.total_workers || 0;
  console.log(`  Roles designed: ${totalFromRoles} workers across ${roleCount} roles`);
  console.log(`  Rationale: ${(roles.rationale || "").slice(0, 100)}`);

  // Parse roles into focus areas with per-role attack vectors
  const focusAreas: string[] = [];
  const roleNameParts: string[] = [];

  for (let i = 0; i < roleCount; i++) {
    const role = roles.roles[i];
    const roleId = role.id;
    const rolePasses = role.passes || 1;
    const roleAv = role.attack_vectors || "";

    // Store custom attack vectors
    writeFileSync(join(ctx.sessionDir, `av-${roleId}.txt`), roleAv);
    roleNameParts.push(`${roleId}(×${rolePasses})`);

    for (let j = 0; j < rolePasses; j++) {
      focusAreas.push(roleId);
    }
  }

  // Compute max passes per focus (used for coordinator context)
  let maxPassesPerFocus = 1;
  for (let i = 0; i < roleCount; i++) {
    const rp = roles.roles[i].passes || 1;
    if (rp > maxPassesPerFocus) maxPassesPerFocus = rp;
  }

  const roleNames = roleNameParts.join(", ");
  console.log(`  Roles: ${roleNames}`);
  console.log(`  Max passes/focus: ${maxPassesPerFocus} | Total workers: ${focusAreas.length}`);
  console.log("");

  return {
    useDynamicRoles: true,
    focusAreas,
    numFocus: roleCount,
    totalWorkers: focusAreas.length,
    passesPerFocus: maxPassesPerFocus,
    roleNames,
  };
}

function fallbackResult(config: DeepReviewConfig): RoleDesignerResult {
  console.log("");
  return {
    useDynamicRoles: false,
    focusAreas: config.focusAreas,
    numFocus: config.focusAreas.length,
    totalWorkers: config.passesPerFocus * config.focusAreas.length,
    passesPerFocus: config.passesPerFocus,
    roleNames: "",
  };
}
