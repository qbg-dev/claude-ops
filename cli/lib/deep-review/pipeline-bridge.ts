#!/usr/bin/env bun
/**
 * Pipeline bridge — async phase transitions for deep review.
 *
 * Called by Stop hook scripts to chain planning phases → worker launch.
 * Entry point: `bun pipeline-bridge.ts <command> <session-dir>`
 *
 * Commands:
 *   phase0-to-05   — After role designer completes, launch REVIEW.md improver
 *   phase05-to-workers — After improver completes, launch review workers
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join, basename } from "node:path";
import type { PipelineState } from "./types";
import { parseRolesResult, fallbackResult } from "./roles";
import { generateImproverSeed, parseImproverResult } from "./review-improver";
import { runContextPrePass } from "./context";
import {
  generateWorkerSeeds,
  generateCoordinatorSeed,
  generateJudgeSeed,
  generateVerifierSeeds,
  generateLaunchWrappers,
} from "./templates";
import {
  createTmuxSession,
  launchWorkers,
  launchCoordinator,
  launchVerifiers,
} from "./tmux";
import { provisionReviewFleet, buildMailEnvExport } from "./fleet-provisioning";
import { FLEET_DATA } from "../../lib/paths";

const HOME = process.env.HOME || "/tmp";
const FLEET_DIR = process.env.CLAUDE_FLEET_DIR || join(HOME, ".claude-fleet");

// ── Serialization ──────────────────────────────────────────────────

export function serializePipelineState(state: PipelineState, sessionDir: string): void {
  writeFileSync(join(sessionDir, "pipeline-state.json"), JSON.stringify(state, null, 2));
}

function loadPipelineState(sessionDir: string): PipelineState {
  const raw = readFileSync(join(sessionDir, "pipeline-state.json"), "utf-8");
  return JSON.parse(raw) as PipelineState;
}

// ── Tmux helpers ───────────────────────────────────────────────────

function tmux(...args: string[]): { ok: boolean; stdout: string } {
  const result = Bun.spawnSync(["tmux", ...args], { stderr: "pipe" });
  return { ok: result.exitCode === 0, stdout: result.stdout.toString().trim() };
}

function getPaneId(target: string, index: number): string {
  const { stdout } = tmux("list-panes", "-t", target, "-F", "#{pane_id}");
  const panes = stdout.split("\n").filter(Boolean);
  return panes[index] || "";
}

// ── Hook writing ───────────────────────────────────────────────────

function writeStopHook(
  workerName: string,
  project: string,
  scriptSourcePath: string,
  sessionDir: string,
): void {
  const hooksDir = join(FLEET_DATA, project, workerName, "hooks");
  mkdirSync(hooksDir, { recursive: true });

  // Copy script to hooks dir
  const scriptName = basename(scriptSourcePath);
  const destScript = join(hooksDir, scriptName);
  copyFileSync(scriptSourcePath, destScript);

  // Write session-dir.txt next to the script so it can find the session
  writeFileSync(join(hooksDir, "session-dir.txt"), sessionDir);

  // Write hooks.json with the Stop hook
  const hooks = {
    hooks: [{
      id: "dh-1",
      event: "Stop",
      description: `Bridge: ${scriptName.replace('.sh', '').replace('-stop', '')} phase transition`,
      blocking: false,
      completed: false,
      status: "active",
      lifetime: "persistent" as const,
      script_path: scriptName,
      registered_by: "deep-review",
      ownership: "creator" as const,
      added_at: new Date().toISOString(),
    }],
  };

  writeFileSync(join(hooksDir, "hooks.json"), JSON.stringify(hooks, null, 2));
}

// ── Launch wrapper generation ──────────────────────────────────────

function generatePlanningLaunchWrapper(
  workerName: string,
  project: string,
  workDir: string,
  seedPath: string,
  model: string,
  sessionDir: string,
): string {
  const fleetEnv = buildMailEnvExport(workerName, project);
  const hooksDir = join(FLEET_DATA, project, workerName, "hooks");

  const script = `#!/usr/bin/env bash
cd "${workDir}"
${fleetEnv}
export PROJECT_ROOT="${workDir}"
export HOOKS_DIR="${hooksDir}"
export CLAUDE_FLEET_DIR="${FLEET_DIR}"
exec claude --model ${model} --dangerously-skip-permissions "$(cat '${seedPath}')"
`;
  const wrapperPath = join(sessionDir, `run-${workerName}.sh`);
  writeFileSync(wrapperPath, script, { mode: 0o755 });
  return wrapperPath;
}

// ── Phase 0 → Phase 0.5 bridge ────────────────────────────────────

async function bridgePhase0ToPhase05(sessionDir: string): Promise<void> {
  console.log("[bridge] Phase 0 → Phase 0.5: Role designer completed");

  const state = loadPipelineState(sessionDir);
  const { config, material, ctx } = state;

  // Parse role designer output
  const roleResult = parseRolesResult(ctx, config);

  // Update focus areas from role result
  config.focusAreas = roleResult.focusAreas;

  // Save role result into pipeline state for Phase 0.5's bridge
  state.roleResult = roleResult;
  serializePipelineState(state, sessionDir);

  console.log(`[bridge] Roles: ${roleResult.roleNames || roleResult.focusAreas.join(", ")}`);
  console.log(`[bridge] Total workers: ${roleResult.totalWorkers}`);

  // Check if REVIEW.md improvement is disabled
  if (config.noImproveReview) {
    console.log("[bridge] REVIEW.md improvement disabled, skipping to workers");
    await bridgePhase05ToWorkers(sessionDir);
    return;
  }

  // Generate improver seed
  const seed = generateImproverSeed(config, material, ctx, roleResult);
  if (!seed) {
    console.log("[bridge] No improver seed template, skipping to workers");
    await bridgePhase05ToWorkers(sessionDir);
    return;
  }

  // Provision the improver worker
  const improverName = `dr-${ctx.sessionHash}-improver`;
  const projectDir = join(FLEET_DATA, ctx.fleetProject);
  mkdirSync(join(projectDir, improverName), { recursive: true });

  const now = new Date().toISOString();
  writeFileSync(join(projectDir, improverName, "config.json"), JSON.stringify({
    model: "opus",
    reasoning_effort: "high",
    permission_mode: "bypassPermissions",
    sleep_duration: null,
    window: null,
    worktree: ctx.workDir,
    branch: "HEAD",
    mcp: {},
    hooks: [],
    ephemeral: true,
    meta: { created_at: now, created_by: "deep-review", forked_from: null, project: ctx.fleetProject },
  }, null, 2));

  writeFileSync(join(projectDir, improverName, "state.json"), JSON.stringify({
    status: "active",
    pane_id: null,
    pane_target: null,
    tmux_session: ctx.reviewSession,
    session_id: `dr-${ctx.sessionHash}`,
    past_sessions: [],
    last_relaunch: null,
    relaunch_count: 0,
    cycles_completed: 0,
    last_cycle_at: null,
    custom: { role: "improver", session_hash: ctx.sessionHash },
  }, null, 2));

  writeFileSync(join(projectDir, improverName, "token"), "");
  writeFileSync(join(projectDir, improverName, "mission.md"),
    "# REVIEW.md Improver\nDeep review REVIEW.md improver (ephemeral)");

  // Write Stop hook for improver → workers bridge
  const phase05StopScript = join(FLEET_DIR, "scripts/deep-review/phase05-stop.sh");
  writeStopHook(improverName, ctx.fleetProject, phase05StopScript, sessionDir);

  // Generate launch wrapper
  const seedPath = join(sessionDir, "review-improver-seed.md");
  const wrapperPath = generatePlanningLaunchWrapper(
    improverName, ctx.fleetProject, ctx.workDir, seedPath, "opus", sessionDir,
  );

  // Launch in planning window (split a new pane)
  const planningTarget = `${ctx.reviewSession}:planning`;
  const hasWindow = tmux("has-session", "-t", planningTarget);
  if (hasWindow.ok) {
    tmux("split-window", "-d", "-t", planningTarget, "-c", ctx.workDir);
    Bun.sleepSync(500);
    const pane = getPaneId(planningTarget, 1);
    if (pane) {
      tmux("send-keys", "-t", pane, `bash '${wrapperPath}'`, "Enter");

      // Track pane ID
      const stateFile = join(projectDir, improverName, "state.json");
      try {
        const s = JSON.parse(readFileSync(stateFile, "utf-8"));
        s.pane_id = pane;
        s.pane_target = `${ctx.reviewSession}:planning`;
        writeFileSync(stateFile, JSON.stringify(s, null, 2));
      } catch {}

      console.log(`[bridge] Phase 0.5 launched: ${improverName} → ${pane}`);
    }
  } else {
    console.log("[bridge] WARN: planning window not found, launching in new window");
    tmux("new-window", "-d", "-t", ctx.reviewSession, "-n", "planning", "-c", ctx.workDir);
    Bun.sleepSync(500);
    const pane = getPaneId(`${ctx.reviewSession}:planning`, 0);
    if (pane) {
      tmux("send-keys", "-t", pane, `bash '${wrapperPath}'`, "Enter");
      console.log(`[bridge] Phase 0.5 launched: ${improverName} → ${pane}`);
    }
  }
}

// ── Phase 0.5 → Workers bridge ─────────────────────────────────────

async function bridgePhase05ToWorkers(sessionDir: string): Promise<void> {
  console.log("[bridge] Phase 0.5 → Workers: launching review pipeline");

  const state = loadPipelineState(sessionDir);
  const { config, material } = state;
  let { ctx } = state;
  let roleResult = state.roleResult;

  // If no role result (e.g., direct skip from Phase 0 failure), use fallback
  if (!roleResult) {
    roleResult = fallbackResult(config);
  }

  // Parse REVIEW.md improver output (or use original)
  if (!config.noImproveReview) {
    const improved = parseImproverResult(ctx);
    if (improved !== ctx.reviewConfig) {
      ctx.reviewConfig = improved;
      // Update pipeline state with improved REVIEW.md
      state.ctx = ctx;
      serializePipelineState(state, sessionDir);
    }
  }

  // Populate fleet names now that we know worker count
  ctx.coordinatorName = `dr-${ctx.sessionHash}-coord`;
  ctx.judgeName = config.noJudge ? "" : `dr-${ctx.sessionHash}-judge`;
  ctx.workerNames = [];
  for (let i = 1; i <= roleResult.totalWorkers; i++) {
    ctx.workerNames.push(`dr-${ctx.sessionHash}-${i}`);
  }
  ctx.verifierNames = config.verify
    ? ["chrome", "curl", "test", "script"].map((t) => `dr-${ctx.sessionHash}-v-${t}`)
    : [];

  // Fleet provisioning for review workers
  console.log(`[bridge] Provisioning fleet (${ctx.workerNames.length + 1 + (ctx.judgeName ? 1 : 0) + ctx.verifierNames.length} workers)...`);
  await provisionReviewFleet({
    sessionHash: ctx.sessionHash,
    project: ctx.fleetProject,
    workerNames: ctx.workerNames,
    coordinatorName: ctx.coordinatorName,
    judgeName: ctx.judgeName || null,
    verifierNames: ctx.verifierNames,
    sharedWorktree: ctx.workDir,
    workerModel: config.workerModel,
    coordModel: config.coordModel,
    tmuxSession: ctx.reviewSession,
  });

  // Context pre-pass
  if (material.hasDiff && !config.noContext) {
    runContextPrePass(ctx, material);
  }

  // Shuffle material
  const claudeOps = ctx.claudeOps;
  const drContext = join(claudeOps, "bin", "dr-context");
  if (existsSync(drContext)) {
    console.log(`[bridge] Generating ${roleResult.totalWorkers} randomized orderings...`);
    Bun.spawnSync([drContext, "shuffle", material.materialFile, sessionDir, String(roleResult.totalWorkers)], {
      cwd: ctx.projectRoot,
      stderr: "pipe",
      timeout: 60_000,
    });
  }

  // Generate seeds
  console.log("[bridge] Generating seed prompts...");
  generateWorkerSeeds(config, material, ctx, roleResult);
  generateCoordinatorSeed(config, material, ctx, roleResult);

  if (!config.noJudge) {
    generateJudgeSeed(ctx, roleResult);
  }

  if (config.verify) {
    generateVerifierSeeds(config, ctx);
  }

  // Generate launch wrappers
  generateLaunchWrappers(config, ctx, roleResult);

  // Create tmux session windows and launch
  createTmuxSession(config, ctx, roleResult);
  launchWorkers(config, ctx, roleResult);
  launchCoordinator(ctx);

  if (config.verify) {
    launchVerifiers(ctx);
  }

  // Write cleanup script
  if (ctx.coordinatorName) {
    const provisioningModule = join(claudeOps, "cli/lib/deep-review/fleet-provisioning.ts");
    const cleanupScript = `#!/usr/bin/env bash
# Auto-cleanup for deep-review fleet workers (dr-${ctx.sessionHash}-*)
cd "${ctx.projectRoot}"
exec bun -e "
import('${provisioningModule}').then(m => m.cleanupReviewFleet('${ctx.sessionHash}', '${ctx.fleetProject}')).then(() => console.log('Cleanup complete'));
"
`;
    writeFileSync(join(sessionDir, "cleanup-fleet.sh"), cleanupScript, { mode: 0o755 });
  }

  // Update pipeline state with final ctx
  state.ctx = ctx;
  state.roleResult = roleResult;
  serializePipelineState(state, sessionDir);

  console.log("[bridge] Review pipeline launched successfully");
  console.log(`[bridge] Session: ${ctx.reviewSession}`);
  console.log(`[bridge] Workers: ${roleResult.totalWorkers} | Coordinator: ${ctx.coordinatorName}`);
}

// ── CLI entry point ────────────────────────────────────────────────

const command = process.argv[2];
const sessionDir = process.argv[3];

if (!command || !sessionDir) {
  console.error("Usage: bun pipeline-bridge.ts <phase0-to-05|phase05-to-workers> <session-dir>");
  process.exit(1);
}

if (!existsSync(join(sessionDir, "pipeline-state.json"))) {
  console.error(`Pipeline state not found: ${sessionDir}/pipeline-state.json`);
  process.exit(1);
}

try {
  if (command === "phase0-to-05") {
    await bridgePhase0ToPhase05(sessionDir);
  } else if (command === "phase05-to-workers") {
    await bridgePhase05ToWorkers(sessionDir);
  } else {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }
} catch (err) {
  console.error(`[bridge] FATAL: ${err}`);
  process.exit(1);
}
