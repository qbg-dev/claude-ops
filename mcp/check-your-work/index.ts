#!/usr/bin/env bun
/**
 * check-your-work MCP server — paranoid verification for Claude Code agents.
 *
 * Runs TWO independent reviewers in parallel:
 *   1. OpenAI Codex CLI (codex review --commit)
 *   2. Claude Opus subagent (claude -p with full codebase read access)
 *
 * If Codex is rate-limited or fails, falls back to Claude-only.
 * Both reviewers get the same context (CLAUDE.md patterns, security rules).
 *
 * Log file: /tmp/check-your-work.log — tail -f to watch progress.
 *
 * Tools:
 *   - check_commit: Review a specific commit by SHA
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execSync, spawn } from "child_process";
import { readFileSync, existsSync, appendFileSync } from "fs";
import { resolve, join } from "path";

// ── Config ──────────────────────────────────────────────────────────────────
const PROJECT_ROOT =
  process.env.PROJECT_ROOT || resolve((import.meta as any).dir, "../../..");
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const CODEX_MODEL = process.env.CODEX_MODEL || "gpt-5.4";
const CLAUDE_MODEL = process.env.CLAUDE_REVIEW_MODEL || "opus";
const LOG_FILE = process.env.CHECK_LOG || "/tmp/check-your-work.log";

// ── Logging ─────────────────────────────────────────────────────────────────

function log(msg: string) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  appendFileSync(LOG_FILE, line);
}

// Resolve main project root (handles worktrees)
function resolveMainProject(): string {
  const gitPath = join(PROJECT_ROOT, ".git");
  try {
    const content = readFileSync(gitPath, "utf-8").trim();
    if (content.startsWith("gitdir:")) {
      const match = content.match(/^gitdir:\s*(.+)$/);
      if (match) return match[1].replace(/\/\.git\/worktrees\/.*$/, "");
    }
  } catch {}
  return PROJECT_ROOT;
}
const MAIN_PROJECT = resolveMainProject();

log(`check-your-work MCP server starting`);
log(`PROJECT_ROOT: ${PROJECT_ROOT}`);
log(`MAIN_PROJECT: ${MAIN_PROJECT}`);
log(`Backends: Codex (${CODEX_MODEL}) + Claude (${CLAUDE_MODEL})`);
log(`Log file: ${LOG_FILE}`);

// ── Context builder ─────────────────────────────────────────────────────────

function buildContextPreamble(): string {
  const sections: string[] = [];

  sections.push(`# Verification Context

You are acting as an independent, PARANOID code reviewer / verifier. Your job is to find bugs, security holes, logic errors, and violations of project conventions. Be thorough and skeptical.

## Environment
- **Primary IDE**: Claude Code (CLI agent in tmux panes)
- **Project root**: ${PROJECT_ROOT}
- **Main project** (if worktree): ${MAIN_PROJECT}
- **Runtime**: Bun + TypeScript
- **Platform**: macOS (darwin)

## Claude Code Memory & Instructions
These files contain the project conventions, patterns, and accumulated knowledge. Reference them heavily when reviewing — they ARE the source of truth for how this codebase should work:

- **Project instructions**: \`${MAIN_PROJECT}/CLAUDE.md\` — architecture, patterns, security rules, deploy workflow
- **Worker instructions**: \`${MAIN_PROJECT}/.claude/CLAUDE.md\` — credentials, infrastructure, worker fleet rules
- **Auto-memory**: \`~/.claude/projects/-Users-wz-Desktop-zPersonalProjects-Wechat/memory/MEMORY.md\` — accumulated learnings, gotchas, conventions
- **Memory topic files**: \`~/.claude/projects/-Users-wz-Desktop-zPersonalProjects-Wechat/memory/*.md\` — detailed notes per topic

## Review Philosophy — BE PARANOID
- **Assume every change has a bug until proven otherwise.**
- **Check against CLAUDE.md patterns.** The project has specific security patterns (ownership checks, CSRF, bounded queries), ontology rules (V2 actionSecurity, no custom authorize), and UI conventions (no inline styles, CSS variables, border-radius: 0).
- **Zero mock data rule.** Any placeholder, dummy, or hardcoded test data is a hard failure.
- **No hardcoded IDs.** Project IDs, tenant IDs, etc. must be resolved dynamically.
- **StarRocks-first.** All BI/dashboard queries must use StarRocks, not MySQL.
- **Security is non-negotiable.** Check for IDOR, info disclosure, unbounded queries, XXE, injection.
- **Read surrounding code.** Don't just look at the diff — read the files being modified to understand full context. Check imports, callers, and downstream effects.
- **Verify edge cases.** What happens with empty input? Null? Missing fields? Concurrent access?
- **Check for regressions.** Does this change break anything that was working before?`);

  // Try to load key CLAUDE.md sections for inline context
  for (const claudeMdPath of [
    join(MAIN_PROJECT, "CLAUDE.md"),
    join(MAIN_PROJECT, ".claude", "CLAUDE.md"),
  ]) {
    if (existsSync(claudeMdPath)) {
      try {
        const content = readFileSync(claudeMdPath, "utf-8");
        const secMatch = content.match(
          /## Security Patterns[\s\S]*?(?=\n## |\n---\n|$)/
        );
        if (secMatch) {
          sections.push(
            `## Security Patterns (from CLAUDE.md)\n${secMatch[0]}`
          );
        }
        const codeMatch = content.match(
          /## Code Patterns[\s\S]*?(?=\n## |\n---\n|$)/
        );
        if (codeMatch) {
          sections.push(`## Code Patterns (from CLAUDE.md)\n${codeMatch[0]}`);
        }
      } catch {}
    }
  }

  return sections.join("\n\n");
}

// ── Get commit diff ─────────────────────────────────────────────────────────

function getCommitDiff(sha: string): string {
  try {
    return execSync(`git show --stat --patch ${sha}`, {
      cwd: PROJECT_ROOT, encoding: "utf-8", timeout: 30000,
      maxBuffer: 10 * 1024 * 1024, // 10MB for large diffs
    });
  } catch (e: any) {
    return `(Could not get diff: ${e.message?.slice(0, 200)})`;
  }
}

function getCommitTitle(sha: string): string | undefined {
  try {
    return execSync(`git log --format='%s' -1 ${sha}`, {
      encoding: "utf-8", cwd: PROJECT_ROOT,
    }).trim();
  } catch { return undefined; }
}

// ── Codex backend ───────────────────────────────────────────────────────────

async function runCodexReview(args: {
  commitSha: string;
  reviewPrompt: string;
  title?: string;
  timeout: number;
}): Promise<{ output: string; success: boolean; error?: string }> {
  const cmdArgs = [
    "review",
    "-c", `model="${CODEX_MODEL}"`,
    "--commit", args.commitSha,
  ];
  if (args.title) cmdArgs.push("--title", args.title);

  log(`[codex] Starting review of ${args.commitSha}`);

  let timedOut = false;

  return new Promise((resolve) => {
    const child = spawn(CODEX_BIN, cmdArgs, {
      cwd: PROJECT_ROOT,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      for (const line of text.split("\n")) {
        if (line.trim()) log(`  [codex:out] ${line}`);
      }
    });

    child.stdin.write(args.reviewPrompt);
    child.stdin.end();

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      for (const line of text.split("\n")) {
        if (line.trim()) log(`  [codex:err] ${line}`);
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      log(`  [codex] TIMEOUT after ${args.timeout}ms`);
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, args.timeout);

    child.on("close", (code) => {
      clearTimeout(timer);
      const output = (stdout.trim() || stderr.trim());

      // Detect rate limit
      if (output.includes("usage limit") || output.includes("rate limit") || output.includes("Upgrade to Plus")) {
        log(`  [codex] Rate limited`);
        resolve({ output: "", success: false, error: "rate_limited" });
        return;
      }

      if (timedOut) {
        resolve({
          output: output ? `[TIMEOUT — partial]\n\n${output}` : "",
          success: !!output,
          error: output ? undefined : "timeout",
        });
      } else if (output) {
        resolve({ output, success: true });
      } else if (code !== 0) {
        resolve({ output: "", success: false, error: `exit_code_${code}` });
      } else {
        resolve({ output: "(No output from Codex)", success: true });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      log(`  [codex] ERROR: ${err.message}`);
      resolve({ output: "", success: false, error: err.message });
    });
  });
}

// ── Claude Opus backend ─────────────────────────────────────────────────────

async function runClaudeReview(args: {
  commitSha: string;
  diff: string;
  reviewPrompt: string;
  focus?: string;
  timeout: number;
}): Promise<{ output: string; success: boolean; error?: string }> {

  // Build a focused prompt for Claude that includes the diff inline
  // but also gives it tools to explore the codebase
  const prompt = [
    args.reviewPrompt,
    "",
    `## Commit to review: ${args.commitSha}`,
    "",
    "## Your task",
    "1. Read the diff below carefully",
    "2. For EACH changed file, read the FULL file (not just the diff) to understand context",
    "3. Check for: bugs, security holes, logic errors, convention violations, edge cases, regressions",
    "4. Read CLAUDE.md and .claude/CLAUDE.md for project conventions if you haven't already",
    "5. Be PARANOID — assume there's a bug until you've proven otherwise",
    args.focus ? `6. Special focus: ${args.focus}` : "",
    "",
    "## Diff",
    "```",
    args.diff.slice(0, 100000), // Cap at 100K chars
    "```",
    "",
    "## Output format",
    "Provide your review as:",
    "- **CRITICAL**: Must-fix issues (bugs, security holes, data loss risks)",
    "- **WARNING**: Should-fix issues (convention violations, edge cases, code smell)",
    "- **INFO**: Observations and suggestions (style, performance, readability)",
    "- **VERDICT**: PASS (no critical/warning), NEEDS_FIXES, or FAIL",
    "",
    "If you find zero issues, still explain WHY you believe the code is correct — prove it.",
  ].filter(Boolean).join("\n");

  log(`[claude] Starting review of ${args.commitSha} (prompt: ${prompt.length} chars)`);

  return new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, [
      "-p", prompt,
      "--model", CLAUDE_MODEL,
      "--output-format", "text",
      "--allowedTools", "Read,Grep,Glob,Bash(git show*),Bash(git log*),Bash(git diff*),Bash(bun test*)",
      "--max-turns", "25",
      "--max-budget-usd", "1.00",
      "--no-session-persistence",
      "--dangerously-skip-permissions",
    ], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, NO_COLOR: "1", CLAUDECODE: "" },  // Unset CLAUDECODE to allow nested session
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      // Log first and last chunks, skip middle to avoid noise
      if (stdout.length < 2000 || stdout.length > text.length + 1000) {
        for (const line of text.split("\n").slice(0, 3)) {
          if (line.trim()) log(`  [claude:out] ${line.slice(0, 200)}`);
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      log(`  [claude] TIMEOUT after ${args.timeout}ms`);
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, args.timeout);

    child.on("close", (code) => {
      clearTimeout(timer);
      log(`  [claude] Done (exit: ${code}, output: ${stdout.length} chars)`);

      if (timedOut && stdout.trim()) {
        resolve({ output: `[TIMEOUT — partial]\n\n${stdout.trim()}`, success: true });
      } else if (stdout.trim()) {
        resolve({ output: stdout.trim(), success: true });
      } else {
        resolve({
          output: "",
          success: false,
          error: timedOut ? "timeout" : `exit_code_${code}: ${stderr.slice(0, 500)}`,
        });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      log(`  [claude] ERROR: ${err.message}`);
      resolve({ output: "", success: false, error: err.message });
    });
  });
}

// ── MCP Server ──────────────────────────────────────────────────────────────
const server = new McpServer({
  name: "check-your-work",
  version: "2.0.0",
});

// @ts-ignore — MCP SDK deep type instantiation with Zod
server.registerTool(
  "check_commit",
  {
    description:
      "Paranoid code review of a git commit using TWO independent AI reviewers (Codex + Claude Opus) in parallel. Falls back to Claude-only if Codex is rate-limited. Both get full project context and codebase access. Streams progress to /tmp/check-your-work.log.",
    inputSchema: {
      commit_sha: z.string().describe("Git commit SHA to review"),
      focus: z.string().optional().describe("What to focus on (e.g. 'security', 'SQL injection', 'ontology patterns')"),
      backend: z.enum(["both", "codex", "claude"]).optional().describe("Which reviewer(s) to use (default: 'both' — runs parallel, falls back to claude if codex fails)"),
      timeout_ms: z.number().optional().describe("Timeout per reviewer in ms (default: 300000 / 5 min)"),
    },
  },
  async ({ commit_sha, focus, backend, timeout_ms }: {
    commit_sha: string;
    focus?: string;
    backend?: "both" | "codex" | "claude";
    timeout_ms?: number;
  }) => {
    try {
      const timeout = timeout_ms || 300000;
      const useBackend = backend || "both";
      const title = getCommitTitle(commit_sha);
      const context = buildContextPreamble();
      const reviewPrompt = [
        context,
        focus ? `\n## Special Focus\n${focus}` : "",
        "\nReview thoroughly and paranoidly. Flag any violations of the patterns described above.",
      ].filter(Boolean).join("\n");

      log(`\n═══ check_commit(${commit_sha}) ═══`);
      log(`  Title: ${title || "(unknown)"}`);
      log(`  Backend: ${useBackend}`);
      log(`  Focus: ${focus || "(general)"}`);
      log(`  Timeout: ${timeout}ms per reviewer`);

      const diff = getCommitDiff(commit_sha);
      const results: string[] = [];

      if (useBackend === "codex") {
        // Codex only
        const codex = await runCodexReview({ commitSha: commit_sha, reviewPrompt, title, timeout });
        if (codex.success) {
          results.push(`## Codex Review\n\n${codex.output}`);
        } else {
          results.push(`## Codex Review\n\n⚠ Failed: ${codex.error}`);
        }

      } else if (useBackend === "claude") {
        // Claude only
        const claude = await runClaudeReview({ commitSha: commit_sha, diff, reviewPrompt, focus, timeout });
        if (claude.success) {
          results.push(`## Claude Opus Review\n\n${claude.output}`);
        } else {
          results.push(`## Claude Opus Review\n\n⚠ Failed: ${claude.error}`);
        }

      } else {
        // Both in parallel — the default paranoid mode
        log(`  Launching both reviewers in parallel...`);
        const [codex, claude] = await Promise.all([
          runCodexReview({ commitSha: commit_sha, reviewPrompt, title, timeout }),
          runClaudeReview({ commitSha: commit_sha, diff, reviewPrompt, focus, timeout }),
        ]);

        if (codex.success) {
          results.push(`## Codex Review (${CODEX_MODEL})\n\n${codex.output}`);
        } else {
          results.push(`## Codex Review\n\n⚠ ${codex.error === "rate_limited" ? "Rate limited — skipped" : `Failed: ${codex.error}`}`);
        }

        if (claude.success) {
          results.push(`## Claude Opus Review\n\n${claude.output}`);
        } else {
          results.push(`## Claude Opus Review\n\n⚠ Failed: ${claude.error}`);
        }

        // If both failed, that's an error
        if (!codex.success && !claude.success) {
          const msg = `Both reviewers failed. Codex: ${codex.error}. Claude: ${claude.error}. Check log: ${LOG_FILE}`;
          log(`ERROR: ${msg}`);
          return { content: [{ type: "text" as const, text: msg }], isError: true };
        }
      }

      const finalOutput = results.join("\n\n---\n\n");
      log(`  Combined output: ${finalOutput.length} chars`);
      return { content: [{ type: "text" as const, text: finalOutput }] };

    } catch (e: any) {
      const msg = `Commit review failed: ${e.message?.slice(0, 500) || String(e)}`;
      log(`ERROR: ${msg}`);
      return { content: [{ type: "text" as const, text: msg }], isError: true };
    }
  }
);

log(`Server ready — check_commit with dual backend (Codex + Claude Opus)`);

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
