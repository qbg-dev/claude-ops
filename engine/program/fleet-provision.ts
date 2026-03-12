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

    const config: WorkerConfig = {
      model: worker.model,
      reasoning_effort: state.defaults.effort || "high",
      permission_mode: state.defaults.permission || "bypassPermissions",
      sleep_duration: null,
      window: null,
      worktree: state.workDir,
      branch: "HEAD",
      mcp: {},
      hooks: [],
      ephemeral: true,
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
      `# ${worker.name}\n${state.programName} ${worker.role} (ephemeral)`);
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

    console.log(`  Fleet Mail: ${provisioned}/${names.length} accounts provisioned`);
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
 * Generate a launch wrapper script for a compiled worker.
 */
export function generateLaunchWrapper(
  worker: CompiledWorker,
  state: ProgramPipelineState,
): string {
  const fleetEnv = buildMailEnvExport(worker.name, state.fleetProject);
  const hooksDir = join(FLEET_DATA, state.fleetProject, worker.name, "hooks");
  const fleetDir = process.env.CLAUDE_FLEET_DIR || join(process.env.HOME || "/tmp", ".claude-fleet");

  const script = `#!/usr/bin/env bash
cd "${state.workDir}"
${fleetEnv}
export PROJECT_ROOT="${state.workDir}"
export HOOKS_DIR="${hooksDir}"
export CLAUDE_FLEET_DIR="${fleetDir}"
exec claude --model ${worker.model} --dangerously-skip-permissions "$(cat '${worker.seedPath}')"
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
