/**
 * Runtime configuration — abstraction layer for Claude vs Codex CLI differences.
 */

import { WORKER_NAME } from "./config";
import { getWorkerEntry } from "./registry";

// ── Types ────────────────────────────────────────────────────────────

export type WorkerType = "implementer" | "monitor" | "coordinator" | "optimizer" | "verifier";
export type WorkerRuntime = "claude" | "codex";
export type ReasoningEffort = "low" | "medium" | "high" | "extra_high";

export interface RuntimeLaunchOpts {
  model: string;
  permissionMode: string;
  disallowedTools?: string;
  workerDir: string;
  reasoningEffort?: ReasoningEffort;
}

export interface RuntimeResumeOpts {
  model: string;
  permissionMode: string;
  workerDir: string;
  sessionId: string;
}

export interface RuntimeConfig {
  type: WorkerRuntime;
  binary: string;
  defaultModel: string;
  buildLaunchCmd(opts: RuntimeLaunchOpts): string;
  buildResumeCmd(opts: RuntimeResumeOpts): string;
  buildForkCmd(opts: RuntimeResumeOpts): string;
  exitCommand: string;
  processPattern: RegExp;
  tuiReadyPattern: RegExp;
  buildEnv(): Record<string, string>;
}

// ── Runtime Implementations ──────────────────────────────────────────

export const CLAUDE_RUNTIME: RuntimeConfig = {
  type: "claude",
  binary: "claude",
  defaultModel: "opus",
  buildLaunchCmd({ model, permissionMode, disallowedTools, workerDir, reasoningEffort }) {
    let cmd = `CLAUDE_CODE_SKIP_PROJECT_LOCK=1 claude --model ${model}`;
    if (permissionMode === "bypassPermissions") cmd += " --dangerously-skip-permissions";
    if (reasoningEffort) cmd += ` --effort ${reasoningEffort}`;
    if (disallowedTools) cmd += ` --disallowed-tools "${disallowedTools}"`;
    cmd += ` --add-dir ${workerDir}`;
    return cmd;
  },
  buildResumeCmd({ model, permissionMode, workerDir, sessionId }) {
    let cmd = `CLAUDE_CODE_SKIP_PROJECT_LOCK=1 claude --model ${model}`;
    if (permissionMode === "bypassPermissions") cmd += " --dangerously-skip-permissions";
    cmd += ` --add-dir ${workerDir} --resume ${sessionId}`;
    return cmd;
  },
  buildForkCmd({ model, permissionMode, workerDir, sessionId }) {
    let cmd = `CLAUDE_CODE_SKIP_PROJECT_LOCK=1 claude --model ${model}`;
    if (permissionMode === "bypassPermissions") cmd += " --dangerously-skip-permissions";
    cmd += ` --add-dir ${workerDir} --resume ${sessionId} --fork-session`;
    return cmd;
  },
  exitCommand: "/exit",
  processPattern: /claude/,
  tuiReadyPattern: /bypass permissions|Context left/,
  buildEnv() {
    return { CLAUDE_CODE_SKIP_PROJECT_LOCK: "1" };
  },
};

export const CODEX_RUNTIME: RuntimeConfig = {
  type: "codex",
  binary: "codex",
  defaultModel: "gpt-5.4",
  buildLaunchCmd({ model, permissionMode, reasoningEffort, workerDir }) {
    let cmd = `codex -m ${model}`;
    if (permissionMode === "bypassPermissions") cmd += " --dangerously-bypass-approvals-and-sandbox";
    else cmd += " -s danger-full-access -a on-request";
    if (reasoningEffort) cmd += ` -c model_reasoning_effort=${reasoningEffort}`;
    cmd += " --no-alt-screen";
    if (workerDir) cmd += ` --add-dir "${workerDir}"`;
    return cmd;
  },
  buildResumeCmd({ sessionId }) {
    return `codex resume ${sessionId}`;
  },
  buildForkCmd({ sessionId }) {
    return `codex fork ${sessionId}`;
  },
  exitCommand: "/exit",
  processPattern: /codex/,
  tuiReadyPattern: /codex|ready/i,
  buildEnv() {
    return {};
  },
};

export const RUNTIMES: Record<WorkerRuntime, RuntimeConfig> = {
  claude: CLAUDE_RUNTIME,
  codex: CODEX_RUNTIME,
};

// ── Runtime Resolution ───────────────────────────────────────────────

/** Get the RuntimeConfig for a worker by name. Reads custom.runtime from registry. */
export function getWorkerRuntime(workerName?: string): RuntimeConfig {
  const name = workerName || WORKER_NAME;
  try {
    const entry = getWorkerEntry(name);
    const rt = (entry?.custom?.runtime as WorkerRuntime) || "claude";
    return RUNTIMES[rt] || CLAUDE_RUNTIME;
  } catch {
    return CLAUDE_RUNTIME;
  }
}
