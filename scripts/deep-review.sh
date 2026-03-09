#!/usr/bin/env bash
# deep-review.sh — Launch multi-pass deep review (code diffs OR content/plans/docs)
#
# Architecture:
#   Window 0 "coordinator": 1 pane — coordinator (Sonnet)
#   Window 1+ "workers-N":  4 panes tiled per window — review workers (Opus)
#
# Workers = passes × focus areas. Each focus area gets `passes` independent
# workers, each seeing a different randomized ordering of the material.
#
# Two modes:
#   DIFF MODE (default): Reviews git diffs (commit, branch, PR, uncommitted)
#   CONTENT MODE:        Reviews files/plans/docs (no git diff needed)
#
# Examples:
#   --passes 2 --focus security,logic,perf  →  6 workers (2 per focus)
#   --passes 4                              →  32 workers (4 × 8 default focus areas)
#   --passes 2                              →  16 workers (2 × 8 default)
#   --passes 1 --focus security             →  1 worker
#   --content plan.md                       →  review a plan (2×4=8 workers, content focus)
#   --content a.md,b.md --spec "check gaps" →  review multiple files with custom spec
#
# Session naming: dr-{worktree}-{first-two-words}-{short-hash}
#
# Usage:
#   bash ~/.claude-ops/scripts/deep-review.sh                     # review HEAD (2×8=16 workers)
#   bash ~/.claude-ops/scripts/deep-review.sh --base main         # changes since main
#   bash ~/.claude-ops/scripts/deep-review.sh --uncommitted       # uncommitted changes
#   bash ~/.claude-ops/scripts/deep-review.sh --commit abc123     # specific commit
#   bash ~/.claude-ops/scripts/deep-review.sh --pr 42             # pull request
#   bash ~/.claude-ops/scripts/deep-review.sh --content file.md   # review content (no diff)
#   bash ~/.claude-ops/scripts/deep-review.sh --content f1,f2     # review multiple files
#   bash ~/.claude-ops/scripts/deep-review.sh --spec "find gaps"  # review spec (content mode)
#   bash ~/.claude-ops/scripts/deep-review.sh --passes 1          # quick (1×8=8 workers)
#   bash ~/.claude-ops/scripts/deep-review.sh --passes 3 --focus security,logic  # 6 workers
#   bash ~/.claude-ops/scripts/deep-review.sh --session-name foo  # custom session name
#   bash ~/.claude-ops/scripts/deep-review.sh --notify user       # notify on completion
set -euo pipefail

CLAUDE_OPS="${CLAUDE_OPS_DIR:-$HOME/.claude-ops}"
TEMPLATE_DIR="$CLAUDE_OPS/templates/deep-review"
PROJECT_ROOT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
PASSES_PER_FOCUS=2
WORKER_MODEL="${DEEP_REVIEW_WORKER_MODEL:-opus}"
COORD_MODEL="${DEEP_REVIEW_COORD_MODEL:-sonnet}"
CUSTOM_SESSION_NAME=""
NOTIFY_TARGET=""
CUSTOM_FOCUS=""
CONTENT_FILES=""
REVIEW_SPEC=""

# Default focus areas (diff mode)
DEFAULT_FOCUS=(
  "security"
  "logic"
  "error-handling"
  "data-integrity"
  "architecture"
  "performance"
  "ux-impact"
  "completeness"
)

# Default focus areas (content mode)
DEFAULT_CONTENT_FOCUS=(
  "correctness"
  "completeness"
  "feasibility"
  "risks"
)

# ── Parse args ────────────────────────────────────────────────
DIFF_MODE="base"
BASE_BRANCH="main"
COMMIT=""
PR_NUMBER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) DIFF_MODE="base"; BASE_BRANCH="$2"; shift 2 ;;
    --uncommitted) DIFF_MODE="uncommitted"; shift ;;
    --commit) DIFF_MODE="commit"; COMMIT="$2"; shift 2 ;;
    --pr) DIFF_MODE="pr"; PR_NUMBER="$2"; shift 2 ;;
    --content) DIFF_MODE="content"; CONTENT_FILES="$2"; shift 2 ;;
    --spec) REVIEW_SPEC="$2"; shift 2 ;;
    --passes) PASSES_PER_FOCUS="$2"; shift 2 ;;
    --session-name) CUSTOM_SESSION_NAME="$2"; shift 2 ;;
    --notify) NOTIFY_TARGET="$2"; shift 2 ;;
    --focus) CUSTOM_FOCUS="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: deep-review.sh [--base BRANCH] [--uncommitted] [--commit SHA] [--pr NUM] [--content FILE]"
      echo ""
      echo "Diff mode (default):"
      echo "  --base BRANCH        Compare against branch (default: main)"
      echo "  --uncommitted        Review uncommitted changes"
      echo "  --commit SHA         Review a specific commit"
      echo "  --pr NUM             Review a pull request"
      echo ""
      echo "Content mode:"
      echo "  --content FILE       Review file(s) instead of a diff (comma-separated for multiple)"
      echo "  --spec TEXT          What to review for (e.g., 'check for logical gaps')"
      echo ""
      echo "Common options:"
      echo "  --passes N           Passes PER focus area (default: 2). Total workers = passes × focus"
      echo "  --session-name NAME  Custom tmux session name (overrides auto-naming)"
      echo "  --notify TARGET      Send completion notification (worker name or 'user')"
      echo "  --focus LIST         Comma-separated focus areas"
      echo "                       Diff default: security,logic,error-handling,data-integrity,architecture,performance,ux-impact,completeness"
      echo "                       Content default: correctness,completeness,feasibility,risks"
      echo ""
      echo "Examples:"
      echo "  --passes 2                              16 workers (2 × 8 default focus areas)"
      echo "  --passes 3 --focus security,logic       6 workers (3 × 2 focus areas)"
      echo "  --passes 1 --focus security             1 worker"
      echo "  --content plan.md                       8 workers (2 × 4 content focus areas)"
      echo "  --content a.md,b.md --spec 'find gaps'  review multiple files"
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# ── Resolve focus areas ──────────────────────────────────────
if [ -n "$CUSTOM_FOCUS" ]; then
  IFS=',' read -ra FOCUS_AREAS <<< "$CUSTOM_FOCUS"
elif [ "$DIFF_MODE" = "content" ]; then
  FOCUS_AREAS=("${DEFAULT_CONTENT_FOCUS[@]}")
else
  FOCUS_AREAS=("${DEFAULT_FOCUS[@]}")
fi

REVIEW_MODE="diff"
[ "$DIFF_MODE" = "content" ] && REVIEW_MODE="content"

NUM_FOCUS=${#FOCUS_AREAS[@]}
TOTAL_WORKERS=$((PASSES_PER_FOCUS * NUM_FOCUS))

echo "Focus areas ($NUM_FOCUS): ${FOCUS_AREAS[*]}"
echo "Passes per focus: $PASSES_PER_FOCUS"
echo "Total workers: $TOTAL_WORKERS"

# ── Validate environment ─────────────────────────────────────
if ! tmux info &>/dev/null; then
  echo "ERROR: tmux not running" >&2; exit 1
fi

if [ "$REVIEW_MODE" = "content" ]; then
  if [ ! -f "$TEMPLATE_DIR/worker-content-seed.md" ] || [ ! -f "$TEMPLATE_DIR/coordinator-seed.md" ]; then
    echo "ERROR: Content review templates not found at $TEMPLATE_DIR" >&2; exit 1
  fi
else
  if [ ! -f "$TEMPLATE_DIR/worker-seed.md" ] || [ ! -f "$TEMPLATE_DIR/coordinator-seed.md" ]; then
    echo "ERROR: Templates not found at $TEMPLATE_DIR" >&2; exit 1
  fi
fi

cd "$PROJECT_ROOT"

# ── Build session name ───────────────────────────────────────
if [ -n "$CUSTOM_SESSION_NAME" ]; then
  REVIEW_SESSION="$CUSTOM_SESSION_NAME"
elif [ "$REVIEW_MODE" = "content" ]; then
  # Content mode: name from first file basename
  FIRST_FILE=$(echo "$CONTENT_FILES" | cut -d',' -f1)
  FILE_BASE=$(basename "$FIRST_FILE" | sed 's/\.[^.]*$//' | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//;s/-$//')
  CONTENT_HASH=$(echo "$CONTENT_FILES" | md5 2>/dev/null | cut -c1-8 || echo "$CONTENT_FILES" | md5sum 2>/dev/null | cut -c1-8 || echo "unknown")
  REVIEW_SESSION="dr-content-${FILE_BASE}-${CONTENT_HASH}"
  REVIEW_SESSION="${REVIEW_SESSION:0:50}"
else
  WORKTREE_NAME=$(basename "$PROJECT_ROOT" | sed 's/^Wechat-w-//' | sed 's/^Wechat$/main/')

  case "$DIFF_MODE" in
    commit) REVIEW_COMMIT="$COMMIT" ;;
    pr)     REVIEW_COMMIT="pr${PR_NUMBER}" ;;
    *)      REVIEW_COMMIT=$(git rev-parse --short=8 HEAD 2>/dev/null || echo "unknown") ;;
  esac

  COMMIT_MSG=$(git log -1 --format='%s' "$REVIEW_COMMIT" 2>/dev/null || echo "review")
  COMMIT_MSG=$(echo "$COMMIT_MSG" | sed 's/^[a-z]*([^)]*): *//' | sed 's/^[a-z]*: *//')
  FIRST_TWO=$(echo "$COMMIT_MSG" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//;s/-$//' | cut -d'-' -f1-2)
  SHORT_HASH=$(git rev-parse --short=8 "$REVIEW_COMMIT" 2>/dev/null || echo "$REVIEW_COMMIT")

  REVIEW_SESSION="dr-${WORKTREE_NAME}-${FIRST_TWO}-${SHORT_HASH}"
  REVIEW_SESSION="${REVIEW_SESSION:0:50}"
fi

# Kill existing session with same name
if tmux has-session -t "$REVIEW_SESSION" 2>/dev/null; then
  echo "Killing existing session: $REVIEW_SESSION"
  tmux kill-session -t "$REVIEW_SESSION"
fi

# ── Create session directory ─────────────────────────────────
SESSION_ID=$(date -u '+%Y%m%d-%H%M%S')
SESSION_DIR="$PROJECT_ROOT/.claude/state/deep-review/session-$SESSION_ID"
mkdir -p "$SESSION_DIR"
HISTORY_FILE="$PROJECT_ROOT/.claude/state/deep-review/history.jsonl"

echo "Session: $SESSION_DIR"

# ── Generate material (diff or content) ──────────────────────
if [ "$REVIEW_MODE" = "content" ]; then
  echo "Collecting content files..."
  IFS=',' read -ra _CONTENT_ARRAY <<< "$CONTENT_FILES"
  MATERIAL_FILE="$SESSION_DIR/content-full.txt"
  CONTENT_FILE_LIST=""
  for cf in "${_CONTENT_ARRAY[@]}"; do
    # Expand ~ to $HOME
    cf="${cf/#\~/$HOME}"
    if [ ! -f "$cf" ]; then
      echo "ERROR: Content file not found: $cf" >&2
      rm -rf "$SESSION_DIR"
      exit 1
    fi
    echo "  + $cf"
    echo "═══ FILE: $(basename "$cf") ═══" >> "$MATERIAL_FILE"
    cat "$cf" >> "$MATERIAL_FILE"
    echo "" >> "$MATERIAL_FILE"
    CONTENT_FILE_LIST="${CONTENT_FILE_LIST:+$CONTENT_FILE_LIST, }$(basename "$cf")"
  done
  DIFF_DESC="content review of $CONTENT_FILE_LIST"
  [ -n "$REVIEW_SPEC" ] || REVIEW_SPEC="Review this content thoroughly for issues, gaps, and improvements."
  DIFF_LINES=$(wc -l < "$MATERIAL_FILE" | tr -d ' ')
  echo "Content: $DIFF_LINES lines ($DIFF_DESC)"
else
  echo "Generating diff..."
  MATERIAL_FILE="$SESSION_DIR/diff-full.patch"
  case "$DIFF_MODE" in
    base)
      git diff "${BASE_BRANCH}...HEAD" > "$MATERIAL_FILE" 2>/dev/null || \
      git diff "${BASE_BRANCH}..HEAD" > "$MATERIAL_FILE" 2>/dev/null || true
      DIFF_DESC="changes since $BASE_BRANCH"

      DIFF_LINES=$(wc -l < "$MATERIAL_FILE" | tr -d ' ')
      if [ "$DIFF_LINES" -eq 0 ]; then
        COMMITS_AHEAD=$(git rev-list "${BASE_BRANCH}..HEAD" --count 2>/dev/null || echo "0")
        if [ "$COMMITS_AHEAD" -gt 0 ]; then
          echo "WARN: $COMMITS_AHEAD commits ahead but tree content identical (already merged?)."
          echo "Auto-fallback: generating diff from individual commits..."
          for sha in $(git rev-list --reverse "${BASE_BRANCH}..HEAD"); do
            git show "$sha" >> "$MATERIAL_FILE" 2>/dev/null || true
          done
          DIFF_DESC="$COMMITS_AHEAD commits on $(git branch --show-current 2>/dev/null || echo 'HEAD')"
        fi
      fi
      ;;
    uncommitted)
      { git diff; git diff --cached; } > "$MATERIAL_FILE"
      for f in $(git ls-files --others --exclude-standard 2>/dev/null); do
        echo "diff --git a/$f b/$f" >> "$MATERIAL_FILE"
        echo "new file mode 100644" >> "$MATERIAL_FILE"
        echo "--- /dev/null" >> "$MATERIAL_FILE"
        echo "+++ b/$f" >> "$MATERIAL_FILE"
        sed 's/^/+/' "$f" >> "$MATERIAL_FILE" 2>/dev/null || true
      done
      DIFF_DESC="uncommitted changes"
      ;;
    commit)
      git show "$COMMIT" > "$MATERIAL_FILE"
      DIFF_DESC="commit $COMMIT"
      ;;
    pr)
      gh pr diff "$PR_NUMBER" > "$MATERIAL_FILE"
      DIFF_DESC="PR #$PR_NUMBER"
      ;;
  esac

  DIFF_LINES=$(wc -l < "$MATERIAL_FILE" | tr -d ' ')
  echo "Diff: $DIFF_LINES lines ($DIFF_DESC)"

  if [ "$DIFF_LINES" -eq 0 ]; then
    echo "ERROR: Empty diff — nothing to review" >&2
    rm -rf "$SESSION_DIR"
    exit 1
  fi
fi

# ── Split material + generate randomized orderings ───────────
echo "Generating $TOTAL_WORKERS randomized orderings..."

python3 << 'PYEOF' - "$MATERIAL_FILE" "$SESSION_DIR" "$TOTAL_WORKERS" "$REVIEW_MODE"
import sys, os, random, json
from datetime import datetime, timezone

material_file = sys.argv[1]
session_dir = sys.argv[2]
num_workers = int(sys.argv[3])
review_mode = sys.argv[4]

with open(material_file) as f:
    content = f.read()

# Split into chunks based on mode
chunks = []
current = []

if review_mode == "content":
    # Split by section headers (## ) or file boundaries (═══ FILE:)
    for line in content.split('\n'):
        if (line.startswith('## ') or line.startswith('═══ FILE:')) and current:
            chunks.append('\n'.join(current))
            current = []
        current.append(line)
else:
    # Split into file-level chunks at "diff --git" boundaries
    for line in content.split('\n'):
        if line.startswith('diff --git ') and current:
            chunks.append('\n'.join(current))
            current = []
        current.append(line)

if current:
    chunks.append('\n'.join(current))

# If content didn't split well (no headers), treat the whole thing as one chunk
if len(chunks) <= 1:
    chunks = [content]

print(f"  Split into {len(chunks)} chunks")

# Generate randomized orderings (each worker gets a unique shuffle)
suffix = 'txt' if review_mode == 'content' else 'patch'
for i in range(1, num_workers + 1):
    shuffled = chunks[:]
    random.shuffle(shuffled)
    outpath = os.path.join(session_dir, f'material-pass-{i}.{suffix}')
    with open(outpath, 'w') as f:
        f.write('\n'.join(shuffled))

# Write session metadata
meta = {
    'session_id': os.path.basename(session_dir),
    'review_mode': review_mode,
    'num_chunks': len(chunks),
    'num_workers': num_workers,
    'lines': content.count('\n'),
    'created_at': datetime.now(timezone.utc).isoformat()
}
with open(os.path.join(session_dir, 'meta.json'), 'w') as f:
    json.dump(meta, f, indent=2)
PYEOF

# ── Build focus assignment table ─────────────────────────────
# Worker N gets focus area: FOCUS_AREAS[(N-1) / PASSES_PER_FOCUS]
# Within each focus group, pass index: ((N-1) % PASSES_PER_FOCUS) + 1
# Example: 3 focus × 2 passes = workers 1-2=focus[0], 3-4=focus[1], 5-6=focus[2]

# Build a comma-separated focus list for coordinator template
FOCUS_LIST_CSV=$(IFS=','; echo "${FOCUS_AREAS[*]}")

# ── Generate seed prompts from templates ─────────────────────
echo "Generating seed prompts..."

MATERIAL_SUFFIX="patch"
[ "$REVIEW_MODE" = "content" ] && MATERIAL_SUFFIX="txt"

WORKER_TEMPLATE="$TEMPLATE_DIR/worker-seed.md"
[ "$REVIEW_MODE" = "content" ] && WORKER_TEMPLATE="$TEMPLATE_DIR/worker-content-seed.md"

for i in $(seq 1 "$TOTAL_WORKERS"); do
  FOCUS_IDX=$(( (i - 1) / PASSES_PER_FOCUS ))
  PASS_IN_FOCUS=$(( (i - 1) % PASSES_PER_FOCUS + 1 ))
  FOCUS="${FOCUS_AREAS[$FOCUS_IDX]}"

  sed \
    -e "s|{{PASS_NUMBER}}|$i|g" \
    -e "s|{{PASS_IN_FOCUS}}|$PASS_IN_FOCUS|g" \
    -e "s|{{PASSES_PER_FOCUS}}|$PASSES_PER_FOCUS|g" \
    -e "s|{{NUM_PASSES}}|$TOTAL_WORKERS|g" \
    -e "s|{{DIFF_FILE}}|$SESSION_DIR/material-pass-$i.$MATERIAL_SUFFIX|g" \
    -e "s|{{CONTENT_FILE}}|$SESSION_DIR/material-pass-$i.$MATERIAL_SUFFIX|g" \
    -e "s|{{OUTPUT_FILE}}|$SESSION_DIR/findings-pass-$i.json|g" \
    -e "s|{{DONE_FILE}}|$SESSION_DIR/pass-$i.done|g" \
    -e "s|{{PROJECT_ROOT}}|$PROJECT_ROOT|g" \
    -e "s|{{SESSION_DIR}}|$SESSION_DIR|g" \
    -e "s|{{SPECIALIZATION}}|$FOCUS|g" \
    -e "s|{{SPEC}}|$REVIEW_SPEC|g" \
    "$WORKER_TEMPLATE" > "$SESSION_DIR/worker-$i-seed.md"
done

sed \
  -e "s|{{SESSION_DIR}}|$SESSION_DIR|g" \
  -e "s|{{SESSION_ID}}|$SESSION_ID|g" \
  -e "s|{{PROJECT_ROOT}}|$PROJECT_ROOT|g" \
  -e "s|{{NUM_PASSES}}|$TOTAL_WORKERS|g" \
  -e "s|{{PASSES_PER_FOCUS}}|$PASSES_PER_FOCUS|g" \
  -e "s|{{NUM_FOCUS}}|$NUM_FOCUS|g" \
  -e "s|{{FOCUS_LIST}}|$FOCUS_LIST_CSV|g" \
  -e "s|{{REPORT_FILE}}|$SESSION_DIR/report.md|g" \
  -e "s|{{HISTORY_FILE}}|$HISTORY_FILE|g" \
  -e "s|{{NOTIFY_TARGET}}|$NOTIFY_TARGET|g" \
  -e "s|{{REVIEW_SESSION}}|$REVIEW_SESSION|g" \
  -e "s|{{REVIEW_MODE}}|$REVIEW_MODE|g" \
  -e "s|{{DIFF_DESC}}|$DIFF_DESC|g" \
  "$TEMPLATE_DIR/coordinator-seed.md" > "$SESSION_DIR/coordinator-seed.md"

# ── Create launch wrappers ───────────────────────────────────
for i in $(seq 1 "$TOTAL_WORKERS"); do
  cat > "$SESSION_DIR/run-pass-$i.sh" << WEOF
#!/usr/bin/env bash
cd "$PROJECT_ROOT"
exec claude --model $WORKER_MODEL --dangerously-skip-permissions "\$(cat '$SESSION_DIR/worker-$i-seed.md')"
WEOF
  chmod +x "$SESSION_DIR/run-pass-$i.sh"
done

cat > "$SESSION_DIR/run-coordinator.sh" << CEOF
#!/usr/bin/env bash
cd "$PROJECT_ROOT"
exec claude --model $COORD_MODEL --dangerously-skip-permissions "\$(cat '$SESSION_DIR/coordinator-seed.md')"
CEOF
chmod +x "$SESSION_DIR/run-coordinator.sh"

# ── Create dedicated tmux session ────────────────────────────
# Layout: 1 coordinator window + ceil(TOTAL_WORKERS/4) worker windows (4 panes each)
NUM_WORKER_WINDOWS=$(( (TOTAL_WORKERS + 3) / 4 ))
echo "Creating tmux session: $REVIEW_SESSION (1 coordinator + $NUM_WORKER_WINDOWS worker windows)..."

# Window 0: coordinator
tmux new-session -d -s "$REVIEW_SESSION" -n "coordinator" -c "$PROJECT_ROOT"

# Worker windows: 4 panes each
WORKERS_REMAINING=$TOTAL_WORKERS
for w in $(seq 1 "$NUM_WORKER_WINDOWS"); do
  PANES_IN_WINDOW=$((WORKERS_REMAINING > 4 ? 4 : WORKERS_REMAINING))
  tmux new-window -d -t "$REVIEW_SESSION" -n "workers-$w" -c "$PROJECT_ROOT"
  for _ in $(seq 1 $((PANES_IN_WINDOW - 1))); do
    tmux split-window -d -t "$REVIEW_SESSION:workers-$w" -c "$PROJECT_ROOT"
  done
  tmux select-layout -t "$REVIEW_SESSION:workers-$w" tiled
  WORKERS_REMAINING=$((WORKERS_REMAINING - PANES_IN_WINDOW))
done

sleep 1

# ── Launch workers (staggered) ───────────────────────────────
echo "Launching $TOTAL_WORKERS review workers across $NUM_FOCUS focus areas..."
echo ""

# Helper: get Nth pane ID from a window (0-indexed)
get_pane() {
  tmux list-panes -t "$1" -F '#{pane_id}' | sed -n "$((${2} + 1))p"
}

WORKER=1
for w in $(seq 1 "$NUM_WORKER_WINDOWS"); do
  PANE_COUNT=$(tmux list-panes -t "$REVIEW_SESSION:workers-$w" | wc -l | tr -d ' ')
  for p in $(seq 0 $((PANE_COUNT - 1))); do
    if [ "$WORKER" -gt "$TOTAL_WORKERS" ]; then break; fi
    PANE=$(get_pane "$REVIEW_SESSION:workers-$w" "$p")
    FOCUS_IDX=$(( (WORKER - 1) / PASSES_PER_FOCUS ))
    PASS_IN_FOCUS=$(( (WORKER - 1) % PASSES_PER_FOCUS + 1 ))
    echo "  Worker $WORKER → $PANE (win $w) [${FOCUS_AREAS[$FOCUS_IDX]} #$PASS_IN_FOCUS/$PASSES_PER_FOCUS]"
    tmux send-keys -t "$PANE" "bash '$SESSION_DIR/run-pass-$WORKER.sh'" Enter
    WORKER=$((WORKER + 1))
    sleep 0.3
  done
done

# ── Launch coordinator ───────────────────────────────────────
echo ""
echo "Launching coordinator..."
COORD_PANE=$(get_pane "$REVIEW_SESSION:coordinator" 0)
tmux send-keys -t "$COORD_PANE" "bash '$SESSION_DIR/run-coordinator.sh'" Enter

# ── Summary ──────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════"
echo "  DEEP REVIEW LAUNCHED"
echo ""
echo "  Session:     $REVIEW_SESSION"
echo "  Dir:         $SESSION_DIR"
echo "  Mode:        $REVIEW_MODE"
echo "  Reviewing:   $DIFF_DESC ($DIFF_LINES lines)"
if [ "$REVIEW_MODE" = "content" ] && [ -n "$REVIEW_SPEC" ]; then
echo "  Spec:        $REVIEW_SPEC"
fi
echo ""
echo "  Focus areas ($NUM_FOCUS): ${FOCUS_AREAS[*]}"
echo "  Passes/focus: $PASSES_PER_FOCUS"
echo "  Total workers: $TOTAL_WORKERS (model: $WORKER_MODEL)"
echo "  Coordinator: $REVIEW_SESSION:coordinator (model: $COORD_MODEL)"
echo ""
for w in $(seq 1 "$NUM_WORKER_WINDOWS"); do
  FIRST=$((  (w - 1) * 4 + 1 ))
  LAST=$(( w * 4 ))
  if [ "$LAST" -gt "$TOTAL_WORKERS" ]; then LAST=$TOTAL_WORKERS; fi
  echo "  Window $w: workers $FIRST-$LAST (4 panes tiled)"
done
if [ -n "$NOTIFY_TARGET" ]; then
  echo ""
  echo "  Notify:      $NOTIFY_TARGET (on completion)"
fi
echo ""
echo "  Attach: tmux switch-client -t $REVIEW_SESSION"
echo "          tmux a -t $REVIEW_SESSION"
echo ""
echo "  Voting: ≥2/$PASSES_PER_FOCUS within each focus group"
echo "  Report: $SESSION_DIR/report.md"
echo "════════════════════════════════════════════════════════════"
