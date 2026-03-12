/**
 * fleet pipeline <program> [opts] — Launch a program-API pipeline.
 *
 * Programs are declared in ~/.claude-fleet/programs/<name>.program.ts.
 * Each program exports a default function that returns a Program object.
 *
 * Examples:
 *   fleet pipeline deep-review --scope HEAD~3..HEAD --verify
 *   fleet pipeline deep-review --scope HEAD --dry-run
 */
import type { Command } from "commander";
import { existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { addGlobalOpts } from "../index";
import { fail } from "../lib/fmt";
import { resolveProjectRoot, resolveProject } from "../lib/paths";
import type { Program, ProgramPipelineState } from "../../engine/program/types";
import { compile, savePipelineState } from "../../engine/program/compiler";
import { generateManifest } from "../../engine/program/manifest";
import { createTmuxSession, showManifest, launchAgents, launchInPlanningWindow } from "../../engine/program/tmux-layout";
import { provisionWorkers, generateLaunchWrapper, generateCleanupScript } from "../../engine/program/fleet-provision";
import { createBridgeFifos } from "../../engine/program/fifo";
import { installStopHook } from "../../engine/program/hook-generator";

const HOME = process.env.HOME || "/tmp";
const FLEET_DIR = process.env.CLAUDE_FLEET_DIR || join(HOME, ".claude-fleet");

export function register(program: Command): void {
  const cmd = program
    .command("pipeline")
    .alias("pipe")
    .description("Launch a program-API pipeline")
    .argument("<program>", "Program name (e.g. deep-review)")
    .option("--scope <scope>", "Git diff scope")
    .option("--content <files>", "File path(s) to review, comma-separated")
    .option("--spec <text>", "What to review for")
    .option("--passes <n>", "Passes per focus area", "2")
    .option("--verify", "Enable verification phase")
    .option("--verify-roles <list>", "User roles to test as")
    .option("--no-judge", "Skip judge")
    .option("--no-context", "Skip context pre-pass")
    .option("--no-improve-review", "Skip REVIEW.md improvement")
    .option("--max-workers <n>", "Max worker budget")
    .option("--session-name <name>", "Custom tmux session name")
    .option("--notify <target>", "Notify on completion")
    .option("--dry-run", "Print manifest without launching")
    .action(async (programName: string, opts: Record<string, any>) => {
      try {
        await runPipeline(programName, opts);
      } catch (e: any) {
        fail(e.message || String(e));
      }
    });

  addGlobalOpts(cmd);
}

async function runPipeline(programName: string, opts: Record<string, any>): Promise<void> {
  // Find program file
  const programPath = join(FLEET_DIR, "programs", `${programName}.program.ts`);
  if (!existsSync(programPath)) {
    fail(`Program not found: ${programPath}\nAvailable programs: ${listPrograms().join(", ") || "none"}`);
  }

  // Import program module
  const programModule = await import(programPath);
  const programFn = programModule.default;
  if (typeof programFn !== "function") {
    fail(`Program ${programName} must export a default function`);
  }

  const projectRoot = process.env.PROJECT_ROOT || resolveProjectRoot();
  const fleetProject = resolveProject(projectRoot);

  // Build program-specific options
  const programOpts = buildProgramOpts(programName, opts, projectRoot);

  // Generate the Program declaration
  const program: Program = programFn(programOpts);

  // Validate
  const tmuxCheck = Bun.spawnSync(["tmux", "info"], { stderr: "pipe", stdout: "pipe" });
  if (tmuxCheck.exitCode !== 0 && !opts.dryRun) {
    fail("tmux not running — required for pipeline execution");
  }

  // Build session name
  const sessionName = opts.sessionName || buildSessionName(programName, projectRoot, programOpts);

  // Create session directory
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const sessionId = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const sessionDir = join(projectRoot, ".claude", "state", programName, `session-${sessionId}`);
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(join(sessionDir, "comms"), { recursive: true });

  const sessionHash = hashStr(sessionId).slice(0, 8);

  // Detect REVIEW.md
  let reviewConfig = "";
  const reviewPaths = [
    join(projectRoot, "REVIEW.md"),
    join(projectRoot, ".claude", "REVIEW.md"),
  ];
  for (const rmd of reviewPaths) {
    if (existsSync(rmd)) {
      reviewConfig = readFileSync(rmd, "utf-8");
      console.log(`REVIEW.md: ${rmd}`);
      break;
    }
  }

  // Build pipeline state
  const state: ProgramPipelineState = {
    programPath,
    opts: programOpts,
    programName: program.name,
    tmuxSession: sessionName,
    sessionDir,
    projectRoot,
    workDir: projectRoot, // TODO: worktree support
    fleetProject,
    sessionHash,
    defaults: program.defaults || {},
    phaseState: {},
    compiledPhases: [],
    templateDir: join(FLEET_DIR, "templates"),
    validatorPath: join(FLEET_DIR, "scripts", "validate-findings.sh"),
    reviewConfig,
    spec: programOpts.spec || program.material?.spec || "",
  };

  // Collect material (for deep-review)
  if (program.material?.scope || (program.material?.contentFiles && program.material.contentFiles.length > 0)) {
    try {
      const { collectMaterial, shouldAutoSkip } = await import("../lib/deep-review/material");
      const materialConfig = {
        scope: program.material.scope || "",
        contentFiles: program.material.contentFiles || [],
        spec: program.material.spec || "",
        force: false,
        passesPerFocus: programOpts.passesPerFocus || 2,
        focusAreas: programOpts.focusAreas || [],
        customFocus: "",
        noJudge: false,
        noContext: false,
        verify: false,
        verifyRoles: "",
        v1Mode: false,
        maxWorkers: null,
        noWorktree: true,
        noImproveReview: false,
        sessionName: "",
        notifyTarget: "",
        workerModel: "sonnet",
        coordModel: "sonnet",
      };

      const material = collectMaterial(materialConfig, sessionDir, projectRoot);
      if (material) {
        const skipReason = shouldAutoSkip(material, materialConfig);
        if (skipReason && !programOpts.force) {
          console.log(skipReason);
          rmSync(sessionDir, { recursive: true, force: true });
          return;
        }
        state.material = {
          materialFile: material.materialFile,
          materialType: material.materialType,
          diffLines: material.diffLines,
          diffDesc: material.diffDesc,
          materialTypesStr: material.materialTypesStr,
          hasDiff: material.hasDiff,
          hasContent: material.hasContent,
          changedFiles: material.changedFiles,
        };
      }
    } catch (err) {
      console.log(`WARN: Material collection failed: ${err}`);
    }
  }

  console.log(`Session: ${sessionDir}`);

  // Compile the program (eager pass)
  console.log(`Compiling program: ${program.name} (${program.phases.length} phases)`);
  const plan = compile(program, state);

  // Store compiled phases in state
  state.compiledPhases = plan.phases;

  // Save pipeline state (for bridge scripts)
  savePipelineState(state);

  // Generate manifest
  const manifestPath = generateManifest(program, state, plan.phases);
  console.log(`Manifest: ${manifestPath}`);

  // Dry run: print manifest and exit
  if (opts.dryRun) {
    console.log("");
    console.log(readFileSync(manifestPath, "utf-8"));
    rmSync(sessionDir, { recursive: true, force: true });
    return;
  }

  // Determine bridge phases (phases > 0 that need bridge windows)
  const bridgePhases: Array<{ phaseIndex: number; label: string }> = [];
  for (let i = 1; i < program.phases.length; i++) {
    const prev = program.phases[i - 1];
    bridgePhases.push({
      phaseIndex: i,
      label: `${prev.name} → ${program.phases[i].name}`,
    });
  }

  // Create bridge FIFOs
  createBridgeFifos(sessionDir, bridgePhases.map(bp => bp.phaseIndex));

  // Determine initial phase windows (Phase 0 only)
  const phase0Workers = plan.workers.filter(w => w.phaseIndex === 0);
  const phase0Windows = plan.windows.filter(w =>
    phase0Workers.some(worker => worker.window === w.name)
  );

  // Create tmux session with manifest + bridge windows + Phase 0 windows
  createTmuxSession(state, phase0Windows, bridgePhases);

  // Provision Phase 0 workers
  if (phase0Workers.length > 0) {
    console.log(`Provisioning Phase 0 workers (${phase0Workers.length})...`);
    await provisionWorkers(phase0Workers, state);

    // Generate launch wrappers
    for (const worker of phase0Workers) {
      generateLaunchWrapper(worker, state);
    }

    // Install stop hooks on Phase 0 gate agents (→ Phase 1)
    if (program.phases.length > 1) {
      const phase0 = program.phases[0];
      if (!phase0.gate || phase0.gate !== "all") {
        // Default gate: last agent
        const gateWorker = phase0Workers[phase0Workers.length - 1];
        installStopHook(gateWorker.name, fleetProject, "", sessionDir, 1);
      }
    }

    // Launch Phase 0 agents
    console.log("");
    console.log(`Phase 0: Launching ${phase0Workers.length} agent(s)...`);

    if (phase0Workers.length === 1) {
      launchInPlanningWindow(phase0Workers[0], sessionName, state);
    } else {
      launchAgents(phase0Workers, sessionName, state);
    }
  }

  // Show manifest
  showManifest(sessionName, manifestPath);

  // Generate cleanup script
  generateCleanupScript(state);

  // Print summary
  console.log("");
  console.log("════════════════════════════════════════════════════════════");
  console.log(`  PIPELINE: ${program.name}`);
  console.log("");
  console.log(`  Session:     ${sessionName}`);
  console.log(`  Dir:         ${sessionDir}`);
  if (state.material) {
    console.log(`  Material:    ${state.material.materialTypesStr} (${state.material.materialType})`);
    console.log(`  Reviewing:   ${state.material.diffDesc} (${state.material.diffLines} lines)`);
  }
  console.log("");
  console.log(`  Phases: ${program.phases.length} (hook-chained, no timeouts)`);
  for (let i = 0; i < program.phases.length; i++) {
    const phase = program.phases[i];
    const status = i === 0 ? "← running now" : "← auto-launches on completion";
    console.log(`    ${i}. ${phase.name}: ${phase.description || ""} ${status}`);
  }
  console.log("");
  console.log(`  Attach: tmux switch-client -t ${sessionName}`);
  console.log(`          tmux a -t ${sessionName}`);
  console.log(`  Report: ${sessionDir}/report.md (after completion)`);
  console.log("════════════════════════════════════════════════════════════");
}

// ── Helpers ──────────────────────────────────────────────────────

function listPrograms(): string[] {
  const programsDir = join(FLEET_DIR, "programs");
  if (!existsSync(programsDir)) return [];
  try {
    const { readdirSync } = require("node:fs");
    return readdirSync(programsDir)
      .filter((f: string) => f.endsWith(".program.ts"))
      .map((f: string) => f.replace(".program.ts", ""));
  } catch {
    return [];
  }
}

function buildProgramOpts(
  programName: string,
  opts: Record<string, any>,
  projectRoot: string,
): Record<string, any> {
  if (programName === "deep-review") {
    return {
      scope: opts.scope || "HEAD",
      contentFiles: opts.content ? opts.content.split(",").map((s: string) => s.trim()) : [],
      spec: opts.spec || "Review this material thoroughly for issues, gaps, and improvements.",
      passesPerFocus: parseInt(opts.passes, 10) || 2,
      focusAreas: opts.focus ? opts.focus.split(",").map((s: string) => s.trim()) : [],
      maxWorkers: opts.maxWorkers ? parseInt(opts.maxWorkers, 10) : null,
      verify: !!opts.verify,
      verifyRoles: opts.verifyRoles || "",
      noJudge: opts.judge === false,
      noContext: opts.context === false,
      noImproveReview: opts.improveReview === false,
      workerModel: process.env.DEEP_REVIEW_WORKER_MODEL || "sonnet",
      coordModel: process.env.DEEP_REVIEW_COORD_MODEL || "sonnet",
      notifyTarget: opts.notify || "",
      force: !!opts.force,
    };
  }

  // Generic: pass all opts through
  return { ...opts, projectRoot };
}

function buildSessionName(
  programName: string,
  projectRoot: string,
  opts: Record<string, any>,
): string {
  const worktreeName = basename(projectRoot).replace(/^Wechat-w-/, "").replace(/^Wechat$/, "main");
  const scope = opts.scope || "HEAD";

  let resolvedRef = scope;
  if (scope === "uncommitted") {
    const r = Bun.spawnSync(["git", "rev-parse", "--short=8", "HEAD"], { cwd: projectRoot, stderr: "pipe" });
    resolvedRef = r.stdout.toString().trim() || "wip";
  } else if (scope.includes("..")) {
    resolvedRef = scope.split("..").pop() || scope;
  }

  const shortResult = Bun.spawnSync(["git", "rev-parse", "--short=8", resolvedRef], { cwd: projectRoot, stderr: "pipe" });
  const shortHash = shortResult.stdout.toString().trim().split("\n")[0] || resolvedRef.replace(/[^a-zA-Z0-9]+/g, "-");

  return `${programName.slice(0, 3)}-${worktreeName}-${shortHash}`.slice(0, 50);
}

function hashStr(s: string): string {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(16).padStart(8, "0");
}
