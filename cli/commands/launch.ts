import type { Command } from "commander";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import yaml from "js-yaml";
import {
  FLEET_DATA, workerDir, resolveProjectRoot, resolveProject,
} from "../lib/paths";
import { getConfig, getState, getFleetConfig, setConfigValue } from "../lib/config";
import { info, ok, warn, fail, table } from "../lib/fmt";
import { listPaneIds } from "../lib/tmux";
import { runCreate } from "./create";
import { addGlobalOpts } from "../index";

interface ManifestWorker {
  model?: string;
  permission_mode?: string;
  sleep_duration?: number | null;
  type?: string;
  effort?: string;
  window?: string;
}

interface Manifest {
  project?: string;
  tmux_session?: string;
  workers: Record<string, ManifestWorker>;
}

function findManifest(manifestPath?: string): string {
  if (manifestPath) {
    const p = resolve(manifestPath);
    if (!existsSync(p)) fail(`Manifest not found: ${p}`);
    return p;
  }
  // Look in .fleet/manifest.yaml from project root
  const root = resolveProjectRoot();
  const candidates = [
    join(root, ".fleet/manifest.yaml"),
    join(root, ".fleet/manifest.yml"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  fail("No .fleet/manifest.yaml found. Create one or use --manifest <path>");
}

function parseManifest(path: string): Manifest {
  const raw = readFileSync(path, "utf-8");
  const doc = yaml.load(raw) as Record<string, unknown>;
  if (!doc || typeof doc !== "object") fail("Invalid manifest: not a YAML object");
  if (!doc.workers || typeof doc.workers !== "object") fail("Invalid manifest: missing 'workers' map");
  return doc as unknown as Manifest;
}

/** Check if a worker already has a live tmux pane */
function isAlive(project: string, name: string, panes: Set<string>): boolean {
  const state = getState(project, name);
  return !!(state?.pane_id && panes.has(state.pane_id));
}

export async function runLaunch(opts: {
  manifest?: string;
  dryRun?: boolean;
  only?: string;
  force?: boolean;
}, globalOpts: Record<string, unknown>): Promise<void> {
  const manifestPath = findManifest(opts.manifest);
  const manifest = parseManifest(manifestPath);
  const projectRoot = resolveProjectRoot();
  const project = manifest.project || (globalOpts.project as string) || resolveProject(projectRoot);

  info(`Manifest: ${manifestPath}`);
  info(`Project: ${project}`);

  // Ensure fleet.json exists
  const fleetJsonDir = join(FLEET_DATA, project);
  mkdirSync(fleetJsonDir, { recursive: true });
  const fleetJsonPath = join(fleetJsonDir, "fleet.json");
  if (!existsSync(fleetJsonPath)) {
    writeFileSync(fleetJsonPath, JSON.stringify({
      project_name: project,
      tmux_session: manifest.tmux_session || "w",
      commit_notify: [],
      deploy_authority: "operator",
      merge_authority: "operator",
      mission_authority: "operator",
    }, null, 2) + "\n");
    ok("Created fleet.json");
  } else if (manifest.tmux_session) {
    // Update tmux_session if manifest specifies one
    const fleetConfig = getFleetConfig(project);
    if (fleetConfig && fleetConfig.tmux_session !== manifest.tmux_session) {
      const fc = JSON.parse(readFileSync(fleetJsonPath, "utf-8"));
      fc.tmux_session = manifest.tmux_session;
      writeFileSync(fleetJsonPath, JSON.stringify(fc, null, 2) + "\n");
      info(`Updated tmux_session to '${manifest.tmux_session}'`);
    }
  }

  // Filter workers
  let workerNames = Object.keys(manifest.workers);
  if (opts.only) {
    const only = opts.only.split(",").map(s => s.trim());
    workerNames = workerNames.filter(n => only.includes(n));
    if (workerNames.length === 0) fail(`No matching workers for --only ${opts.only}`);
  }

  const panes = listPaneIds();
  const results: { name: string; action: string }[] = [];

  for (const name of workerNames) {
    const spec = manifest.workers[name];
    const dir = workerDir(project, name);
    const exists = existsSync(dir);
    const alive = exists && isAlive(project, name, panes);

    // Determine action
    let action: string;
    if (alive && !opts.force) {
      action = "skip (running)";
    } else if (alive && opts.force) {
      action = "restart";
    } else if (exists) {
      action = "start";
    } else {
      action = "create";
    }

    if (opts.dryRun) {
      results.push({ name, action });
      continue;
    }

    // Find mission file
    const missionDir = join(manifestPath, "..");
    const missionFile = join(missionDir, `${name}.md`);
    const hasMission = existsSync(missionFile);

    if (action === "create") {
      const mission = hasMission
        ? `@${missionFile}`
        : `You are worker '${name}'. Await instructions from the operator.`;

      await runCreate(name, mission, {
        model: spec.model,
        effort: spec.effort,
        permissionMode: spec.permission_mode,
        type: spec.type,
        window: spec.window,
      }, { ...globalOpts, project });

      // Apply config overrides from manifest after creation
      if (spec.sleep_duration !== undefined) {
        setConfigValue(project, name, "sleep_duration", spec.sleep_duration);
      }

      results.push({ name, action: "created" });
    } else if (action === "start" || action === "restart") {
      // Apply config overrides before starting
      applyManifestOverrides(project, name, spec);

      // Use subprocess to call fleet start (avoids circular import)
      const args = ["bun", "run", join(import.meta.dir, "../index.ts"), "start", name, "-p", project];
      if (opts.force) args.push("--force");
      const result = Bun.spawnSync(args, { stderr: "pipe", stdout: "pipe" });
      if (result.exitCode !== 0) {
        warn(`Failed to start ${name}: ${result.stderr.toString()}`);
        results.push({ name, action: "failed" });
      } else {
        results.push({ name, action: action === "restart" ? "restarted" : "started" });
      }
    } else {
      results.push({ name, action: "skipped" });
    }
  }

  // Summary
  console.log();
  const created = results.filter(r => r.action === "created").length;
  const started = results.filter(r => r.action === "started").length;
  const restarted = results.filter(r => r.action === "restarted").length;
  const skipped = results.filter(r => r.action.startsWith("skip")).length;
  const failed = results.filter(r => r.action === "failed").length;

  if (opts.dryRun) {
    info("Dry run — no changes made");
    table(["Worker", "Action"], results.map(r => [r.name, r.action]));
  } else {
    const parts: string[] = [];
    if (created) parts.push(`${created} created`);
    if (started) parts.push(`${started} started`);
    if (restarted) parts.push(`${restarted} restarted`);
    if (skipped) parts.push(`${skipped} skipped`);
    if (failed) parts.push(`${failed} failed`);
    ok(parts.join(", ") || "Nothing to do");
  }
}

/** Apply manifest config overrides to an existing worker */
function applyManifestOverrides(project: string, name: string, spec: ManifestWorker): void {
  const config = getConfig(project, name);
  if (!config) return;

  if (spec.model && spec.model !== config.model) {
    setConfigValue(project, name, "model", spec.model);
  }
  if (spec.effort && spec.effort !== config.reasoning_effort) {
    setConfigValue(project, name, "reasoning_effort", spec.effort);
  }
  if (spec.permission_mode && spec.permission_mode !== config.permission_mode) {
    setConfigValue(project, name, "permission_mode", spec.permission_mode);
  }
  if (spec.sleep_duration !== undefined && spec.sleep_duration !== config.sleep_duration) {
    setConfigValue(project, name, "sleep_duration", spec.sleep_duration);
  }
}

export function register(parent: Command): void {
  const sub = parent
    .command("launch")
    .description("Launch fleet from .fleet/manifest.yaml")
    .option("--manifest <path>", "Path to manifest YAML")
    .option("--dry-run", "Show what would happen without doing it")
    .option("--only <names>", "Comma-separated worker names to launch")
    .option("-f, --force", "Restart even if workers are already running");
  addGlobalOpts(sub)
    .action(async (opts: {
      manifest?: string; dryRun?: boolean; only?: string; force?: boolean;
    }, cmd: Command) => {
      await runLaunch(opts, cmd.optsWithGlobals());
    });
}
