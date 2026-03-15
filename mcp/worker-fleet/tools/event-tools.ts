/**
 * Event Tools — Druids-style dynamic MCP tool registration per worker.
 *
 * Reads event-tools.json from the worker's fleet dir (written by provisioner
 * or fleet run), then registers each tool with the MCP server. On invocation,
 * routes to either:
 *   - mode:"inline" → import(programPath)[handler](input, ctx)
 *   - mode:"command" → bash with INPUT_* env vars
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { HOME, FLEET_DIR, WORKER_NAME } from "../config";
import { FLEET_MAIL_URL } from "../mail-client";
import type { EventTool, EventToolContext, EventToolResult } from "../../../shared/types";

interface EventToolsConfig {
  programPath: string | null;
  tools: EventTool[];
  sessionDir: string;
  projectRoot: string;
}

/**
 * Build an EventToolContext for handler invocations.
 */
function buildContext(config: EventToolsConfig): EventToolContext {
  const workerName = WORKER_NAME;
  const resultsDir = join(config.sessionDir, "results", workerName);

  return {
    workerName,
    projectRoot: config.projectRoot,
    sessionDir: config.sessionDir,

    async sendMail(to: string, subject: string, body: string) {
      const mailUrl = FLEET_MAIL_URL || process.env.FLEET_MAIL_URL;
      const mailToken = process.env.FLEET_MAIL_TOKEN;
      if (!mailUrl || !mailToken) return;
      try {
        await fetch(`${mailUrl}/api/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${mailToken}`,
          },
          body: JSON.stringify({ to, subject, body }),
          signal: AbortSignal.timeout(5000),
        });
      } catch {}
    },

    updateState(key: string, value: unknown) {
      const statePath = join(FLEET_DIR, workerName, "state.json");
      try {
        const state = JSON.parse(readFileSync(statePath, "utf-8"));
        if (!state.custom) state.custom = {};
        state.custom[key] = value;
        writeFileSync(statePath, JSON.stringify(state, null, 2));
      } catch {}
    },

    async spawnWorker(name: string, mission: string, opts?: Record<string, unknown>) {
      const model = (opts?.model as string) || "sonnet";
      try {
        execSync(
          `fleet create "${name}" "${mission.replace(/"/g, '\\"')}" --model "${model}"`,
          { timeout: 30000, stdio: "pipe" },
        );
      } catch {}
    },

    async triggerNode(nodeName: string) {
      const fleetDir = process.env.CLAUDE_FLEET_DIR || join(HOME, ".claude-fleet");
      try {
        execSync(
          `nohup bun "${fleetDir}/engine/program/bridge.ts" "${config.sessionDir}" --node "${nodeName}" >> "${config.sessionDir}/bridge-launch.log" 2>&1 &`,
          { timeout: 5000, stdio: "pipe" },
        );
      } catch {}
    },

    writeResult(filename: string, content: string) {
      mkdirSync(resultsDir, { recursive: true });
      writeFileSync(join(resultsDir, filename), content);
    },

    readResult(filename: string): string | null {
      const path = join(resultsDir, filename);
      try { return readFileSync(path, "utf-8"); } catch { return null; }
    },
  };
}

/**
 * Convert EventToolParam to Zod schema.
 */
function paramToZod(param: { type: string; description?: string; required?: boolean }): z.ZodTypeAny {
  let schema: z.ZodTypeAny;
  switch (param.type) {
    case "number": schema = z.number(); break;
    case "boolean": schema = z.boolean(); break;
    case "object": schema = z.record(z.unknown()); break;
    case "array": schema = z.array(z.unknown()); break;
    default: schema = z.string(); break;
  }
  if (param.description) schema = schema.describe(param.description);
  if (!param.required) schema = schema.optional();
  return schema;
}

/**
 * Register event tools from the worker's event-tools.json.
 * Called at MCP server startup.
 */
export function registerEventTools(server: McpServer): void {
  // Find event-tools.json in worker's fleet dir
  const configPath = join(FLEET_DIR, WORKER_NAME, "event-tools.json");
  if (!existsSync(configPath)) return;

  let config: EventToolsConfig;
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return;
  }

  if (!config.tools?.length) return;

  const ctx = buildContext(config);

  for (const tool of config.tools) {
    // Build Zod input schema
    const zodShape: Record<string, z.ZodTypeAny> = {};
    if (tool.inputSchema) {
      for (const [key, param] of Object.entries(tool.inputSchema)) {
        zodShape[key] = paramToZod(param);
      }
    }

    // @ts-ignore — MCP SDK deep type instantiation with Zod
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: zodShape,
      },
      // @ts-ignore — MCP SDK deep type instantiation with Zod
      async (params: Record<string, any>) => {
        try {
          let result: EventToolResult;

          if (tool.mode === "inline" && config.programPath) {
            // Import program file and call handler function
            const programModule = await import(config.programPath);
            const handlerFn = programModule[tool.handler];
            if (typeof handlerFn !== "function") {
              return { content: [{ type: "text" as const, text: `Error: handler '${tool.handler}' not found in program file` }], isError: true };
            }
            result = await handlerFn(params, ctx);
          } else {
            // Command mode — run bash with INPUT_* env vars
            const env: Record<string, string> = {
              ...process.env as Record<string, string>,
              WORKER_NAME: ctx.workerName,
              SESSION_DIR: ctx.sessionDir,
              PROJECT_ROOT: ctx.projectRoot,
              RESULTS_DIR: join(ctx.sessionDir, "results", ctx.workerName),
            };

            // Set INPUT_* env vars from params
            for (const [key, value] of Object.entries(params)) {
              env[`INPUT_${key.toUpperCase()}`] = String(value);
            }

            // Also pass full input as JSON
            env.INPUT_JSON = JSON.stringify(params);

            const output = execSync(tool.handler, {
              env,
              timeout: 30000,
              encoding: "utf-8",
              stdio: ["pipe", "pipe", "pipe"],
            });

            result = { text: output.trim() };
          }

          return { content: [{ type: "text" as const, text: result.text }] };
        } catch (e: any) {
          return { content: [{ type: "text" as const, text: `Error in ${tool.name}: ${e.message}` }], isError: true };
        }
      },
    );
  }

  console.error(`event-tools: registered ${config.tools.length} tool(s) for ${WORKER_NAME}`);
}
