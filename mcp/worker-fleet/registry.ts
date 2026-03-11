/**
 * Registry — per-worker directory storage, migration, compatibility shim, locking.
 * All registry read/write operations go through this module.
 */

import {
  readFileSync, writeFileSync, existsSync, mkdirSync,
  readdirSync, copyFileSync, symlinkSync, realpathSync,
} from "fs";
import { join } from "path";
import { acquireLock, releaseLock } from "../shared/lock-utils.js";
import {
  type WorkerConfig as SharedWorkerConfig,
  type WorkerState as SharedWorkerState,
  type SystemHook,
  SYSTEM_HOOKS,
} from "../../shared/types";
import {
  PROJECT_ROOT, FLEET_DIR, REGISTRY_PATH,
  FLEET_CONFIG_PATH, LEGACY_REGISTRY_PATH, HARNESS_LOCK_DIR,
  WORKER_NAME, resolveProjectName,
} from "./config";
import { readJsonFile } from "./helpers";

// Re-export lock utilities for backward compatibility
export { acquireLock, releaseLock };

// ── Type Definitions ─────────────────────────────────────────────────

/**
 * WorkerConfig and WorkerState — local aliases with relaxed nullability
 * for backward compatibility with legacy registry data. The canonical
 * strict types live in shared/types.ts.
 */
export interface WorkerConfig extends Omit<SharedWorkerConfig, 'worktree' | 'mcp' | 'hooks'> {
  worktree: string | null;
  mcp: Record<string, any>;
  hooks: Array<any>;
}

export interface WorkerState extends Omit<SharedWorkerState, 'status' | 'tmux_session' | 'session_id' | 'custom'> {
  status: string;
  tmux_session: string;
  session_id: string | null;
  custom: Record<string, any>;
}

export interface RegistryConfig {
  commit_notify: string[];
  merge_authority: string;
  deploy_authority: string;
  mission_authority: string | string[];
  tmux_session: string;
  project_name: string;
}

export interface RegistryWorkerEntry {
  model: string;
  permission_mode: string;
  disallowed_tools: string[];

  status: string;
  /** @deprecated Use sleep_duration instead. Derived: sleep_duration !== null */
  perpetual: boolean;
  sleep_duration: number | null;
  branch: string;
  worktree: string | null;
  window: string | null;

  pane_id: string | null;
  pane_target: string | null;
  tmux_session: string;
  session_id: string | null;
  session_file: string | null;

  mission_file: string;
  custom: Record<string, any>;

  // Flat org — everyone reports to someone (default: chief-of-staff)
  report_to?: string | null;
  forked_from?: string | null;  // set when created with fork_from_session=true

  // Optional commit tracking
  last_commit_sha?: string;
  last_commit_msg?: string;
  last_commit_at?: string;
  issues_found?: number;
  issues_fixed?: number;

  // Fleet Mail Server token (auto-provisioned)
  bms_token?: string;
}

export interface ProjectRegistry {
  _config: RegistryConfig;
  [workerName: string]: RegistryWorkerEntry | RegistryConfig;
}

export interface DiagnosticIssue {
  severity: "error" | "warning";
  check: string;
  message: string;
  fix?: string;
}

// ── System Hooks ─────────────────────────────────────────────────────

/** Default system hooks applied to ALL workers — nobody can remove these */
export function getDefaultSystemHooks(): SystemHook[] {
  return [...SYSTEM_HOOKS];
}

// ── Fleet Config ─────────────────────────────────────────────────────

/** Read fleet-wide config from fleet.json */
export function readFleetConfig(): RegistryConfig {
  try {
    const raw = readJsonFile(FLEET_CONFIG_PATH);
    if (raw) return raw as RegistryConfig;
  } catch {}
  // Fallback defaults
  return {
    commit_notify: ["merger"],
    merge_authority: "merger",
    deploy_authority: "merger",
    mission_authority: "chief-of-staff",
    tmux_session: "w",
    project_name: resolveProjectName(),
  };
}

/** Write fleet-wide config to fleet.json */
export function writeFleetConfig(config: RegistryConfig): void {
  mkdirSync(FLEET_DIR, { recursive: true });
  writeFileSync(FLEET_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

// ── Per-Worker Directory Storage ─────────────────────────────────────
// Each worker gets: {FLEET_DIR}/{name}/config.json, state.json, mission.md, launch.sh, token

/** Read a worker's config.json */
export function readWorkerConfig(name: string): WorkerConfig | null {
  const configPath = join(FLEET_DIR, name, "config.json");
  return readJsonFile(configPath) as WorkerConfig | null;
}

/** Write a worker's config.json */
export function writeWorkerConfig(name: string, config: WorkerConfig): void {
  const dir = join(FLEET_DIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2) + "\n");
}

/** Read a worker's state.json */
export function readWorkerState(name: string): WorkerState | null {
  const statePath = join(FLEET_DIR, name, "state.json");
  return readJsonFile(statePath) as WorkerState | null;
}

/** Write a worker's state.json */
export function writeWorkerState(name: string, state: WorkerState): void {
  const dir = join(FLEET_DIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2) + "\n");
}

/** List all worker names (directories with config.json) */
export function listWorkerNames(): string[] {
  try {
    return readdirSync(FLEET_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_") && d.name !== "missions")
      .filter(d => existsSync(join(FLEET_DIR, d.name, "config.json")))
      .map(d => d.name);
  } catch {
    return [];
  }
}

/** Generate launch.sh for a worker */
export function generateLaunchScript(name: string, config: WorkerConfig): string {
  const worktree = config.worktree || PROJECT_ROOT;
  const model = config.model || "opus";
  const effort = config.reasoning_effort || "high";
  const permMode = config.permission_mode || "bypassPermissions";
  const missionPath = join(FLEET_DIR, name, "mission.md");

  let cmd = `CLAUDE_CODE_SKIP_PROJECT_LOCK=1 claude --model ${model}`;
  if (permMode === "bypassPermissions") cmd += " --dangerously-skip-permissions";
  if (effort) cmd += ` --effort ${effort}`;
  // Note: disallowed_tools are now hooks in config.json, not CLI flags

  return `#!/bin/bash
# Auto-generated by fleet — restart command for ${name}
# Regenerated on config changes. Do not edit manually.
cd "${worktree}"
exec ${cmd} -p "$(cat '${missionPath}')"
`;
}

/** Write launch.sh for a worker */
export function writeLaunchScript(name: string, config: WorkerConfig): void {
  const dir = join(FLEET_DIR, name);
  mkdirSync(dir, { recursive: true });
  const script = generateLaunchScript(name, config);
  const scriptPath = join(dir, "launch.sh");
  writeFileSync(scriptPath, script, { mode: 0o755 });
}

// ── Migration: registry.json → per-worker directories ────────────────

/** Convert a flat RegistryWorkerEntry to the new config+state pair */
export function registryEntryToConfigState(
  name: string, entry: RegistryWorkerEntry, config: RegistryConfig
): { config: WorkerConfig; state: WorkerState } {
  const wConfig: WorkerConfig = {
    model: entry.model || "opus",
    reasoning_effort: (entry.custom?.reasoning_effort as string) || "high",
    permission_mode: entry.permission_mode || "bypassPermissions",
    sleep_duration: entry.sleep_duration ?? null,
    window: entry.window || null,
    worktree: entry.worktree || null,
    branch: entry.branch || `worker/${name}`,
    mcp: {},
    hooks: [...getDefaultSystemHooks()],
    meta: {
      created_at: new Date().toISOString(),
      created_by: "migration",
      forked_from: entry.forked_from || null,
      project: config.project_name?.toLowerCase() || resolveProjectName().toLowerCase(),
    },
  };

  // Preserve custom state but separate out known config keys
  const customState = { ...(entry.custom || {}) };
  // Remove keys that moved to config
  delete customState.runtime;
  delete customState.reasoning_effort;

  const wState: WorkerState = {
    status: entry.status || "idle",
    pane_id: entry.pane_id || null,
    pane_target: entry.pane_target || null,
    tmux_session: entry.tmux_session || "w",
    session_id: (entry as any).active_session_id || entry.session_id || null,
    past_sessions: (entry as any).past_session_ids || [],
    last_relaunch: (entry as any).last_relaunch || null,
    relaunch_count: (entry as any).watchdog_relaunches || 0,
    cycles_completed: customState.cycles_completed || 0,
    last_cycle_at: customState.last_cycle_at || null,
    custom: customState,
  };

  // Clean up migrated fields from custom
  delete wState.custom.cycles_completed;
  delete wState.custom.last_cycle_at;

  return { config: wConfig, state: wState };
}

/** Migrate from registry.json to per-worker directories.
 *  Runs on startup. Idempotent: skips if per-worker dirs already exist. */
export function migrateToPerWorkerDirs(): void {
  mkdirSync(FLEET_DIR, { recursive: true });

  // Check if migration already happened (fleet.json exists)
  if (existsSync(FLEET_CONFIG_PATH)) return;

  // Try to read existing registry.json
  let raw: any = readJsonFile(REGISTRY_PATH);

  // Fallback: try legacy path
  if ((!raw || raw._migrated_to) && existsSync(LEGACY_REGISTRY_PATH)) {
    let legacyPath = LEGACY_REGISTRY_PATH;
    try { legacyPath = realpathSync(LEGACY_REGISTRY_PATH); } catch {}
    const legacy = readJsonFile(legacyPath);
    if (legacy && legacy._config && !legacy._migrated_to) {
      raw = legacy;
    }
  }

  if (!raw || !raw._config) {
    // No registry to migrate — write default fleet.json
    writeFleetConfig({
      commit_notify: ["merger"],
      merge_authority: "merger",
      deploy_authority: "merger",
      mission_authority: "chief-of-staff",
      tmux_session: "w",
      project_name: resolveProjectName(),
    });
    return;
  }

  const regConfig = raw._config as RegistryConfig;

  // Write fleet.json from _config
  writeFleetConfig(regConfig);

  // Migrate each worker entry
  for (const [name, entry] of Object.entries(raw)) {
    if (name === "_config") continue;
    const workerEntry = entry as RegistryWorkerEntry;

    // Skip "user" entry (special Fleet Mail account, not a real worker)
    if (name === "user") {
      // Preserve user account data in a minimal way
      const userDir = join(FLEET_DIR, "_user");
      mkdirSync(userDir, { recursive: true });
      writeFileSync(join(userDir, "account.json"), JSON.stringify(workerEntry, null, 2) + "\n");
      continue;
    }

    const workerDir = join(FLEET_DIR, name);
    // Skip if already migrated
    if (existsSync(join(workerDir, "config.json"))) continue;

    mkdirSync(workerDir, { recursive: true });
    const { config: wConfig, state: wState } = registryEntryToConfigState(name, workerEntry, regConfig);
    writeWorkerConfig(name, wConfig);
    writeWorkerState(name, wState);

    // Copy mission.md if it exists in missions/
    const centralMission = join(FLEET_DIR, "missions", `${name}.md`);
    const workerMission = join(workerDir, "mission.md");
    if (existsSync(centralMission) && !existsSync(workerMission)) {
      try { symlinkSync(centralMission, workerMission); } catch {
        try { copyFileSync(centralMission, workerMission); } catch {}
      }
    }

    // Copy bms_token to token file
    if (workerEntry.bms_token) {
      writeFileSync(join(workerDir, "token"), workerEntry.bms_token);
    }

    // Generate launch.sh
    writeLaunchScript(name, wConfig);
  }

  // Backup old registry.json
  if (existsSync(REGISTRY_PATH)) {
    try { copyFileSync(REGISTRY_PATH, REGISTRY_PATH + ".bak"); } catch {}
  }
}

// Run migration on startup
migrateToPerWorkerDirs();

// ── Compatibility Shim: reconstruct ProjectRegistry from per-worker dirs ──

/** Reconstruct a RegistryWorkerEntry from per-worker config.json + state.json */
export function workerDirsToRegistryEntry(name: string): RegistryWorkerEntry | null {
  const config = readWorkerConfig(name);
  const state = readWorkerState(name);
  if (!config) return null;

  const s = state || {
    status: "idle", pane_id: null, pane_target: null, tmux_session: "w",
    session_id: null, past_sessions: [], last_relaunch: null,
    relaunch_count: 0, cycles_completed: 0, last_cycle_at: null, custom: {},
  };

  // Read token from file
  let bmsToken: string | undefined;
  try { bmsToken = readFileSync(join(FLEET_DIR, name, "token"), "utf-8").trim(); } catch {}

  // Reconstruct the flat entry format for backward compatibility
  const entry: RegistryWorkerEntry = {
    model: config.model || "opus",
    permission_mode: config.permission_mode || "bypassPermissions",
    disallowed_tools: [], // Replaced by hooks in config.json
    status: s.status || "idle",
    perpetual: config.sleep_duration !== null && config.sleep_duration !== undefined && config.sleep_duration > 0,
    sleep_duration: config.sleep_duration ?? null,
    branch: config.branch || `worker/${name}`,
    worktree: config.worktree || null,
    window: config.window || null,
    pane_id: s.pane_id || null,
    pane_target: s.pane_target || null,
    tmux_session: s.tmux_session || "w",
    session_id: s.session_id || null,
    session_file: null,
    mission_file: join(FLEET_DIR, name, "mission.md"),
    custom: {
      ...s.custom,
      runtime: "claude", // Always reconstruct this
      reasoning_effort: config.reasoning_effort || "high",
      ...(s.cycles_completed ? { cycles_completed: s.cycles_completed } : {}),
      ...(s.last_cycle_at ? { last_cycle_at: s.last_cycle_at } : {}),
    },
    forked_from: config.meta?.forked_from || undefined,
    bms_token: bmsToken,
  };

  // Carry over extra state fields
  if (s.past_sessions?.length) (entry as any).past_session_ids = s.past_sessions;
  if (s.session_id) (entry as any).active_session_id = s.session_id;
  if (s.last_relaunch) (entry as any).last_relaunch = s.last_relaunch;
  if (s.relaunch_count) (entry as any).watchdog_relaunches = s.relaunch_count;

  return entry;
}

// ── Registry Operations ──────────────────────────────────────────────

/** Read project registry from per-worker dirs (compatibility shim).
 *  Reconstructs the old ProjectRegistry shape by reading fleet.json + all per-worker dirs.
 *  No locking — caller handles concurrency. */
export function readRegistry(): ProjectRegistry {
  const config = readFleetConfig();
  const registry: ProjectRegistry = { _config: config };

  // Read all per-worker directories
  const workerNames = listWorkerNames();
  for (const name of workerNames) {
    const entry = workerDirsToRegistryEntry(name);
    if (entry) registry[name] = entry;
  }

  // Also include "user" account if it exists (special Fleet Mail account)
  const userAccountPath = join(FLEET_DIR, "_user", "account.json");
  try {
    const userAccount = readJsonFile(userAccountPath);
    if (userAccount) registry["user"] = userAccount;
  } catch {}

  return registry;
}

/** Get a worker entry (reads directly from per-worker dirs, not full registry) */
export function getWorkerEntry(name: string): RegistryWorkerEntry | null {
  if (name === "_config") return null;
  // Special case: "user" account
  if (name === "user") {
    const userAccountPath = join(FLEET_DIR, "_user", "account.json");
    return readJsonFile(userAccountPath) as RegistryWorkerEntry | null;
  }
  return workerDirsToRegistryEntry(name);
}

/** Atomic read-modify-write under lock. Returns the value from fn().
 *  After fn() mutates the registry, changes are written back to per-worker dirs
 *  (and fleet.json for _config changes). */
export function withRegistryLocked<T>(fn: (registry: ProjectRegistry) => T): T {
  const lockPath = join(HARNESS_LOCK_DIR, "worker-registry");
  if (!acquireLock(lockPath)) {
    throw new Error("Could not acquire worker-registry lock after 10s — stale lock?");
  }
  try {
    const registry = readRegistry();
    // Snapshot worker names before mutation
    const beforeNames = new Set(Object.keys(registry).filter(k => k !== "_config" && k !== "user"));

    const result = fn(registry);

    // Write _config changes back to fleet.json
    const config = registry._config as RegistryConfig;
    writeFleetConfig(config);

    // Write worker changes back to per-worker dirs
    const afterNames = new Set(Object.keys(registry).filter(k => k !== "_config" && k !== "user"));

    for (const name of afterNames) {
      const entry = registry[name] as RegistryWorkerEntry;
      if (!entry) continue;

      // Read existing config+state to merge changes
      const existingConfig = readWorkerConfig(name);
      const existingState = readWorkerState(name);

      if (existingConfig && existingState) {
        // Update config fields from entry
        existingConfig.model = entry.model || existingConfig.model;
        existingConfig.permission_mode = entry.permission_mode || existingConfig.permission_mode;
        existingConfig.sleep_duration = entry.sleep_duration ?? null;
        existingConfig.window = entry.window || existingConfig.window;
        existingConfig.worktree = entry.worktree || existingConfig.worktree;
        existingConfig.branch = entry.branch || existingConfig.branch;
        if (entry.custom?.reasoning_effort) {
          existingConfig.reasoning_effort = entry.custom.reasoning_effort as string;
        }
        if (entry.forked_from) existingConfig.meta.forked_from = entry.forked_from;
        writeWorkerConfig(name, existingConfig);

        // Update state fields from entry
        existingState.status = entry.status || existingState.status;
        existingState.pane_id = entry.pane_id;
        existingState.pane_target = entry.pane_target;
        existingState.tmux_session = entry.tmux_session || existingState.tmux_session;
        existingState.session_id = (entry as any).active_session_id || entry.session_id || existingState.session_id;
        if ((entry as any).past_session_ids) existingState.past_sessions = (entry as any).past_session_ids;
        if ((entry as any).last_relaunch) existingState.last_relaunch = (entry as any).last_relaunch;
        if ((entry as any).watchdog_relaunches) existingState.relaunch_count = (entry as any).watchdog_relaunches;
        // Sync custom state (strip config keys that don't belong in state)
        const stateCustom = { ...(entry.custom || {}) };
        delete stateCustom.runtime;
        delete stateCustom.reasoning_effort;
        if (stateCustom.cycles_completed !== undefined) {
          existingState.cycles_completed = stateCustom.cycles_completed;
          delete stateCustom.cycles_completed;
        }
        if (stateCustom.last_cycle_at !== undefined) {
          existingState.last_cycle_at = stateCustom.last_cycle_at;
          delete stateCustom.last_cycle_at;
        }
        existingState.custom = stateCustom;
        writeWorkerState(name, existingState);
      } else {
        // Worker doesn't have per-dir files yet — create from entry
        const cs = registryEntryToConfigState(name, entry, config);
        writeWorkerConfig(name, cs.config);
        writeWorkerState(name, cs.state);
      }

      // Sync token
      if (entry.bms_token) {
        const tokenPath = join(FLEET_DIR, name, "token");
        try { writeFileSync(tokenPath, entry.bms_token); } catch {}
      }

      // Regenerate launch.sh
      const latestConfig = readWorkerConfig(name);
      if (latestConfig) writeLaunchScript(name, latestConfig);
    }

    // Handle deleted workers (present in before but not after)
    for (const name of beforeNames) {
      if (!afterNames.has(name)) {
        // Worker was deleted from registry — don't delete per-worker dir
        // (deregister preserves files), but mark state as deregistered
        const existingState = readWorkerState(name);
        if (existingState) {
          existingState.status = "deregistered";
          writeWorkerState(name, existingState);
        }
      }
    }

    // Handle "user" account specially
    if (registry["user"]) {
      const userDir = join(FLEET_DIR, "_user");
      mkdirSync(userDir, { recursive: true });
      writeFileSync(join(userDir, "account.json"), JSON.stringify(registry["user"], null, 2) + "\n");
    }

    // Also write registry.json for backward compatibility (watchdog, external scripts)
    writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n");

    return result;
  } finally {
    releaseLock(join(HARNESS_LOCK_DIR, "worker-registry"));
  }
}

/** Ensure worker entry exists in registry. Creates default entry if missing.
 *  Also ensures per-worker dir structure exists. */
export function ensureWorkerInRegistry(registry: ProjectRegistry, name: string): RegistryWorkerEntry {
  if (registry[name] && name !== "_config") {
    const e = registry[name] as RegistryWorkerEntry;
    if (!e.custom) e.custom = {};  // backfill missing custom field for older entries
    return e;
  }

  const projectName = resolveProjectName();
  const worktreeDir = join(PROJECT_ROOT, "..", `${projectName}-w-${name}`);

  const entry: RegistryWorkerEntry = {
    model: "opus",
    permission_mode: "bypassPermissions",
    disallowed_tools: [],
    status: "idle",
    perpetual: false,  // derived from sleep_duration
    sleep_duration: null,
    branch: `worker/${name}`,
    worktree: worktreeDir,
    window: null,
    pane_id: null,
    pane_target: null,
    tmux_session: registry._config?.tmux_session || "w",
    session_id: null,
    session_file: null,
    mission_file: join(FLEET_DIR, name, "mission.md"),
    custom: { runtime: "claude" },
  };

  // Also ensure per-worker dir exists with config+state
  const workerDir = join(FLEET_DIR, name);
  if (!existsSync(join(workerDir, "config.json"))) {
    mkdirSync(workerDir, { recursive: true });
    const config = registry._config as RegistryConfig;
    const cs = registryEntryToConfigState(name, entry, config);
    writeWorkerConfig(name, cs.config);
    writeWorkerState(name, cs.state);
    writeLaunchScript(name, cs.config);
  }

  registry[name] = entry;
  return entry;
}

// ── Authority Helpers ────────────────────────────────────────────────

/** Check if a worker name is in the mission_authority group (supports string or string[]) */
export function isMissionAuthority(name: string, config?: RegistryConfig): boolean {
  if (!config?.mission_authority) return false;
  const ma = config.mission_authority;
  return Array.isArray(ma) ? ma.includes(name) : ma === name;
}

/** Get the first mission authority name (for display/fallback purposes) */
export function getMissionAuthorityLabel(config?: RegistryConfig): string {
  const ma = config?.mission_authority;
  if (!ma) return "chief-of-staff";
  return Array.isArray(ma) ? ma.join(", ") : ma;
}

/** Resolve report_to (falls back to first mission_authority) */
export function getReportTo(w: RegistryWorkerEntry, config?: RegistryConfig): string | null {
  if (w.report_to) return w.report_to;
  const ma = config?.mission_authority;
  if (!ma) return null;
  return Array.isArray(ma) ? ma[0] : ma;
}

/** Check if caller has authority to update target worker's state */
export function canUpdateWorker(callerName: string, targetName: string, registry: ProjectRegistry): boolean {
  if (callerName === targetName) return true;
  const config = registry._config as RegistryConfig;
  if (isMissionAuthority(callerName, config)) return true;
  const target = registry[targetName] as RegistryWorkerEntry | undefined;
  if (target && getReportTo(target, config) === callerName) return true;
  return false;
}

// ── Inbox Helpers ────────────────────────────────────────────────────
// writeToTriageQueue and buildMessageBody are in helpers.ts (canonical versions)

/** Read worker's model from registry */
export function getWorkerModel(): string {
  try {
    const entry = getWorkerEntry(WORKER_NAME);
    return entry?.model || "opus";
  } catch { return "opus"; }
}
