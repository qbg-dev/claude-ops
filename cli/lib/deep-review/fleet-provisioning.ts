/**
 * Fleet provisioning for deep-review workers.
 * Creates ephemeral fleet workers with Fleet Mail accounts for review pipelines.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FLEET_DATA, FLEET_MAIL_URL, FLEET_MAIL_TOKEN } from "../../lib/paths";
import type { WorkerConfig, WorkerState } from "../../../shared/types";

export interface ReviewFleetOpts {
  sessionHash: string;
  project: string;
  /** Worker names: dr-{hash}-1, dr-{hash}-2, etc. */
  workerNames: string[];
  /** Coordinator name: dr-{hash}-coord */
  coordinatorName: string;
  /** Judge name: dr-{hash}-judge (null if --no-judge) */
  judgeName: string | null;
  /** Verifier names: dr-{hash}-v-chrome, etc. */
  verifierNames: string[];
  /** Shared worktree path (all workers share this) */
  sharedWorktree: string;
  /** Worker model (e.g. "opus") */
  workerModel: string;
  /** Coordinator model (e.g. "opus") */
  coordModel: string;
  /** tmux session name for deep-review */
  tmuxSession: string;
}

/** All worker names in a review fleet (workers + coord + judge + verifiers) */
function allNames(opts: ReviewFleetOpts): string[] {
  const names = [...opts.workerNames, opts.coordinatorName];
  if (opts.judgeName) names.push(opts.judgeName);
  names.push(...opts.verifierNames);
  return names;
}

/**
 * Provision a complete review fleet: per-worker dirs + Fleet Mail accounts.
 * Workers are ephemeral (watchdog skips them, auto-cleaned after completion).
 */
export async function provisionReviewFleet(opts: ReviewFleetOpts): Promise<Map<string, string>> {
  const tokens = new Map<string, string>();
  const names = allNames(opts);
  const projectDir = join(FLEET_DATA, opts.project);
  mkdirSync(projectDir, { recursive: true });

  // 1. Create per-worker fleet directories
  const now = new Date().toISOString();
  for (const name of names) {
    const workerDir = join(projectDir, name);
    mkdirSync(workerDir, { recursive: true });

    const isCoord = name === opts.coordinatorName;
    const isJudge = name === opts.judgeName;
    const model = isCoord ? opts.coordModel : opts.workerModel;

    const config: WorkerConfig = {
      model,
      reasoning_effort: "high",
      permission_mode: "bypassPermissions",
      sleep_duration: null,
      window: null,
      worktree: opts.sharedWorktree,
      branch: "HEAD",
      mcp: {},
      hooks: [],
      ephemeral: true,
      meta: {
        created_at: now,
        created_by: "deep-review",
        forked_from: null,
        project: opts.project,
      },
    };
    writeFileSync(join(workerDir, "config.json"), JSON.stringify(config, null, 2));

    const role = isCoord ? "coordinator" : isJudge ? "judge" : "reviewer";
    const state: WorkerState = {
      status: "active",
      pane_id: null,
      pane_target: null,
      tmux_session: opts.tmuxSession,
      session_id: `dr-${opts.sessionHash}`,
      past_sessions: [],
      last_relaunch: null,
      relaunch_count: 0,
      cycles_completed: 0,
      last_cycle_at: null,
      custom: { role, session_hash: opts.sessionHash },
    };
    writeFileSync(join(workerDir, "state.json"), JSON.stringify(state, null, 2));

    writeFileSync(join(workerDir, "mission.md"), `# ${name}\nDeep review ${role} (ephemeral)`);
  }

  // 2. Provision Fleet Mail accounts in parallel
  if (FLEET_MAIL_URL) {
    const mailHeaders: Record<string, string> = { "Content-Type": "application/json" };
    if (FLEET_MAIL_TOKEN) mailHeaders["Authorization"] = `Bearer ${FLEET_MAIL_TOKEN}`;

    const results = await Promise.allSettled(
      names.map(async (name) => {
        const accountName = `${name}@${opts.project}`;
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
            // Account exists — reset token
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
    throw new Error(
      "Fleet Mail is required for deep review. Configure it:\n" +
      "  fleet mail-server start    (local server)\n" +
      "  fleet mail-server connect  (remote server)"
    );
  }

  return tokens;
}

/**
 * Clean up a review fleet: delete mail accounts + remove fleet directories.
 */
export async function cleanupReviewFleet(
  sessionHash: string,
  project: string,
): Promise<void> {
  const projectDir = join(FLEET_DATA, project);
  if (!existsSync(projectDir)) return;

  // Find all workers belonging to this session (dr-{hash}-*)
  const prefix = `dr-${sessionHash}-`;
  const workers = readdirSync(projectDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith(prefix))
    .map((d) => d.name);

  if (workers.length === 0) return;

  // 1. Delete Fleet Mail accounts in parallel
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
        } catch {
          // Non-fatal — orphaned accounts are harmless
        }
      }),
    );
  }

  // 2. Remove per-worker fleet directories
  for (const name of workers) {
    try {
      rmSync(join(projectDir, name), { recursive: true, force: true });
    } catch {
      // Non-fatal
    }
  }

  console.log(`  Cleaned up ${workers.length} ephemeral workers (dr-${sessionHash}-*)`);
}

/**
 * Build the WORKER_NAME → mail token map for template substitution.
 * Returns env export lines for launch wrappers.
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
