import type { Command } from "commander";
import { readdirSync, mkdirSync, writeFileSync, existsSync, readFileSync, copyFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { FLEET_DATA, resolveProject, resolveProjectRoot } from "../lib/paths";
import { addGlobalOpts } from "../index";
import { runCreate } from "./create";
import { info, ok, fail } from "../lib/fmt";
import { loadAgentSpec, type AgentSpecFile, type EventTool } from "../../shared/types";

/** Find the next available run-NNN name */
function nextRunName(project: string): string {
  const projectDir = `${FLEET_DATA}/${project}`;
  let existing: string[] = [];
  try {
    existing = readdirSync(projectDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name.startsWith("run-"))
      .map(d => d.name);
  } catch {}

  let n = 1;
  while (existing.includes(`run-${n}`)) n++;
  return `run-${n}`;
}

// ── Parse --hook flags ──────────────────────────────────────────

interface ParsedHook {
  event: string;
  matcher?: string;
  command: string;
  blocking: boolean;
}

function parseHookFlag(raw: string, blocking: boolean): ParsedHook {
  // Format: "EVENT:COMMAND" or "EVENT:MATCHER:COMMAND"
  const parts = raw.split(":");
  if (parts.length < 2) throw new Error(`Invalid --hook format: ${raw} (expected EVENT:COMMAND)`);

  const event = parts[0];
  if (parts.length === 2) {
    return { event, command: parts[1], blocking };
  }
  // 3+ parts: EVENT:MATCHER:COMMAND (rejoin remaining with :)
  return { event, matcher: parts[1], command: parts.slice(2).join(":"), blocking };
}

// ── Parse --tool flags ──────────────────────────────────────────

function parseToolFlag(raw: string): EventTool {
  // Format: "name:description:handler=fn|cmd=script:param=type:..."
  const parts = raw.split(":");
  if (parts.length < 2) throw new Error(`Invalid --tool format: ${raw}`);

  const name = parts[0];
  const description = parts[1];
  let handler = "";
  let mode: "inline" | "command" = "command";
  const inputSchema: Record<string, { type: "string" | "number" | "boolean"; required?: boolean }> = {};

  for (let i = 2; i < parts.length; i++) {
    const [k, v] = parts[i].split("=", 2);
    if (k === "handler") { handler = v; mode = "inline"; }
    else if (k === "cmd") { handler = v; mode = "command"; }
    else {
      // param=type
      const paramType = (v || "string") as "string" | "number" | "boolean";
      inputSchema[k] = { type: paramType, required: true };
    }
  }

  return { name, description, mode, handler: handler || `echo ${name}`, inputSchema };
}

// ── Resolve @file references ────────────────────────────────────

function resolveFileRef(value: string, specDir: string): string {
  if (value.startsWith("@")) {
    const filePath = resolve(specDir, value.slice(1));
    if (!existsSync(filePath)) throw new Error(`Referenced file not found: ${filePath}`);
    return readFileSync(filePath, "utf-8");
  }
  return value;
}

// ── Tmux launch helper ──────────────────────────────────────────

function launchInTmuxPane(
  wrapperPath: string, workerName: string, workerDir: string,
  workDir: string, tmuxSession: string, windowName: string,
): void {
  try {
    const tmuxResult = Bun.spawnSync(["tmux", "has-session", "-t", tmuxSession], { stderr: "pipe" });
    if (tmuxResult.exitCode !== 0) {
      Bun.spawnSync(["tmux", "new-session", "-d", "-s", tmuxSession, "-n", windowName, "-c", workDir], { stderr: "pipe" });
      Bun.sleepSync(300);
      const paneResult = Bun.spawnSync(
        ["tmux", "list-panes", "-t", `${tmuxSession}:${windowName}`, "-F", "#{pane_id}"],
        { stderr: "pipe" },
      );
      const paneId = paneResult.stdout.toString().trim().split("\n")[0];
      if (paneId) {
        Bun.spawnSync(["tmux", "send-keys", "-t", paneId, `bash '${wrapperPath}'`, "Enter"]);
        ok(`Launched ${workerName} → ${paneId} (${tmuxSession}:${windowName})`);
      }
    } else {
      const winCheck = Bun.spawnSync(
        ["tmux", "list-windows", "-t", tmuxSession, "-F", "#{window_name}"],
        { stderr: "pipe" },
      );
      const windows = winCheck.stdout.toString().trim().split("\n");
      let paneId: string;
      if (windows.includes(windowName)) {
        const result = Bun.spawnSync(
          ["tmux", "split-window", "-t", `${tmuxSession}:${windowName}`, "-d", "-P", "-F", "#{pane_id}", "-c", workDir],
          { stderr: "pipe" },
        );
        paneId = result.stdout.toString().trim();
        Bun.spawnSync(["tmux", "select-layout", "-t", `${tmuxSession}:${windowName}`, "tiled"], { stderr: "pipe" });
      } else {
        const result = Bun.spawnSync(
          ["tmux", "new-window", "-t", tmuxSession, "-n", windowName, "-d", "-P", "-F", "#{pane_id}", "-c", workDir],
          { stderr: "pipe" },
        );
        paneId = result.stdout.toString().trim();
      }
      if (paneId) {
        Bun.spawnSync(["tmux", "send-keys", "-t", paneId, `bash '${wrapperPath}'`, "Enter"]);
        try {
          const state = JSON.parse(readFileSync(join(workerDir, "state.json"), "utf-8"));
          state.pane_id = paneId;
          state.pane_target = `${tmuxSession}:${windowName}`;
          state.tmux_session = tmuxSession;
          writeFileSync(join(workerDir, "state.json"), JSON.stringify(state, null, 2));
        } catch {}
        ok(`Launched ${workerName} → ${paneId} (${tmuxSession}:${windowName})`);
      }
    }
  } catch (e: any) {
    fail(`Failed to launch: ${e.message}`);
  }
}

// ── Main: run with --spec or --prompt ───────────────────────────

async function runWithSpec(
  spec: AgentSpecFile,
  opts: {
    window?: string;
    session?: string;
    specDir?: string;
  },
  globalOpts: Record<string, unknown>,
): Promise<void> {
  const projectRoot = resolveProjectRoot();
  const project = (globalOpts.project as string) || resolveProject(projectRoot);
  const workerName = spec.name;
  const fleetDir = process.env.CLAUDE_FLEET_DIR || join(process.env.HOME || "/tmp", ".claude-fleet");

  info(`Running agent: ${workerName}`);

  // Create session directory
  const sessionHash = Date.now().toString(36).slice(-8);
  const sessionDir = join(process.env.HOME || "/tmp", ".claude/state", workerName, `session-${sessionHash}`);
  mkdirSync(sessionDir, { recursive: true });

  // Resolve prompt
  let prompt = spec.prompt || "";
  if (opts.specDir && prompt.startsWith("@")) {
    prompt = resolveFileRef(prompt, opts.specDir);
  }
  if (!prompt) {
    prompt = `You are ${workerName}. ${spec.role || "Complete your task."}`;
  }

  // Write seed file
  const seedPath = join(sessionDir, `${workerName}-seed.md`);
  writeFileSync(seedPath, prompt);

  // Copy spec file for provenance (Step 6)
  if (opts.specDir) {
    const specFiles = readdirSync(opts.specDir).filter(f => f.endsWith(".agent.yaml") || f.endsWith(".agent.json") || f.endsWith(".agent.yml"));
    for (const f of specFiles) {
      if (f.includes(workerName) || specFiles.length === 1) {
        copyFileSync(join(opts.specDir, f), join(sessionDir, "agent-spec.yaml"));
        break;
      }
    }
  }

  // Create worker fleet directory
  const workerDir = join(FLEET_DATA, project, workerName);
  mkdirSync(workerDir, { recursive: true });
  mkdirSync(join(workerDir, "hooks"), { recursive: true });

  // Write config.json
  const model = spec.model || "opus[1m]";
  const runtime = spec.runtime || "claude";
  const effort = spec.effort || "high";
  const perm = spec.permission_mode || "bypassPermissions";
  const isPerpetual = typeof spec.sleep_duration === "number" && spec.sleep_duration > 0;

  const config = {
    model,
    runtime,
    reasoning_effort: effort,
    permission_mode: perm,
    sleep_duration: isPerpetual ? spec.sleep_duration : null,
    window: null,
    worktree: spec.dir || projectRoot,
    branch: spec.branch || "HEAD",
    mcp: {},
    hooks: [],
    ephemeral: spec.ephemeral ?? !isPerpetual,
    meta: {
      created_at: new Date().toISOString(),
      created_by: "fleet-run",
      forked_from: null,
      project,
    },
  };
  writeFileSync(join(workerDir, "config.json"), JSON.stringify(config, null, 2));

  // Write state.json
  writeFileSync(join(workerDir, "state.json"), JSON.stringify({
    status: "active",
    pane_id: null,
    pane_target: null,
    tmux_session: null,
    session_id: sessionHash,
    past_sessions: [],
    last_relaunch: null,
    relaunch_count: 0,
    cycles_completed: 0,
    last_cycle_at: null,
    custom: { role: spec.role || workerName, program: "fleet-run", session_dir: sessionDir },
  }, null, 2));

  // Write token placeholder
  writeFileSync(join(workerDir, "token"), "");

  // Write mission.md
  let missionContent = spec.mission ||
    `# ${workerName}\n${spec.role || "fleet run agent"} (${isPerpetual ? "perpetual" : "ephemeral"})`;
  if (missionContent.startsWith("@")) {
    missionContent = readFileSync(missionContent.slice(1), "utf-8").trim();
  }
  writeFileSync(join(workerDir, "mission.md"), missionContent + "\n");

  // Provision Fleet Mail
  const { FLEET_MAIL_URL, FLEET_MAIL_TOKEN } = await import("../lib/paths");
  if (FLEET_MAIL_URL) {
    try {
      const accountName = `${workerName}@${project}`;
      const mailHeaders: Record<string, string> = { "Content-Type": "application/json" };
      if (FLEET_MAIL_TOKEN) mailHeaders["Authorization"] = `Bearer ${FLEET_MAIL_TOKEN}`;
      const resp = await fetch(`${FLEET_MAIL_URL}/api/accounts`, {
        method: "POST", headers: mailHeaders,
        body: JSON.stringify({ name: accountName }),
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        const data = (await resp.json()) as { bearerToken?: string; token?: string };
        const token = data.bearerToken || data.token || "";
        if (token) writeFileSync(join(workerDir, "token"), token);
      } else if (resp.status === 409 && FLEET_MAIL_TOKEN) {
        const resetResp = await fetch(
          `${FLEET_MAIL_URL}/api/admin/accounts/${encodeURIComponent(accountName)}/reset-token`,
          { method: "POST", headers: { Authorization: `Bearer ${FLEET_MAIL_TOKEN}` }, signal: AbortSignal.timeout(5000) },
        );
        if (resetResp.ok) {
          const data = (await resetResp.json()) as { bearerToken?: string; token?: string };
          const token = data.bearerToken || data.token || "";
          if (token) writeFileSync(join(workerDir, "token"), token);
        }
      }
    } catch {}
  }

  // Write event-tools.json if tools specified
  if (spec.tools?.length) {
    writeFileSync(join(workerDir, "event-tools.json"), JSON.stringify({
      programPath: null,
      tools: spec.tools,
      sessionDir,
      projectRoot,
    }, null, 2));
  }

  // Install hooks from spec
  if (spec.hooks?.length) {
    const { installPipelineHooks } = await import("../../engine/program/hook-generator");
    const pipelineHooks = spec.hooks.map(h => ({
      event: h.event as any,
      type: h.type || "command" as any,
      command: h.command,
      prompt: h.content,
      matcher: h.matcher,
      blocking: h.blocking,
      check: h.check,
      description: h.description,
      to: h.to,
      subject: h.subject,
      body: h.body,
      workers: h.workers?.map(w => ({
        name: w.name,
        role: w.role || w.name,
        model: w.model,
        runtime: w.runtime,
        seed: { inline: w.prompt || `You are ${w.name}.` },
      })) as any,
    }));
    await installPipelineHooks(join(workerDir, "hooks"), pipelineHooks, "fleet-run");
  }

  // Generate launch wrapper
  const wrapperPath = join(sessionDir, `run-${workerName}.sh`);
  const workDir = spec.dir || projectRoot;
  const resultsDir = join(sessionDir, "results", workerName);
  mkdirSync(resultsDir, { recursive: true });

  // Build Fleet Mail env export
  let mailEnv = `export WORKER_NAME="${workerName}"`;
  try {
    const token = readFileSync(join(workerDir, "token"), "utf-8").trim();
    if (token) {
      const { FLEET_MAIL_URL: mailUrl } = await import("../lib/paths");
      mailEnv += `\nexport FLEET_MAIL_URL="${mailUrl || ""}"`;
      mailEnv += `\nexport FLEET_MAIL_TOKEN="${token}"`;
    }
  } catch {}

  // Build exec line
  let execLine: string;
  if (runtime === "sdk") {
    const { generateStandaloneSdkLauncher } = await import("../../engine/program/sdk-launcher");
    const sdkPath = generateStandaloneSdkLauncher(spec, sessionDir, workDir);
    execLine = `exec bun run "${sdkPath}"`;
  } else if (runtime === "codex") {
    execLine = `exec codex exec --full-auto --skip-git-repo-check -c model='"${model}"' "$(cat '${seedPath}')"`;
  } else if (runtime === "custom" && spec.custom_launcher) {
    execLine = `exec ${spec.custom_launcher}`;
  } else {
    let cmd = `exec claude --model ${model} --dangerously-skip-permissions`;
    if (spec.effort) cmd += ` --effort "${spec.effort}"`;
    if (spec.system_prompt) {
      const syspromptPath = join(sessionDir, "system-prompt.md");
      writeFileSync(syspromptPath, spec.system_prompt);
      cmd += ` --system-prompt "${syspromptPath}"`;
    }
    if (spec.append_system_prompt) {
      const appendPath = join(sessionDir, "append-system-prompt.md");
      writeFileSync(appendPath, spec.append_system_prompt);
      cmd += ` --append-system-prompt "${appendPath}"`;
    }
    if (spec.allowed_tools?.length) {
      cmd += ` --allowedTools "${spec.allowed_tools.join(",")}"`;
    }
    if (spec.disallowed_tools?.length) {
      cmd += ` --disallowedTools "${spec.disallowed_tools.join(",")}"`;
    }
    if (spec.add_dir?.length) {
      for (const d of spec.add_dir) cmd += ` --add-dir "${d}"`;
    }
    if (spec.json_schema) {
      cmd += ` --output-format json --json '${spec.json_schema}'`;
    }
    cmd += ` "$(cat '${seedPath}')"`;
    execLine = cmd;
  }

  // Write env vars
  let envExport = "";
  if (spec.env) {
    for (const [k, v] of Object.entries(spec.env)) {
      envExport += `export ${k}="${v}"\n`;
    }
  }

  const script = `#!/usr/bin/env bash
cd "${workDir}"
${mailEnv}
export PROJECT_ROOT="${workDir}"
export HOOKS_DIR="${join(workerDir, "hooks")}"
export CLAUDE_FLEET_DIR="${fleetDir}"
export RESULTS_DIR="${resultsDir}"
${envExport}${execLine}
`;

  writeFileSync(wrapperPath, script, { mode: 0o755 });

  // Launch in tmux
  const { getFleetConfig } = await import("../lib/config");
  const fleetConfig = getFleetConfig(project);
  const tmuxSession = opts.session || fleetConfig?.tmux_session || "w";
  const windowName = opts.window || workerName;

  launchInTmuxPane(wrapperPath, workerName, workerDir, workDir, tmuxSession, windowName);

  console.log(`  Session dir: ${sessionDir}`);
  console.log(`  Worker dir:  ${workerDir}`);
}

// ── Register CLI command ────────────────────────────────────────

export function register(parent: Command): void {
  const sub = parent
    .command("run [name]")
    .description("Launch an agent from spec file, flags, or interactive mode")
    .option("--spec <file>", "AgentSpec YAML/JSON file")
    .option("--prompt <text>", "Initial prompt (inline or @file)")
    .option("--model <model>", "Override model")
    .option("--runtime <runtime>", "Runtime: claude, codex, custom")
    .option("--effort <effort>", "Reasoning effort: low, medium, high, max")
    .option("--permission <mode>", "Permission mode")
    .option("--name <name>", "Worker name (overrides spec or auto-generated)")
    .option("--hook <spec...>", "Hook: EVENT:COMMAND or EVENT:MATCHER:COMMAND")
    .option("--hook-gate <spec...>", "Blocking hook: EVENT:COMMAND")
    .option("--tool <spec...>", "Event tool: name:desc:handler=fn|cmd=script:param=type")
    .option("--env <pairs...>", "Environment: KEY=VALUE")
    .option("--allowed-tools <tools>", "Comma-separated tool whitelist")
    .option("--disallowed-tools <tools>", "Comma-separated tool denylist")
    .option("--system-prompt <text>", "Custom system prompt (inline or @file)")
    .option("--append-system-prompt <text>", "Append to system prompt")
    .option("--add-dir <dirs...>", "Additional directories")
    .option("--on-stop <command>", "Shorthand for --hook Stop:COMMAND")
    .option("--worktree", "Create git worktree")
    .option("--window <name>", "tmux window name")
    .option("--session <name>", "tmux session name")
    .option("--dir <path>", "Working directory")
    .option("--perpetual", "Run as perpetual worker")
    .option("--max-budget <usd>", "Cost cap in USD")
    .option("--type <type>", "Worker archetype template")
    .option("--report-to <name>", "Manager worker name")
    .option("--json-schema <schema>", "JSON output schema")
    .option("--mission <text>", "Mission statement (inline or @file)");
  addGlobalOpts(sub)
    .action(async (name: string | undefined, opts: Record<string, any>, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals();
      const project = globalOpts.project as string || resolveProject();

      // Mode 1: --spec file → load full AgentSpec
      if (opts.spec) {
        const specPath = resolve(opts.spec);
        if (!existsSync(specPath)) fail(`Spec file not found: ${specPath}`);
        const spec = loadAgentSpec(specPath);

        // CLI flags override spec fields
        if (opts.name || name) spec.name = opts.name || name || spec.name;
        if (opts.model) spec.model = opts.model;
        if (opts.runtime) spec.runtime = opts.runtime;
        if (opts.effort) spec.effort = opts.effort;
        if (opts.permission) spec.permission_mode = opts.permission;
        if (opts.prompt) spec.prompt = opts.prompt;
        if (opts.systemPrompt) spec.system_prompt = opts.systemPrompt;
        if (opts.appendSystemPrompt) spec.append_system_prompt = opts.appendSystemPrompt;
        if (opts.dir) spec.dir = opts.dir;
        if (opts.allowedTools) spec.allowed_tools = opts.allowedTools.split(",");
        if (opts.disallowedTools) spec.disallowed_tools = opts.disallowedTools.split(",");
        if (opts.addDir) spec.add_dir = [...(spec.add_dir || []), ...opts.addDir];
        if (opts.jsonSchema) spec.json_schema = opts.jsonSchema;
        if (opts.mission) spec.mission = opts.mission;

        // Parse additional hooks from CLI
        if (opts.hook || opts.hookGate || opts.onStop) {
          spec.hooks = spec.hooks || [];
          for (const h of opts.hook || []) {
            const parsed = parseHookFlag(h, false);
            spec.hooks.push({ event: parsed.event, type: "command", command: parsed.command, matcher: parsed.matcher, blocking: false });
          }
          for (const h of opts.hookGate || []) {
            const parsed = parseHookFlag(h, true);
            spec.hooks.push({ event: parsed.event, type: "command", command: parsed.command, matcher: parsed.matcher, blocking: true });
          }
          if (opts.onStop) {
            spec.hooks.push({ event: "Stop", type: "command", command: opts.onStop });
          }
        }

        // Parse additional tools from CLI
        if (opts.tool) {
          spec.tools = spec.tools || [];
          for (const t of opts.tool) spec.tools.push(parseToolFlag(t));
        }

        // Parse additional env from CLI
        if (opts.env) {
          spec.env = spec.env || {};
          for (const e of opts.env) {
            const [k, ...v] = e.split("=");
            spec.env[k] = v.join("=");
          }
        }

        await runWithSpec(spec, {
          window: opts.window,
          session: opts.session,
          specDir: dirname(specPath),
        }, globalOpts);
        return;
      }

      // Mode 2: --prompt flag → build AgentSpec inline
      if (opts.prompt) {
        const workerName = opts.name || name || nextRunName(project);
        const spec: AgentSpecFile = {
          name: workerName,
          role: "fleet run agent",
          model: opts.model,
          runtime: opts.runtime,
          effort: opts.effort,
          permission_mode: opts.permission,
          prompt: opts.prompt,
          system_prompt: opts.systemPrompt,
          append_system_prompt: opts.appendSystemPrompt,
          dir: opts.dir,
          allowed_tools: opts.allowedTools?.split(","),
          disallowed_tools: opts.disallowedTools?.split(","),
          add_dir: opts.addDir,
          sleep_duration: opts.perpetual ? 30 : null,
          type: opts.type,
          report_to: opts.reportTo,
          json_schema: opts.jsonSchema,
          mission: opts.mission,
          hooks: [],
          tools: [],
          env: {},
        };

        // Parse hooks
        for (const h of opts.hook || []) {
          const parsed = parseHookFlag(h, false);
          spec.hooks!.push({ event: parsed.event, type: "command", command: parsed.command, matcher: parsed.matcher });
        }
        for (const h of opts.hookGate || []) {
          const parsed = parseHookFlag(h, true);
          spec.hooks!.push({ event: parsed.event, type: "command", command: parsed.command, matcher: parsed.matcher, blocking: true });
        }
        if (opts.onStop) {
          spec.hooks!.push({ event: "Stop", type: "command", command: opts.onStop });
        }

        // Parse tools
        for (const t of opts.tool || []) spec.tools!.push(parseToolFlag(t));

        // Parse env
        for (const e of opts.env || []) {
          const [k, ...v] = e.split("=");
          spec.env![k] = v.join("=");
        }

        await runWithSpec(spec, {
          window: opts.window,
          session: opts.session,
        }, globalOpts);
        return;
      }

      // Mode 3: No --spec or --prompt → interactive mode (original behavior)
      const workerName = name || nextRunName(project);
      await runCreate(workerName, "Interactive session", {
        model: opts.model,
        effort: opts.effort,
        permissionMode: opts.permission,
        window: opts.window || workerName,
        type: opts.type,
        noLaunch: false,
      }, globalOpts);
    });
}
