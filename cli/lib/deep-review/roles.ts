/**
 * V2 dynamic role designer — generates seed for Opus to design optimal team composition.
 * Split into seed generation (orchestrator) and result parsing (bridge).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeepReviewConfig, MaterialResult, SessionContext, RoleDesignerResult } from "./types";

/**
 * Generate the role designer seed prompt (template-substituted).
 * Returns the seed content string, or null if template not found.
 */
export function generateRoleDesignerSeed(
  config: DeepReviewConfig,
  material: MaterialResult,
  ctx: SessionContext,
): string | null {
  const rolesFile = join(ctx.sessionDir, "roles.json");
  const maxW = config.maxWorkers ?? config.passesPerFocus * 8;

  const templatePath = join(ctx.templateDir, "role-designer-seed.md");
  if (!existsSync(templatePath)) {
    console.log("  WARN: role-designer-seed.md not found");
    return null;
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
  return template;
}

/**
 * Parse roles.json output from the role designer.
 * Returns RoleDesignerResult, or fallback if roles.json is missing/invalid.
 */
export function parseRolesResult(
  ctx: SessionContext,
  config: DeepReviewConfig,
): RoleDesignerResult {
  const rolesFile = join(ctx.sessionDir, "roles.json");

  if (!existsSync(rolesFile)) {
    console.log("  WARN: roles.json not found, falling back to v1");
    return fallbackResult(config);
  }

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

  const focusAreas: string[] = [];
  const roleNameParts: string[] = [];

  for (let i = 0; i < roleCount; i++) {
    const role = roles.roles[i];
    const roleId = role.id;
    const rolePasses = role.passes || 1;
    const roleAv = role.attack_vectors || "";

    writeFileSync(join(ctx.sessionDir, `av-${roleId}.txt`), roleAv);
    roleNameParts.push(`${roleId}(×${rolePasses})`);

    for (let j = 0; j < rolePasses; j++) {
      focusAreas.push(roleId);
    }
  }

  let maxPassesPerFocus = 1;
  for (let i = 0; i < roleCount; i++) {
    const rp = roles.roles[i].passes || 1;
    if (rp > maxPassesPerFocus) maxPassesPerFocus = rp;
  }

  const roleNames = roleNameParts.join(", ");
  console.log(`  Roles: ${roleNames}`);
  console.log(`  Max passes/focus: ${maxPassesPerFocus} | Total workers: ${focusAreas.length}`);

  return {
    useDynamicRoles: true,
    focusAreas,
    numFocus: roleCount,
    totalWorkers: focusAreas.length,
    passesPerFocus: maxPassesPerFocus,
    roleNames,
  };
}

export function fallbackResult(config: DeepReviewConfig): RoleDesignerResult {
  return {
    useDynamicRoles: false,
    focusAreas: config.focusAreas,
    numFocus: config.focusAreas.length,
    totalWorkers: config.passesPerFocus * config.focusAreas.length,
    passesPerFocus: config.passesPerFocus,
    roleNames: "",
  };
}
