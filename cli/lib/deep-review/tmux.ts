/**
 * Tmux session orchestration for deep review.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FLEET_DATA } from "../../lib/paths";
import type { DeepReviewConfig, SessionContext, RoleDesignerResult } from "./types";

function tmux(...args: string[]): { ok: boolean; stdout: string } {
  const result = Bun.spawnSync(["tmux", ...args], { stderr: "pipe" });
  return { ok: result.exitCode === 0, stdout: result.stdout.toString().trim() };
}

function getPaneId(target: string, index: number): string {
  const { stdout } = tmux("list-panes", "-t", target, "-F", "#{pane_id}");
  const panes = stdout.split("\n").filter(Boolean);
  return panes[index] || "";
}

/** Create the tmux session with coordinator + worker windows.
 *  If the session already exists (e.g. planning window from async pipeline),
 *  adds windows to it instead of recreating.
 */
export function createTmuxSession(
  config: DeepReviewConfig,
  ctx: SessionContext,
  roleResult: RoleDesignerResult,
): void {
  const numWorkerWindows = Math.ceil(roleResult.totalWorkers / 4);
  const sessionExists = tmux("has-session", "-t", ctx.reviewSession).ok;

  if (sessionExists) {
    console.log(`Adding windows to existing session: ${ctx.reviewSession} (1 coordinator + ${numWorkerWindows} worker windows)...`);
    // Add coordinator window to existing session
    tmux("new-window", "-d", "-t", ctx.reviewSession, "-n", "coordinator", "-c", ctx.projectRoot);
  } else {
    console.log(`Creating tmux session: ${ctx.reviewSession} (1 coordinator + ${numWorkerWindows} worker windows)...`);
    // Create new session with coordinator window
    tmux("new-session", "-d", "-s", ctx.reviewSession, "-n", "coordinator", "-c", ctx.projectRoot);
  }

  // Create worker windows (4 panes each, tiled layout)
  let workersRemaining = roleResult.totalWorkers;
  for (let w = 1; w <= numWorkerWindows; w++) {
    const panesInWindow = Math.min(workersRemaining, 4);
    tmux("new-window", "-d", "-t", ctx.reviewSession, "-n", `workers-${w}`, "-c", ctx.projectRoot);
    for (let p = 1; p < panesInWindow; p++) {
      tmux("split-window", "-d", "-t", `${ctx.reviewSession}:workers-${w}`, "-c", ctx.projectRoot);
    }
    tmux("select-layout", "-t", `${ctx.reviewSession}:workers-${w}`, "tiled");
    workersRemaining -= panesInWindow;
  }

  // Create verifier window if needed
  if (config.verify) {
    const verifierCount = 4; // chrome, curl, test, script
    tmux("new-window", "-d", "-t", ctx.reviewSession, "-n", "verifiers", "-c", ctx.workDir);
    for (let p = 1; p < verifierCount; p++) {
      tmux("split-window", "-d", "-t", `${ctx.reviewSession}:verifiers`, "-c", ctx.workDir);
    }
    tmux("select-layout", "-t", `${ctx.reviewSession}:verifiers`, "tiled");
  }

  // Short sleep for tmux to settle
  Bun.sleepSync(1000);
}

/** Launch all workers (staggered 0.3s apart) */
export function launchWorkers(
  config: DeepReviewConfig,
  ctx: SessionContext,
  roleResult: RoleDesignerResult,
): void {
  const numWorkerWindows = Math.ceil(roleResult.totalWorkers / 4);
  console.log(`Launching ${roleResult.totalWorkers} review workers across ${roleResult.numFocus} focus areas...`);
  console.log("");

  let worker = 1;
  for (let w = 1; w <= numWorkerWindows; w++) {
    const { stdout } = tmux("list-panes", "-t", `${ctx.reviewSession}:workers-${w}`, "-F", "#{pane_id}");
    const panes = stdout.split("\n").filter(Boolean);

    for (let p = 0; p < panes.length; p++) {
      if (worker > roleResult.totalWorkers) break;
      const pane = panes[p];
      const focusIdx = roleResult.useDynamicRoles
        ? worker - 1
        : Math.floor((worker - 1) / config.passesPerFocus);
      const passInFocus = roleResult.useDynamicRoles
        ? 1 // v2: flat array, pass counting handled elsewhere
        : ((worker - 1) % config.passesPerFocus) + 1;
      const focus = roleResult.focusAreas[focusIdx] || roleResult.focusAreas[worker - 1];
      const ppf = roleResult.useDynamicRoles
        ? roleResult.focusAreas.filter((f) => f === focus).length
        : config.passesPerFocus;

      const fleetName = ctx.workerNames?.[worker - 1] || "";
      const nameTag = fleetName ? ` (${fleetName})` : "";
      console.log(`  Worker ${worker} → ${pane} (win ${w}) [${focus} #${passInFocus}/${ppf}]${nameTag}`);
      tmux("send-keys", "-t", pane, `bash '${ctx.sessionDir}/run-pass-${worker}.sh'`, "Enter");

      // Track pane ID in fleet state.json for observability (fleet ls, fleet attach)
      if (fleetName && ctx.fleetProject) {
        const stateFile = join(FLEET_DATA, ctx.fleetProject, fleetName, "state.json");
        try {
          const state = JSON.parse(readFileSync(stateFile, "utf-8"));
          state.pane_id = pane;
          state.pane_target = `${ctx.reviewSession}:workers-${w}`;
          writeFileSync(stateFile, JSON.stringify(state, null, 2));
        } catch {}
      }

      worker++;
      Bun.sleepSync(300);
    }
  }
}

/** Launch the coordinator */
export function launchCoordinator(ctx: SessionContext): void {
  console.log("");
  console.log("Launching coordinator...");
  const coordPane = getPaneId(`${ctx.reviewSession}:coordinator`, 0);
  tmux("send-keys", "-t", coordPane, `bash '${ctx.sessionDir}/run-coordinator.sh'`, "Enter");

  // Track coordinator pane ID
  if (ctx.coordinatorName && ctx.fleetProject) {
    const stateFile = join(FLEET_DATA, ctx.fleetProject, ctx.coordinatorName, "state.json");
    try {
      const state = JSON.parse(readFileSync(stateFile, "utf-8"));
      state.pane_id = coordPane;
      state.pane_target = `${ctx.reviewSession}:coordinator`;
      writeFileSync(stateFile, JSON.stringify(state, null, 2));
    } catch {}
  }
}

/** Launch verifiers (if enabled) */
export function launchVerifiers(ctx: SessionContext): void {
  const types = ["chrome", "curl", "test", "script"];
  console.log(`Launching ${types.length} verifiers (will start after coordinator completes)...`);

  for (let i = 0; i < types.length; i++) {
    const pane = getPaneId(`${ctx.reviewSession}:verifiers`, i);
    tmux("send-keys", "-t", pane, `bash '${ctx.sessionDir}/run-verifier-${types[i]}.sh'`, "Enter");
    console.log(`  Verifier ${types[i]} → ${pane}`);

    // Track verifier pane ID
    const verifierName = ctx.verifierNames?.[i];
    if (verifierName && ctx.fleetProject) {
      const stateFile = join(FLEET_DATA, ctx.fleetProject, verifierName, "state.json");
      try {
        const state = JSON.parse(readFileSync(stateFile, "utf-8"));
        state.pane_id = pane;
        state.pane_target = `${ctx.reviewSession}:verifiers`;
        writeFileSync(stateFile, JSON.stringify(state, null, 2));
      } catch {}
    }

    Bun.sleepSync(300);
  }
}

/** Print the session summary */
export function printSummary(
  config: DeepReviewConfig,
  ctx: SessionContext,
  material: { materialTypesStr: string; materialType: string; diffDesc: string; diffLines: number },
  roleResult: RoleDesignerResult,
): void {
  const numWorkerWindows = Math.ceil(roleResult.totalWorkers / 4);

  console.log("");
  console.log("════════════════════════════════════════════════════════════");
  console.log("  DEEP REVIEW LAUNCHED");
  console.log("");
  console.log(`  Session:     ${ctx.reviewSession}`);
  console.log(`  Dir:         ${ctx.sessionDir}`);
  console.log(`  Material:    ${material.materialTypesStr} (${material.materialType})`);
  console.log(`  Reviewing:   ${material.diffDesc} (${material.diffLines} lines)`);

  if (config.spec && config.spec !== "Review this material thoroughly for issues, gaps, and improvements.") {
    console.log(`  Spec:        ${config.spec}`);
  }

  console.log("");
  if (roleResult.useDynamicRoles) {
    console.log("  Mode:        v2 (dynamic roles from role designer)");
    console.log(`  Roles:       ${roleResult.roleNames}`);
  } else {
    console.log("  Mode:        v1 (static focus areas)");
    console.log(`  Focus areas (${roleResult.numFocus}): ${roleResult.focusAreas.join(" ")}`);
  }
  console.log(`  Passes/focus: ${roleResult.passesPerFocus} (max)`);
  console.log(`  Total workers: ${roleResult.totalWorkers} (model: ${config.workerModel})`);
  console.log(`  Coordinator: ${ctx.reviewSession}:coordinator (model: ${config.coordModel})`);

  if (ctx.worktreeDir) {
    console.log(`  Worktree:    ${ctx.worktreeDir}`);
    console.log(`  Branch:      ${ctx.worktreeBranch}`);
  }

  console.log("");
  for (let w = 1; w <= numWorkerWindows; w++) {
    const first = (w - 1) * 4 + 1;
    let last = w * 4;
    if (last > roleResult.totalWorkers) last = roleResult.totalWorkers;
    console.log(`  Window ${w}: workers ${first}-${last} (4 panes tiled)`);
  }

  if (config.notifyTarget) {
    console.log("");
    console.log(`  Notify:      ${config.notifyTarget} (on completion)`);
  }

  console.log("");
  console.log(`  Attach: tmux switch-client -t ${ctx.reviewSession}`);
  console.log(`          tmux a -t ${ctx.reviewSession}`);
  console.log("");
  console.log("  Voting: graduated (confidence + votes)");
  console.log("  Validation: post-exit JSON validation enforced");

  const hasJudge = !config.noJudge;
  console.log(`  Judge: ${hasJudge ? "enabled (adversarial validation)" : "disabled"}`);

  if (existsSync(join(ctx.sessionDir, "dep-graph.json"))) {
    console.log("  Context: pre-gathered (static analysis, deps, tests)");
  }
  console.log(`  Report: ${ctx.sessionDir}/report.md`);

  if (config.verify) {
    console.log("  Verify: enabled (verifiers spawn after coordinator)");
  }

  if (ctx.coordinatorName) {
    console.log("");
    console.log("  ── FLEET INTEGRATION ───────────────────────────────────");
    console.log(`  Coordinator: ${ctx.coordinatorName}`);
    if (ctx.judgeName) console.log(`  Judge:       ${ctx.judgeName}`);
    console.log(`  Workers:     ${ctx.workerNames?.join(", ") || "none"}`);
    if (ctx.verifierNames?.length) console.log(`  Verifiers:   ${ctx.verifierNames.join(", ")}`);
    console.log("  Coordination: Fleet Mail");
    console.log(`  Cleanup:     bash ${ctx.sessionDir}/cleanup-fleet.sh`);
  }

  console.log("");
  console.log("  ── RECOMMENDATION ──────────────────────────────────────");
  console.log("  Deep review takes 15-25 min. While it runs, consider:");
  console.log("  • Work on generic/simple issues from your task list");
  console.log("  • Launch targeted quick reviews on specific files");
  console.log("  • Continue development — deep review catches the gnarly");
  console.log("    bugs and unexpected errors in the background.");
  console.log("  You'll be notified when results are ready.");
  console.log("════════════════════════════════════════════════════════════");
}
