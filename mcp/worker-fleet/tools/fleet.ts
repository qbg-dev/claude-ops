/**
 * Fleet tools — create_worker, fleet_help
 *
 * Removed tools (use fleet CLI instead):
 *   register_worker → fleet create / auto-detected
 *   deregister_worker → fleet stop + manual cleanup
 *   move_worker → tmux move-pane / fleet attach
 *   standby_worker → fleet stop / update_state
 *   fleet_template → fleet config / fleet_help docs
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, lstatSync, rmSync, unlinkSync, symlinkSync, copyFileSync, cpSync } from "fs";
import { join } from "path";
import { execSync, spawnSync } from "child_process";
import { HOME, PROJECT_ROOT, CLAUDE_FLEET, WORKERS_DIR, FLEET_DIR, WORKER_NAME, FLEET_MAIL_PROJECT, resolveProjectName } from "../config";
import {
  readRegistry, getWorkerEntry, withRegistryLocked, ensureWorkerInRegistry,
  readFleetConfig, readWorkerConfig, writeWorkerConfig, readWorkerState, writeWorkerState,
  writeLaunchScript, getDefaultSystemHooks,
  isMissionAuthority, getMissionAuthorityLabel,
  type WorkerConfig, type WorkerState, type RegistryConfig, type RegistryWorkerEntry,
} from "../registry";
import { findOwnPane, getSessionId } from "../tmux";
import { type WorkerType, type WorkerRuntime, type ReasoningEffort } from "../runtime";
import { FLEET_MAIL_URL } from "../mail-client";

// ── Types ──────────────────────────────────────────────────────────────

interface CreateWorkerInput {
  name: string;
  mission: string;
  type?: WorkerType;
  runtime?: WorkerRuntime;
  model?: string;
  reasoning_effort?: ReasoningEffort;
  sleep_duration?: number | null;
  disallowed_tools?: string[];
  window?: string;
  report_to?: string;
  permission_mode?: string;
  proposal_required?: boolean;
}

const TEMPLATE_TYPES_DIR = join(CLAUDE_FLEET, "templates/flat-worker/types");

function loadTypeTemplate(type: WorkerType): { model?: string; sleep_duration?: number | null; disallowedTools?: string[]; permission_mode?: string } {
  const typeDir = join(TEMPLATE_TYPES_DIR, type);
  const result: { model?: string; sleep_duration?: number | null; disallowedTools?: string[]; permission_mode?: string } = {};
  try {
    const perms = JSON.parse(readFileSync(join(typeDir, "permissions.json"), "utf-8"));
    if (perms.model) result.model = perms.model;
    if (perms.permission_mode) result.permission_mode = perms.permission_mode;
    if (Array.isArray(perms.denyList)) result.disallowedTools = perms.denyList;
  } catch {}
  try {
    const defaults = JSON.parse(readFileSync(join(typeDir, "defaults.json"), "utf-8"));
    // sleep_duration: null = one-shot, N > 0 = perpetual
    if ("sleep_duration" in defaults) result.sleep_duration = defaults.sleep_duration;
  } catch {}
  return result;
}

interface CreateWorkerResult {
  ok: boolean;
  error?: string;
  workerDir?: string;
  model?: string;
  runtime?: WorkerRuntime;
  /** @deprecated Derived from sleep_duration */
  perpetual?: boolean;
  state?: Record<string, any>;
  permissions?: Record<string, any>;
}

/** Core logic for creating a worker's directory and files. Exported for testing. */
export function createWorkerFiles(input: CreateWorkerInput): CreateWorkerResult {
  const { name, mission, type, runtime, model, reasoning_effort, sleep_duration, disallowed_tools, window: windowGroup, report_to, permission_mode } = input;
  const resolvedRuntime: WorkerRuntime = runtime || "claude";

  // Validate
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    return { ok: false, error: `Name must be kebab-case (got '${name}')` };
  }
  const workerDir = join(WORKERS_DIR, name);
  if (existsSync(workerDir)) {
    return { ok: false, error: `Worker '${name}' already exists at ${workerDir}` };
  }
  if (!mission.trim()) {
    return { ok: false, error: `Mission cannot be empty` };
  }

  // Load type template defaults (if type provided)
  const tpl = type ? loadTypeTemplate(type) : {};

  // Create directory
  mkdirSync(workerDir, { recursive: true });

  // MEMORY.md — project-level auto-memory subdirectory (shared across all workers)
  // Path: ~/.claude/projects/{project-slug}/memory/{worker-name}/MEMORY.md
  const projectSlug = PROJECT_ROOT.replace(/\//g, "-");
  const autoMemoryDir = join(HOME, ".claude", "projects", projectSlug, "memory", name);
  mkdirSync(autoMemoryDir, { recursive: true });
  const autoMemoryPath = join(autoMemoryDir, "MEMORY.md");
  // Remove stale symlink if present (legacy linkWorkerMemory artifact), then write real file
  try { if (lstatSync(autoMemoryPath).isSymbolicLink()) { rmSync(autoMemoryPath); } } catch {}
  if (!existsSync(autoMemoryPath)) {
    writeFileSync(autoMemoryPath, `# ${name} Memory\n\n`);
  }

  // mission.md — write to per-worker fleet dir + central missions + symlink from worktree
  const perWorkerFleetDir = join(FLEET_DIR, name);
  mkdirSync(perWorkerFleetDir, { recursive: true });
  const perWorkerMission = join(perWorkerFleetDir, "mission.md");
  writeFileSync(perWorkerMission, mission.trim() + "\n");

  // Also write to central missions dir for backward compatibility
  const centralMissionsDir = join(FLEET_DIR, "missions");
  mkdirSync(centralMissionsDir, { recursive: true });
  const centralMission = join(centralMissionsDir, `${name}.md`);
  writeFileSync(centralMission, mission.trim() + "\n");

  // Symlink from legacy workerDir to per-worker fleet mission
  const worktreeMission = join(workerDir, "mission.md");
  try { unlinkSync(worktreeMission); } catch {}
  try { symlinkSync(perWorkerMission, worktreeMission); } catch {
    // Fallback: write a copy if symlink fails
    writeFileSync(worktreeMission, mission.trim() + "\n");
  }

  // Config — override precedence: explicit param > type template > runtime default > hardcoded default
  const defaultDisallowed = [
    "Bash(git checkout main*)",
    "Bash(git merge*)",
    "Bash(git push*)",
    "Bash(git reset --hard*)",
    "Bash(git clean*)",
    "Bash(rm -rf*)",
  ];
  const runtimeModelDefault = resolvedRuntime === "codex" ? "gpt-5.4" : "opus";
  const selectedModel = model ?? tpl.model ?? runtimeModelDefault;
  const resolvedEffort: ReasoningEffort = reasoning_effort ?? "high";
  const resolvedDisallowed = disallowed_tools ?? tpl.disallowedTools ?? defaultDisallowed;
  const resolvedPermMode = permission_mode ?? tpl.permission_mode ?? "bypassPermissions";
  const permissions = {
    model: selectedModel,
    permission_mode: resolvedPermMode,
    reasoning_effort: resolvedEffort,
    disallowedTools: resolvedDisallowed,
    window: windowGroup || null,
    report_to: report_to || null,
    runtime: resolvedRuntime,
  };

  // State — override precedence: explicit param > type template > hardcoded default
  // sleep_duration: null = one-shot (never respawned), N > 0 = perpetual (respawn after N seconds)
  const resolvedSleepDuration: number | null = sleep_duration !== undefined ? sleep_duration : (tpl.sleep_duration !== undefined ? tpl.sleep_duration : null);
  const isPerpetual = resolvedSleepDuration !== null && resolvedSleepDuration > 0;
  const state: Record<string, any> = {
    status: "idle",
    sleep_duration: resolvedSleepDuration,
  };

  return { ok: true, workerDir, model: selectedModel, runtime: resolvedRuntime, perpetual: isPerpetual, state, permissions };
}

// ── Shared pane-move logic ──────────────────────────────────────────────
/** Move a worker's tmux pane to a target window. Returns a status string. */
function moveWorkerPane(
  paneId: string,
  tmuxSession: string,
  targetWindow: string,
): string {
  try {
    // Normalize common typos
    if (targetWindow === "stand-by") targetWindow = "standby";
    spawnSync("tmux", ["rename-window", "-t", `${tmuxSession}:stand-by`, "standby"], { encoding: "utf-8" });

    // Ensure target window exists
    const windowCheck = spawnSync("tmux", ["list-windows", "-t", tmuxSession, "-F", "#{window_name}"], { encoding: "utf-8" });
    const windows = (windowCheck.stdout || "").split("\n").map(w => w.trim());
    if (!windows.includes(targetWindow)) {
      spawnSync("tmux", ["new-window", "-t", tmuxSession, "-n", targetWindow, "-d"], { encoding: "utf-8" });
    }

    // Move the pane
    const moveRes = spawnSync("tmux", ["move-pane", "-s", paneId, "-t", `${tmuxSession}:${targetWindow}`], { encoding: "utf-8" });
    if (moveRes.status === 0) {
      spawnSync("tmux", ["select-layout", "-t", `${tmuxSession}:${targetWindow}`, "tiled"], { encoding: "utf-8" });
      return `Pane ${paneId}: moved to ${tmuxSession}:${targetWindow}`;
    } else {
      return `Pane ${paneId}: move failed — ${(moveRes.stderr || "").trim()}`;
    }
  } catch (e: any) {
    return `Pane move error: ${e.message}`;
  }
}

// ── Fleet handler functions ─────────────────────────────────────────────

type McpResult = { content: { type: "text"; text: string }[]; isError?: boolean };

async function handleFleetCreate(params: Record<string, any>): Promise<McpResult> {
  const { name, mission, type, runtime, model, reasoning_effort, sleep_duration, disallowed_tools: disallowedToolsJson, window: windowGroup, window_index: windowIndex, report_to, permission_mode, launch, proposal_required, fork_from_session, direct_report } = params;

  if (!name) return { content: [{ type: "text" as const, text: `Error: 'name' is required for create` }], isError: true };
  if (!mission) return { content: [{ type: "text" as const, text: `Error: 'mission' is required for create` }], isError: true };

  try {
    // Enforce unique worker names
    const existingRegistry = readRegistry();
    if (existingRegistry[name] && name !== "_config") {
      return { content: [{ type: "text" as const, text: `Error: Worker '${name}' already exists in registry. Choose a unique name.` }], isError: true };
    }

    // Parse disallowed_tools JSON if provided
    let disallowedTools: string[] | undefined;
    if (disallowedToolsJson) {
      try {
        const parsed = JSON.parse(disallowedToolsJson);
        if (!Array.isArray(parsed) || !parsed.every((t: any) => typeof t === "string")) {
          return { content: [{ type: "text" as const, text: `Error: disallowed_tools must be a JSON array of strings` }], isError: true };
        }
        disallowedTools = parsed;
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error parsing disallowed_tools JSON: ${e.message}` }], isError: true };
      }
    }

    // Validate fork_from_session requires launch
    if (fork_from_session && !launch) {
      return { content: [{ type: "text" as const, text: `Error: fork_from_session=true requires launch=true` }], isError: true };
    }

    // Create files
    const result = createWorkerFiles({ name, mission, type, runtime, model, reasoning_effort, sleep_duration, disallowed_tools: disallowedTools, window: windowGroup, report_to, permission_mode, proposal_required });
    if (!result.ok) {
      return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
    }

    // Determine report_to — default to chief-of-staff (mission_authority) unless explicit
    const config = readRegistry()._config as RegistryConfig | undefined;
    // For report_to, use first mission_authority name as default
    const firstMa = config?.mission_authority;
    const defaultReportTo = Array.isArray(firstMa) ? firstMa[0] : (firstMa || "chief-of-staff");
    const reportTo = direct_report
      ? WORKER_NAME
      : (report_to || defaultReportTo);

    // Register in unified registry + write per-worker dir files
    const { state, permissions, runtime: resolvedRuntime, model: selectedModel } = result as Required<CreateWorkerResult>;
    const isPerpetual = (state.sleep_duration ?? null) !== null && (state.sleep_duration ?? 0) > 0;

    // Write per-worker config.json directly
    const workerFleetDir = join(FLEET_DIR, name);
    mkdirSync(workerFleetDir, { recursive: true });
    // Merge system hooks + per-type hooks from fleet.json
    const allHooks = [...getDefaultSystemHooks()];
    if (type) {
      const fleetCfg = readFleetConfig();
      const typeHooks = (fleetCfg as any)?.hooks_by_type?.[type] || [];
      for (let i = 0; i < typeHooks.length; i++) {
        allHooks.push({ ...typeHooks[i], id: `type-${i + 1}`, owner: "creator" });
      }
    }
    const workerConfig: WorkerConfig = {
      model: permissions.model || "opus",
      reasoning_effort: permissions.reasoning_effort || "high",
      permission_mode: permissions.permission_mode || "bypassPermissions",
      sleep_duration: state.sleep_duration ?? null,
      window: permissions.window || null,
      worktree: null, // Will be set after worktree creation below
      branch: `worker/${name}`,
      mcp: {},
      hooks: allHooks,
      meta: {
        created_at: new Date().toISOString(),
        created_by: WORKER_NAME,
        forked_from: fork_from_session ? WORKER_NAME : null,
        project: FLEET_MAIL_PROJECT,
      },
    };
    writeWorkerConfig(name, workerConfig);

    // Write per-worker state.json
    const workerState: WorkerState = {
      status: state.status || "idle",
      pane_id: null,
      pane_target: null,
      tmux_session: readFleetConfig().tmux_session || "w",
      session_id: null,
      past_sessions: [],
      last_relaunch: null,
      relaunch_count: 0,
      cycles_completed: 0,
      last_cycle_at: null,
      custom: {
        ...(proposal_required ? { proposal_required: true } : {}),
      },
    };
    writeWorkerState(name, workerState);

    // Generate launch.sh
    writeLaunchScript(name, workerConfig);

    // Also update legacy registry for backward compatibility
    withRegistryLocked((registry) => {
      ensureWorkerInRegistry(registry, name);
      const entry = registry[name] as RegistryWorkerEntry;
      entry.model = permissions.model || "opus";
      entry.permission_mode = permissions.permission_mode || "bypassPermissions";
      entry.disallowed_tools = permissions.disallowedTools || [];
      entry.status = state.status || "idle";
      entry.perpetual = isPerpetual;  // derived from sleep_duration
      entry.sleep_duration = state.sleep_duration ?? null;
      if (permissions.window) {
        entry.window = permissions.window;
      }
      entry.report_to = reportTo;
      entry.custom = { ...entry.custom, runtime: resolvedRuntime || "claude", reasoning_effort: permissions.reasoning_effort || "high" };
      if (proposal_required) {
        entry.custom.proposal_required = true;
      }
      if (fork_from_session) {
        entry.forked_from = WORKER_NAME;
      }
    });

    // Create worktree for the new worker
    const projectName = PROJECT_ROOT.split("/").pop()!.replace(/-w-.*$/, "");
    const worktreeDir = join(PROJECT_ROOT, "..", `${projectName}-w-${name}`);
    const workerBranch = `worker/${name}`;
    let worktreeReady = false;
    try {
      if (!existsSync(worktreeDir)) {
        try { execSync(`git -C "${PROJECT_ROOT}" branch "${workerBranch}" HEAD 2>/dev/null`, { timeout: 5000 }); } catch {}
        execSync(`git -C "${PROJECT_ROOT}" worktree add "${worktreeDir}" "${workerBranch}"`, { encoding: "utf-8", timeout: 10000 });
      }
      worktreeReady = true;
      // Update per-worker config with worktree path
      const latestConfig = readWorkerConfig(name);
      if (latestConfig) {
        latestConfig.worktree = worktreeDir;
        writeWorkerConfig(name, latestConfig);
        writeLaunchScript(name, latestConfig);
      }
      // Ensure .mcp.json includes claude-hooks for this worker
      const baseMcp = join(PROJECT_ROOT, ".mcp.json");
      try {
        const claudeHooksDir = process.env.CLAUDE_HOOKS_DIR || join(HOME, ".claude-hooks");
        const claudeHooksMcp = join(claudeHooksDir, "mcp/index.ts");
        if (existsSync(claudeHooksMcp)) {
          let mcpCfg: Record<string, any> = { mcpServers: {} };
          if (existsSync(baseMcp)) {
            try { mcpCfg = JSON.parse(readFileSync(baseMcp, "utf-8")); } catch {}
          }
          if (!mcpCfg.mcpServers) mcpCfg.mcpServers = {};
          const bunPath = process.execPath || join(HOME, ".bun/bin/bun");
          mcpCfg.mcpServers["claude-hooks"] = {
            command: bunPath,
            args: ["run", claudeHooksMcp],
            env: {
              HOOKS_DIR: join(FLEET_DIR, name, "hooks"),
              HOOKS_IDENTITY: name,
              HOOKS_PERMISSIONS: join(PROJECT_ROOT, ".claude/workers", name, "permissions.json"),
            },
          };
          writeFileSync(baseMcp, JSON.stringify(mcpCfg, null, 2) + "\n");
        }
      } catch {}
      // Symlink .mcp.json to project root (single source of truth for MCP config)
      const wtMcp = join(worktreeDir, ".mcp.json");
      if (existsSync(baseMcp)) {
        try { unlinkSync(wtMcp); } catch {}
        try { symlinkSync(baseMcp, wtMcp); } catch {}
      }
      // Symlink gitignored essential files (.env, users.json, projects.json) from main repo
      const setupScript = join(PROJECT_ROOT, ".claude/scripts/worker/setup-worktree.sh");
      if (existsSync(setupScript)) {
        try { execSync(`bash "${setupScript}" "${worktreeDir}"`, { timeout: 5000 }); } catch {}
      }
      // Copy mission.md into the worktree's .claude/workers/{name}/ dir
      // so seed.ts can find it when PROJECT_ROOT is the worktree
      const wtWorkerDir = join(worktreeDir, ".claude/workers", name);
      mkdirSync(wtWorkerDir, { recursive: true });
      const wtMissionPath = join(wtWorkerDir, "mission.md");
      try { writeFileSync(wtMissionPath, mission.trim() + "\n"); } catch {}
    } catch {}

    // ── Launch helpers (shared by all placement modes) ──

    /** Create a tmux pane in the named window group. Returns pane ID or null. */
    function createPane(_pl: string, cwd: string): string | null {
      const ownPane = findOwnPane();
      const tmuxSession = ownPane?.paneTarget?.split(":")[0] || "w";
      const winName = windowGroup || "workers";
      const winCheck = spawnSync("tmux", ["list-windows", "-t", tmuxSession, "-F", "#{window_name}"], { encoding: "utf-8" });
      const windows = (winCheck.stdout || "").split("\n").map(w => w.trim());
      if (!windows.includes(winName)) {
        // Use explicit window index if provided, otherwise let tmux auto-assign
        const target = windowIndex != null ? `${tmuxSession}:${windowIndex}` : tmuxSession;
        return execSync(
          `tmux new-window -t "${target}" -n "${winName}" -d -P -F '#{pane_id}' -c "${cwd}"`,
          { encoding: "utf-8", timeout: 5000 }
        ).trim();
      }
      const paneId = execSync(
        `tmux split-window -t "${tmuxSession}:${winName}" -d -P -F '#{pane_id}' -c "${cwd}"`,
        { encoding: "utf-8", timeout: 5000 }
      ).trim();
      spawnSync("tmux", ["select-layout", "-t", `${tmuxSession}:${winName}`, "tiled"], { encoding: "utf-8" });
      return paneId;
    }

    /** Register a newly created pane in the registry. */
    function registerPane(paneId: string) {
      let paneTarget = "";
      try {
        paneTarget = execSync(
          `tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' | awk -v id="${paneId}" '$1 == id {print $2}'`,
          { encoding: "utf-8", timeout: 5000 }
        ).trim();
      } catch {}
      withRegistryLocked((registry) => {
        const entry = registry[name] as RegistryWorkerEntry;
        if (entry) {
          entry.pane_id = paneId;
          entry.pane_target = paneTarget;
          entry.tmux_session = paneTarget?.split(":")[0] || "w";
        }
      });
    }

    // ── Optional launch ──
    // Non-fork launches use TypeScript launchInTmux() (reliable: waits for TUI, paste-buffer, retries).
    // Fork uses fork-worker.sh (inherits conversation context — needs session data copy).
    // Never use spawnInPane + tmux send-keys — it's fragile and breaks on escaping.
    let launchInfo = "";
    if (launch) {
      if (fork_from_session) {
        // Fork path: inherit caller's conversation context via fork-worker.sh
        const ownPane = findOwnPane();
        const sessionId = ownPane ? getSessionId(ownPane.paneId) : null;
        if (!ownPane) {
          launchInfo = `\n  Launch: SKIPPED — could not find own pane (not in tmux?). Run manually: bash fork-worker.sh`;
        } else if (!sessionId) {
          launchInfo = `\n  Launch: SKIPPED — no session ID for pane ${ownPane.paneId}. Run manually: bash fork-worker.sh`;
        } else {
          // Copy session data to new worktree's project dir.
          // Session JSONLs are stored under ~/.claude/projects/{cwd-slug}/.
          // Search all project dirs for the session file (session IDs are globally unique)
          // instead of assuming it's under process.cwd()'s slug.
          if (worktreeReady) {
            try {
              const { readdirSync } = await import("fs");
              const projectsDir = join(HOME, ".claude/projects");
              let parentProj = "";
              // Search all project dirs for the session file
              for (const dir of readdirSync(projectsDir)) {
                const candidate = join(projectsDir, dir, `${sessionId}.jsonl`);
                if (existsSync(candidate)) {
                  parentProj = join(projectsDir, dir);
                  break;
                }
              }
              // Fallback: try cwd-based slug (original behavior)
              if (!parentProj) {
                const callerCwd = process.cwd();
                const parentSlug = callerCwd.replace(/\//g, "-");
                parentProj = join(HOME, ".claude/projects", parentSlug);
              }
              const newSlug = worktreeDir.replace(/\//g, "-");
              const newProj = join(HOME, ".claude/projects", newSlug);
              mkdirSync(newProj, { recursive: true });
              const jsonlSrc = join(parentProj, `${sessionId}.jsonl`);
              if (existsSync(jsonlSrc)) copyFileSync(jsonlSrc, join(newProj, `${sessionId}.jsonl`));
              const subdirSrc = join(parentProj, sessionId);
              if (existsSync(subdirSrc)) cpSync(subdirSrc, join(newProj, sessionId), { recursive: true });
            } catch {} // non-fatal
          }

          // Fork needs a TTY (Claude runs interactively), so we must run inside the pane.
          // Write a self-contained wrapper script and send just "bash /tmp/wrapper.sh" to the pane.
          // The wrapper cleans up AFTER fork-worker.sh finishes (blocking), avoiding race conditions.
          try {
            const childPaneId = createPane("window", worktreeReady ? worktreeDir : PROJECT_ROOT);
            if (!childPaneId?.startsWith("%")) {
              launchInfo = `\n  Launch: SKIPPED — pane creation failed. Run manually.`;
            } else {
              registerPane(childPaneId);
              const forkScript = join(CLAUDE_FLEET, "scripts/fork-worker.sh");
              const workerModel = selectedModel || "opus";
              const workerDir = join(PROJECT_ROOT, ".claude/workers", name);
              const cwdFlag = worktreeReady ? `--cwd ${worktreeDir}` : "";
              const wrapperPath = `/tmp/fork-launch-${name}-${Date.now()}.sh`;

              // Write wrapper script — fork-worker.sh blocks until Claude exits, so cleanup is safe
              const wrapperContent = [
                `#!/bin/bash`,
                `cd ${worktreeReady ? worktreeDir : PROJECT_ROOT}`,
                `bash ${forkScript} ${ownPane.paneId} ${sessionId} --name ${name} --no-worktree ${cwdFlag} --model ${workerModel} --dangerously-skip-permissions --add-dir ${workerDir}`,
                `rm -f "${wrapperPath}"`,
              ].join("\n");
              writeFileSync(wrapperPath, wrapperContent, { mode: 0o755 });

              // Send short command to pane — no escaping issues
              execSync(`tmux send-keys -t "${childPaneId}" "bash ${wrapperPath}" && tmux send-keys -t "${childPaneId}" -H 0d`, { timeout: 5000 });
              launchInfo = `\n  Launched (fork from ${sessionId}): pane ${childPaneId}`;
            }
          } catch (e: any) {
            launchInfo = `\n  Launch: FAILED — ${e.message}`;
          }
        }
      } else {
        // Non-fork: use TypeScript launchInTmux (handles Claude + Codex, seed injection, state update)
        try {
          const { launchInTmux } = await import("../../../cli/lib/launch");
          const projectName = resolveProjectName();
          const fleetConfig = readFleetConfig();
          const sess = fleetConfig?.tmux_session || "w";
          const winGroup = windowGroup || permissions.window || name;
          const launchedPaneId = await launchInTmux(
            name, projectName, sess, winGroup, windowIndex ?? undefined,
            { runtime: (resolvedRuntime as "claude" | "codex") || "claude" },
          );
          launchInfo = `\n  Launched: pane ${launchedPaneId}`;
        } catch (e: any) {
          launchInfo = `\n  Launch: FAILED — ${e.message}`;
        }
      }
    } else {
      launchInfo = `\n  Launch: manual — fleet start ${name}`;
    }

    // Return summary
    const summary = [
      `Created worker/${name}:`,
      `  Dir: .claude/workers/${name}/`,
      `  Runtime: ${resolvedRuntime} | Model: ${selectedModel} | Perpetual: ${isPerpetual}`,
      permissions.window ? `  Window: ${permissions.window}` : null,
      `  Reports to: ${reportTo}`,
      fork_from_session ? `  Forked from: ${WORKER_NAME}` : null,
      proposal_required ? `  Proposal: REQUIRED (worker produces HTML proposal before coding)` : null,
      permissions.disallowedTools.length > 0 ? `  Disallowed: ${permissions.disallowedTools.length} rules` : `  Disallowed: none (full access)`,
      worktreeReady ? `  Worktree: ${worktreeDir}` : `  Worktree: NOT CREATED (manual setup needed)`,
      launchInfo.trim() ? `  ${launchInfo.trim()}` : null,
    ].filter(Boolean).join("\n");

    return { content: [{ type: "text" as const, text: summary }] };
  } catch (e: any) {
    return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
  }
}

async function handleFleetTemplate(params: Record<string, any>): Promise<McpResult> {
  const { type } = params;
  if (!type) return { content: [{ type: "text" as const, text: `Error: 'type' is required for template` }], isError: true };

  const typeDir = join(TEMPLATE_TYPES_DIR, type);
  if (!existsSync(typeDir)) {
    return { content: [{ type: "text" as const, text: `Error: template type '${type}' not found at ${typeDir}` }], isError: true };
  }
  const sections: string[] = [`# Template: ${type}\n`];
  try {
    sections.push("## mission.md (structure to follow)\n```markdown\n" + readFileSync(join(typeDir, "mission.md"), "utf-8").trim() + "\n```\n");
  } catch { sections.push("## mission.md\n_Not found_\n"); }
  try {
    const perms = JSON.parse(readFileSync(join(typeDir, "permissions.json"), "utf-8"));
    sections.push("## Defaults (from permissions.json)\n" +
      `- **model**: ${perms.model || "opus"}\n` +
      `- **permission_mode**: ${perms.permission_mode || "bypassPermissions"}\n` +
      `- **denyList** (${(perms.denyList || []).length} rules): ${(perms.denyList || []).map((r: string) => `\`${r}\``).join(", ") || "none"}\n`);
  } catch { sections.push("## permissions.json\n_Not found_\n"); }
  try {
    const defaults = JSON.parse(readFileSync(join(typeDir, "defaults.json"), "utf-8"));
    const sdLabel = defaults.sleep_duration === null ? "null (one-shot)" : `${defaults.sleep_duration}s`;
    sections.push("## Defaults (from defaults.json)\n" +
      `- **sleep_duration**: ${sdLabel}\n`);
  } catch { sections.push("## defaults.json\n_Not found_\n"); }
  sections.push("## Usage\n`create_worker(name=\"...\", type=\"" + type + "\", mission=\"# Your mission here\\n...\")`\nThe `type` sets model/permissions/sleep defaults. You always write your own mission. Explicit params override type defaults.");
  return { content: [{ type: "text" as const, text: sections.join("\n") }] };
}

async function handleFleetMove(params: Record<string, any>): Promise<McpResult> {
  const { name, window: targetWindow, reason } = params;
  if (!targetWindow) return { content: [{ type: "text" as const, text: `Error: 'window' is required for move` }], isError: true };

  const targetName = name || WORKER_NAME;

  // Authorization: self or mission_authority
  const _mwRegistry = readRegistry();
  const _mwConfig = _mwRegistry._config as RegistryConfig | undefined;
  const _mwAuth = getMissionAuthorityLabel(_mwConfig);
  if (targetName !== WORKER_NAME && !isMissionAuthority(WORKER_NAME, _mwConfig)) {
    return {
      content: [{
        type: "text" as const,
        text: `Only ${_mwAuth} (mission_authority) can move other workers. Contact ${_mwAuth}.`,
      }],
      isError: true,
    };
  }

  const existing = getWorkerEntry(targetName);
  if (!existing) {
    return {
      content: [{ type: "text" as const, text: `Worker '${targetName}' not found in registry.` }],
      isError: true,
    };
  }

  const paneId = existing.pane_id;
  const tmuxSession = existing.tmux_session || "w";

  if (!paneId) {
    return {
      content: [{ type: "text" as const, text: `Worker '${targetName}' has no pane_id — cannot move.` }],
      isError: true,
    };
  }

  // Move the pane
  const moveResult = moveWorkerPane(paneId, tmuxSession, targetWindow);

  // Update registry
  const previousWindow = existing.window;
  const isMovingToStandby = targetWindow === "standby";
  const isMovingFromStandby = existing.status === "standby" && targetWindow !== "standby";

  withRegistryLocked((registry) => {
    const entry = registry[targetName] as RegistryWorkerEntry;
    if (entry) {
      entry.window = targetWindow;
      if (isMovingToStandby) {
        entry.status = "standby";
      } else if (isMovingFromStandby) {
        entry.status = "active";
      }
    }
  });

  // Write handoff if going to standby
  if (isMovingToStandby && reason) {
    try {
      const handoffPath = join(WORKERS_DIR, targetName, "handoff.md");
      const timestamp = new Date().toISOString();
      writeFileSync(handoffPath, `# Standby\n\n**At:** ${timestamp}\n**Reason:** ${reason}\n\nWorker is in standby — registered but not running. Call move_worker(name="${targetName}", window="${previousWindow || targetName}") to wake.\n`);
    } catch {}
  }

  const statusChange = isMovingToStandby
    ? " status=standby (watchdog will ignore)"
    : isMovingFromStandby
      ? " status=active (woken from standby)"
      : "";

  return {
    content: [{
      type: "text" as const,
      text: [
        `Worker '${targetName}' moved: ${previousWindow || "?"} → ${targetWindow}.${statusChange}`,
        `  ${moveResult}`,
        reason ? `  Reason: ${reason}` : null,
      ].filter(Boolean).join("\n"),
    }],
  };
}

async function handleFleetStandby(params: Record<string, any>): Promise<McpResult> {
  const { name, reason } = params;
  const targetName = name || WORKER_NAME;

  // Authorization: self-only unless mission_authority
  const _sbRegistry = readRegistry();
  const _sbConfig = _sbRegistry._config as RegistryConfig | undefined;
  const _sbAuth = getMissionAuthorityLabel(_sbConfig);
  if (targetName !== WORKER_NAME && !isMissionAuthority(WORKER_NAME, _sbConfig)) {
    return {
      content: [{
        type: "text" as const,
        text: `Only ${_sbAuth} (mission_authority) can toggle standby for other workers. Contact ${_sbAuth}.`,
      }],
      isError: true,
    };
  }

  const existing = getWorkerEntry(targetName);
  if (!existing) {
    return {
      content: [{ type: "text" as const, text: `Worker '${targetName}' not found in registry.` }],
      isError: true,
    };
  }

  const isStandby = existing.status === "standby";
  const tmuxSession = existing.tmux_session || "w";

  if (isStandby) {
    // ── WAKE UP: standby → active ──
    // Move the pane back to its original window
    const paneId = existing.pane_id;
    const originalWindow = existing.window || targetName;
    let moveResult = "";

    if (paneId) {
      moveResult = moveWorkerPane(paneId, tmuxSession, originalWindow);
    } else {
      moveResult = "No pane_id in registry — pane may have been killed";
    }

    withRegistryLocked((registry) => {
      const entry = registry[targetName] as RegistryWorkerEntry;
      if (entry) {
        entry.status = "active";
        // Restore window to original (move_window set it to "standby")
        if (originalWindow !== "standby") entry.window = originalWindow;
      }
    });

    return {
      content: [{
        type: "text" as const,
        text: [
          `Worker '${targetName}' → active (woken from standby).`,
          `  Registry: status=active`,
          reason ? `  Reason: ${reason}` : null,
          moveResult ? `  ${moveResult}` : null,
        ].filter(Boolean).join("\n"),
      }],
    };
  }

  // ── STANDBY: active → standby ──

  // Write handoff.md
  if (reason) {
    try {
      const handoffPath = join(WORKERS_DIR, targetName, "handoff.md");
      const timestamp = new Date().toISOString();
      writeFileSync(handoffPath, `# Standby\n\n**At:** ${timestamp}\n**Reason:** ${reason}\n\nWorker is in standby — registered but not running. Call standby_worker(name="${targetName}") again to wake.\n`);
    } catch {}
  }

  // Check for unread Fleet Mail (best-effort)
  let standbyPendingWarning = "";
  try {
    const targetEntry = getWorkerEntry(targetName);
    const mailToken =(targetEntry as any)?.bms_token;
    if (mailToken) {
      const resp = await fetch(`${FLEET_MAIL_URL}/api/messages?label=UNREAD&maxResults=1`, {
        headers: { Authorization: `Bearer ${mailToken}` },
        signal: AbortSignal.timeout(3000),
      });
      if (resp.ok) {
        const data = await resp.json() as any;
        const unread = data?._diagnostics?.unread_count || 0;
        if (unread > 0) {
          standbyPendingWarning = `\n  WARNING: ${unread} unread mail in ${targetName}'s inbox`;
        }
      }
    }
  } catch {}

  // Set status = standby and move pane
  const paneId = existing.pane_id;
  let moveResult = "";

  withRegistryLocked((registry) => {
    const entry = registry[targetName] as RegistryWorkerEntry;
    if (entry) {
      entry.status = "standby";
    }
  });

  if (paneId) {
    moveResult = moveWorkerPane(paneId, tmuxSession, "standby");
  } else {
    moveResult = "No active pane to move";
  }

  return {
    content: [{
      type: "text" as const,
      text: [
        `Worker '${targetName}' → standby.`,
        `  Registry: status=standby (watchdog will ignore it)`,
        moveResult ? `  ${moveResult}` : null,
        reason ? `  Handoff: written to .claude/workers/${targetName}/handoff.md` : null,
        ``,
        standbyPendingWarning || null,
        ``,
        `To resume: call standby_worker(name="${targetName}") again, or: fleet start ${targetName}`,
      ].filter(Boolean).join("\n"),
    }],
  };
}

async function handleFleetRegister(params: Record<string, any>): Promise<McpResult> {
  const { model, sleep_duration, report_to } = params;

  try {
    const ownPane = findOwnPane();
    let paneTarget = "";
    let tmuxSession = "w";
    if (ownPane) {
      paneTarget = ownPane.paneTarget || "";
      tmuxSession = paneTarget.split(":")[0] || "w";
    }

    const fleetConfig = readFleetConfig();
    const maVal = fleetConfig?.mission_authority;
    const defaultReportTo = Array.isArray(maVal) ? maVal[0] : (maVal || "chief-of-staff");

    // Update per-worker dir files directly
    const workerDir = join(FLEET_DIR, WORKER_NAME);
    mkdirSync(workerDir, { recursive: true });

    // Config — create or update
    let wConfig = readWorkerConfig(WORKER_NAME);
    if (!wConfig) {
      const projectName = resolveProjectName();
      const worktreeDir = join(PROJECT_ROOT, "..", `${projectName}-w-${WORKER_NAME}`);
      wConfig = {
        model: model || "opus",
        reasoning_effort: "high",
        permission_mode: "bypassPermissions",
        sleep_duration: sleep_duration ?? null,
        window: null,
        worktree: existsSync(worktreeDir) ? worktreeDir : null,
        branch: `worker/${WORKER_NAME}`,
        mcp: {},
        hooks: [...getDefaultSystemHooks()],
        meta: {
          created_at: new Date().toISOString(),
          created_by: "self-register",
          forked_from: null,
          project: FLEET_MAIL_PROJECT,
        },
      };
    } else {
      if (model) wConfig.model = model;
      if (sleep_duration !== undefined) wConfig.sleep_duration = sleep_duration;
    }
    writeWorkerConfig(WORKER_NAME, wConfig);
    writeLaunchScript(WORKER_NAME, wConfig);

    // State — create or update
    let wState = readWorkerState(WORKER_NAME);
    const sessionId = ownPane ? getSessionId(ownPane.paneId) : null;
    if (!wState) {
      wState = {
        status: "active",
        pane_id: ownPane?.paneId || null,
        pane_target: paneTarget || null,
        tmux_session: tmuxSession,
        session_id: sessionId || null,
        past_sessions: [],
        last_relaunch: null,
        relaunch_count: 0,
        cycles_completed: 0,
        last_cycle_at: null,
        custom: {},
      };
    } else {
      wState.status = "active";
      if (ownPane) {
        wState.pane_id = ownPane.paneId;
        wState.pane_target = paneTarget;
        wState.tmux_session = tmuxSession;
        if (sessionId) wState.session_id = sessionId;
      }
    }
    writeWorkerState(WORKER_NAME, wState);

    // Also update legacy registry for backward compatibility
    withRegistryLocked((reg) => {
      const entry = ensureWorkerInRegistry(reg, WORKER_NAME);
      entry.status = "active";
      entry.model = model || entry.model || "opus";
      if (sleep_duration !== undefined) {
        entry.sleep_duration = sleep_duration;
        entry.perpetual = sleep_duration !== null && sleep_duration > 0;
      }
      entry.report_to = report_to || entry.report_to || defaultReportTo;
      entry.custom = {
        ...(entry.custom || {}),
        runtime: entry.custom?.runtime || process.env.WORKER_RUNTIME || "claude",
      };
      if (ownPane) {
        entry.pane_id = ownPane.paneId;
        entry.pane_target = paneTarget;
        entry.tmux_session = tmuxSession;
        const sid = getSessionId(ownPane.paneId);
        if (sid) entry.session_id = sid;
      }
    });

    const paneInfo = ownPane ? `pane ${ownPane.paneId} (${paneTarget})` : "no pane detected";
    const sessionInfo = sessionId ? `, session: ${sessionId.slice(0, 8)}…` : "";
    return {
      content: [{
        type: "text" as const,
        text: `Registered '${WORKER_NAME}' — ${paneInfo}${sessionInfo}, model: ${model || "opus"}, report_to: ${report_to || defaultReportTo}\n  Fleet dir: ${workerDir}/`,
      }],
    };
  } catch (e: any) {
    return { content: [{ type: "text" as const, text: `Register failed: ${e.message}` }], isError: true };
  }
}

async function handleFleetDeregister(params: Record<string, any>): Promise<McpResult> {
  const { name, reason } = params;
  const targetName = name || WORKER_NAME;

  // Authorization: only self-deregister, OR mission_authority can deregister anyone
  const _drRegistry = readRegistry();
  const _drConfig = _drRegistry._config as RegistryConfig | undefined;
  const _drAuth = getMissionAuthorityLabel(_drConfig);
  if (targetName !== WORKER_NAME && !isMissionAuthority(WORKER_NAME, _drConfig)) {
    return {
      content: [{
        type: "text" as const,
        text: `Only ${_drAuth} (mission_authority) can deregister other workers. Contact ${_drAuth} to deregister '${targetName}'.`,
      }],
      isError: true,
    };
  }

  // Check worker exists
  const existing = getWorkerEntry(targetName);
  if (!existing) {
    return {
      content: [{ type: "text" as const, text: `Worker '${targetName}' not found in registry.` }],
      isError: true,
    };
  }

  // Require HANDOFF.md before deregistration
  const handoffPath = join(WORKERS_DIR, targetName, "HANDOFF.md");
  let hasHandoff = false;
  try { hasHandoff = existsSync(handoffPath) && readFileSync(handoffPath, "utf-8").trim().length > 50; } catch {}
  if (!hasHandoff) {
    return {
      content: [{
        type: "text" as const,
        text: [
          `HANDOFF.md required before deregistering '${targetName}'.`,
          ``,
          `Before unregistering, write a HANDOFF.md at:`,
          `  .claude/workers/${targetName}/HANDOFF.md`,
          ``,
          `Include:`,
          `  - Generalizable learnings (patterns, gotchas, conventions discovered)`,
          `  - Business process details specific to this domain`,
          `  - Important repo/architecture details you learned`,
          `  - Any unfinished work or known issues`,
          `  - Recommendations for whoever picks this up next`,
          ``,
          `Then call deregister_worker() again.`,
        ].join("\n"),
      }],
      isError: true,
    };
  }

  // Append deregistration metadata to handoff
  if (reason) {
    try {
      const timestamp = new Date().toISOString();
      const appendix = `\n\n---\n## Deregistered\n\n**By:** ${WORKER_NAME}\n**At:** ${timestamp}\n**Reason:** ${reason}\n`;
      appendFileSync(handoffPath, appendix);
    } catch {
      // Best-effort
    }
  }

  const preservedWorktree = existing.worktree || "(none registered)";

  // Remove entry from registry (files and worktree are NOT touched)
  withRegistryLocked((registry) => {
    delete registry[targetName];
  });

  return {
    content: [{
      type: "text" as const,
      text: [
        `Deregistered '${targetName}' from registry.`,
        ``,
        `Preserved (not deleted):`,
        `  Worker files: .claude/workers/${targetName}/`,
        `  Git worktree: ${preservedWorktree}`,
        ``,
        `To fully clean up when ready:`,
        `  git worktree remove ${preservedWorktree}`,
        `  rm -rf .claude/workers/${targetName}/`,
      ].join("\n"),
    }],
  };
}

// spawn_feature removed — use Agent tool with isolation:"worktree" instead (zero infrastructure)

function handleFleetHelp(): McpResult {
  return {
    content: [{
      type: "text" as const,
      text: [
        `# Fleet Management`,
        ``,
        `## MCP Tools (core)`,
        ``,
        `### create_worker(name, mission, ...) — Spawn a new worker`,
        `Required: name, mission. Optional: type, runtime, model, reasoning_effort,`,
        `sleep_duration, window, report_to, permission_mode, launch, direct_report.`,
        ``,
        `### fleet_help() — This reference`,
        ``,
        `## Fleet CLI (from bash)`,
        ``,
        `The fleet CLI covers everything beyond the core MCP tools:`,
        ``,
        `\`\`\`bash`,
        `fleet ls                          # List all workers with status`,
        `fleet start <name>                # Start/restart a worker`,
        `fleet stop <name> [--all]         # Graceful stop`,
        `fleet attach <name>               # Focus worker's tmux pane`,
        `fleet config <name> [key] [value] # Get/set per-worker config`,
        `fleet defaults [key] [value]      # Get/set fleet-wide defaults`,
        `fleet log <name>                  # Tail worker output`,
        `fleet mail <name>                 # Check worker's inbox`,
        `fleet fork <parent> <child>       # Fork from existing session`,
        `fleet doctor                      # Health check`,
        `\`\`\``,
        ``,
        `## Deep Review (from bash)`,
        ``,
        `\`\`\`bash`,
        `bash ~/.deep-review/scripts/deep-review.sh --scope main --spec "verify changes"`,
        `# Options: --passes N, --focus "security,logic", --verify, --no-judge, --no-context`,
        `\`\`\``,
        ``,
        `## Common Operations (CLI equivalents)`,
        ``,
        `| Operation | How |`,
        `|-----------|-----|`,
        `| Move pane to window | \`tmux move-pane -t w:window-name\` |`,
        `| Toggle standby | \`fleet stop <name>\` / \`fleet start <name>\` |`,
        `| Update worker config | \`fleet config <name> key value\` |`,
        `| Update fleet defaults | \`fleet defaults key value\` |`,
        `| Preview archetype | \`fleet config <name>\` (shows full config) |`,
        `| Deregister worker | \`fleet stop <name>\` + remove worker dir |`,
      ].join("\n"),
    }],
  };
}

// ── Tool Registration ────────────────────────────────────────────────────

export function registerFleetTools(server: McpServer): void {

// @ts-ignore — MCP SDK deep type instantiation with Zod
server.registerTool(
  "create_worker",
  {
    description: "Create a new worker with full AgentSpec support: worktree, branch, registry entry, hooks, tools, optional launch.",
    inputSchema: {
      name: z.string().describe("Worker name (alphanumeric + hyphens)"),
      mission: z.string().optional().describe("Mission markdown content (or use prompt)"),
      prompt: z.string().optional().describe("Initial prompt (AgentSpec: replaces mission as seed content)"),
      type: z.enum(["implementer", "monitor", "coordinator", "optimizer", "verifier"]).optional().describe("Worker archetype"),
      runtime: z.enum(["claude", "codex"]).optional().describe("Execution engine (default: claude)"),
      model: z.string().optional().describe("LLM model override"),
      reasoning_effort: z.enum(["low", "medium", "high", "extra_high"]).optional().describe("Depth of reasoning (default: high)"),
      effort: z.string().optional().describe("Alias for reasoning_effort"),
      sleep_duration: z.number().nullable().optional().describe("Seconds between cycles. null = one-shot, N > 0 = perpetual"),
      disallowed_tools: z.string().optional().describe("JSON array of tool deny-list patterns"),
      allowed_tools: z.string().optional().describe("JSON array of allowed tool patterns"),
      window: z.string().optional().describe("Target tmux window name"),
      window_index: z.number().optional().describe("Explicit tmux window index for new windows"),
      report_to: z.string().optional().describe("Who this worker reports to"),
      permission_mode: z.string().optional().describe("Claude permission mode (default: bypassPermissions)"),
      launch: z.boolean().optional().describe("Launch immediately after creation"),
      proposal_required: z.boolean().optional().describe("Require HTML proposal before coding"),
      fork_from_session: z.boolean().optional().describe("Fork caller's session (requires launch=true)"),
      direct_report: z.boolean().optional().describe("Set report_to to calling worker"),
      // ── AgentSpec extensions ──
      spec_file: z.string().optional().describe("Path to .agent.yaml/.agent.json spec file (overrides inline params)"),
      system_prompt: z.string().optional().describe("Custom system prompt"),
      append_system_prompt: z.string().optional().describe("Append to default system prompt"),
      add_dir: z.string().optional().describe("JSON array of additional directories"),
      tools: z.string().optional().describe("JSON array of EventTool definitions [{name,description,mode,handler,inputSchema}]"),
      hooks: z.string().optional().describe("JSON array of hook definitions [{event,type,command,to,subject,body}]"),
      env: z.string().optional().describe("JSON object of environment variables"),
      on_stop: z.string().optional().describe("Command to run on Stop (shorthand for hooks)"),
      max_budget_usd: z.number().optional().describe("Cost cap in USD"),
      worktree: z.boolean().optional().describe("Create git worktree (default: true)"),
      ephemeral: z.boolean().optional().describe("Auto-cleanup on completion"),
    },
  },
  // @ts-ignore — MCP SDK deep type instantiation with Zod
  async (params: Record<string, any>) => {
    // If spec_file provided, load it and merge with inline params
    if (params.spec_file) {
      try {
        const { loadAgentSpec } = await import("../../../shared/types");
        const spec = loadAgentSpec(params.spec_file);
        // Spec fields become defaults, inline params override
        if (!params.name && spec.name) params.name = spec.name;
        if (!params.mission && !params.prompt && spec.prompt) params.prompt = spec.prompt;
        if (!params.mission && !params.prompt && spec.role) params.mission = spec.role;
        if (!params.model && spec.model) params.model = spec.model;
        if (!params.runtime && spec.runtime) params.runtime = spec.runtime;
        if (!params.permission_mode && spec.permission_mode) params.permission_mode = spec.permission_mode;
        if (!params.reasoning_effort && !params.effort && spec.effort) params.effort = spec.effort;
        if (!params.sleep_duration && spec.sleep_duration !== undefined) params.sleep_duration = spec.sleep_duration;
        if (!params.tools && spec.tools?.length) params.tools = JSON.stringify(spec.tools);
        if (!params.hooks && spec.hooks?.length) params.hooks = JSON.stringify(spec.hooks);
        if (!params.env && spec.env) params.env = JSON.stringify(spec.env);
        if (!params.system_prompt && spec.system_prompt) params.system_prompt = spec.system_prompt;
        if (!params.on_stop) {
          const stopHook = spec.hooks?.find(h => h.event === "Stop" && h.command);
          if (stopHook?.command) params.on_stop = stopHook.command;
        }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error loading spec file: ${e.message}` }], isError: true };
      }
    }

    // If prompt provided but no mission, use prompt as mission
    if (!params.mission && params.prompt) {
      params.mission = params.prompt;
    }

    // Merge effort alias
    if (params.effort && !params.reasoning_effort) {
      params.reasoning_effort = params.effort;
    }

    const result = await handleFleetCreate(params);

    // Post-create: write event-tools.json and hooks if provided
    if (result.isError) return result;

    const workerFleetDir = join(FLEET_DIR, params.name);
    const hooksDir = join(workerFleetDir, "hooks");
    mkdirSync(hooksDir, { recursive: true });

    // Write event-tools.json
    if (params.tools) {
      try {
        const tools = typeof params.tools === "string" ? JSON.parse(params.tools) : params.tools;
        if (Array.isArray(tools) && tools.length > 0) {
          writeFileSync(join(workerFleetDir, "event-tools.json"), JSON.stringify({
            programPath: null,
            tools,
            sessionDir: join(workerFleetDir, "session"),
            projectRoot: PROJECT_ROOT,
          }, null, 2));
          mkdirSync(join(workerFleetDir, "session", "results", params.name), { recursive: true });
        }
      } catch {}
    }

    // Install hooks (beyond system hooks)
    if (params.hooks || params.on_stop) {
      try {
        const hookDefs: any[] = [];
        if (params.hooks) {
          const parsed = typeof params.hooks === "string" ? JSON.parse(params.hooks) : params.hooks;
          if (Array.isArray(parsed)) hookDefs.push(...parsed);
        }
        if (params.on_stop) {
          hookDefs.push({ event: "Stop", type: "command", command: params.on_stop });
        }
        if (hookDefs.length > 0) {
          const { installPipelineHooks } = await import("../../../engine/program/hook-generator");
          await installPipelineHooks(hooksDir, hookDefs, WORKER_NAME);
        }
      } catch {}
    }

    // Write env vars to a file the launch script can source
    if (params.env) {
      try {
        const envObj = typeof params.env === "string" ? JSON.parse(params.env) : params.env;
        if (typeof envObj === "object") {
          const envLines = Object.entries(envObj).map(([k, v]) => `export ${k}="${v}"`).join("\n");
          writeFileSync(join(workerFleetDir, "env.sh"), envLines + "\n", { mode: 0o755 });
        }
      } catch {}
    }

    return result;
  }
);

// Removed tools: register_worker, deregister_worker, move_worker, standby_worker, fleet_template
// Use fleet CLI equivalents (see fleet_help output)

server.registerTool(
  "fleet_help",
  {
    description: "Show fleet management documentation and available operations.",
    inputSchema: {},
  },
  async () => handleFleetHelp()
);

} // end registerFleetTools
