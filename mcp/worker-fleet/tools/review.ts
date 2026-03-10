/**
 * Review tools — deep_review
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { HOME, PROJECT_ROOT } from "../config";

export function registerReviewTools(server: McpServer): void {

// @ts-ignore — MCP SDK deep type instantiation with Zod
server.registerTool(
  "deep_review",
  {
    description:
      "Launch a multi-pass deep review pipeline (v4). NEW in v2: dynamic role designer (Sonnet designs optimal team composition), worktree isolation (fixes on separate branch), inter-worker communication (file-based comms), post-exit output validation (JSON schema enforcement), multi-verifier dispatch (chrome/curl/test/script verifiers in parallel), lightweight static analysis (oxlint/biome/tsc auto-detect). Workers follow investigation protocols with structured attack vectors, confidence scoring, chain-of-thought evidence, and self-verification via subagents. Context pre-pass gathers static analysis, dependency graphs, test coverage, and git blame context. Judge agent does adversarial validation. Material is ADDITIVE. Use --v1 for legacy static focus areas. RECOMMENDATION: launch deep review then continue working on other tasks — it runs in the background and catches gnarly bugs while you handle generic issues.",
    inputSchema: {
      scope: z
        .string()
        .optional()
        .describe("Git diff scope. Auto-detects: branch name (e.g. 'main'), commit SHA, 'uncommitted', 'pr:42'. Default: HEAD if no content. Additive with content."),
      content: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("File path(s) to review. Comma-separated string or array. Additive with scope."),
      spec: z
        .string()
        .optional()
        .describe("What to review for — guides all workers. E.g., 'verify implementation matches the plan'."),
      passes: z
        .number()
        .optional()
        .describe("Passes PER focus area (default: 2). Total workers = passes × focus areas."),
      session_name: z
        .string()
        .optional()
        .describe("Custom tmux session name (overrides auto-naming)"),
      notify: z
        .string()
        .optional()
        .describe("Worker name or 'user' to notify on completion."),
      focus: z
        .array(z.string())
        .optional()
        .describe("Custom focus areas. Overrides auto-detect. Diff: 8 areas, content: 4 areas, mixed: 6 areas. Extra specializations: 'silent-failure' (error swallowing), 'claude-md' (CLAUDE.md compliance). Smart focus auto-includes these when patterns detected."),
      no_judge: z
        .boolean()
        .optional()
        .describe("Skip the adversarial judge validation stage (faster but less precise). Default: false."),
      no_context: z
        .boolean()
        .optional()
        .describe("Skip context pre-pass (static analysis, dependency graph, test coverage). Default: false."),
      force: z
        .boolean()
        .optional()
        .describe("Force review even if auto-skip would trigger (lockfile-only changes, <5 substantive lines). Default: false."),
      verify: z
        .boolean()
        .optional()
        .describe("Enable verification phase after review. Spawns a verifier worker that deploys to a test slot, walks the verification checklist, writes scripts/tests, and tests all enumerated paths. Default: false."),
      verify_roles: z
        .array(z.string())
        .optional()
        .describe("User roles to test as during verification (e.g. ['admin', 'shenlan-pm']). Only used when verify=true."),
      v1: z
        .boolean()
        .optional()
        .describe("Use v1 mode: static focus areas, no role designer, no worktree isolation. Default: false."),
      max_workers: z
        .number()
        .optional()
        .describe("Max worker budget for the role designer. Default: passes × 8."),
      no_worktree: z
        .boolean()
        .optional()
        .describe("Skip worktree isolation — run workers directly in PROJECT_ROOT. Default: false."),
    },
  },
  async ({
    scope,
    content,
    spec,
    passes,
    session_name,
    notify,
    focus,
    no_judge,
    no_context,
    force,
    verify,
    verify_roles,
    v1,
    max_workers,
    no_worktree,
  }: {
    scope?: string;
    content?: string | string[];
    spec?: string;
    passes?: number;
    session_name?: string;
    notify?: string;
    focus?: string[];
    no_judge?: boolean;
    no_context?: boolean;
    force?: boolean;
    verify?: boolean;
    verify_roles?: string[];
    v1?: boolean;
    max_workers?: number;
    no_worktree?: boolean;
  }) => {
    try {
      // Resolve deep-review package: DEEP_REVIEW_DIR env > ~/.deep-review > CLAUDE_OPS fallback
      const deepReviewDir = process.env.DEEP_REVIEW_DIR
        || (existsSync(join(HOME, ".deep-review", "scripts", "deep-review.sh")) ? join(HOME, ".deep-review") : null)
        || process.env.CLAUDE_OPS_DIR
        || join(HOME, ".claude-ops");
      const scriptPath = join(deepReviewDir, "scripts", "deep-review.sh");
      if (!existsSync(scriptPath)) {
        throw new Error(`deep-review.sh not found at ${scriptPath}. Install deep-review to ~/.deep-review/ or set DEEP_REVIEW_DIR.`);
      }

      const args: string[] = [];

      // Scope and content are additive
      if (scope) {
        args.push("--scope", scope);
      }
      if (content) {
        const contentPaths = Array.isArray(content) ? content.join(",") : content;
        args.push("--content", contentPaths);
      }
      // If neither provided, shell script defaults to HEAD

      if (spec) {
        args.push("--spec", spec);
      }
      if (passes) {
        args.push("--passes", String(passes));
      }
      if (session_name) {
        args.push("--session-name", session_name);
      }
      if (notify) {
        args.push("--notify", notify);
      }
      if (focus?.length) {
        args.push("--focus", focus.join(","));
      }
      if (no_judge) {
        args.push("--no-judge");
      }
      if (no_context) {
        args.push("--no-context");
      }
      if (force) {
        args.push("--force");
      }
      if (verify) {
        args.push("--verify");
      }
      if (verify_roles?.length) {
        args.push("--verify-roles", verify_roles.join(","));
      }
      if (v1) {
        args.push("--v1");
      }
      if (max_workers) {
        args.push("--max-workers", String(max_workers));
      }
      if (no_worktree) {
        args.push("--no-worktree");
      }

      // Validate content files exist before spawning (fast fail with clear message)
      if (content) {
        const paths = Array.isArray(content) ? content : content.split(",");
        for (const p of paths) {
          const resolved = p.trim().replace(/^~/, HOME);
          const abs = resolved.startsWith("/") ? resolved : join(PROJECT_ROOT, resolved);
          if (!existsSync(abs)) {
            throw new Error(`Content file not found: ${p.trim()} (resolved: ${abs})`);
          }
        }
      }

      const launchResult = spawnSync("bash", [scriptPath, ...args], {
        encoding: "utf-8",
        cwd: PROJECT_ROOT,
        env: { ...process.env, PROJECT_ROOT, DEEP_REVIEW_DIR: deepReviewDir },
        timeout: 120_000, // 2 min — context pre-pass (tsc + deps) can be slow
      });

      if (launchResult.status !== 0 && launchResult.status !== null) {
        const stderr = launchResult.stderr?.slice(0, 1000) || "";
        throw new Error(`deep-review.sh failed (exit ${launchResult.status}): ${stderr}`);
      }
      if (launchResult.status === null) {
        // Killed by signal (timeout or OOM)
        const signal = launchResult.signal || "unknown";
        const stderr = launchResult.stderr?.slice(0, 500) || "";
        throw new Error(`deep-review.sh killed by ${signal} (likely timeout — try --no-context to skip static analysis, or reduce scope). ${stderr}`);
      }

      const stdout = launchResult.stdout || "";
      const tmuxSessionMatch = stdout.match(/Session:\s+(\S+)/);
      const sessionDir = tmuxSessionMatch ? tmuxSessionMatch[1] : "unknown";
      const reviewSessionMatch = stdout.match(/tmux switch-client -t (\S+)/);
      const reviewSession = reviewSessionMatch ? reviewSessionMatch[1] : session_name || "dr-unknown";
      const passesPerFocus = passes || 2;
      const hasContent = !!content;
      const hasScope = !!scope;
      const defaultFocus = hasContent && !hasScope ? 4 : hasContent && hasScope ? 6 : 8;
      const numFocus = focus?.length || defaultFocus;
      const totalWorkers = passesPerFocus * numFocus;
      const numWorkerWindows = Math.ceil(totalWorkers / 4);

      const windowLines: string[] = [];
      windowLines.push(`  Window 0: coordinator (1 pane, ${process.env.DEEP_REVIEW_COORD_MODEL || "sonnet"})`);
      for (let w = 1; w <= numWorkerWindows; w++) {
        const first = (w - 1) * 4 + 1;
        const last = Math.min(w * 4, totalWorkers);
        const count = last - first + 1;
        windowLines.push(`  Window ${w}: workers-${w} (${count} panes tiled, ${process.env.DEEP_REVIEW_WORKER_MODEL || "opus"})`);
      }

      return {
        content: [{
          type: "text" as const,
          text: [
            `Deep review pipeline launched.`,
            ``,
            `tmux session: ${reviewSession}`,
            ...windowLines,
            ``,
            `Session dir: ${sessionDir}`,
            `Workers: ${totalWorkers} (${numFocus} focus × ${passesPerFocus} passes)`,
            `Focus: ${focus?.length ? focus.join(", ") : "security, logic, error-handling, data-integrity, architecture, performance, ux-impact, completeness"}`,
            `Completion: sentinel files at ${sessionDir}/pass-{1..${totalWorkers}}.done`,
            notify ? `Notify: ${notify} (on completion)` : `Notify: desktop only`,
            ``,
            `Attach: tmux switch-client -t ${reviewSession}`,
            `        tmux a -t ${reviewSession}`,
            ``,
            `Pipeline: ${totalWorkers} workers -> bucket -> majority vote (>=2/${passesPerFocus} per focus group) -> validate -> dedup -> autofix -> report + notify`,
            v1 ? `Mode: v1 (static focus areas)` : `Mode: v2 (dynamic roles, worktree isolation, output validation)`,
            verify ? `Verify: enabled (4 specialized verifiers: chrome, curl, test, script)` : `Verify: disabled`,
            `Report: ${sessionDir}/report.md`,
            verify ? `Verification: ${sessionDir}/verification-*-results.json` : "",
            ``,
            `RECOMMENDATION: Deep review takes 15-25 min. While it runs:`,
            `• Work on generic/simple issues from your task list`,
            `• Launch targeted quick reviews on specific files`,
            `• Continue development — deep review catches gnarly bugs in the background`,
            `You'll be notified when results are ready.`,
          ].join("\n"),
        }],
      };
    } catch (e: any) {
      const msg = `Deep review launch failed: ${e.message?.slice(0, 500) || String(e)}`;
      return {
        content: [{ type: "text" as const, text: msg }],
        isError: true,
      };
    }
  }
);

} // end registerReviewTools
