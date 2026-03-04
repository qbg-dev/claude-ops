#!/usr/bin/env bash
# scaffold.sh — Create a new v3 harness with agents/module-manager/ structure.
# Usage: bash ~/.boring/scripts/scaffold.sh [--long-running] <harness-name> [project-root]
#
# Flags:
#   --long-running   Harness cycles indefinitely (lifecycle: long-running)
#   --from-description "text"  One-line mission for config.json + mission.md
set -euo pipefail

# ── Parse flags ─────────────────────────────────────────────────
PERPETUAL=false
DESCRIPTION=""
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --perpetual|--long-running|--sidecar) PERPETUAL=true; shift ;;
    --from-description) DESCRIPTION="$2"; shift 2 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
HARNESS="${ARGS[0]:-}"
PROJECT_ROOT="${ARGS[1]:-$(pwd)}"

if [ -z "$HARNESS" ]; then
  echo "Usage: bash ~/.boring/scripts/scaffold.sh [--long-running] <harness-name> [project-root]"
  echo ""
  echo "Creates a v3 harness:"
  echo "  .claude/harness/{name}/tasks.json"
  echo "  .claude/harness/{name}/harness.md"
  echo "  .claude/harness/{name}/policy.json"
  echo "  .claude/harness/{name}/spec.md"
  echo "  .claude/harness/{name}/acceptance.md"
  echo "  .claude/harness/{name}/agents/module-manager/{config,state,MEMORY,permissions,mission,inbox,outbox}"
  echo "  .claude/scripts/{name}-seed.sh"
  exit 1
fi

TMPL_DIR="$HOME/.boring/templates"
HARNESS_DIR="$PROJECT_ROOT/.claude/harness/$HARNESS"
MM_DIR="$HARNESS_DIR/agents/module-manager"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
LIFECYCLE="bounded"
[ "$PERPETUAL" = "true" ] && LIFECYCLE="long-running"
MISSION="${DESCRIPTION:-}"

mkdir -p "$HARNESS_DIR" "$PROJECT_ROOT/.claude/scripts" "$MM_DIR/memory"
mkdir -p "$HOME/.boring/harness/reports/$HARNESS/screenshots"
mkdir -p "$HOME/.boring/state/playwright/$HARNESS"

find_tmpl() {
  local f="$TMPL_DIR/$1"
  [ -f "$f" ] && echo "$f" || echo ""
}

replace() {
  sed "s|{{HARNESS}}|$HARNESS|g; s|{{PROJECT_ROOT}}|$PROJECT_ROOT|g; s|{{TITLE}}|$HARNESS|g" "$1"
}

echo "Scaffolding harness: $HARNESS"

# ── Harness root files ───────────────────────────────────────────

# tasks.json — empty task graph
if [ ! -f "$HARNESS_DIR/tasks.json" ]; then
  echo '{"tasks": {}}' > "$HARNESS_DIR/tasks.json"
  echo "  created tasks.json"
fi

# harness.md, policy.json, acceptance.md, vision.html — from templates if available
for pair in "harness.md.tmpl:harness.md" "policy.json.tmpl:policy.json" "acceptance.md.tmpl:acceptance.md" "vision.html.tmpl:vision.html"; do
  tmpl_name="${pair%%:*}"
  out_name="${pair#*:}"
  if [ ! -f "$HARNESS_DIR/$out_name" ]; then
    tmpl_file=$(find_tmpl "$tmpl_name")
    if [ -n "$tmpl_file" ]; then
      replace "$tmpl_file" > "$HARNESS_DIR/$out_name"
      echo "  created $out_name"
    else
      echo "  WARN: template $tmpl_name not found, skipping $out_name" >&2
    fi
  fi
done

# report.css — shared stylesheet for wave reports and vision docs
if [ ! -f "$HARNESS_DIR/report.css" ]; then
  _css_tmpl=$(find_tmpl "report.css")
  if [ -n "$_css_tmpl" ]; then
    cp "$_css_tmpl" "$HARNESS_DIR/report.css"
    echo "  created report.css"
  fi
fi

# spec.md — requirements stub
if [ ! -f "$HARNESS_DIR/spec.md" ]; then
  cat > "$HARNESS_DIR/spec.md" <<SPECEOF
# $HARNESS — Spec

> Source of truth: requirements the coordinator checks every cycle.

## Goal
${MISSION:-[Describe goal here]}

## Requirements
<!-- Add specific requirements here -->

## Success Criteria
<!-- Add measurable criteria here -->
SPECEOF
  echo "  created spec.md"
fi

# ── agents/module-manager/ files ────────────────────────────────

# config.json
if [ ! -f "$MM_DIR/config.json" ]; then
  jq -n \
    --arg name "$HARNESS" \
    --arg mission "$MISSION" \
    --arg lifecycle "$LIFECYCLE" \
    --arg ts "$NOW" \
    '{
      name: $name,
      mission: $mission,
      model: "sonnet",
      lifecycle: $lifecycle,
      sleep_duration: 900,
      rotation: {max_rounds: 20, claude_command: "cds", mode: "new_session"},
      scope_tags: [],
      created_at: $ts
    }' > "$MM_DIR/config.json"
  echo "  created agents/module-manager/config.json (lifecycle=$LIFECYCLE)"
fi

# state.json
if [ ! -f "$MM_DIR/state.json" ]; then
  jq -n '{status:"active",cycles_completed:0,last_cycle_at:null,session_count:0,sleep_duration:900,phase:"phase-now"}' \
    > "$MM_DIR/state.json"
  echo "  created agents/module-manager/state.json"
fi

# MEMORY.md
if [ ! -f "$MM_DIR/MEMORY.md" ]; then
  printf '# Memory\n\n' > "$MM_DIR/MEMORY.md"
  echo "  created agents/module-manager/MEMORY.md"
fi

# inbox.jsonl / outbox.jsonl
if [ ! -f "$MM_DIR/inbox.jsonl" ]; then
  touch "$MM_DIR/inbox.jsonl"
  echo "  created agents/module-manager/inbox.jsonl"
fi
[ ! -f "$MM_DIR/outbox.jsonl" ] && touch "$MM_DIR/outbox.jsonl"

# permissions.json — bypassPermissions + standard disallowed ops
if [ ! -f "$MM_DIR/permissions.json" ]; then
  cat > "$MM_DIR/permissions.json" <<'PERMEOF'
{
  "model": "sonnet",
  "permission_mode": "bypassPermissions",
  "disallowedTools": [
    "Bash(./scripts/deploy-prod*)",
    "Bash(./scripts/deploy.sh*)",
    "Bash(git push*)",
    "Bash(git reset --hard*)",
    "Bash(git clean*)",
    "Bash(rm -rf*)",
    "Bash(sudo *)",
    "Bash(sshpass*)"
  ]
}
PERMEOF
  echo "  created agents/module-manager/permissions.json"
fi

# mission.md — coordinator mission stub
if [ ! -f "$MM_DIR/mission.md" ]; then
  cat > "$MM_DIR/mission.md" <<MEOF
# $HARNESS — Module Manager Mission

## Objective
${MISSION:-[Describe what this coordinator should accomplish]}

## Scope
- [ ] Define scope here

## Constraints
- Read the relevant code before modifying it
- Stage specific files only — never \`git add -A\` or \`git add .\`
- Never push or merge to main without operator approval
- Bus-only messaging — never write directly to another agent's inbox.jsonl
MEOF
  echo "  created agents/module-manager/mission.md"
fi

# ── Seed script ─────────────────────────────────────────────────
SEED_FILE="$PROJECT_ROOT/.claude/scripts/${HARNESS}-seed.sh"
if [ ! -f "$SEED_FILE" ]; then
  SEED_TMPL=$(find_tmpl "seed.sh.tmpl")
  if [ -n "$SEED_TMPL" ]; then
    mkdir -p "$(dirname "$SEED_FILE")"
    replace "$SEED_TMPL" > "$SEED_FILE"
    chmod +x "$SEED_FILE"
    echo "  created .claude/scripts/${HARNESS}-seed.sh"
  fi
fi

# ── Manifest ────────────────────────────────────────────────────
mkdir -p "$HOME/.boring/harness/manifests/$HARNESS"
jq -n \
  --arg harness "$HARNESS" \
  --arg root "$PROJECT_ROOT" \
  --arg ts "$NOW" \
  '{
    harness: $harness,
    project_root: $root,
    type: "module-manager",
    status: "active",
    created_at: $ts,
    files: {
      tasks: (".claude/harness/\($harness)/tasks.json"),
      harness_md: (".claude/harness/\($harness)/harness.md"),
      policy: (".claude/harness/\($harness)/policy.json"),
      spec: (".claude/harness/\($harness)/spec.md"),
      acceptance: (".claude/harness/\($harness)/acceptance.md"),
      config: (".claude/harness/\($harness)/agents/module-manager/config.json"),
      state: (".claude/harness/\($harness)/agents/module-manager/state.json"),
      memory: (".claude/harness/\($harness)/agents/module-manager/MEMORY.md"),
      permissions: (".claude/harness/\($harness)/agents/module-manager/permissions.json"),
      mission: (".claude/harness/\($harness)/agents/module-manager/mission.md"),
      inbox: (".claude/harness/\($harness)/agents/module-manager/inbox.jsonl")
    }
  }' > "$HOME/.boring/harness/manifests/$HARNESS/manifest.json"

echo ""
echo "Done. Structure:"
echo "  .claude/harness/${HARNESS}/"
echo "    tasks.json         ← add your task graph"
echo "    harness.md         ← terrain map + key files"
echo "    policy.json        ← rules + context injections"
echo "    spec.md            ← requirements"
echo "    acceptance.md      ← pass/fail status"
echo "    agents/module-manager/"
echo "      config.json      lifecycle=$LIFECYCLE"
echo "      state.json       cycles_completed=0"
echo "      MEMORY.md        empty"
echo "      permissions.json bypassPermissions"
echo "      mission.md       ← EDIT with detailed objective"
echo "      inbox.jsonl      bus messages land here"
echo "  .claude/scripts/${HARNESS}-seed.sh"
echo ""
echo "Next:"
echo "  1. Edit agents/module-manager/mission.md — detailed objective + constraints"
echo "  2. Edit tasks.json — add task graph {\"tasks\": {\"t1\": {\"status\": \"pending\", ...}}}"
echo "  3. Edit harness.md — terrain map + key files"
echo "  4. Launch: bash ~/.boring/scripts/harness-launch.sh $HARNESS"
