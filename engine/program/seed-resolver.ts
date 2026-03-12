/**
 * Seed resolver — loads templates, substitutes variables, handles inline/generator seeds.
 *
 * Supports three seed spec forms:
 *   { template: "deep-review/worker-seed.md", vars: { ... } }
 *   { inline: "You are a reviewer..." }
 *   { generator: "generateWorkerSeed" }  — called at bridge time
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSpec, ProgramPipelineState } from "./types";

const HOME = process.env.HOME || "/tmp";
const FLEET_DIR = process.env.CLAUDE_FLEET_DIR || join(HOME, ".claude-fleet");

/** Replace all occurrences of a literal string */
function replaceAll(str: string, search: string, replacement: string): string {
  return str.split(search).join(replacement);
}

/** Substitute all {{PLACEHOLDER}} occurrences in template content */
export function substitute(content: string, vars: Record<string, string>): string {
  let result = content;
  for (const [k, v] of Object.entries(vars)) {
    // Support both raw key and {{KEY}} form
    const key = k.startsWith("{{") ? k : `{{${k}}}`;
    result = replaceAll(result, key, v);
  }
  return result;
}

/**
 * Resolve a template path relative to the templates directory.
 * Searches: templateDir (from state) > FLEET_DIR/templates > fallback
 */
function resolveTemplatePath(templateRef: string, templateDir?: string): string | null {
  const candidates = [
    templateDir ? join(templateDir, templateRef) : null,
    join(FLEET_DIR, "templates", templateRef),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve a single agent's seed to a string.
 * For { template }, loads + substitutes.
 * For { inline }, returns as-is.
 * For { generator }, returns null (must be resolved at bridge time).
 */
export function resolveSeed(
  agent: AgentSpec,
  state: ProgramPipelineState,
  extraVars?: Record<string, string>,
): string | null {
  const seed = agent.seed;

  if ("inline" in seed) {
    let content = seed.inline;
    const allVars = { ...(agent.vars || {}), ...(extraVars || {}) };
    if (Object.keys(allVars).length > 0) {
      content = substitute(content, allVars);
    }
    return content;
  }

  if ("template" in seed) {
    const templatePath = resolveTemplatePath(seed.template, state.templateDir);
    if (!templatePath) {
      console.log(`  WARN: Template not found: ${seed.template}`);
      return null;
    }

    let content = readFileSync(templatePath, "utf-8");
    // Merge vars: seed.vars < agent.vars < extraVars
    const allVars = { ...(seed.vars || {}), ...(agent.vars || {}), ...(extraVars || {}) };
    if (Object.keys(allVars).length > 0) {
      content = substitute(content, allVars);
    }
    return content;
  }

  if ("generator" in seed) {
    // Generator seeds are resolved at bridge time, not eagerly
    return null;
  }

  return null;
}

/**
 * Resolve and write seed file for an agent.
 * Returns the path to the written seed file.
 */
export function resolveSeedToFile(
  agent: AgentSpec,
  state: ProgramPipelineState,
  sessionDir: string,
  extraVars?: Record<string, string>,
): string {
  const content = resolveSeed(agent, state, extraVars);
  const seedPath = join(sessionDir, `${agent.name}-seed.md`);

  if (content) {
    writeFileSync(seedPath, content);
  } else {
    // Placeholder for generator seeds
    writeFileSync(seedPath, `# ${agent.name}\nSeed pending — will be generated at bridge time.`);
  }

  return seedPath;
}

/**
 * Build standard variable map from pipeline state.
 * These are available to all templates automatically.
 */
export function buildStateVars(state: ProgramPipelineState): Record<string, string> {
  const vars: Record<string, string> = {
    SESSION_DIR: state.sessionDir,
    PROJECT_ROOT: state.workDir,
    WORK_DIR: state.workDir,
    TEMPLATE_DIR: state.templateDir,
    VALIDATOR: state.validatorPath,
    SESSION_HASH: state.sessionHash,
    TMUX_SESSION: state.tmuxSession,
  };

  if (state.material) {
    vars.MATERIAL_FILE = state.material.materialFile;
    vars.MATERIAL_TYPE = state.material.materialType;
    vars.MATERIAL_LINES = String(state.material.diffLines);
    vars.DIFF_DESC = state.material.diffDesc;
    vars.MATERIAL_TYPES = state.material.materialTypesStr;
  }

  if (state.spec) {
    vars.REVIEW_SPEC = state.spec;
  }

  if (state.reviewConfig) {
    vars.REVIEW_CONFIG = state.reviewConfig;
  }

  if (state.coordinatorName) {
    vars.COORDINATOR_NAME = state.coordinatorName;
  }

  if (state.roleResult) {
    vars.NUM_PASSES = String(state.roleResult.totalWorkers);
    vars.NUM_FOCUS = String(state.roleResult.numFocus);
    vars.PASSES_PER_FOCUS = String(state.roleResult.passesPerFocus);
    vars.FOCUS_LIST = state.roleResult.focusAreas
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(",");
    if (state.roleResult.roleNames) {
      vars.ROLE_NAMES = state.roleResult.roleNames;
    }
  }

  return vars;
}
