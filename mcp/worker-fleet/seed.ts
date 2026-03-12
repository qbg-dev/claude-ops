/**
 * Seed content generation — worker initialization prompts and context loading.
 * Used when launching or relaunching a worker to provide initial context.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { PROJECT_ROOT, CLAUDE_FLEET, WORKERS_DIR, WORKER_NAME, FLEET_DIR, getWorktreeDir } from "./config";
import { readRegistry, getMissionAuthorityLabel, isMissionAuthority, type RegistryConfig, type RegistryWorkerEntry } from "./registry";
import { loadSeedFragments } from "../../shared/extensions";

// ── Seed Context Template ────────────────────────────────────────────

/** Load shared seed context template, interpolate placeholders */
export function loadSeedContext(branch: string, missionAuthority: string, workerName?: string): string {
  const name = workerName || WORKER_NAME;
  const tmplPath = join(CLAUDE_FLEET, "templates/seed-context.md");
  try {
    let content = readFileSync(tmplPath, "utf-8")
      .replace(/\{\{WORKER_NAME\}\}/g, name)
      .replace(/\{\{BRANCH\}\}/g, branch)
      .replace(/\{\{MISSION_AUTHORITY\}\}/g, missionAuthority);

    // Append extension seed fragments (alphabetical by extension name)
    for (const frag of loadSeedFragments()) {
      const fragContent = frag.content
        .replace(/\{\{WORKER_NAME\}\}/g, name)
        .replace(/\{\{BRANCH\}\}/g, branch)
        .replace(/\{\{MISSION_AUTHORITY\}\}/g, missionAuthority);
      content += `\n\n<!-- extension: ${frag.extensionName} -->\n${fragContent}`;
    }

    return content;
  } catch {
    // Fallback if template missing — minimal reminder
    return `Use \`mcp__worker-fleet__*\` MCP tools. Call \`mail_inbox()\` first. Report to ${missionAuthority}.`;
  }
}

// ── Seed Content Generation ──────────────────────────────────────────

/** Generate the seed prompt content for a worker.
 *  Optional workerName parameter allows generating seeds for any worker (used by watchdog). */
export function generateSeedContent(handoff?: string, workerName?: string): string {
  const effectiveName = workerName || WORKER_NAME;
  const workerDir = join(PROJECT_ROOT, ".claude/workers", effectiveName);
  const fleetWorkerDir = join(FLEET_DIR, effectiveName);
  const worktreeDir = getWorktreeDir();
  const branch = `worker/${effectiveName}`;
  const _seedConfig = readRegistry()._config as RegistryConfig | undefined;
  const _missionAuth = getMissionAuthorityLabel(_seedConfig);

  // Include persisted state in seed so workers resume where they left off
  let stateBlock = "";
  let proposalBlock = "";
  try {
    const reg = readRegistry();
    const entry = reg[effectiveName] as RegistryWorkerEntry | undefined;
    if (entry?.custom && Object.keys(entry.custom).length > 0) {
      stateBlock = `\n\n## Persisted State\n\`\`\`json\n${JSON.stringify(entry.custom, null, 2)}\n\`\`\`\nThese values were saved by your previous instance via \`update_state()\`. Use them to resume context.`;
    }
    // Load proposal instructions if proposal_required is set
    if (entry?.custom?.proposal_required) {
      const instrPath = join(CLAUDE_FLEET, "templates/proposal-instructions.md");
      const tmplPath = join(CLAUDE_FLEET, "templates/proposal-template.html");
      try {
        let instrContent = readFileSync(instrPath, "utf-8");
        instrContent = instrContent
          .replace(/\{\{WORKER_NAME\}\}/g, effectiveName)
          .replace(/\{\{MISSION_AUTHORITY\}\}/g, _missionAuth)
          .replace(/\{\{TEMPLATE_PATH\}\}/g, tmplPath);
        proposalBlock = "\n\n" + instrContent;
      } catch {}
    }
  } catch {}

  // ── Build handoff/checkpoint block FIRST (most important context for resuming) ──
  let handoffBlock = "";
  if (handoff) {
    handoffBlock = `\n## HANDOFF FROM PREVIOUS CYCLE — READ FIRST\n\n${handoff}`;
  } else {
    // Read checkpoint from previous cycle (replaces handoff.md)
    const checkpointLatest = join(WORKERS_DIR, effectiveName, "checkpoints", "latest.json");
    if (existsSync(checkpointLatest)) {
      try {
        const cpRaw = readFileSync(checkpointLatest, "utf-8").trim();
        const cp = JSON.parse(cpRaw);
        let cpBlock = `\n## HANDOFF FROM PREVIOUS CYCLE — READ FIRST\n\n`;
        cpBlock += `**Summary**: ${cp.summary || "No summary"}\n`;
        if (cp.git_state?.branch) {
          cpBlock += `**Git**: ${cp.git_state.branch} @ ${cp.git_state.sha || "?"} (${cp.git_state.dirty_count || 0} dirty, ${cp.git_state.staged_count || 0} staged)\n`;
        }
        if (cp.key_facts?.length > 0) {
          cpBlock += `**Key facts**:\n${cp.key_facts.map((f: string) => `- ${f}`).join("\n")}\n`;
        }
        if (cp.dynamic_hooks?.length > 0) {
          const pending = cp.dynamic_hooks.filter((h: any) => !h.completed);
          if (pending.length > 0) {
            cpBlock += `**Pending hooks**: ${pending.map((h: any) => `${h.id} (${h.event}: ${h.description})`).join(", ")}\n`;
          }
        }
        if (cp.transcript_ref) {
          cpBlock += `**Transcript**: ${cp.transcript_ref} — Read this if you need details from before recycling\n`;
        }
        handoffBlock = cpBlock;
      } catch {
        // Fall back to legacy handoff.md
        const handoffPath = join(WORKERS_DIR, effectiveName, "handoff.md");
        if (existsSync(handoffPath)) {
          try {
            const handoffContent = readFileSync(handoffPath, "utf-8").trim();
            if (handoffContent) {
              handoffBlock = `\n## HANDOFF FROM PREVIOUS CYCLE — READ FIRST\n\n${handoffContent}`;
            }
          } catch {}
        }
      }
    } else {
      // Legacy fallback: read handoff.md if no checkpoint exists
      const handoffPath = join(WORKERS_DIR, effectiveName, "handoff.md");
      if (existsSync(handoffPath)) {
        try {
          const handoffContent = readFileSync(handoffPath, "utf-8").trim();
          if (handoffContent) {
            handoffBlock = `\n## HANDOFF FROM PREVIOUS CYCLE — READ FIRST\n\n${handoffContent}`;
          }
        } catch {}
      }
    }
  }

  // ── Supervisor template (injected for mission_authority or workers with direct reports) ──
  let supervisorBlock = "";
  try {
    const reg = readRegistry();
    const config = reg._config as RegistryConfig | undefined;
    const hasSupervisorAuthority =
      isMissionAuthority(effectiveName, config) ||
      Object.entries(reg).some(([name, entry]) =>
        name !== "_config" && name !== effectiveName &&
        (entry as RegistryWorkerEntry).report_to === effectiveName
      );
    if (hasSupervisorAuthority) {
      const supervisorPath = join(CLAUDE_FLEET, "templates/seed-supervisor.md");
      if (existsSync(supervisorPath)) {
        supervisorBlock = "\n\n" + readFileSync(supervisorPath, "utf-8");
      }
    }
  } catch {}

  // ── Assemble seed: identity → handoff (FIRST) → instructions → context ──
  let seed = `You are worker **${effectiveName}**.
Worktree: ${worktreeDir} (branch: ${branch})
Worker config: ${workerDir}/
${handoffBlock}
Read these files NOW in this order:
1. ${existsSync(join(workerDir, "mission.md")) ? workerDir : fleetWorkerDir}/mission.md — your mission and goals (you own this file — update it as your mission evolves)
2. Call \`mail_inbox()\` — check for messages before anything else
3. Check \`.claude/scripts/${effectiveName}/\` for existing scripts

**Code > Memory**: Encode domain knowledge as hooks, scripts, and automation—not memory notes. Hooks fire automatically; memory requires you to remember to read it. If you do something twice, automate it.

If your inbox has a message from the user or ${_missionAuth} (mission_authority), prioritize it over your current work.${stateBlock}${proposalBlock}

${loadSeedContext(branch, _missionAuth)}${supervisorBlock}`;

  return seed;
}
