#!/usr/bin/env bun
/**
 * worker-fleet MCP server — Core tools for worker fleet coordination.
 *
 * 14 tools (fundamentals only — use fleet CLI for everything else):
 *   Mail (4):       mail_send, mail_inbox, mail_read, mail_help
 *   Lifecycle (2):  recycle, save_checkpoint
 *   State (2):      get_worker_state, update_state
 *   Hooks (4):      add_hook, complete_hook, remove_hook, list_hooks
 *   Fleet (2):      create_worker, fleet_help
 *
 * Removed (use fleet CLI):
 *   register_worker, deregister_worker, move_worker, standby_worker, fleet_template
 *   update_config → fleet defaults, update_worker_config → fleet config
 *   deep_review → bash ~/.deep-review/scripts/deep-review.sh
 *
 * Runtime: bun run ~/.tmux-agents/mcp/worker-fleet/index.ts (stdio transport)
 * Identity: auto-detected from WORKER_NAME env or git branch (worker/* → name)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// ── Tool modules ─────────────────────────────────────────────────────
import { registerStateTools } from "./tools/state";
import { registerHookTools } from "./tools/hooks";
import { registerLifecycleTools } from "./tools/lifecycle";
import { registerFleetTools } from "./tools/fleet";
import { registerMailTools } from "./tools/mail";

// ── Server ───────────────────────────────────────────────────────────

const server = new McpServer({
  name: "worker-fleet",
  version: "3.0.0",
});

registerStateTools(server);
registerHookTools(server);
registerLifecycleTools(server);
registerFleetTools(server);
registerMailTools(server);

// ── Start ────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("worker-fleet MCP server fatal:", e);
    process.exit(1);
  });
}

// ── Exports for testing ──────────────────────────────────────────────
// Re-export everything that the monolith previously exported, preserving
// backward compatibility for tests and external consumers.

// helpers.ts
export { writeToTriageQueue, buildMessageBody, readJsonFile, _replaceMemorySection, _captureGitState, _timestampFilename, _writeCheckpoint } from "./helpers";

// tmux.ts
export { resolveRecipient, isPaneAlive, findOwnPane, getSessionId } from "./tmux";

// registry.ts
export {
  acquireLock, releaseLock,
  readRegistry, getWorkerEntry, withRegistryLocked, ensureWorkerInRegistry,
  getReportTo, canUpdateWorker, getWorkerModel,
  readFleetConfig, writeFleetConfig,
  readWorkerConfig, writeWorkerConfig,
  readWorkerState, writeWorkerState,
  listWorkerNames, getDefaultSystemHooks,
  generateLaunchScript, writeLaunchScript,
  type WorkerConfig, type WorkerState,
  type RegistryConfig, type RegistryWorkerEntry, type ProjectRegistry,
} from "./registry";

// config.ts
export { WORKER_NAME, WORKERS_DIR, HARNESS_LOCK_DIR, REGISTRY_PATH, FLEET_DIR, FLEET_CONFIG_PATH, _setWorkersDir, getWorktreeDir } from "./config";

// diagnostics.ts
export { runDiagnostics, lintRegistry, type DiagnosticIssue } from "./diagnostics";

// hooks.ts
export { _captureHooksSnapshot } from "./hooks";

// seed.ts
export { generateSeedContent } from "./seed";

// runtime.ts
export { type WorkerRuntime, type ReasoningEffort, type RuntimeConfig, getWorkerRuntime, RUNTIMES } from "./runtime";

// tools/fleet.ts
export { createWorkerFiles } from "./tools/fleet";
