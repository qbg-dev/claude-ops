/**
 * Seed resolver — loads templates, substitutes variables, handles inline/generator seeds.
 *
 * Supports three seed spec forms:
 *   { template: "deep-review/worker-seed.md", vars: { ... } }
 *   { inline: "You are a reviewer..." }
 *   { generator: "generateWorkerSeed" }  — called at bridge time
 *
 * Uses Handlebars for template compilation:
 *   - {{VAR}} substitution (drop-in replacement for old split/join)
 *   - {{> partial}} for shared fragments in templates/fragments/
 *   - {{#if}}, {{#each}} for conditional/loop blocks
 *   - noEscape: true (markdown, not HTML)
 *   - helperMissing preserves literal {{UNRESOLVED}} for vars resolved later at bridge time
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Handlebars from "handlebars";
import type { AgentSpec, ProgramPipelineState } from "./types";

const HOME = process.env.HOME || "/tmp";
const FLEET_DIR = process.env.CLAUDE_FLEET_DIR || join(HOME, ".claude-fleet");

// ── Handlebars setup ──────────────────────────────────────────

/** Preserve {{UNRESOLVED}} literally — phased compilation means some vars resolve at bridge time */
Handlebars.registerHelper("helperMissing", function (this: unknown, ...args: unknown[]) {
  const opts = args[args.length - 1] as { name: string };
  return new Handlebars.SafeString(`{{${opts.name}}}`);
});

let _partialsRegistered = false;

/** Auto-register all templates/fragments/*.md as Handlebars partials */
export function registerPartials(templateDir?: string): void {
  const dirs = [
    templateDir ? join(templateDir, "fragments") : null,
    join(FLEET_DIR, "templates", "fragments"),
  ].filter(Boolean) as string[];

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter(f => f.endsWith(".md"))) {
      const name = file.replace(".md", "");
      // Don't overwrite if already registered from a higher-priority dir
      if (!(Handlebars.partials as Record<string, unknown>)[name]) {
        Handlebars.registerPartial(name, readFileSync(join(dir, file), "utf-8"));
      }
    }
  }
  _partialsRegistered = true;
}

/** Substitute all {{PLACEHOLDER}} occurrences in template content using Handlebars */
export function substitute(content: string, vars: Record<string, string>): string {
  const template = Handlebars.compile(content, { noEscape: true, strict: false });
  return template(vars);
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
    // Ensure partials are registered before first template resolution
    if (!_partialsRegistered) registerPartials(state.templateDir);

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

  // Auto-bind all opts as template variables (e.g. opts.scope → {{SCOPE}})
  if (state.opts) {
    for (const [k, v] of Object.entries(state.opts)) {
      if (typeof v === "string") vars[k.toUpperCase()] = v;
      else if (v !== null && v !== undefined) vars[k.toUpperCase()] = String(v);
    }
  }

  if (state.material) {
    vars.MATERIAL_FILE = state.material.materialFile;
    vars.MATERIAL_TYPE = state.material.materialType;
    vars.MATERIAL_LINES = String(state.material.diffLines);
    vars.DIFF_DESC = state.material.diffDesc;
    vars.MATERIAL_TYPES = state.material.materialTypesStr;
  }

  // Check ext first, fall back to deprecated top-level fields
  const spec = (state.ext?.spec as string) || state.spec;
  if (spec) {
    vars.REVIEW_SPEC = spec;
  }

  const reviewConfig = (state.ext?.reviewConfig as string) || state.reviewConfig;
  if (reviewConfig) {
    vars.REVIEW_CONFIG = reviewConfig;
  }

  const coordinatorName = (state.ext?.coordinatorName as string) || state.coordinatorName;
  if (coordinatorName) {
    vars.COORDINATOR_NAME = coordinatorName;
  }

  const roleResult = (state.ext?.roleResult as typeof state.roleResult) || state.roleResult;
  if (roleResult) {
    vars.NUM_PASSES = String(roleResult.totalWorkers);
    vars.NUM_FOCUS = String(roleResult.numFocus);
    vars.PASSES_PER_FOCUS = String(roleResult.passesPerFocus);
    vars.FOCUS_LIST = roleResult.focusAreas
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(",");
    if (roleResult.roleNames) {
      vars.ROLE_NAMES = roleResult.roleNames;
    }
  }

  return vars;
}
