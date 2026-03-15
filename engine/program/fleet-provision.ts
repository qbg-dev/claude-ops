/**
 * Fleet provisioning for program-API pipelines.
 *
 * Creates ephemeral fleet workers with Fleet Mail accounts.
 * Generalized from deep-review's fleet-provisioning.ts to accept
 * CompiledWorker[] from any program.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FLEET_DATA, FLEET_MAIL_URL, FLEET_MAIL_TOKEN } from "../../cli/lib/paths";
import type { WorkerConfig, WorkerState } from "../../shared/types";
import type { CompiledWorker, ProgramPipelineState } from "./types";

/**
 * Provision fleet directories and Fleet Mail accounts for a set of compiled workers.
 * Returns a map of worker name → Fleet Mail token.
 */
export async function provisionWorkers(
  workers: CompiledWorker[],
  state: ProgramPipelineState,
): Promise<Map<string, string>> {
  const tokens = new Map<string, string>();
  const project = state.fleetProject;
  const projectDir = join(FLEET_DATA, project);
  mkdirSync(projectDir, { recursive: true });

  const now = new Date().toISOString();

  // 1. Create per-worker fleet directories
  for (const worker of workers) {
    const workerDir = join(projectDir, worker.name);
    mkdirSync(workerDir, { recursive: true });

    const isPerpetual = typeof worker.sleepDuration === "number" && worker.sleepDuration > 0;
    const config: WorkerConfig = {
      model: worker.model,
      runtime: worker.runtime || "claude",
      customLauncher: worker.customLauncher,
      reasoning_effort: state.defaults.effort || "high",
      permission_mode: state.defaults.permission || "bypassPermissions",
      sleep_duration: isPerpetual ? worker.sleepDuration! : null,
      window: null,
      worktree: state.workDir,
      branch: "HEAD",
      mcp: {},
      hooks: [],
      ephemeral: !isPerpetual,
      meta: {
        created_at: now,
        created_by: state.programName,
        forked_from: null,
        project,
      },
    };
    writeFileSync(join(workerDir, "config.json"), JSON.stringify(config, null, 2));

    const workerState: WorkerState = {
      status: "active",
      pane_id: null,
      pane_target: null,
      tmux_session: state.tmuxSession,
      session_id: state.sessionHash,
      past_sessions: [],
      last_relaunch: null,
      relaunch_count: 0,
      cycles_completed: 0,
      last_cycle_at: null,
      custom: {
        role: worker.role,
        session_hash: state.sessionHash,
        program: state.programName,
        phase: worker.phaseIndex,
      },
    };
    writeFileSync(join(workerDir, "state.json"), JSON.stringify(workerState, null, 2));

    writeFileSync(join(workerDir, "token"), "");
    writeFileSync(join(workerDir, "mission.md"),
      `# ${worker.name}\n${state.programName} ${worker.role} (${isPerpetual ? `perpetual, ${worker.sleepDuration}s cycles` : "ephemeral"})`);

    // Write event-tools.json if this worker has custom tools
    if (worker.eventTools?.length) {
      writeFileSync(join(workerDir, "event-tools.json"), JSON.stringify({
        programPath: worker.eventToolsProgramPath,
        tools: worker.eventTools,
        sessionDir: state.sessionDir,
        projectRoot: state.projectRoot,
      }, null, 2));
    }
  }

  // 2. Provision Fleet Mail accounts in parallel
  if (FLEET_MAIL_URL) {
    const mailHeaders: Record<string, string> = { "Content-Type": "application/json" };
    if (FLEET_MAIL_TOKEN) mailHeaders["Authorization"] = `Bearer ${FLEET_MAIL_TOKEN}`;

    const names = workers.map(w => w.name);
    const results = await Promise.allSettled(
      names.map(async (name) => {
        const accountName = `${name}@${project}`;
        try {
          const resp = await fetch(`${FLEET_MAIL_URL}/api/accounts`, {
            method: "POST",
            headers: mailHeaders,
            body: JSON.stringify({ name: accountName }),
            signal: AbortSignal.timeout(5000),
          });

          if (resp.ok) {
            const data = (await resp.json()) as { bearerToken?: string; token?: string };
            return { name, token: data.bearerToken || data.token || "" };
          }

          if (resp.status === 409 && FLEET_MAIL_TOKEN) {
            const resetResp = await fetch(
              `${FLEET_MAIL_URL}/api/admin/accounts/${encodeURIComponent(accountName)}/reset-token`,
              {
                method: "POST",
                headers: { Authorization: `Bearer ${FLEET_MAIL_TOKEN}` },
                signal: AbortSignal.timeout(5000),
              },
            );
            if (resetResp.ok) {
              const data = (await resetResp.json()) as { bearerToken?: string; token?: string };
              return { name, token: data.bearerToken || data.token || "" };
            }
          }

          return { name, token: "" };
        } catch {
          return { name, token: "" };
        }
      }),
    );

    let provisioned = 0;
    for (const result of results) {
      if (result.status === "fulfilled" && result.value.token) {
        const { name, token } = result.value;
        tokens.set(name, token);
        writeFileSync(join(projectDir, name, "token"), token);
        provisioned++;
      } else if (result.status === "fulfilled") {
        writeFileSync(join(projectDir, result.value.name, "token"), "");
      }
    }

    const failed = names.length - provisioned;
    if (failed > 0) {
      const failedNames: string[] = [];
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status === "rejected" || (r.status === "fulfilled" && !r.value.token)) {
          failedNames.push(names[i]);
        }
      }
      console.log(`  Fleet Mail: ${provisioned}/${names.length} accounts provisioned (failed: ${failedNames.join(", ")})`);

      // Throw if >50% failed and more than 1 worker — pipeline can't function without messaging
      if (failed > names.length / 2 && names.length > 1) {
        throw new Error(
          `Fleet Mail provisioning failed for ${failed}/${names.length} workers: ${failedNames.join(", ")}. ` +
          `Pipeline requires messaging for coordination.`,
        );
      }
    } else {
      console.log(`  Fleet Mail: ${provisioned}/${names.length} accounts provisioned`);
    }
  } else {
    console.log("  WARN: Fleet Mail not configured — workers will run without messaging");
  }

  return tokens;
}

/**
 * Clean up ephemeral workers from a pipeline session.
 * Deletes Fleet Mail accounts + per-worker fleet directories.
 */
export async function cleanupPipelineWorkers(
  sessionHash: string,
  project: string,
  prefix?: string,
): Promise<void> {
  const projectDir = join(FLEET_DATA, project);
  if (!existsSync(projectDir)) return;

  const namePrefix = prefix || sessionHash;
  const workers = readdirSync(projectDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.includes(namePrefix))
    .map((d) => d.name);

  if (workers.length === 0) return;

  // Delete Fleet Mail accounts in parallel
  if (FLEET_MAIL_URL && FLEET_MAIL_TOKEN) {
    await Promise.allSettled(
      workers.map(async (name) => {
        const accountName = `${name}@${project}`;
        try {
          await fetch(
            `${FLEET_MAIL_URL}/api/admin/accounts/${encodeURIComponent(accountName)}`,
            {
              method: "DELETE",
              headers: { Authorization: `Bearer ${FLEET_MAIL_TOKEN}` },
              signal: AbortSignal.timeout(5000),
            },
          );
        } catch {}
      }),
    );
  }

  // Remove per-worker fleet directories
  for (const name of workers) {
    try {
      rmSync(join(projectDir, name), { recursive: true, force: true });
    } catch {}
  }

  console.log(`  Cleaned up ${workers.length} ephemeral workers (*${namePrefix}*)`);
}

/**
 * Build Fleet Mail env export lines for a worker's launch wrapper.
 */
export function buildMailEnvExport(
  workerName: string,
  project: string,
): string {
  const tokenPath = join(FLEET_DATA, project, workerName, "token");
  let token = "";
  try {
    token = readFileSync(tokenPath, "utf-8").trim();
  } catch {}

  const mailUrl = FLEET_MAIL_URL || "";

  return [
    `export WORKER_NAME="${workerName}"`,
    `export FLEET_MAIL_URL="${mailUrl}"`,
    token ? `export FLEET_MAIL_TOKEN="${token}"` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Build the exec line for a worker based on its runtime.
 * - "claude" (default): claude --model MODEL --dangerously-skip-permissions "$(cat SEED)"
 * - "codex": codex exec --full-auto -c model="MODEL" "$(cat SEED)"
 * - "sdk": bun run sdk-WORKER.ts (Claude Agent SDK programmatic)
 * - "custom": use customLauncher string as the exec line
 */
function buildExecLine(worker: CompiledWorker, state?: ProgramPipelineState): string {
  const runtime = worker.runtime || "claude";

  switch (runtime) {
    case "codex": {
      const model = worker.model || "gpt-5.4";
      return `exec codex exec --full-auto --skip-git-repo-check -c model='"${model}"' "$(cat '${worker.seedPath}')"`;
    }
    case "sdk": {
      // SDK runtime — run the generated TypeScript launcher
      const sdkPath = state
        ? join(state.sessionDir, `sdk-${worker.name}.ts`)
        : worker.wrapperPath.replace(/run-/, "sdk-").replace(/\.sh$/, ".ts");
      return `exec bun run "${sdkPath}"`;
    }
    case "custom": {
      if (!worker.customLauncher) {
        throw new Error(`Worker ${worker.name} has runtime "custom" but no customLauncher`);
      }
      return `exec ${worker.customLauncher}`;
    }
    case "claude":
    default:
      return `exec claude --model ${worker.model} --dangerously-skip-permissions "$(cat '${worker.seedPath}')"`;
  }
}

/**
 * Generate a launch wrapper script for a compiled worker.
 */
export function generateLaunchWrapper(
  worker: CompiledWorker,
  state: ProgramPipelineState,
): string {
  const fleetEnv = buildMailEnvExport(worker.name, state.fleetProject);
  const hooksDir = join(FLEET_DATA, state.fleetProject, worker.name, "hooks");
  const fleetDir = process.env.CLAUDE_FLEET_DIR || join(process.env.HOME || "/tmp", ".claude-fleet");

  // BUG 4 fix: export worker.env entries
  const customEnv = worker.env
    ? Object.entries(worker.env)
        .map(([k, v]) => `export ${k}="${v.replace(/"/g, '\\"')}"`)
        .join("\n")
    : "";

  // BUG 5 fix: conditional permission flag from worker.permissionMode
  const permMode = worker.permissionMode || state.defaults.permission || "bypassPermissions";
  const permFlag = permMode === "bypassPermissions" ? " --dangerously-skip-permissions" : "";

  // Timeout support
  const execPrefix = worker.timeout && worker.timeout > 0 ? `timeout ${worker.timeout} ` : "";

  // Effort flag from defaults
  const effort = state.defaults.effort || "high";
  const effortFlag = ` --effort "${effort}"`;

  // --add-dir for fleet worker directory (mission, config, hooks, token)
  const workerDir = join(FLEET_DATA, state.fleetProject, worker.name);
  const addDirFlag = ` --add-dir "${workerDir}"`;

  // Create results directory for this worker (results convention)
  const resultsDir = join(state.sessionDir, "results", worker.name);
  mkdirSync(resultsDir, { recursive: true });

  // For SDK runtime, generate the TypeScript launcher
  if (worker.runtime === "sdk") {
    const { generateSdkLauncher } = require("./sdk-launcher") as typeof import("./sdk-launcher");
    generateSdkLauncher(worker, state);
  }

  // Use tmux paste-buffer to inject the seed prompt after Claude starts.
  // Passing long prompts as CLI args in interactive mode can hang Claude
  // due to argument buffering issues. tmux paste is reliable for any size.
  const script = `#!/usr/bin/env bash
cd "${state.workDir}"
${fleetEnv}
${customEnv ? customEnv + "\n" : ""}export PROJECT_ROOT="${state.workDir}"
export HOOKS_DIR="${hooksDir}"
export CLAUDE_FLEET_DIR="${fleetDir}"
export CLAUDE_CODE_SKIP_PROJECT_LOCK=1
export RESULTS_DIR="${resultsDir}"

# Launch Claude, then inject seed via tmux paste (more reliable than CLI arg)
SEED_FILE='${worker.seedPath}'
PANE_ID="\${TMUX_PANE:-}"

if [ -n "\$PANE_ID" ] && [ -f "\$SEED_FILE" ]; then
  ${execPrefix}claude --model ${worker.model}${effortFlag}${permFlag}${addDirFlag} &
  CLAUDE_PID=\$!
  sleep 5
  tmux load-buffer "\$SEED_FILE"
  tmux paste-buffer -t "\$PANE_ID"
  sleep 1
  tmux send-keys -t "\$PANE_ID" Enter
  wait \$CLAUDE_PID
else
  # Fallback: CLI arg (works for non-tmux or missing seed)
  exec ${execPrefix}claude --model ${worker.model}${effortFlag}${permFlag}${addDirFlag} "\$(cat '\${SEED_FILE}')"
fi
`;

  writeFileSync(worker.wrapperPath, script, { mode: 0o755 });
  return worker.wrapperPath;
}

/**
 * Generate a cleanup script for the entire pipeline session.
 */
export function generateCleanupScript(
  state: ProgramPipelineState,
): string {
  const fleetDir = process.env.CLAUDE_FLEET_DIR || join(process.env.HOME || "/tmp", ".claude-fleet");
  const cleanupPath = join(state.sessionDir, "cleanup.sh");

  const script = `#!/usr/bin/env bash
# Auto-cleanup for ${state.programName} pipeline workers
cd "${state.projectRoot}"
exec bun -e "
import('${fleetDir}/engine/program/fleet-provision.ts').then(m =>
  m.cleanupPipelineWorkers('${state.sessionHash}', '${state.fleetProject}')
).then(() => console.log('Cleanup complete'));
"
`;

  writeFileSync(cleanupPath, script, { mode: 0o755 });
  return cleanupPath;
}
