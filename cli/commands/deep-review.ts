/**
 * fleet deep-review — Multi-pass adversarial code review pipeline.
 *
 * V2 (default): Delegates to the program-API pipeline system.
 *   Declarative pipeline in programs/deep-review.program.ts, compiled
 *   into hooks/FIFOs/seeds by engine/program/.
 *
 * V1 (--v1): Legacy synchronous pipeline (static focus areas, no planning phases).
 */
import type { Command } from "commander";
import { existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { addGlobalOpts } from "../index";
import { fail } from "../lib/fmt";
import { resolveProjectRoot } from "../lib/paths";
import { runPipeline } from "./pipeline";
// V1-only imports
import { DEFAULT_DIFF_FOCUS, DEFAULT_CONTENT_FOCUS, DEFAULT_MIXED_FOCUS, DEFAULT_CODEBASE_FOCUS } from "../lib/deep-review/args";
import { collectMaterial, shouldAutoSkip } from "../lib/deep-review/material";
import { runContextPrePass } from "../lib/deep-review/context";
import {
  generateWorkerSeeds,
  generateCoordinatorSeed,
  generateJudgeSeed,
  generateVerifierSeeds,
  generateLaunchWrappers,
} from "../lib/deep-review/templates";
import {
  createTmuxSession,
  launchWorkers,
  launchCoordinator,
  launchVerifiers,
  printSummary,
} from "../lib/deep-review/tmux";
import type { DeepReviewConfig, SessionContext, RoleDesignerResult } from "../lib/deep-review/types";

const HOME = process.env.HOME || "/tmp";

export function register(program: Command): void {
  const cmd = program
    .command("deep-review")
    .alias("dr")
    .description("Launch a multi-pass deep review pipeline")
    .option("--scope <scope>", "Git diff scope (branch, SHA, uncommitted, pr:N, HEAD, codebase)")
    .option("--content <files>", "File path(s) to review, comma-separated")
    .option("--spec <text>", "What to review for (guides all workers)")
    .option("--passes <n>", "Passes per focus area (default: 2)", "2")
    .option("--session-name <name>", "Custom tmux session name")
    .option("--notify <target>", "Notify on completion (worker name or 'user')")
    .option("--focus <list>", "Comma-separated focus areas (overrides auto-detect)")
    .option("--no-judge", "Skip adversarial judge validation")
    .option("--no-context", "Skip context pre-pass (static analysis, deps)")
    .option("--force", "Force review even if auto-skip would trigger")
    .option("--verify", "Enable verification phase after review")
    .option("--verify-roles <list>", "Comma-separated user roles to test as")
    .option("--v1", "Use v1 mode (static focus areas, no role designer, no worktree)")
    .option("--max-workers <n>", "Max worker budget for role designer")
    .option("--no-worktree", "Skip worktree isolation")
    .option("--no-improve-review", "Skip REVIEW.md improvement phase")
    .option("--dry-run", "Print manifest without launching")
    .action(async (opts: Record<string, any>) => {
      try {
        await runDeepReview(opts);
      } catch (e: any) {
        fail(e.message || String(e));
      }
    });

  addGlobalOpts(cmd);
}

async function runDeepReview(opts: Record<string, any>): Promise<void> {
  // V1 mode: legacy synchronous pipeline
  if (opts.v1) {
    return runV1DeepReview(opts);
  }

  // V2 (default): delegate to program-API pipeline system
  const claudeOps = process.env.CLAUDE_FLEET_DIR || join(HOME, ".claude-fleet");
  const drContextBin = join(claudeOps, "bin", "dr-context");
  if (existsSync(drContextBin)) {
    const verify = (Bun.spawnSync as any)(["codesign", "-v", drContextBin], { stderr: "pipe" });
    if (verify.exitCode !== 0) {
      (Bun.spawnSync as any)(["codesign", "-s", "-", drContextBin], { stderr: "pipe" });
    }
  }

  await runPipeline("deep-review", opts);
}

// ══════════════════════════════════════════════════════════════════
// V1 mode: synchronous pipeline (no hooks, no planning phases)
// ══════════════════════════════════════════════════════════════════

async function runV1DeepReview(opts: Record<string, any>): Promise<void> {
  const claudeOps = process.env.CLAUDE_FLEET_DIR || join(HOME, ".claude-fleet");
  const templateDir = join(claudeOps, "templates", "deep-review");
  const projectRoot = process.env.PROJECT_ROOT || resolveProjectRoot();

  // Ensure dr-context binary is signed (macOS)
  const drContextBin = join(claudeOps, "bin", "dr-context");
  if (existsSync(drContextBin)) {
    const verify = (Bun.spawnSync as any)(["codesign", "-v", drContextBin], { stderr: "pipe" });
    if (verify.exitCode !== 0) {
      (Bun.spawnSync as any)(["codesign", "-s", "-", drContextBin], { stderr: "pipe" });
    }
  }

  // Validate environment
  const tmuxCheck = (Bun.spawnSync as any)(["tmux", "info"], { stderr: "pipe", stdout: "pipe" });
  if (tmuxCheck.exitCode !== 0) fail("tmux not running");

  if (!existsSync(join(templateDir, "worker-seed.md")) || !existsSync(join(templateDir, "coordinator-seed.md"))) {
    fail(`Templates not found at ${templateDir}`);
  }

  // Build config
  const config: DeepReviewConfig = {
    scope: opts.scope || "",
    contentFiles: opts.content ? opts.content.split(",").map((s: string) => s.trim()) : [],
    spec: opts.spec || "",
    passesPerFocus: parseInt(opts.passes, 10) || 2,
    focusAreas: [],
    customFocus: opts.focus || "",
    noJudge: opts.judge === false,
    noContext: opts.context === false,
    force: !!opts.force,
    verify: !!opts.verify,
    verifyRoles: opts.verifyRoles || "",
    v1Mode: true,
    maxWorkers: opts.maxWorkers ? parseInt(opts.maxWorkers, 10) : null,
    noWorktree: true,
    noImproveReview: true,
    sessionName: opts.sessionName || "",
    notifyTarget: opts.notify || "",
    workerModel: process.env.DEEP_REVIEW_WORKER_MODEL || "sonnet[1m]",
    coordModel: process.env.DEEP_REVIEW_COORD_MODEL || "sonnet[1m]",
  };

  if (!config.scope && config.contentFiles.length === 0) {
    config.scope = "HEAD";
  }

  const isCodebase = config.scope === "codebase";
  const hasDiff = !!config.scope && !isCodebase;
  const hasContent = config.contentFiles.length > 0;

  // Resolve focus areas
  if (config.customFocus) {
    config.focusAreas = config.customFocus.split(",").map((s) => s.trim());
  } else if (isCodebase) {
    config.focusAreas = [...DEFAULT_CODEBASE_FOCUS];
  } else if (hasDiff && hasContent) {
    config.focusAreas = [...DEFAULT_MIXED_FOCUS];
  } else if (hasContent) {
    config.focusAreas = [...DEFAULT_CONTENT_FOCUS];
  } else {
    config.focusAreas = [...DEFAULT_DIFF_FOCUS];
  }

  const numFocus = config.focusAreas.length;
  const totalWorkers = config.passesPerFocus * numFocus;

  console.log(`Focus areas (${numFocus}): ${config.focusAreas.join(" ")}`);
  console.log(`Passes per focus: ${config.passesPerFocus}`);
  console.log(`Total workers (estimate): ${totalWorkers}`);

  // Detect REVIEW.md
  let reviewConfig = "";
  const searchRoots = [projectRoot];

  const mainWorktreeResult = (Bun.spawnSync as any)(["git", "worktree", "list", "--porcelain"], { cwd: projectRoot, stderr: "pipe" });
  const mainWorktree = mainWorktreeResult.stdout.toString().split("\n")[0]?.replace("worktree ", "").trim();
  if (mainWorktree && mainWorktree !== projectRoot) searchRoots.push(mainWorktree);

  const baseName = basename(projectRoot);
  const baseRepo = baseName.replace(/-w-[^/]*$/, "");
  if (baseRepo !== baseName) {
    const sibling = join(dirname(projectRoot), baseRepo);
    if (existsSync(sibling)) searchRoots.push(sibling);
  }

  for (const root of searchRoots) {
    for (const rmd of [join(root, "REVIEW.md"), join(root, ".claude", "REVIEW.md")]) {
      if (existsSync(rmd)) {
        reviewConfig = readFileSync(rmd, "utf-8");
        console.log(`REVIEW.md: ${rmd}`);
        break;
      }
    }
    if (reviewConfig) break;
  }
  if (!reviewConfig) console.log("REVIEW.md: not found (skipping project-specific rules)");

  // Build session name
  let reviewSession: string;
  if (config.sessionName) {
    reviewSession = config.sessionName;
  } else {
    const worktreeName = basename(projectRoot).replace(/^Wechat-w-/, "").replace(/^Wechat$/, "main");

    if (isCodebase) {
      const codebaseHash = hashStr(projectRoot + Date.now().toString()).slice(0, 8);
      reviewSession = `dr-${worktreeName}-codebase-${codebaseHash}`;
    } else if (hasContent && !hasDiff) {
      const firstFile = config.contentFiles[0];
      const fileBase = basename(firstFile)
        .replace(/\.[^.]*$/, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      const contentHash = hashStr(config.contentFiles.join(",")).slice(0, 8);
      reviewSession = `dr-${worktreeName}-${fileBase}-${contentHash}`;
    } else {
      let resolvedRef = config.scope;
      if (config.scope === "uncommitted") {
        const r = (Bun.spawnSync as any)(["git", "rev-parse", "--short=8", "HEAD"], { cwd: projectRoot, stderr: "pipe" });
        resolvedRef = r.stdout.toString().trim() || "wip";
      } else if (config.scope.startsWith("pr:")) {
        resolvedRef = `pr${config.scope.slice(3)}`;
      } else if (config.scope.includes("..")) {
        resolvedRef = config.scope.split("..").pop() || config.scope;
      }

      const commitMsgResult = (Bun.spawnSync as any)(["git", "log", "-1", "--format=%s", resolvedRef], { cwd: projectRoot, stderr: "pipe" });
      let commitMsg = commitMsgResult.stdout.toString().trim() || "review";
      commitMsg = commitMsg.replace(/^[a-z]*\([^)]*\):\s*/, "").replace(/^[a-z]*:\s*/, "");
      const firstTwo = commitMsg
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .split("-")
        .slice(0, 2)
        .join("-");
      const shortHashResult = (Bun.spawnSync as any)(["git", "rev-parse", "--short=8", resolvedRef], { cwd: projectRoot, stderr: "pipe" });
      const shortHash = shortHashResult.stdout.toString().trim().split("\n")[0] || resolvedRef.replace(/[^a-zA-Z0-9]+/g, "-");
      reviewSession = `dr-${worktreeName}-${firstTwo}-${shortHash}`;
    }
    reviewSession = reviewSession.slice(0, 50);
  }

  // Kill existing session
  const hasSession = (Bun.spawnSync as any)(["tmux", "has-session", "-t", reviewSession], { stderr: "pipe" });
  if (hasSession.exitCode === 0) {
    console.log(`Killing existing session: ${reviewSession}`);
    (Bun.spawnSync as any)(["tmux", "kill-session", "-t", reviewSession]);
  }

  // Create session directory
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const sessionId = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const sessionDir = join(projectRoot, ".claude", "state", "deep-review", `session-${sessionId}`);
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(join(sessionDir, "comms"), { recursive: true });

  const historyFile = join(projectRoot, ".claude", "state", "deep-review", "history.jsonl");
  const validatorPath = join(claudeOps, "scripts", "validate-findings.sh");
  const sessionHash = hashStr(sessionId).slice(0, 8);

  console.log(`Session: ${sessionDir}`);

  const ctx: SessionContext = {
    sessionId,
    sessionDir,
    reviewSession,
    projectRoot,
    workDir: projectRoot,
    worktreeDir: "",
    worktreeBranch: "",
    historyFile,
    templateDir,
    claudeOps,
    reviewConfig,
    validatorPath,
    sessionHash,
    coordinatorName: "",
    judgeName: "",
    workerNames: [],
    verifierNames: [],
    fleetProject: "",
  };

  // Collect material
  let material: ReturnType<typeof collectMaterial> | undefined;
  try {
    material = collectMaterial(config, sessionDir, projectRoot);
  } catch (e: any) {
    rmSync(sessionDir, { recursive: true, force: true });
    fail(e.message);
  }
  if (!material) return;

  const skipReason = shouldAutoSkip(material, config);
  if (skipReason) {
    console.log(skipReason);
    rmSync(sessionDir, { recursive: true, force: true });
    return;
  }

  if (!config.spec) {
    if (isCodebase) {
      config.spec = "Perform a comprehensive quality review of this codebase. Look for bugs, security issues, architectural problems, error handling gaps, and opportunities for improvement.";
    } else {
      config.spec = "Review this material thoroughly for issues, gaps, and improvements.";
    }
  }

  // Run V1 pipeline
  const roleResult: RoleDesignerResult = {
    useDynamicRoles: false,
    focusAreas: config.focusAreas,
    numFocus: config.focusAreas.length,
    totalWorkers: config.passesPerFocus * config.focusAreas.length,
    passesPerFocus: config.passesPerFocus,
    roleNames: "",
  };

  // Smart focus auto-detection
  if (!config.customFocus && material.hasDiff) {
    applySmartFocus(config, material, ctx, roleResult);
  }

  // Context pre-pass
  if (material.hasDiff && !config.noContext) {
    runContextPrePass(ctx, material);
  }

  // Shuffle material
  const drContext = join(ctx.claudeOps, "bin", "dr-context");
  if (existsSync(drContext)) {
    console.log(`Generating ${roleResult.totalWorkers} randomized orderings...`);
    (Bun.spawnSync as any)([drContext, "shuffle", material.materialFile, ctx.sessionDir, String(roleResult.totalWorkers)], {
      cwd: ctx.projectRoot,
      stderr: "pipe",
      timeout: 60_000,
    });
  }

  // Generate seeds + launch wrappers
  console.log("Generating seed prompts...");
  generateWorkerSeeds(config, material, ctx, roleResult);
  generateCoordinatorSeed(config, material, ctx, roleResult);

  if (!config.noJudge) {
    generateJudgeSeed(ctx, roleResult);
  }
  if (config.verify) {
    generateVerifierSeeds(config, ctx);
  }

  generateLaunchWrappers(config, ctx, roleResult);

  // Create tmux session and launch
  createTmuxSession(config, ctx, roleResult);
  launchWorkers(config, ctx, roleResult);
  launchCoordinator(ctx);

  if (config.verify) {
    launchVerifiers(ctx);
  }

  printSummary(config, ctx, material, roleResult);
}

/** Apply smart focus auto-detection: claude-md and silent-failure */
function applySmartFocus(
  config: DeepReviewConfig,
  material: { materialFile: string; changedFiles: string[] },
  ctx: SessionContext,
  roleResult: RoleDesignerResult,
): void {
  const materialContent = readFileSync(material.materialFile, "utf-8");
  let changed = false;

  const hasClaudeMd = ctx.reviewConfig ||
    existsSync(join(ctx.projectRoot, "CLAUDE.md")) ||
    existsSync(join(ctx.projectRoot, ".claude", "CLAUDE.md"));

  if (hasClaudeMd) {
    const totalChanged = (materialContent.match(/^diff --git a\//gm) || []).length;
    const tsChanged = (materialContent.match(/^diff --git a\/.*\.(ts|tsx|js|jsx)/gm) || []).length;

    if (totalChanged > 0 && (tsChanged * 100 / totalChanged) >= 50) {
      const idx = config.focusAreas.indexOf("ux-impact");
      if (idx !== -1) {
        config.focusAreas[idx] = "claude-md";
        changed = true;
        console.log("Smart focus: replaced ux-impact with claude-md (>50% TS/JS + CLAUDE.md present)");
      }
    }
  }

  const catchCount = (materialContent.match(/(try\s*\{|\.catch\(|catch\s*\()/g) || []).length;
  if (catchCount >= 3) {
    const idx = config.focusAreas.indexOf("completeness");
    if (idx !== -1) {
      config.focusAreas[idx] = "silent-failure";
      changed = true;
      console.log(`Smart focus: replaced completeness with silent-failure (${catchCount} try/catch patterns)`);
    }
  }

  if (changed) {
    roleResult.focusAreas = config.focusAreas;
    roleResult.numFocus = config.focusAreas.length;
    roleResult.totalWorkers = config.passesPerFocus * roleResult.numFocus;
    console.log(`Updated focus areas (${roleResult.numFocus}): ${config.focusAreas.join(" ")} (${roleResult.totalWorkers} workers)`);
  }
}

/** Simple string hash (for session naming) */
function hashStr(s: string): string {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(16).padStart(8, "0");
}
