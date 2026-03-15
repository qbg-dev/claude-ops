/**
 * Build WorkerSnapshots from per-worker directory files.
 * Reads config.json + state.json for each worker in a single pass.
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { FLEET_DATA } from "./config";
import type { WorkerSnapshot, WatchdogConfig, SpawnHook } from "./types";
import { DEFAULT_SPAWN_HOOKS } from "./types";

/** Read and parse JSON, return null on failure */
function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

/** List all worker names for a project (directories with config.json) */
export function listWorkerNames(projectName: string): string[] {
  const projectDir = join(FLEET_DATA, projectName);
  try {
    return readdirSync(projectDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_") && d.name !== "missions")
      .filter(d => existsSync(join(projectDir, d.name, "config.json")))
      .map(d => d.name);
  } catch {
    return [];
  }
}

/** Build a WorkerSnapshot from per-worker config.json + state.json */
export function buildSnapshot(name: string, projectName: string, config: WatchdogConfig): WorkerSnapshot | null {
  const workerDir = join(FLEET_DATA, projectName, name);
  const cfg = readJson<Record<string, any>>(join(workerDir, "config.json"));
  if (!cfg) return null;

  const state = readJson<Record<string, any>>(join(workerDir, "state.json"));

  const sleepDuration = cfg.sleep_duration ?? null;
  // Cap to maxCycleSec
  const cappedSleepDuration = sleepDuration !== null && sleepDuration > config.maxCycleSec
    ? config.maxCycleSec
    : sleepDuration;

  // Read Fleet Mail token
  let bmsToken: string | null = null;
  try {
    bmsToken = readFileSync(join(workerDir, "token"), "utf-8").trim() || null;
  } catch {}

  return {
    name,
    paneId: state?.pane_id || null,
    status: state?.status || "idle",
    sleepDuration: cappedSleepDuration,
    window: cfg.window || null,
    tmuxSession: state?.tmux_session || "w",
    worktree: cfg.worktree || null,
    branch: cfg.branch || `worker/${name}`,
    perpetual: cappedSleepDuration !== null && cappedSleepDuration > 0,
    sleepUntil: state?.custom?.sleep_until || null,
    lastRelaunchAt: state?.last_relaunch?.at || null,
    createdAt: cfg.meta?.created_at || null,
    bmsToken,
    model: cfg.model || "opus[1m]",
    permissionMode: cfg.permission_mode || "bypassPermissions",
    reasoningEffort: cfg.reasoning_effort || "high",
    runtime: (state?.custom?.runtime as string) || "claude",
    ephemeral: !!cfg.ephemeral,
    onSpawn: (cfg.on_spawn as SpawnHook[] | undefined) ?? DEFAULT_SPAWN_HOOKS,
  };
}

/** Build snapshots for all workers in a project */
export function buildAllSnapshots(projectName: string, config: WatchdogConfig): WorkerSnapshot[] {
  const names = listWorkerNames(projectName);
  const snapshots: WorkerSnapshot[] = [];
  for (const name of names) {
    const snap = buildSnapshot(name, projectName, config);
    if (snap) snapshots.push(snap);
  }
  return snapshots;
}
