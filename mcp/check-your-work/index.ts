#!/usr/bin/env bun
/**
 * check-your-work MCP server — verification workflow for Claude Code agents.
 *
 * Wraps OpenAI Codex CLI (and future verification backends) to provide
 * independent code review. A second AI with full codebase access reviews
 * your work before you commit/merge.
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
  process.env.PROJECT_ROOT || resolve(import.meta.dir, "../../..");
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const CODEX_MODEL = process.env.CODEX_MODEL || "gpt-5.4";
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
log(`CODEX_BIN: ${CODEX_BIN}`);
log(`CODEX_MODEL: ${CODEX_MODEL}`);
log(`Log file: ${LOG_FILE} — tail -f ${LOG_FILE} to watch`);

// ── Context builder ─────────────────────────────────────────────────────────

function buildContextPreamble(): string {
  const sections: string[] = [];

  sections.push(`# Verification Context

You are acting as an independent code reviewer / verifier for a project primarily developed using **Claude Code** (Anthropic's CLI agent).

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

## Review Philosophy
- **Extra context is always better.** Read surrounding code, related files, and memory notes before forming opinions. Don't review in isolation.
- **Check against CLAUDE.md patterns.** The project has specific security patterns (ownership checks, CSRF, bounded queries), ontology rules (V2 actionSecurity, no custom authorize), and UI conventions (no inline styles, CSS variables, border-radius: 0).
- **Zero mock data rule.** Any placeholder, dummy, or hardcoded test data is a hard failure.
- **No hardcoded IDs.** Project IDs, tenant IDs, etc. must be resolved dynamically.
- **StarRocks-first.** All BI/dashboard queries must use StarRocks, not MySQL.
- **Commit quality matters.** Small, focused commits with clear messages.`);

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

// ── Codex execution (streaming to log) ──────────────────────────────────────

async function runCodexReview(args: {
  commitSha: string;
  extraInstructions?: string;
  title?: string;
  timeout?: number;
}): Promise<string> {
  const context = buildContextPreamble();
  const reviewPrompt = [
    context,
    args.extraInstructions || "",
    "Review thoroughly. Flag any violations of the patterns described above.",
  ]
    .filter(Boolean)
    .join("\n\n");

  // Pass review instructions as the PROMPT argument (not stdin — stdin piping can cause hangs)
  const cmdArgs = [
    "review",
    "-c", `model="${CODEX_MODEL}"`,
    "--commit", args.commitSha,
  ];
  if (args.title) cmdArgs.push("--title", args.title);
  // Append the prompt as positional arg
  cmdArgs.push(reviewPrompt);

  log(`── Starting review of commit ${args.commitSha} ──`);
  if (args.title) log(`  Title: ${args.title}`);
  if (args.extraInstructions) log(`  Focus: ${args.extraInstructions}`);
  log(`  Command: ${CODEX_BIN} review --commit ${args.commitSha} (prompt: ${reviewPrompt.length} chars)`);

  const timeout = args.timeout || 600000; // 10 min default — large diffs with xhigh reasoning need time
  let timedOut = false;

  return new Promise((resolve, reject) => {
    const child = spawn(CODEX_BIN, cmdArgs, {
      cwd: PROJECT_ROOT,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],  // no stdin needed — prompt is positional arg
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      for (const line of text.split("\n")) {
        if (line.trim()) log(`  [codex] ${line}`);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      for (const line of text.split("\n")) {
        if (line.trim()) log(`  [codex:err] ${line}`);
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      log(`  TIMEOUT after ${timeout}ms — killing codex`);
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, timeout);

    child.on("close", (code) => {
      clearTimeout(timer);
      log(`── Review complete (exit code: ${code}) ──`);
      if (timedOut) {
        // Return partial output if any, with timeout notice
        const partial = stdout.trim();
        if (partial) {
          resolve(`[TIMEOUT after ${Math.round(timeout/1000)}s — partial output below]\n\n${partial}`);
        } else {
          reject(new Error(`Codex timed out after ${Math.round(timeout/1000)}s with no output. The diff may be too large. Try increasing timeout_ms or reviewing smaller commits. Log: tail -f ${LOG_FILE}`));
        }
      } else if (stdout.trim()) {
        resolve(stdout.trim());
      } else if (code !== 0) {
        reject(new Error(`Codex exited with code ${code}. Check log: tail -f ${LOG_FILE}\n\nStderr: ${stderr.slice(0, 500)}`));
      } else {
        resolve("(No output from reviewer)");
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      log(`  ERROR: ${err.message}`);
      reject(err);
    });
  });
}

// ── MCP Server ──────────────────────────────────────────────────────────────
const server = new McpServer({
  name: "check-your-work",
  version: "1.0.0",
});

// @ts-ignore — MCP SDK deep type instantiation with Zod
server.registerTool(
  "check_commit",
  {
    description:
      "Review a specific git commit by SHA using an independent AI (Codex). Useful for verifying commits before merge, or reviewing work done by other agents/workers. Injects full project context (CLAUDE.md patterns, security rules, conventions) automatically. Streams progress to /tmp/check-your-work.log — tail -f to watch.",
    inputSchema: {
      commit_sha: z.string().describe("Git commit SHA to review"),
      focus: z
        .string()
        .optional()
        .describe(
          "What to focus on in the review (e.g. 'security', 'check SQL injection', 'verify ontology patterns')"
        ),
      timeout_ms: z
        .number()
        .optional()
        .describe("Timeout in milliseconds (default: 300000 / 5 min)"),
    },
  },
  async ({
    commit_sha,
    focus,
    timeout_ms,
  }: {
    commit_sha: string;
    focus?: string;
    timeout_ms?: number;
  }) => {
    try {
      let commitTitle: string | undefined;
      try {
        commitTitle = execSync(`git log --format='%s' -1 ${commit_sha}`, {
          encoding: "utf-8",
          cwd: PROJECT_ROOT,
        }).trim();
      } catch {}

      log(`Tool call: check_commit(${commit_sha})`);
      const result = await runCodexReview({
        commitSha: commit_sha,
        extraInstructions: focus,
        title: commitTitle,
        timeout: timeout_ms,
      });
      log(`Result length: ${result.length} chars`);
      return { content: [{ type: "text" as const, text: result }] };
    } catch (e: any) {
      const msg = `Commit review failed: ${e.message?.slice(0, 500) || String(e)}`;
      log(`ERROR: ${msg}`);
      return {
        content: [{ type: "text" as const, text: msg }],
        isError: true,
      };
    }
  }
);

log(`Server ready — 1 tool registered: check_commit`);

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
