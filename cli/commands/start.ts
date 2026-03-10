import { defineCommand } from "citty";
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  FLEET_DATA, DEFAULT_SESSION, workerDir, resolveProject,
} from "../lib/paths";
import {
  getConfig, getFleetConfig, generateLaunchSh, writeJson,
} from "../lib/config";
import { info, ok, warn, fail } from "../lib/fmt";
import { launchInTmux } from "../lib/launch";

export default defineCommand({
  meta: { name: "start", description: "Start/restart existing worker" },
  args: {
    name:         { type: "positional", description: "Worker name", required: true },
    model:        { type: "string", description: "Override model" },
    effort:       { type: "string", description: "Override effort" },
    "permission-mode": { type: "string", description: "Override permission mode" },
    window:       { type: "string", description: "tmux window group" },
    "window-index": { type: "string", description: "Explicit window position" },
    project:      { type: "string", description: "Override project detection" },
    save:         { type: "boolean", description: "Persist flag overrides to config", default: false },
  },
  async run({ args }) {
    const project = args.project || resolveProject();
    const dir = workerDir(project, args.name);
    const configPath = join(dir, "config.json");

    if (!existsSync(dir)) fail(`Worker '${args.name}' not found in project '${project}'`);
    if (!existsSync(configPath)) fail(`No config.json for '${args.name}'`);

    // Apply overrides
    const overrides: Record<string, string> = {};
    if (args.model) overrides.model = args.model;
    if (args.effort) overrides.reasoning_effort = args.effort;
    if (args["permission-mode"]) overrides.permission_mode = args["permission-mode"];
    if (args.window) overrides.window = args.window;

    const hasOverrides = Object.keys(overrides).length > 0;
    const backupPath = `${configPath}.start-bak`;

    if (hasOverrides) {
      if (args.save) {
        // Save to config permanently
        info("Saving overrides to config");
        const config = JSON.parse(readFileSync(configPath, "utf-8"));
        Object.assign(config, overrides);
        writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
        generateLaunchSh(project, args.name);
        ok("Config updated + launch.sh regenerated");
      } else {
        // Temporary: backup, modify, launch, restore later
        copyFileSync(configPath, backupPath);
        const config = JSON.parse(readFileSync(configPath, "utf-8"));
        Object.assign(config, overrides);
        writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
      }
    }

    const config = getConfig(project, args.name);
    const window = config?.window || args.name;
    const fleetConfig = getFleetConfig(project);
    const session = fleetConfig?.tmux_session || DEFAULT_SESSION;

    const windowIndex = args["window-index"] ? parseInt(args["window-index"], 10) : undefined;

    try {
      await launchInTmux(args.name, project, session, window, windowIndex);
    } finally {
      // Restore config backup if temporary override
      if (hasOverrides && !args.save && existsSync(backupPath)) {
        copyFileSync(backupPath, configPath);
        Bun.spawnSync(["rm", "-f", backupPath]);
      }
    }
  },
});
