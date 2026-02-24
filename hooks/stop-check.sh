#!/usr/bin/env bash
# Smart stop hook: reads prompts, checklist, and sensitive paths from agent-harness.xml.
# Uses session-aware baseline to avoid false positives on pre-existing dirty state.
# Three-hook system: baseline-init.sh (UserPromptSubmit) + write-flag.sh (PostToolUse) + this (Stop).
set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
HARNESS_XML="$PROJECT_ROOT/.claude/agent-harness.xml"

INPUT=$(cat)

# Skip if echo chain is active
SESSION_ID=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null || echo "")
if [ -n "$SESSION_ID" ] && [ -f "/tmp/claude_echo_state_${SESSION_ID}" ]; then
  echo '{}'
  exit 0
fi

if [ -z "$SESSION_ID" ]; then
  SESSION_ID="pid-$$"
fi

cd "$PROJECT_ROOT"

SESSION_HASH=$(echo "$SESSION_ID" | md5 -q 2>/dev/null || echo "$SESSION_ID" | md5sum | cut -d' ' -f1)

# Gate: fire if Claude wrote files OR deployed this session
WRITE_FLAG="/tmp/claude-write-flags/$SESSION_HASH"
DEPLOY_FLAG_CHECK="/tmp/claude-deploy-flags/$SESSION_HASH"
if [ ! -f "$WRITE_FLAG" ] && [ ! -f "$DEPLOY_FLAG_CHECK" ]; then
  echo '{}'
  exit 0
fi

# Clear the write flag so we don't re-trigger on the next stop without new writes
rm -f "$WRITE_FLAG"

BASELINE_DIR="/tmp/claude-stop-baselines"
BASELINE_FILE="$BASELINE_DIR/$SESSION_HASH"

# Current dirty files (staged + unstaged + untracked in src/)
ALL_DIRTY=$(git diff --name-only HEAD 2>/dev/null; git diff --name-only --cached 2>/dev/null; git ls-files --others --exclude-standard src/ 2>/dev/null)
ALL_DIRTY=$(echo "$ALL_DIRTY" | sort -u | grep -v '^$' || true)

# Create baseline on first invocation
if [ ! -f "$BASELINE_FILE" ]; then
  mkdir -p "$BASELINE_DIR"
  echo "$ALL_DIRTY" > "$BASELINE_FILE"
fi

# Only files NEW since baseline
BASELINE=$(cat "$BASELINE_FILE" 2>/dev/null || true)
CHANGED=$(comm -23 <(echo "$ALL_DIRTY") <(echo "$BASELINE" | sort -u) 2>/dev/null || true)
CHANGED=$(echo "$CHANGED" | grep -v '^$' || true)

# Allow deploy-only sessions (no file changes but deployed)
if [ -z "$CHANGED" ] && [ ! -f "$DEPLOY_FLAG_CHECK" ]; then
  echo '{}'
  exit 0
fi

# Categorize
HAS_TSX=$(echo "$CHANGED" | grep -c '\.tsx\?$' || true)
HAS_CSS=$(echo "$CHANGED" | grep -c '\.css$' || true)
HAS_TEST=$(echo "$CHANGED" | grep -c '\.test\.' || true)
HAS_FRONTEND=$(echo "$CHANGED" | grep -c 'admin/app\|\.css$\|\.html$' || true)
HAS_BACKEND=$(echo "$CHANGED" | grep -cE 'routes/|server\.ts|core/|db/|sql/' || true)
HAS_CONFIG=$(echo "$CHANGED" | grep -c 'hooks\|settings\|\.json$' || true)
HAS_ONTOLOGY=$(echo "$CHANGED" | grep -c 'ontology/' || true)
FILE_COUNT=$(echo "$CHANGED" | wc -l | tr -d ' ')

# --- Deploy detection (from deploy-flag.sh PostToolUse hook) ---
DEPLOY_FLAG="/tmp/claude-deploy-flags/$SESSION_HASH"
HAS_DEPLOYED=0
DEPLOY_TARGET=""
DEPLOY_SERVICE=""
DEPLOY_DOMAIN=""
if [ -f "$DEPLOY_FLAG" ]; then
  HAS_DEPLOYED=1
  DEPLOY_TARGET=$(python3 -c "import json; d=json.load(open('$DEPLOY_FLAG')); print(d.get('target','unknown'))" 2>/dev/null || echo "unknown")
  DEPLOY_SERVICE=$(python3 -c "import json; d=json.load(open('$DEPLOY_FLAG')); print(d.get('service','all'))" 2>/dev/null || echo "all")
  if [ "$DEPLOY_TARGET" = "prod" ]; then
    DEPLOY_DOMAIN="wx.baoyuansmartlife.com"
  else
    DEPLOY_DOMAIN="test.baoyuansmartlife.com"
  fi
  # Consume the flag
  rm -f "$DEPLOY_FLAG"
fi

# --- Sensitive path detection ---
SENSITIVE_MATCHES=""
if [ -f "$HARNESS_XML" ]; then
  # Extract patterns from <sensitive-paths> section
  PATTERNS=$(sed -n '/<sensitive-paths>/,/<\/sensitive-paths>/p' "$HARNESS_XML" \
    | grep '<path ' \
    | sed 's/.*pattern="\([^"]*\)".*/\1/' || true)

  if [ -n "$PATTERNS" ]; then
    while IFS= read -r pattern; do
      [ -z "$pattern" ] && continue
      MATCHES=$(echo "$CHANGED" | grep -E "$pattern" || true)
      if [ -n "$MATCHES" ]; then
        # Get the reason for this pattern
        REASON=$(sed -n '/<sensitive-paths>/,/<\/sensitive-paths>/p' "$HARNESS_XML" \
          | grep "pattern=\"${pattern}\"" \
          | sed 's/.*reason="\([^"]*\)".*/\1/' || echo "sensitive area")
        if [ -z "$SENSITIVE_MATCHES" ]; then
          SENSITIVE_MATCHES="$pattern ($REASON)"
        else
          SENSITIVE_MATCHES="$SENSITIVE_MATCHES, $pattern ($REASON)"
        fi
      fi
    done <<< "$PATTERNS"
  fi
fi

HAS_SENSITIVE=0
if [ -n "$SENSITIVE_MATCHES" ]; then
  HAS_SENSITIVE=1
fi

# --- Extract from XML ---
extract_questions() {
  local section="$1"
  if [ ! -f "$HARNESS_XML" ]; then return; fi
  # Extract <prompt>, <question>, <advisory> from the named section
  sed -n "/<${section}>/,/<\/${section}>/p" "$HARNESS_XML" \
    | grep -E '<(prompt|question|advisory)' \
    | sed 's/.*<prompt[^>]*>//' | sed 's/<\/prompt>//' \
    | sed 's/.*<question[^>]*>//' | sed 's/<\/question>//' \
    | sed 's/.*<advisory[^>]*>//' | sed 's/<\/advisory>//' \
    | sed "s/{file_count}/${FILE_COUNT}/g" \
    | sed "s/{sensitive_matches}/${SENSITIVE_MATCHES}/g" \
    | sed 's/&lt;/</g' | sed 's/&gt;/>/g' | sed 's/&amp;/\&/g'
}

extract_checklist() {
  if [ ! -f "$HARNESS_XML" ]; then return; fi
  sed -n '/<checklist>/,/<\/checklist>/p' "$HARNESS_XML" \
    | grep '<item' \
    | sed 's/.*<item[^>]*>/  [ ] /' | sed 's/<\/item>//'
}

# --- Build message ---
MSG=""

if [ "$HAS_TSX" -gt 0 ] || [ "$HAS_CSS" -gt 0 ] || [ "$HAS_BACKEND" -gt 0 ]; then
  # Code changes — extract prompts from XML, apply gates
  LINES=$(extract_questions "code-changes")
  if [ -n "$LINES" ]; then
    MSG="$LINES"
    # Remove gated lines that don't apply
    if [ "$HAS_FRONTEND" -eq 0 ]; then
      MSG=$(echo "$MSG" | grep -v 'UI changed' || echo "$MSG")
    fi
    if [ "$HAS_TEST" -gt 0 ] || [ "$HAS_TSX" -eq 0 ]; then
      MSG=$(echo "$MSG" | grep -v 'need tests' || echo "$MSG")
    fi
    MSG=$(echo "$MSG" | tr '\n' ' ' | sed 's/  */ /g')
  else
    # Fallback if XML missing
    MSG="You changed ${FILE_COUNT} file(s). Before finishing: 1) What does it do now? 2) How did you implement it? 3) How did you verify it works?"
  fi

elif [ "$HAS_CONFIG" -gt 0 ]; then
  LINES=$(extract_questions "config-changes")
  if [ -n "$LINES" ]; then
    MSG=$(echo "$LINES" | sed "s/{file_count}/${FILE_COUNT}/g" | tr '\n' ' ')
  else
    MSG="Config/hook changes (${FILE_COUNT} files). Summarize what changed and verify it works."
  fi

else
  LINES=$(extract_questions "uncommitted")
  if [ -n "$LINES" ]; then
    MSG=$(echo "$LINES" | sed "s/{file_count}/${FILE_COUNT}/g" | tr '\n' ' ')
  else
    MSG="Uncommitted changes (${FILE_COUNT} files). Ready to commit?"
  fi
fi

# Append sensitive path escalation
if [ "$HAS_SENSITIVE" -eq 1 ]; then
  SENSITIVE_LINES=$(extract_questions "sensitive-escalation")
  if [ -n "$SENSITIVE_LINES" ]; then
    MSG="${MSG}

${SENSITIVE_LINES}"
  else
    MSG="${MSG}

CAUTION: You touched sensitive path(s): ${SENSITIVE_MATCHES}. What exactly changed, and what is the rollback plan?"
  fi
fi

# Deploy checklist (from deploy-flag.sh)
if [ "$HAS_DEPLOYED" -eq 1 ]; then
  DEPLOY_LINES=$(extract_questions "deploy-changes")
  if [ -n "$DEPLOY_LINES" ]; then
    DEPLOY_LINES=$(echo "$DEPLOY_LINES" \
      | sed "s/{deploy_target}/${DEPLOY_TARGET}/g" \
      | sed "s/{deploy_service}/${DEPLOY_SERVICE}/g" \
      | sed "s/{deploy_domain}/${DEPLOY_DOMAIN}/g")
    # Remove prod-only line if target is not prod
    if [ "$DEPLOY_TARGET" != "prod" ]; then
      DEPLOY_LINES=$(echo "$DEPLOY_LINES" | grep -v 'PROD deploy' || echo "$DEPLOY_LINES")
    fi
    MSG="${MSG}

${DEPLOY_LINES}"
  else
    MSG="${MSG}

You deployed to ${DEPLOY_TARGET} (service: ${DEPLOY_SERVICE}). Health check: curl -sf https://${DEPLOY_DOMAIN}/health"
  fi
fi

# Blast radius escalation
if [ "$FILE_COUNT" -gt 10 ]; then
  MSG="${MSG}

NOTE: ${FILE_COUNT} files changed — this is a sweeping change. Consider running a cx audit or splitting into smaller commits."
fi

# Append checklist
CHECKLIST=$(extract_checklist)
if [ -n "$CHECKLIST" ]; then
  # When sensitive paths are touched, show ALL checklist items (no gate filtering)
  if [ "$HAS_SENSITIVE" -eq 0 ]; then
    # Normal mode: apply gates
    if [ "$HAS_FRONTEND" -eq 0 ]; then
      CHECKLIST=$(echo "$CHECKLIST" | grep -v 'UI changed\|built admin\|screenshots' || echo "$CHECKLIST")
    fi
    if [ "$HAS_BACKEND" -eq 0 ]; then
      CHECKLIST=$(echo "$CHECKLIST" | grep -v 'backend changed\|endpoints respond' || echo "$CHECKLIST")
    fi
    if [ "$HAS_TEST" -eq 0 ] && [ "$HAS_TSX" -eq 0 ]; then
      CHECKLIST=$(echo "$CHECKLIST" | grep -v 'Tests pass' || echo "$CHECKLIST")
    fi
    if [ "$HAS_TSX" -eq 0 ]; then
      CHECKLIST=$(echo "$CHECKLIST" | grep -v 'TypeScript errors' || echo "$CHECKLIST")
    fi
    if [ "$HAS_DEPLOYED" -eq 0 ]; then
      CHECKLIST=$(echo "$CHECKLIST" | grep -v 'Health check passes\|SQL library entries synced' || echo "$CHECKLIST")
    fi
    if [ "$HAS_ONTOLOGY" -eq 0 ]; then
      CHECKLIST=$(echo "$CHECKLIST" | grep -v 'actionSecurity entry' || echo "$CHECKLIST")
    fi
  fi
  # else: sensitive mode — show all items unfiltered

  MSG="${MSG}

Checklist:
${CHECKLIST}"
fi

python3 -c "
import json, sys
msg = sys.argv[1]
print(json.dumps({'decision': 'block', 'reason': msg}))
" "$MSG"
