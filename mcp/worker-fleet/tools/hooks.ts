/**
 * Hook tools — add_hook, complete_hook, remove_hook, list_hooks, manage_worker_hooks
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { CLAUDE_FLEET, HOME, PROJECT_ROOT, WORKER_NAME, FLEET_DIR } from "../config";
import {
  dynamicHooks, _incrementHookCounter, _persistHooks, _pendingHooksSummary,
  writeScriptFile, _archiveHook, readOtherWorkerHooks,
  type DynamicHook,
} from "../hooks";
import { readRegistry, canUpdateWorker } from "../registry";

// ── Permission Scanning ──────────────────────────────────────────────

/** Scan a script against the worker's permissions.json denyList.
 *  Returns null if allowed, or a reason string if blocked. */
function scanScriptAgainstDenyList(scriptContent: string): string | null {
  // Find permissions.json for this worker
  const permsPath = join(PROJECT_ROOT, ".claude/workers", WORKER_NAME, "permissions.json");
  if (!existsSync(permsPath)) return null; // No permissions = no restrictions

  let denyList: string[];
  try {
    const perms = JSON.parse(readFileSync(permsPath, "utf-8"));
    denyList = perms.denyList || [];
  } catch { return null; }

  if (denyList.length === 0) return null;

  // Normalize script: strip shebangs, comments, empty lines
  const lines = scriptContent.split("\n")
    .map(l => l.trim())
    .filter(l => l && !l.startsWith("#"));
  const normalized = lines.join(" ; ");

  for (const pattern of denyList) {
    // Extract tool name and arg pattern
    const toolMatch = pattern.match(/^(\w+)\((.+)\)$/);
    if (!toolMatch) continue;
    const [, toolName, argPattern] = toolMatch;

    // Only check Bash patterns against scripts
    if (toolName !== "Bash") continue;

    // Convert glob to regex
    const regex = argPattern
      .replace(/[.[\]^$+{}|\\]/g, "\\$&")
      .replace(/\*\*/g, "GLOB_STAR_STAR")
      .replace(/\*/g, ".*")
      .replace(/GLOB_STAR_STAR/g, ".*")
      .replace(/\?/g, ".");

    try {
      const re = new RegExp(regex);
      if (re.test(normalized) || re.test(scriptContent)) {
        return `Script blocked by policy: matches Bash(${argPattern}) in denyList`;
      }
    } catch { /* invalid regex — skip */ }
  }

  return null;
}

export function registerHookTools(server: McpServer): void {

server.registerTool(
  "add_hook",
  {
    description: "Register a dynamic hook that fires on a hook event. Can block the event (gate), inject context, or run a script. Use for self-governance: add verification gates before recycling, inject guidance before tool calls, trigger notifications via scripts, or block specific tool usage until conditions are met.",
    inputSchema: {
      event: z.enum([
        "SessionStart", "SessionEnd", "InstructionsLoaded",
        "UserPromptSubmit",
        "PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure",
        "Notification", "Stop",
        "SubagentStart", "SubagentStop", "TeammateIdle", "TaskCompleted",
        "ConfigChange", "PreCompact",
        "WorktreeCreate", "WorktreeRemove",
      ]).describe("Which hook event to fire on. Common: Stop (blocks session exit), PreToolUse (fires before tool call), PreCompact (before context compaction), SubagentStop (when subagent finishes)"),
      description: z.string().describe("Human-readable purpose (e.g. 'verify build passes', 'notify validator on completion')"),
      blocking: z.boolean().optional().describe("If true (default for Stop), blocks the event until complete_hook(id) is called. If false (default for PreToolUse), injects content as context and passes through"),
      content: z.string().optional().describe("For inject hooks: context text to add. For blocking hooks: block reason shown to agent. Falls back to description if omitted"),
      script: z.string().optional().describe("Shell script to execute when hook fires. Inline command or @/path/to/script.sh (file is copied). Scanned against denyList at registration. Exit 0=allow, 2=block (stderr shown), 1=error (logged)"),
      condition: z.object({
        tool: z.string().optional().describe("Only fire when this tool is called (e.g. 'Bash', 'Edit', 'Write')"),
        file_glob: z.string().optional().describe("Only fire when file path matches glob (e.g. 'src/ontology/**')"),
        command_pattern: z.string().optional().describe("Only fire when Bash command matches regex (e.g. 'git push.*')"),
      }).optional().describe("Condition for when this hook fires (PreToolUse only). Omit for unconditional"),
      agent_id: z.string().optional().describe("Scope to a specific subagent. Auto-completed on SubagentStop. Subagents: use the agent_id injected by pre-tool-context-injector"),
      lifetime: z.enum(["cycle", "persistent"]).optional().describe("Hook lifetime. 'cycle' = archived on recycle. 'persistent' = survives recycles. Default: 'persistent' for Stop, 'cycle' for others"),
      check: z.string().optional().describe("Bash command to verify condition. Exit 0 = pass (hook allows), non-zero = block. Re-evaluated each time the event fires — no manual complete_hook needed. Env: $WORKER_NAME, $PROJECT_ROOT"),
      max_fires: z.number().optional().describe("Auto-pass after this many blocks (safety valve). Default: 5. Prevents infinite loops for check-based Stop hooks"),
    },
  },
  async ({ event, description, blocking, content, script, condition, agent_id, lifetime, check, max_fires }) => {
    const id = `dh-${_incrementHookCounter()}`;
    // Stop defaults to blocking, most others default to inject
    const isBlocking = blocking ?? (event === "Stop");

    // If script provided, scan against denyList before writing
    let scriptPath: string | undefined;
    if (script) {
      // Get script content for scanning
      let scriptContent: string;
      if (script.startsWith("@")) {
        const srcPath = script.slice(1);
        if (!existsSync(srcPath)) {
          return { content: [{ type: "text" as const, text: `Script source file not found: ${srcPath}` }], isError: true };
        }
        scriptContent = readFileSync(srcPath, "utf-8");
      } else {
        scriptContent = script;
      }

      // Registration-time scan
      const blocked = scanScriptAgainstDenyList(scriptContent);
      if (blocked) {
        return { content: [{ type: "text" as const, text: `Hook rejected: ${blocked}` }], isError: true };
      }

      // Write script file
      try {
        scriptPath = writeScriptFile(id, description, script);
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Failed to write script: ${e}` }], isError: true };
      }
    }

    // Resolve lifetime: Stop hooks default to persistent, others to cycle
    const resolvedLifetime = lifetime ?? (event === "Stop" ? "persistent" : "cycle");

    const hook: DynamicHook = {
      id, event, description,
      blocking: isBlocking,
      completed: false,
      status: "active",
      lifetime: resolvedLifetime,
      added_at: new Date().toISOString(),
    };
    if (content) hook.content = content;
    if (condition) hook.condition = condition;
    if (agent_id) hook.agent_id = agent_id;
    if (scriptPath) hook.script_path = scriptPath;
    if (check) hook.check = check;
    if (max_fires !== undefined) hook.max_fires = max_fires;
    if (check && hook.max_fires === undefined) hook.max_fires = 5;
    if (check) hook.fire_count = 0;
    dynamicHooks.set(id, hook);
    _persistHooks();
    const agentNote = agent_id ? ` (scoped to subagent ${agent_id})` : "";
    const typeLabel = isBlocking ? "blocking" : "inject";
    const condNote = condition ? ` [condition: ${JSON.stringify(condition)}]` : "";
    const scriptNote = scriptPath ? ` [script: ${scriptPath}]` : "";
    const checkNote = check ? ` [check: ${check.slice(0, 60)}${check.length > 60 ? "..." : ""}]` : "";
    const lifetimeNote = ` [${resolvedLifetime}]`;
    return {
      content: [{
        type: "text" as const,
        text: `Hook registered: [${id}] ${event}/${typeLabel} — ${description}${agentNote}${condNote}${scriptNote}${checkNote}${lifetimeNote}\nActive hooks: ${_pendingHooksSummary()}.`,
      }],
    };
  }
);

server.registerTool(
  "complete_hook",
  {
    description: "Mark a blocking hook as completed (unblocks the event). Call after performing the verification described in the hook. Pass 'all' to complete every pending blocking hook at once.",
    inputSchema: {
      id: z.string().describe("Hook ID (e.g. 'dh-1'). Use 'all' to complete all pending blocking hooks"),
      result: z.string().optional().describe("Brief outcome (e.g. 'PASS — 0 errors'). Stored for audit"),
    },
  },
  async ({ id, result }) => {
    if (id === "all") {
      const pending = [...dynamicHooks.values()].filter(h => h.blocking && !h.completed);
      if (pending.length === 0) {
        return { content: [{ type: "text" as const, text: "No pending blocking hooks to complete." }] };
      }
      const now = new Date().toISOString();
      for (const hook of pending) {
        hook.completed = true;
        hook.completed_at = now;
        if (result) hook.result = result;
      }
      _persistHooks();
      return {
        content: [{
          type: "text" as const,
          text: `Completed ${pending.length} hook(s). All blocking hooks cleared.`,
        }],
      };
    }
    const hook = dynamicHooks.get(id);
    if (!hook) {
      return { content: [{ type: "text" as const, text: `No hook with ID '${id}'.` }], isError: true };
    }
    hook.completed = true;
    hook.completed_at = new Date().toISOString();
    if (result) hook.result = result;
    _persistHooks();
    const pending = [...dynamicHooks.values()].filter(h => h.blocking && !h.completed);
    const resultNote = result ? ` (${result})` : "";
    return {
      content: [{
        type: "text" as const,
        text: `Completed: [${id}] ${hook.description}${resultNote}\n${pending.length} blocking hook(s) remaining.`,
      }],
    };
  }
);

server.registerTool(
  "list_hooks",
  {
    description: "List hooks (static infrastructure + dynamic runtime hooks). Shows what fires on each event, whether it blocks or injects, and its current status. Supports cross-worker discovery.",
    inputSchema: {
      event: z.string().optional().describe("Filter to a specific event (e.g. 'Stop', 'PreToolUse'). Omit for all events"),
      include_static: z.boolean().optional().describe("Include static infrastructure hooks from manifest (default: true)"),
      include_archived: z.boolean().optional().describe("Include archived hooks (default: false). Useful for auditing hook history"),
      worker: z.string().optional().describe("Read another worker's hooks (cross-worker discovery). Omit for your own hooks"),
    },
  },
  async ({ event, include_static, include_archived, worker }) => {
    const showStatic = include_static !== false;
    const showArchived = include_archived === true;
    const isOtherWorker = worker && worker !== WORKER_NAME;
    const lines: string[] = [`# ${isOtherWorker ? `${worker}'s` : "Active"} Hooks\n`];

    // ── Dynamic hooks ──
    let hookList: DynamicHook[];
    if (isOtherWorker) {
      hookList = readOtherWorkerHooks(worker, showArchived);
    } else {
      hookList = [...dynamicHooks.values()];
      // Optionally include archived from file
      if (showArchived) {
        try {
          const hooksDir = join(FLEET_DIR, WORKER_NAME, "hooks", "hooks.json");
          if (existsSync(hooksDir)) {
            const data = JSON.parse(readFileSync(hooksDir, "utf-8"));
            if (Array.isArray(data.hooks)) {
              const activeIds = new Set(hookList.map(h => h.id));
              const archived = data.hooks.filter((h: DynamicHook) => h.status === "archived" && !activeIds.has(h.id));
              hookList = [...hookList, ...archived];
            }
          }
        } catch {}
      }
    }

    const filteredList = hookList
      .filter(h => !event || h.event === event)
      .sort((a, b) => a.event.localeCompare(b.event) || a.id.localeCompare(b.id));

    if (filteredList.length > 0) {
      lines.push(`## Dynamic Hooks (${filteredList.length})\n`);
      for (const h of filteredList) {
        const type = h.blocking ? "GATE" : "INJECT";
        const isArchived = h.status === "archived";
        let status: string;
        if (isArchived) {
          status = `ARCHIVED (${h.archive_reason || "unknown"})`;
        } else if (h.blocking) {
          status = h.completed ? `DONE${h.result ? ` (${h.result})` : ""}` : "PENDING";
        } else {
          status = "active";
        }
        const cond = h.condition ? ` [${Object.entries(h.condition).map(([k,v]) => `${k}=${v}`).join(", ")}]` : "";
        const scope = h.agent_id ? ` (agent: ${h.agent_id})` : "";
        const scriptInfo = h.script_path ? ` [script: ${h.script_path}]` : "";
        const checkInfo = h.check ? ` [check: ${h.check.slice(0, 50)}${h.check.length > 50 ? "..." : ""}]` : "";
        const lifetimeInfo = h.lifetime ? ` [${h.lifetime}]` : "";
        const fireInfo = h.fire_count !== undefined ? ` (fired: ${h.fire_count}/${h.max_fires || 5})` : "";
        lines.push(`- **[${h.id}]** ${h.event}/${type} — ${h.description}${cond}${scope}${scriptInfo}${checkInfo}${lifetimeInfo}${fireInfo}`);
        lines.push(`  Status: ${status} | Added: ${h.added_at.slice(0, 16)}`);
        if (h.content && h.content !== h.description) {
          const preview = h.content.length > 100 ? h.content.slice(0, 97) + "..." : h.content;
          lines.push(`  Content: "${preview}"`);
        }
      }
    } else {
      lines.push("## Dynamic Hooks\nNone registered. Use `add_hook()` to add verification gates, context injectors, or script triggers.\n");
    }

    // ── Static hooks (infrastructure, from manifest) — only for own worker ──
    if (showStatic && !isOtherWorker) {
      try {
        const manifestPath = join(CLAUDE_FLEET, "hooks", "manifest.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        const staticHooks = (manifest.hooks || []).filter((h: any) =>
          h.id && h.event && (!event || h.event === event) && !h._comment
        );

        if (staticHooks.length > 0) {
          const byCategory: Record<string, any[]> = {};
          for (const h of staticHooks) {
            const cat = h.category || "other";
            if (!byCategory[cat]) byCategory[cat] = [];
            byCategory[cat].push(h);
          }

          lines.push(`\n## Static Hooks (${staticHooks.length} from manifest)\n`);
          for (const [cat, hooks] of Object.entries(byCategory)) {
            lines.push(`### ${cat}`);
            for (const h of hooks) {
              lines.push(`- **${h.id}** (${h.event}) — ${h.description}`);
            }
          }
        }
      } catch {
        lines.push("\n## Static Hooks\n_Could not read manifest.json_");
      }
    }

    // Summary
    const activeHooks = hookList.filter(h => h.status !== "archived");
    const blocking = activeHooks.filter(h => h.blocking && !h.completed);
    const inject = activeHooks.filter(h => !h.blocking);
    const withCheck = activeHooks.filter(h => h.check);
    const archivedCount = hookList.filter(h => h.status === "archived").length;
    lines.push(`\n---\n**Summary:** ${activeHooks.length} active (${blocking.length} blocking pending, ${inject.length} inject, ${withCheck.length} with check)${archivedCount > 0 ? ` | ${archivedCount} archived` : ""}`);

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

server.registerTool(
  "remove_hook",
  {
    description: "Archive a dynamic hook (preserved in hooks.json but no longer fires). Use for inject hooks you no longer need, or to clean up completed gates. Archived hooks are discoverable via list_hooks(include_archived=true).",
    inputSchema: {
      id: z.string().describe("Hook ID to archive (e.g. 'dh-2'). Use 'all' to archive all hooks"),
    },
  },
  async ({ id }) => {
    if (id === "all") {
      const count = dynamicHooks.size;
      for (const [hookId] of dynamicHooks) {
        _archiveHook(hookId, "removed");
      }
      return { content: [{ type: "text" as const, text: `Archived all ${count} hook(s). They remain in hooks.json for history.` }] };
    }
    const archived = _archiveHook(id, "removed");
    if (!archived) {
      return { content: [{ type: "text" as const, text: `No active hook with ID '${id}'.` }], isError: true };
    }
    return {
      content: [{
        type: "text" as const,
        text: `Archived: [${id}] ${archived.description}\nRemaining active hooks: ${_pendingHooksSummary()}.`,
      }],
    };
  }
);

// ── Cross-worker hook management ─────────────────────────────────────

server.registerTool(
  "manage_worker_hooks",
  {
    description: "Manage hooks on another worker. Add verification gates, remove hooks, complete hooks, or list hooks for a target worker. Requires authority over the target (mission_authority or direct report). For managing your own hooks, use add_hook/remove_hook/complete_hook/list_hooks instead.",
    inputSchema: {
      action: z.enum(["add", "remove", "complete", "list"]).describe("Action to perform on target worker's hooks"),
      target: z.string().describe("Target worker name"),
      // For add:
      event: z.string().optional().describe("Hook event (Stop, PreToolUse, etc.) — required for 'add'"),
      hook_description: z.string().optional().describe("Human-readable purpose — required for 'add'"),
      blocking: z.boolean().optional().describe("If true, blocks event until completed. Default: true for Stop, false otherwise"),
      content: z.string().optional().describe("Context text (inject) or block reason (gate)"),
      script: z.string().optional().describe("Shell script to run. Scanned against target's permissions"),
      check: z.string().optional().describe("Bash command for auto-verification. Exit 0 = pass"),
      lifetime: z.enum(["cycle", "persistent"]).optional().describe("Hook lifetime. Default: persistent for Stop, cycle for others"),
      max_fires: z.number().optional().describe("Auto-pass after N blocks (safety valve). Default: 5 for check hooks"),
      // For remove/complete:
      id: z.string().optional().describe("Hook ID (e.g. 'dh-1') — required for 'remove'/'complete'. Use 'all' to batch"),
      result: z.string().optional().describe("Brief outcome for 'complete' (e.g. 'PASS')"),
      // For list:
      include_archived: z.boolean().optional().describe("Include archived hooks (default: false)"),
    },
  },
  async (params) => {
    const { action, target } = params;

    // Authorization check
    const registry = readRegistry();
    if (!canUpdateWorker(WORKER_NAME, target, registry)) {
      return {
        content: [{ type: "text" as const, text: `Unauthorized: ${WORKER_NAME} cannot manage hooks on ${target}. Requires mission_authority or direct-report relationship.` }],
        isError: true,
      };
    }

    // Resolve target's hooks file
    const targetHooksDir = join(FLEET_DIR, target, "hooks");
    const targetHooksFile = join(targetHooksDir, "hooks.json");

    // Read target's hooks
    function readTargetHooks(): { hooks: DynamicHook[]; counter: number } {
      if (!existsSync(targetHooksFile)) return { hooks: [], counter: 0 };
      try {
        const data = JSON.parse(readFileSync(targetHooksFile, "utf-8"));
        const hooks: DynamicHook[] = data.hooks || [];
        let counter = 0;
        for (const h of hooks) {
          const num = parseInt(h.id.replace("dh-", ""), 10);
          if (!isNaN(num) && num > counter) counter = num;
        }
        return { hooks, counter };
      } catch { return { hooks: [], counter: 0 }; }
    }

    function writeTargetHooks(hooks: DynamicHook[]): void {
      mkdirSync(targetHooksDir, { recursive: true });
      writeFileSync(targetHooksFile, JSON.stringify({ hooks }, null, 2));
    }

    // ── LIST ──
    if (action === "list") {
      const { hooks } = readTargetHooks();
      const filtered = params.include_archived
        ? hooks
        : hooks.filter(h => h.status !== "archived");
      if (filtered.length === 0) {
        return { content: [{ type: "text" as const, text: `No hooks on ${target}.` }] };
      }
      const lines = filtered.map(h => {
        const type = h.blocking ? "GATE" : "INJECT";
        const status = h.status === "archived" ? "ARCHIVED" : (h.blocking ? (h.completed ? "DONE" : "PENDING") : "active");
        const by = h.registered_by ? ` (by ${h.registered_by})` : "";
        return `[${h.id}] ${h.event}/${type} — ${h.description} [${status}]${by}`;
      });
      return { content: [{ type: "text" as const, text: `# ${target}'s hooks (${filtered.length})\n${lines.join("\n")}` }] };
    }

    // ── ADD ──
    if (action === "add") {
      if (!params.event || !params.hook_description) {
        return { content: [{ type: "text" as const, text: "Error: 'event' and 'hook_description' are required for add" }], isError: true };
      }
      const { hooks, counter } = readTargetHooks();
      const id = `dh-${counter + 1}`;
      const isBlocking = params.blocking ?? (params.event === "Stop");

      // Scan script against target's permissions if provided
      if (params.script) {
        const targetPermsPath = join(PROJECT_ROOT, ".claude/workers", target, "permissions.json");
        if (existsSync(targetPermsPath)) {
          const scriptContent = params.script.startsWith("@")
            ? (existsSync(params.script.slice(1)) ? readFileSync(params.script.slice(1), "utf-8") : params.script)
            : params.script;
          // Reuse scanScriptAgainstDenyList logic with target's permissions
          try {
            const perms = JSON.parse(readFileSync(targetPermsPath, "utf-8"));
            const denyList: string[] = perms.denyList || [];
            for (const pattern of denyList) {
              const m = pattern.match(/^(\w+)\((.+)\)$/);
              if (!m || m[1] !== "Bash") continue;
              const regex = m[2].replace(/[.[\]^$+{}|\\]/g, "\\$&").replace(/\*\*/g, "GLOB_STAR_STAR").replace(/\*/g, ".*").replace(/GLOB_STAR_STAR/g, ".*").replace(/\?/g, ".");
              try {
                if (new RegExp(regex).test(scriptContent)) {
                  return { content: [{ type: "text" as const, text: `Hook rejected: script blocked by target's policy (matches Bash(${m[2]}))` }], isError: true };
                }
              } catch {}
            }
          } catch {}
        }
      }

      const resolvedLifetime = params.lifetime ?? (params.event === "Stop" ? "persistent" : "cycle");
      const hook: DynamicHook = {
        id,
        event: params.event,
        description: params.hook_description,
        blocking: isBlocking,
        completed: false,
        status: "active",
        lifetime: resolvedLifetime,
        registered_by: WORKER_NAME,
        ownership: "creator",
        added_at: new Date().toISOString(),
      };
      if (params.content) hook.content = params.content;
      if (params.check) { hook.check = params.check; hook.max_fires = params.max_fires ?? 5; hook.fire_count = 0; }
      if (params.max_fires !== undefined) hook.max_fires = params.max_fires;

      hooks.push(hook);
      writeTargetHooks(hooks);
      return { content: [{ type: "text" as const, text: `Hook [${id}] added to ${target}: ${params.event}/${isBlocking ? "GATE" : "INJECT"} — ${params.hook_description} [${resolvedLifetime}, owner: ${WORKER_NAME}]` }] };
    }

    // ── REMOVE ──
    if (action === "remove") {
      if (!params.id) return { content: [{ type: "text" as const, text: "Error: 'id' required for remove" }], isError: true };
      const { hooks } = readTargetHooks();
      if (params.id === "all") {
        const count = hooks.length;
        for (const h of hooks) h.status = "archived";
        writeTargetHooks(hooks);
        return { content: [{ type: "text" as const, text: `Archived all ${count} hook(s) on ${target}.` }] };
      }
      const hook = hooks.find(h => h.id === params.id);
      if (!hook) return { content: [{ type: "text" as const, text: `No hook '${params.id}' on ${target}.` }], isError: true };
      hook.status = "archived";
      hook.archived_at = new Date().toISOString();
      hook.archive_reason = `removed by ${WORKER_NAME}`;
      writeTargetHooks(hooks);
      return { content: [{ type: "text" as const, text: `Archived [${params.id}] on ${target}: ${hook.description}` }] };
    }

    // ── COMPLETE ──
    if (action === "complete") {
      if (!params.id) return { content: [{ type: "text" as const, text: "Error: 'id' required for complete" }], isError: true };
      const { hooks } = readTargetHooks();
      const now = new Date().toISOString();
      if (params.id === "all") {
        let count = 0;
        for (const h of hooks) {
          if (h.blocking && !h.completed && h.status !== "archived") {
            h.completed = true;
            h.completed_at = now;
            if (params.result) h.result = params.result;
            count++;
          }
        }
        writeTargetHooks(hooks);
        return { content: [{ type: "text" as const, text: `Completed ${count} blocking hook(s) on ${target}.` }] };
      }
      const hook = hooks.find(h => h.id === params.id);
      if (!hook) return { content: [{ type: "text" as const, text: `No hook '${params.id}' on ${target}.` }], isError: true };
      hook.completed = true;
      hook.completed_at = now;
      if (params.result) hook.result = params.result;
      writeTargetHooks(hooks);
      return { content: [{ type: "text" as const, text: `Completed [${params.id}] on ${target}: ${hook.description}${params.result ? ` (${params.result})` : ""}` }] };
    }

    return { content: [{ type: "text" as const, text: `Unknown action: ${action}` }], isError: true };
  }
);

} // end registerHookTools
