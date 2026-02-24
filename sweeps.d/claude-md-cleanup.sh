#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
# 01-claude-md-cleanup.sh — CLAUDE.md health sweep
# ══════════════════════════════════════════════════════════════════
# Architecture: bash gathers raw context, Claude agent makes all decisions.
# No hardcoded thresholds or heuristics — the LLM is the brain.
#
# 1. Dump raw data (file contents, section structure, ref files)
# 2. Write a well-crafted prompt
# 3. Always spawn a Claude agent to analyze + act
#
# Contract:
#   --interval            Print interval (1800s) and exit
#   --check               Gather context only, print what agent would see
#   --run                 Gather context + spawn agent
#   --project <path>      Target a specific project root
# ══════════════════════════════════════════════════════════════════
set -euo pipefail

SWEEP_NAME="claude-md-cleanup"
source "$HOME/.claude-ops/lib/sweep-config.sh"
load_sweep_config "$SWEEP_NAME"

CONF="${HOME}/.claude-ops/control-plane.conf"
CONTEXT_FILE="/tmp/harness_sweep_01_context.md"

# ── Load control-plane config (for non-sweep vars) ──────────────
if [ -f "$CONF" ]; then
  source "$CONF"
fi

# ── Shared infrastructure ────────────────────────────────────────
source "${HOME}/.claude-ops/lib/spawn-sweep-agent.sh"

# ── Helpers ──────────────────────────────────────────────────────
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# ── CLI parsing ──────────────────────────────────────────────────
MODE=""
PROJECT_ROOT_ARG=""
HARNESS_NAME=""

while [ $# -gt 0 ]; do
  case "$1" in
    --interval) echo "$SWEEP_INTERVAL"; exit 0 ;;
    --scope)    echo "$SWEEP_SCOPE"; exit 0 ;;
    --check)    MODE="check"; shift ;;
    --run)      MODE="run"; shift ;;
    --project)  PROJECT_ROOT_ARG="$2"; shift 2 ;;
    --harness)  HARNESS_NAME="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

[ -z "$MODE" ] && { echo "Usage: $0 [--interval|--check|--run] [--harness <name>|--project <path>]" >&2; exit 1; }

# Resolve PROJECT_ROOT: --harness (via manifest) > --project > env
source "$HOME/.claude-ops/lib/harness-jq.sh" 2>/dev/null || true
if [ -n "$HARNESS_NAME" ]; then
  PROJECT_ROOT=$(harness_project_root "$HARNESS_NAME" 2>/dev/null)
elif [ -n "$PROJECT_ROOT_ARG" ]; then
  PROJECT_ROOT="$PROJECT_ROOT_ARG"
else
  PROJECT_ROOT="${PROJECT_ROOT:-}"
fi
[ -z "$PROJECT_ROOT" ] && { echo "ERROR: No project root." >&2; exit 1; }

# ══════════════════════════════════════════════════════════════════
# PHASE 1: Gather raw context (no judgment, no heuristics)
# ══════════════════════════════════════════════════════════════════

{
cat <<'HEADER'
# CLAUDE.md Health Sweep — Context for Agent

You are a CLAUDE.md health agent spawned by the harness control plane.
Your job is to analyze project CLAUDE.md files and improve their organization.

## Your Mission

Read the raw data below, then:

1. **Identify problems** — bloated sections, stale info, duplicated content across files,
   sections that should be extracted to reference files. Use your judgment — there are no
   hardcoded thresholds. A 50-line section with dense useful info is fine; a 200-line section
   of outdated config is not.

2. **Take action on clear wins** — for sections that are clearly too long or clearly belong
   in a reference file:
   - Move the section to `claude_files/ref/{descriptive-slug}.md`
   - Replace the original with `@{relative-path-to-ref-file}`
   - Preserve ALL content (just relocate it)

3. **Flag ambiguous cases** — if you're unsure whether something is stale or still needed,
   DON'T change it. Instead, add a brief `<!-- SWEEP: reason this might be stale -->` comment.

4. **Report what you did** — write a summary to `claude_files/sweep-reports/claude-md-report.md`
   (this file is gitignored and stays local — do NOT try to `git add` it)

5. **Commit and quit** — Only `git add` the CLAUDE.md files themselves (e.g. `CLAUDE.md`,
   `.claude/CLAUDE.md`) — NOT the report or any `claude_files/` paths (those are gitignored).
   Commit with "chore: CLAUDE.md sweep cleanup", then `/quit`.
   If the only changes are to `claude_files/` (ref files, report), skip the commit entirely.

## Rules

- **Be conservative.** When in doubt, leave it alone.
- **Never delete content.** Only relocate or flag.
- **Do NOT use Bash for SSH, deploy, or anything destructive.** Only use Bash for git commands and report-issue.
- **Do NOT modify code files** — only CLAUDE.md, .claude/CLAUDE.md, and claude_files/ref/*.
- **Report issues you encounter** — If you hit permission errors, config problems, or discover bugs, run: `bash ~/.claude-ops/bin/report-issue.sh --title "..." --severity "..." --category "..." --description "..."`
- If there's nothing worth changing, just write "No issues found" to the report and /quit.

## Raw Data

HEADER

# List CLAUDE.md files with line counts
echo "### CLAUDE.md Files"
echo ""
for candidate in "$PROJECT_ROOT/CLAUDE.md" "$PROJECT_ROOT/.claude/CLAUDE.md"; do
  if [ -f "$candidate" ]; then
    rel="${candidate#"$PROJECT_ROOT/"}"
    lines=$(wc -l < "$candidate" | tr -d ' ')
    echo "**$rel** ($lines lines)"
    echo ""
    # Section structure with line ranges
    echo '```'
    awk '/^##? / { if (heading) printf "%4d-%4d (%3d lines) %s\n", start, NR-1, NR-1-start+1, heading; heading=$0; start=NR }
         END { if (heading) printf "%4d-%4d (%3d lines) %s\n", start, NR, NR-start+1, heading }' "$candidate"
    echo '```'
    echo ""
  fi
done

# List existing ref files (so agent knows what's already extracted)
echo "### Existing Reference Files (claude_files/ref/)"
echo ""
if [ -d "$PROJECT_ROOT/claude_files/ref" ]; then
  for ref in "$PROJECT_ROOT/claude_files/ref/"*.md; do
    [ -f "$ref" ] || continue
    rname=$(basename "$ref")
    rlines=$(wc -l < "$ref" | tr -d ' ')
    echo "- \`$rname\` ($rlines lines)"
  done
else
  echo "(directory does not exist yet)"
fi
echo ""

# Full file contents for agent to analyze
echo "### Full File Contents"
echo ""
for candidate in "$PROJECT_ROOT/CLAUDE.md" "$PROJECT_ROOT/.claude/CLAUDE.md"; do
  if [ -f "$candidate" ]; then
    rel="${candidate#"$PROJECT_ROOT/"}"
    echo "#### $rel"
    echo ""
    echo '````markdown'
    cat "$candidate"
    echo '````'
    echo ""
  fi
done

} > "$CONTEXT_FILE"

context_lines=$(wc -l < "$CONTEXT_FILE" | tr -d ' ')

# ── Check mode: just show the context ────────────────────────────
if [ "$MODE" = "check" ]; then
  echo "Context file: $CONTEXT_FILE ($context_lines lines)"
  jq -n -c --arg ts "$(now_iso)" --arg type "sweep" --arg name "$SWEEP_NAME" \
    --arg action "check" --argjson context_lines "$context_lines" \
    '{ts:$ts, type:$type, name:$name, action:$action, context_lines:$context_lines}'
  exit 0
fi

# ══════════════════════════════════════════════════════════════════
# PHASE 2: Spawn Claude agent (always — the agent decides what to do)
# ══════════════════════════════════════════════════════════════════

notify "CLAUDE.md sweep: spawning agent to analyze project docs" 2>/dev/null || true

PANE=$(spawn_sweep_agent "$SWEEP_NAME" "$PROJECT_ROOT" "$CONTEXT_FILE")

if [ -z "$PANE" ]; then
  jq -n -c --arg ts "$(now_iso)" --arg type "sweep" --arg name "$SWEEP_NAME" \
    --arg action "agent_fail" --arg reason "spawn_sweep_agent returned empty" \
    '{ts:$ts, type:$type, name:$name, action:$action, reason:$reason}'
  exit 0
fi

jq -n -c --arg ts "$(now_iso)" --arg type "sweep" --arg name "$SWEEP_NAME" \
  --arg action "agent_spawned" --arg pane "$PANE" \
  --argjson context_lines "$context_lines" \
  '{ts:$ts, type:$type, name:$name, action:$action, pane:$pane, context_lines:$context_lines}'
