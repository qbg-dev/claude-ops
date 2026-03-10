#!/usr/bin/env bash
# deep-review.sh — Multi-pass deep review (code diffs, content, or both)
#
# Architecture:
#   Window 0 "coordinator": 1 pane — coordinator (Sonnet)
#   Window 1+ "workers-N":  4 panes tiled per window — review workers (Opus)
#
# Workers = passes × focus areas. Each focus area gets `passes` independent
# workers, each seeing a different randomized ordering of the material.
#
# Material is additive — combine diffs AND content files in a single review:
#   --scope main --content plan.md  →  review diff + plan together
#
# Examples:
#   --scope main                            review changes since main
#   --scope abc1234                         review specific commit
#   --scope uncommitted                     review working changes
#   --scope pr:42                           review a pull request
#   --content plan.md                       review a plan/doc (no diff)
#   --scope main --content design.md        review diff + design doc together
#   --content a.md,b.md --spec "find gaps"  review files with custom spec
#   --passes 1 --focus security             1 worker, security only
#
# Session naming: dr-{worktree}-{descriptor}-{hash}
#
# Unified scope replaces --base/--commit/--uncommitted/--pr:
#   main, develop, feature/x  →  diff since branch (was --base)
#   abc1234, HEAD~3           →  specific commit (was --commit)
#   uncommitted               →  working changes (was --uncommitted)
#   pr:42                     →  pull request (was --pr)
#   HEAD (default when no --content) → current commit
set -euo pipefail

CLAUDE_OPS="${CLAUDE_OPS_DIR:-$HOME/.claude-ops}"
TEMPLATE_DIR="$CLAUDE_OPS/templates/deep-review"
PROJECT_ROOT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
PASSES_PER_FOCUS=2
WORKER_MODEL="${DEEP_REVIEW_WORKER_MODEL:-opus}"
COORD_MODEL="${DEEP_REVIEW_COORD_MODEL:-opus}"
CUSTOM_SESSION_NAME=""
NOTIFY_TARGET=""
CUSTOM_FOCUS=""
CONTENT_FILES=""
REVIEW_SPEC=""
SCOPE=""
NO_JUDGE=false
NO_CONTEXT=false
FORCE=false
VERIFY=false
VERIFY_ROLES=""

# ── Attack vectors per specialization ──────────────────────
get_attack_vectors() {
  case "$1" in
    security)     echo "Trace every user-controlled input (URL params, request body, headers, JWT claims, cookie values) to where it is used in SQL queries, shell commands, file paths, or HTML output. Check: parameterized queries or raw string interpolation? Ownership checks on resource access (IDOR)? Rate limits on LLM-invoking endpoints? Auth on every route? CSRF protection? Error messages leaking internal details?" ;;
    logic)        echo "For each changed conditional branch: what if the condition is inverted? Off-by-one? What if input is empty, null, undefined, NaN, or an unexpected type? Are all switch/if-else branches covered? Is there implicit fallthrough? Does the change affect loop termination? Are comparisons correct (=== vs ==, < vs <=)?" ;;
    error-handling) echo "For each try/catch: what specific exceptions can the try block throw? Does the catch handle all of them? Is there a finally block that should exist? Are there async operations without .catch()? Are error messages leaked to the client (should return generic message, log real error)? Does error recovery leave the system in a consistent state?" ;;
    data-integrity) echo "Check all writes: are they atomic? Is there rollback on failure? Could concurrent writes race? Is cache invalidated after writes? Are there silent truncations (string length, number overflow)? Non-atomic read-modify-write patterns? Missing database transactions?" ;;
    performance)  echo "Check for: N+1 query patterns (loop with DB call inside). Unbounded result sets (missing LIMIT/pagination). Unnecessary re-renders or re-computations. Blocking I/O on hot paths. Memory leaks (event listeners not cleaned up, growing arrays). Missing indexes on queried columns. Large payloads without streaming." ;;
    ux-impact)    echo "Check for: missing loading states during async operations. Error messages that are unhelpful or expose internals. Race conditions visible to users (double-click, stale data). Accessibility gaps (missing aria labels, keyboard nav). Misleading UI text or labels. State not cleared on navigation. Missing confirmation for destructive actions." ;;
    architecture) echo "Check for: circular dependencies between modules. God functions doing too many things. Abstraction leaks (implementation details exposed to callers). Wrong layer (business logic in routes, DB queries in UI). Tight coupling that makes testing hard. Missing separation of concerns." ;;
    completeness) echo "Check for: partial migrations (old pattern in some files, new in others). Missing error states or edge cases. TODO/FIXME left behind. Incomplete cleanup of removed features. Missing documentation for public APIs. Untested code paths." ;;
    correctness)  echo "Check for: logical consistency — do claims match the evidence? Contradictions between sections. Factual accuracy — are numbers, dates, versions correct? Unstated assumptions that may be wrong. Circular reasoning. Conclusions that don't follow from premises." ;;
    feasibility)  echo "Check for: implementation complexity underestimated. Dependencies on systems/APIs/people not accounted for. Resource requirements (time, compute, cost) not realistic. Blockers not identified. Ordering issues — does step 3 depend on step 5? Scope creep risks." ;;
    risks)        echo "Check for: single points of failure. What happens if an external dependency goes down? Failure modes not discussed. Security implications of the proposed approach. Operational burden of maintaining this. Rollback strategy if things go wrong." ;;
    improvement)  echo "Look for: real improvements to reliability, readability, or maintainability. Patterns that could be simplified. Duplicated logic that could be extracted. Missing abstractions that would reduce complexity. Better error messages or logging." ;;
    silent-failure) echo "Find every try-catch, .catch(), error callback, optional chaining (?.), null coalescing (??), and fallback/default value. For each: (1) Is the error logged with context? (2) Does the user get actionable feedback or is it swallowed? (3) Is the catch specific or catch-all? (4) Empty catch blocks? (5) Does error recovery leave consistent state? (6) Fallbacks that mask real problems? Every silent swallow is critical." ;;
    claude-md)    echo "Read ALL CLAUDE.md files in the project (root, .claude/, subdirectories). For each changed file, check: does the change comply with every applicable rule? Cross-reference: 'CLAUDE.md rule X requires Y, but the change does Z.' Only report EXPLICIT violations, not general best practices." ;;
    *)            echo "Review thoroughly using your specialization lens. Look for issues that a generalist might miss. Trace implications across the codebase." ;;
  esac
}

# Default focus areas
DEFAULT_DIFF_FOCUS=(
  "security"
  "logic"
  "error-handling"
  "data-integrity"
  "architecture"
  "performance"
  "ux-impact"
  "completeness"
)

DEFAULT_CONTENT_FOCUS=(
  "correctness"
  "completeness"
  "feasibility"
  "risks"
)

DEFAULT_MIXED_FOCUS=(
  "security"
  "logic"
  "correctness"
  "completeness"
  "feasibility"
  "risks"
)

# ── Parse args ────────────────────────────────────────────────
# Legacy flags still work for backwards compatibility
while [[ $# -gt 0 ]]; do
  case "$1" in
    --scope)   SCOPE="$2"; shift 2 ;;
    --content) CONTENT_FILES="$2"; shift 2 ;;
    --spec)    REVIEW_SPEC="$2"; shift 2 ;;
    --passes)  PASSES_PER_FOCUS="$2"; shift 2 ;;
    --session-name) CUSTOM_SESSION_NAME="$2"; shift 2 ;;
    --notify)  NOTIFY_TARGET="$2"; shift 2 ;;
    --focus)   CUSTOM_FOCUS="$2"; shift 2 ;;
    --no-judge)  NO_JUDGE=true; shift ;;
    --no-context) NO_CONTEXT=true; shift ;;
    --force)     FORCE=true; shift ;;
    --verify)    VERIFY=true; shift ;;
    --verify-roles) VERIFY_ROLES="$2"; shift 2 ;;
    # Legacy aliases
    --base)        SCOPE="$2"; shift 2 ;;
    --commit)      SCOPE="$2"; shift 2 ;;
    --uncommitted) SCOPE="uncommitted"; shift ;;
    --pr)          SCOPE="pr:$2"; shift 2 ;;
    -h|--help)
      echo "Usage: deep-review.sh [--scope SCOPE] [--content FILE] [--spec TEXT] [options]"
      echo ""
      echo "Material sources (additive — combine both for richer reviews):"
      echo "  --scope SCOPE        Git diff scope. Auto-detects:"
      echo "                         branch name → diff since branch"
      echo "                         SHA/ref     → specific commit"
      echo "                         uncommitted → working changes"
      echo "                         pr:N        → pull request"
      echo "                         HEAD        → current commit (default if no --content)"
      echo "  --content FILE       Review file(s) (comma-separated for multiple)"
      echo "  --spec TEXT          What to review for (guides all workers)"
      echo ""
      echo "Options:"
      echo "  --passes N           Passes PER focus area (default: 2)"
      echo "  --session-name NAME  Custom tmux session name"
      echo "  --notify TARGET      Notify on completion (worker name or 'user')"
      echo "  --focus LIST         Comma-separated focus areas (overrides auto-detect)"
      echo "  --no-judge           Skip adversarial judge validation"
      echo "  --no-context         Skip context pre-pass (static analysis, deps)"
      echo "  --force              Force review even if auto-skip would trigger"
      echo "  --verify             Enable verification phase after review completes"
      echo "  --verify-roles LIST  Comma-separated user roles to test as (e.g. admin,shenlan-pm)"
      echo "                       Diff: security,logic,error-handling,data-integrity,architecture,performance,ux-impact,completeness"
      echo "                       Content: correctness,completeness,feasibility,risks"
      echo "                       Mixed: security,logic,correctness,completeness,feasibility,risks"
      echo "                       Extra: silent-failure,claude-md (available via --focus)"
      echo ""
      echo "Legacy aliases (still work):"
      echo "  --base BRANCH        Same as --scope BRANCH"
      echo "  --commit SHA         Same as --scope SHA"
      echo "  --uncommitted        Same as --scope uncommitted"
      echo "  --pr NUM             Same as --scope pr:NUM"
      echo ""
      echo "Examples:"
      echo "  --scope main                               diff since main (16 workers)"
      echo "  --content plan.md                          review plan (8 workers)"
      echo "  --scope main --content plan.md             diff + plan together (12 workers)"
      echo "  --scope main --spec 'check auth changes'   diff with custom focus"
      echo "  --passes 1 --focus security                1 worker, security only"
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# ── Determine what we're reviewing ───────────────────────────
HAS_DIFF=false
HAS_CONTENT=false
[ -n "$SCOPE" ] && HAS_DIFF=true
[ -n "$CONTENT_FILES" ] && HAS_CONTENT=true

# Default: if nothing specified, review HEAD commit
if ! $HAS_DIFF && ! $HAS_CONTENT; then
  SCOPE="HEAD"
  HAS_DIFF=true
fi

# ── Resolve focus areas ──────────────────────────────────────
if [ -n "$CUSTOM_FOCUS" ]; then
  IFS=',' read -ra FOCUS_AREAS <<< "$CUSTOM_FOCUS"
elif $HAS_DIFF && $HAS_CONTENT; then
  FOCUS_AREAS=("${DEFAULT_MIXED_FOCUS[@]}")
elif $HAS_CONTENT; then
  FOCUS_AREAS=("${DEFAULT_CONTENT_FOCUS[@]}")
else
  FOCUS_AREAS=("${DEFAULT_DIFF_FOCUS[@]}")
fi

NUM_FOCUS=${#FOCUS_AREAS[@]}
TOTAL_WORKERS=$((PASSES_PER_FOCUS * NUM_FOCUS))

echo "Focus areas ($NUM_FOCUS): ${FOCUS_AREAS[*]}"
echo "Passes per focus: $PASSES_PER_FOCUS"
echo "Total workers: $TOTAL_WORKERS"

# ── Validate environment ─────────────────────────────────────
if ! tmux info &>/dev/null; then
  echo "ERROR: tmux not running" >&2; exit 1
fi

if [ ! -f "$TEMPLATE_DIR/worker-seed.md" ] || [ ! -f "$TEMPLATE_DIR/coordinator-seed.md" ]; then
  echo "ERROR: Templates not found at $TEMPLATE_DIR" >&2; exit 1
fi

cd "$PROJECT_ROOT"

# ── Detect REVIEW.md ─────────────────────────────────────────
# Search order:
#   1. Current project root (worktree or repo)
#   2. Main worktree root (for git worktrees attached to another repo)
#   3. Sibling base repo (for separate clones: Wechat-w-merger → Wechat)
REVIEW_CONFIG=""
_SEARCH_ROOTS=("$PROJECT_ROOT")

# Check main worktree (handles git worktree add)
_MAIN_WORKTREE=$(git worktree list --porcelain 2>/dev/null | head -1 | sed 's/^worktree //')
if [ -n "$_MAIN_WORKTREE" ] && [ "$_MAIN_WORKTREE" != "$PROJECT_ROOT" ]; then
  _SEARCH_ROOTS+=("$_MAIN_WORKTREE")
fi

# Check sibling base repo (handles separate clones like Wechat-w-merger → Wechat)
_BASENAME=$(basename "$PROJECT_ROOT")
_BASE_REPO=$(echo "$_BASENAME" | sed 's/-w-[^/]*$//')
if [ "$_BASE_REPO" != "$_BASENAME" ]; then
  _SIBLING="$(dirname "$PROJECT_ROOT")/$_BASE_REPO"
  [ -d "$_SIBLING" ] && _SEARCH_ROOTS+=("$_SIBLING")
fi

for _root in "${_SEARCH_ROOTS[@]}"; do
  for _rmd in "$_root/REVIEW.md" "$_root/.claude/REVIEW.md"; do
    if [ -f "$_rmd" ]; then
      REVIEW_CONFIG=$(cat "$_rmd")
      echo "REVIEW.md: $_rmd"
      break 2
    fi
  done
done
[ -z "$REVIEW_CONFIG" ] && echo "REVIEW.md: not found (skipping project-specific rules)"

# ── Build session name ───────────────────────────────────────
if [ -n "$CUSTOM_SESSION_NAME" ]; then
  REVIEW_SESSION="$CUSTOM_SESSION_NAME"
else
  WORKTREE_NAME=$(basename "$PROJECT_ROOT" | sed 's/^Wechat-w-//' | sed 's/^Wechat$/main/')

  if $HAS_CONTENT && ! $HAS_DIFF; then
    # Content-only: name from first file
    FIRST_FILE=$(echo "$CONTENT_FILES" | cut -d',' -f1)
    FILE_BASE=$(basename "$FIRST_FILE" | sed 's/\.[^.]*$//' | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//;s/-$//')
    CONTENT_HASH=$(echo "$CONTENT_FILES" | md5 2>/dev/null | cut -c1-8 || echo "$CONTENT_FILES" | md5sum 2>/dev/null | cut -c1-8 || echo "unknown")
    REVIEW_SESSION="dr-${WORKTREE_NAME}-${FILE_BASE}-${CONTENT_HASH}"
  else
    # Has diff (maybe also content)
    RESOLVED_REF="$SCOPE"
    if [ "$SCOPE" = "uncommitted" ]; then
      RESOLVED_REF=$(git rev-parse --short=8 HEAD 2>/dev/null || echo "wip")
    elif [[ "$SCOPE" == pr:* ]]; then
      RESOLVED_REF="pr${SCOPE#pr:}"
    elif [[ "$SCOPE" == *..* ]]; then
      # Range syntax — use the endpoint for commit msg, sanitize for session name
      RANGE_END="${SCOPE##*..}"
      RESOLVED_REF="$RANGE_END"
    fi
    COMMIT_MSG=$(git log -1 --format='%s' "$RESOLVED_REF" 2>/dev/null || echo "review")
    COMMIT_MSG=$(echo "$COMMIT_MSG" | sed 's/^[a-z]*([^)]*): *//' | sed 's/^[a-z]*: *//')
    FIRST_TWO=$(echo "$COMMIT_MSG" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//;s/-$//' | cut -d'-' -f1-2)
    # Use head -1 to prevent multi-line output from ranges
    SHORT_HASH=$(git rev-parse --short=8 "$RESOLVED_REF" 2>/dev/null | head -1 || echo "$RESOLVED_REF" | tr -cs 'a-z0-9A-Z' '-')
    REVIEW_SESSION="dr-${WORKTREE_NAME}-${FIRST_TWO}-${SHORT_HASH}"
  fi
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

# ── Collect material (additive) ──────────────────────────────
MATERIAL_FILE="$SESSION_DIR/material-full.txt"
DIFF_DESC_PARTS=()
MATERIAL_TYPES=()

# 1. Diff (if scope provided)
if $HAS_DIFF; then
  echo "Generating diff..."
  DIFF_TMP="$SESSION_DIR/_diff.patch"

  # Auto-detect scope type
  if [ "$SCOPE" = "uncommitted" ]; then
    { git diff; git diff --cached; } > "$DIFF_TMP"
    for f in $(git ls-files --others --exclude-standard 2>/dev/null); do
      echo "diff --git a/$f b/$f" >> "$DIFF_TMP"
      echo "new file mode 100644" >> "$DIFF_TMP"
      echo "--- /dev/null" >> "$DIFF_TMP"
      echo "+++ b/$f" >> "$DIFF_TMP"
      sed 's/^/+/' "$f" >> "$DIFF_TMP" 2>/dev/null || true
    done
    DIFF_DESC_PARTS+=("uncommitted changes")

  elif [[ "$SCOPE" == pr:* ]]; then
    PR_NUM="${SCOPE#pr:}"
    gh pr diff "$PR_NUM" > "$DIFF_TMP"
    DIFF_DESC_PARTS+=("PR #$PR_NUM")

  elif [[ "$SCOPE" == *..* ]]; then
    # Explicit range (e.g. v1.1.3..v1.1.4 or main..feature)
    git diff "$SCOPE" > "$DIFF_TMP" 2>/dev/null || true
    DIFF_DESC_PARTS+=("$SCOPE")

  elif git rev-parse --verify "$SCOPE^{commit}" &>/dev/null && \
       [ "$(git rev-parse "$SCOPE" 2>/dev/null)" != "$(git merge-base "$SCOPE" HEAD 2>/dev/null)" ]; then
    # It's a reachable commit that's an ancestor — treat as branch base
    # Try 3-dot first (changes on this branch only), fall back to 2-dot
    git diff "${SCOPE}...HEAD" > "$DIFF_TMP" 2>/dev/null || \
    git diff "${SCOPE}..HEAD" > "$DIFF_TMP" 2>/dev/null || true

    DIFF_LINES_TMP=$(wc -l < "$DIFF_TMP" | tr -d ' ')
    if [ "$DIFF_LINES_TMP" -eq 0 ]; then
      COMMITS_AHEAD=$(git rev-list "${SCOPE}..HEAD" --count 2>/dev/null || echo "0")
      if [ "$COMMITS_AHEAD" -gt 0 ]; then
        echo "WARN: $COMMITS_AHEAD commits ahead but tree content identical. Fallback to per-commit diffs..."
        for sha in $(git rev-list --reverse "${SCOPE}..HEAD"); do
          git show "$sha" >> "$DIFF_TMP" 2>/dev/null || true
        done
      fi
    fi
    DIFF_DESC_PARTS+=("changes since $SCOPE")

  else
    # Treat as specific commit
    git show "$SCOPE" > "$DIFF_TMP" 2>/dev/null || true
    DIFF_DESC_PARTS+=("commit $SCOPE")
  fi

  DIFF_LINES_TMP=$(wc -l < "$DIFF_TMP" | tr -d ' ')
  if [ "$DIFF_LINES_TMP" -gt 0 ]; then
    echo "═══ GIT DIFF ═══" >> "$MATERIAL_FILE"
    cat "$DIFF_TMP" >> "$MATERIAL_FILE"
    echo "" >> "$MATERIAL_FILE"
    MATERIAL_TYPES+=("diff")
    echo "  Diff: $DIFF_LINES_TMP lines"
  elif ! $HAS_CONTENT; then
    echo "ERROR: Empty diff and no content files — nothing to review" >&2
    rm -rf "$SESSION_DIR"
    exit 1
  else
    echo "  (diff is empty, reviewing content only)"
  fi
  rm -f "$DIFF_TMP"
fi

# 2. Content files (if provided)
if $HAS_CONTENT; then
  echo "Collecting content files..."
  IFS=',' read -ra _CONTENT_ARRAY <<< "$CONTENT_FILES"
  CONTENT_FILE_LIST=""
  for cf in "${_CONTENT_ARRAY[@]}"; do
    # Strip whitespace and quotes that may sneak in from JSON/MCP parsing
    cf=$(echo "$cf" | sed 's/^[[:space:]"]*//;s/[[:space:]"]*$//')
    cf="${cf/#\~/$HOME}"
    # Resolve relative paths against PROJECT_ROOT
    [[ "$cf" != /* ]] && cf="$PROJECT_ROOT/$cf"
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
  DIFF_DESC_PARTS+=("$CONTENT_FILE_LIST")
  MATERIAL_TYPES+=("content")
fi

DIFF_DESC=$(IFS=' + '; echo "${DIFF_DESC_PARTS[*]}")
MATERIAL_TYPES_STR=$(IFS='+'; echo "${MATERIAL_TYPES[*]}")
[ -n "$REVIEW_SPEC" ] || REVIEW_SPEC="Review this material thoroughly for issues, gaps, and improvements."
DIFF_LINES=$(wc -l < "$MATERIAL_FILE" | tr -d ' ')
echo "Material: $DIFF_LINES lines ($DIFF_DESC)"

# ── Auto-skip trivial changes ────────────────────────────────
if ! $FORCE && $HAS_DIFF && ! $HAS_CONTENT; then
  # Check if ALL changed files are lockfiles only
  CHANGED_PATHS=$(grep -E '^diff --git a/' "$MATERIAL_FILE" 2>/dev/null | sed 's|diff --git a/||;s| b/.*||' | sort -u)
  ALL_LOCKFILES=true
  while IFS= read -r cpath; do
    [ -z "$cpath" ] && continue
    case "$(basename "$cpath")" in
      bun.lock|bun.lockb|package-lock.json|yarn.lock|pnpm-lock.yaml|Cargo.lock|Gemfile.lock|poetry.lock|composer.lock) ;;
      *) ALL_LOCKFILES=false; break ;;
    esac
  done <<< "$CHANGED_PATHS"

  if $ALL_LOCKFILES && [ -n "$CHANGED_PATHS" ]; then
    echo "AUTO-SKIP: All changed files are lockfiles. Use --force to override."
    rm -rf "$SESSION_DIR"
    exit 0
  fi

  # Check if diff is all whitespace-only changes
  SUBSTANTIVE_LINES=$(grep -cE '^\+[^+]|^-[^-]' "$MATERIAL_FILE" 2>/dev/null | tr -d ' ' || echo "0")
  # Filter out whitespace-only additions/removals
  WHITESPACE_ONLY=$(grep -E '^\+[^+]|^-[^-]' "$MATERIAL_FILE" 2>/dev/null | grep -cvE '^\+\s*$|^-\s*$' 2>/dev/null | tr -d ' ' || echo "0")

  if [ "$WHITESPACE_ONLY" -lt 5 ] && [ -z "$REVIEW_SPEC" ]; then
    echo "AUTO-SKIP: <5 substantive diff lines and no --spec. Use --force to override."
    rm -rf "$SESSION_DIR"
    exit 0
  fi
fi

# ── Smart focus auto-detection (runs after material is available) ──
if [ -z "$CUSTOM_FOCUS" ] && $HAS_DIFF; then
  FOCUS_CHANGED=false

  # Auto-include claude-md if project has CLAUDE.md and >50% TS/JS files changed
  if [ -n "$REVIEW_CONFIG" ] || [ -f "$PROJECT_ROOT/CLAUDE.md" ] || [ -f "$PROJECT_ROOT/.claude/CLAUDE.md" ]; then
    TOTAL_CHANGED=$(grep -cE '^diff --git a/' "$MATERIAL_FILE" 2>/dev/null || echo 0)
    TS_CHANGED=$(grep -E '^diff --git a/' "$MATERIAL_FILE" 2>/dev/null | grep -cE '\.(ts|tsx|js|jsx)' || echo 0)
    if [ "$TOTAL_CHANGED" -gt 0 ] && [ "$((TS_CHANGED * 100 / TOTAL_CHANGED))" -ge 50 ]; then
      NEW_FOCUS=()
      REPLACED=false
      for fa in "${FOCUS_AREAS[@]}"; do
        if [ "$fa" = "ux-impact" ] && ! $REPLACED; then
          NEW_FOCUS+=("claude-md")
          REPLACED=true
        else
          NEW_FOCUS+=("$fa")
        fi
      done
      if $REPLACED; then
        FOCUS_AREAS=("${NEW_FOCUS[@]}")
        FOCUS_CHANGED=true
        echo "Smart focus: replaced ux-impact with claude-md (>50% TS/JS + CLAUDE.md present)"
      fi
    fi
  fi

  # Auto-include silent-failure if diff contains try/catch/.catch patterns
  CATCH_COUNT=$(grep -cE '(try\s*\{|\.catch\(|catch\s*\()' "$MATERIAL_FILE" 2>/dev/null || echo 0)
  if [ "$CATCH_COUNT" -ge 3 ]; then
    NEW_FOCUS=()
    REPLACED=false
    for fa in "${FOCUS_AREAS[@]}"; do
      if [ "$fa" = "completeness" ] && ! $REPLACED; then
        NEW_FOCUS+=("silent-failure")
        REPLACED=true
      else
        NEW_FOCUS+=("$fa")
      fi
    done
    if $REPLACED; then
      FOCUS_AREAS=("${NEW_FOCUS[@]}")
      FOCUS_CHANGED=true
      echo "Smart focus: replaced completeness with silent-failure ($CATCH_COUNT try/catch patterns)"
    fi
  fi

  if $FOCUS_CHANGED; then
    NUM_FOCUS=${#FOCUS_AREAS[@]}
    TOTAL_WORKERS=$((PASSES_PER_FOCUS * NUM_FOCUS))
    echo "Updated focus areas ($NUM_FOCUS): ${FOCUS_AREAS[*]} ($TOTAL_WORKERS workers)"
  fi
fi

# ── Context pre-pass (Phase 3: context engineering) ──────────
# Entire pre-pass is best-effort — failures here should never abort the review
if $HAS_DIFF && ! $NO_CONTEXT; then
  echo "Gathering context for changed files..."

  # Extract changed file paths from material
  CHANGED_FILES=$(grep -E '^diff --git a/' "$MATERIAL_FILE" 2>/dev/null | sed 's|diff --git a/||;s| b/.*||' | sort -u)
  CHANGED_COUNT=$(echo "$CHANGED_FILES" | grep -c . 2>/dev/null || echo 0)

  if [ "$CHANGED_COUNT" -gt 0 ]; then (
    # Run in subshell so set -e doesn't abort the main script on pre-pass failures
    # 1. Static analysis — tsc errors for changed files (best-effort, non-fatal)
    echo "  Running static analysis..."
    SA_FILE="$SESSION_DIR/static-analysis.txt"
    if command -v npx &>/dev/null && [ -f "$PROJECT_ROOT/tsconfig.json" ]; then
      cd "$PROJECT_ROOT"
      TSC_OUT=$(timeout 30 npx tsc --noEmit 2>&1 || true)
      # Filter to only errors in changed files
      while IFS= read -r cfile; do
        echo "$TSC_OUT" | grep -F "$cfile" >> "$SA_FILE" 2>/dev/null || true
      done <<< "$CHANGED_FILES"
      if [ -s "$SA_FILE" ]; then
        SA_LINES=$(wc -l < "$SA_FILE" | tr -d ' ')
        echo "    TypeScript: $SA_LINES error lines"
      else
        echo "# No TypeScript errors in changed files" > "$SA_FILE"
        echo "    TypeScript: clean"
      fi
    else
      echo "# No tsconfig.json found — static analysis skipped" > "$SA_FILE"
      echo "    (no tsconfig.json, skipped)"
    fi

    # 2. Dependency graph — imports and callers
    echo "  Building dependency graph..."
    DEP_FILE="$SESSION_DIR/dep-graph.json"
    "$CLAUDE_OPS/bin/dr-context" dep-graph "$PROJECT_ROOT" "$CHANGED_FILES" "$DEP_FILE"

    # 3. Test coverage — check for test file siblings
    echo "  Checking test coverage..."
    TEST_FILE="$SESSION_DIR/test-coverage.json"
    "$CLAUDE_OPS/bin/dr-context" test-coverage "$PROJECT_ROOT" "$CHANGED_FILES" "$TEST_FILE"

    # 4. Blame context — classify lines as new vs pre-existing
    echo "  Building blame context..."
    BLAME_FILE="$SESSION_DIR/blame-context.json"
    "$CLAUDE_OPS/bin/dr-context" blame-context "$PROJECT_ROOT" "$MATERIAL_FILE" "$BLAME_FILE"

    echo "  Context gathering complete."
  ) || echo "  WARN: Context pre-pass had errors (non-fatal, continuing)"
  fi
fi

# ── Split material + generate randomized orderings ───────────
echo "Generating $TOTAL_WORKERS randomized orderings..."

"$CLAUDE_OPS/bin/dr-context" shuffle "$MATERIAL_FILE" "$SESSION_DIR" "$TOTAL_WORKERS"

# ── Build focus assignment table ─────────────────────────────
FOCUS_LIST_CSV=$(IFS=','; echo "${FOCUS_AREAS[*]}")

# ── Generate seed prompts from templates ─────────────────────
echo "Generating seed prompts..."

for i in $(seq 1 "$TOTAL_WORKERS"); do
  FOCUS_IDX=$(( (i - 1) / PASSES_PER_FOCUS ))
  PASS_IN_FOCUS=$(( (i - 1) % PASSES_PER_FOCUS + 1 ))
  FOCUS="${FOCUS_AREAS[$FOCUS_IDX]}"

  # Resolve attack vectors for this specialization
  AV="$(get_attack_vectors "$FOCUS")"

  sed \
    -e "s|{{PASS_NUMBER}}|$i|g" \
    -e "s|{{PASS_IN_FOCUS}}|$PASS_IN_FOCUS|g" \
    -e "s|{{PASSES_PER_FOCUS}}|$PASSES_PER_FOCUS|g" \
    -e "s|{{NUM_PASSES}}|$TOTAL_WORKERS|g" \
    -e "s|{{MATERIAL_FILE}}|$SESSION_DIR/material-pass-$i.txt|g" \
    -e "s|{{OUTPUT_FILE}}|$SESSION_DIR/findings-pass-$i.json|g" \
    -e "s|{{DONE_FILE}}|$SESSION_DIR/pass-$i.done|g" \
    -e "s|{{PROJECT_ROOT}}|$PROJECT_ROOT|g" \
    -e "s|{{SESSION_DIR}}|$SESSION_DIR|g" \
    -e "s|{{SPECIALIZATION}}|$FOCUS|g" \
    -e "s|{{SPEC}}|$REVIEW_SPEC|g" \
    "$TEMPLATE_DIR/worker-seed.md" > "$SESSION_DIR/worker-$i-seed.md"

  # Attack vectors + REVIEW_CONFIG may contain special chars — use python for safe substitution
  _REVIEW_CONFIG="$REVIEW_CONFIG" python3 -c "
import sys, os
with open(sys.argv[1]) as f: content = f.read()
content = content.replace('{{ATTACK_VECTORS}}', sys.argv[2])
content = content.replace('{{REVIEW_CONFIG}}', os.environ.get('_REVIEW_CONFIG', ''))
with open(sys.argv[1], 'w') as f: f.write(content)
" "$SESSION_DIR/worker-$i-seed.md" "$AV"
done

# Use python for all coordinator substitutions (safe against special chars, newlines)
_REVIEW_CONFIG="$REVIEW_CONFIG" python3 -c "
import sys, os
with open(sys.argv[1]) as f: content = f.read()
replacements = {
    '{{SESSION_DIR}}': sys.argv[2],
    '{{SESSION_ID}}': sys.argv[3],
    '{{PROJECT_ROOT}}': sys.argv[4],
    '{{NUM_PASSES}}': sys.argv[5],
    '{{PASSES_PER_FOCUS}}': sys.argv[6],
    '{{NUM_FOCUS}}': sys.argv[7],
    '{{FOCUS_LIST}}': sys.argv[8],
    '{{REPORT_FILE}}': sys.argv[9],
    '{{HISTORY_FILE}}': sys.argv[10],
    '{{NOTIFY_TARGET}}': sys.argv[11],
    '{{REVIEW_SESSION}}': sys.argv[12],
    '{{DIFF_DESC}}': sys.argv[13],
    '{{MATERIAL_TYPES}}': sys.argv[14],
    '{{REVIEW_CONFIG}}': os.environ.get('_REVIEW_CONFIG', ''),
}
for k, v in replacements.items():
    content = content.replace(k, v)
with open(sys.argv[15], 'w') as f: f.write(content)
" "$TEMPLATE_DIR/coordinator-seed.md" \
  "$SESSION_DIR" "$SESSION_ID" "$PROJECT_ROOT" \
  "$TOTAL_WORKERS" "$PASSES_PER_FOCUS" "$NUM_FOCUS" \
  "$FOCUS_LIST_CSV" "$SESSION_DIR/report.md" "$HISTORY_FILE" \
  "$NOTIFY_TARGET" "$REVIEW_SESSION" "$DIFF_DESC" \
  "$MATERIAL_TYPES_STR" "$SESSION_DIR/coordinator-seed.md"

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

# ── Generate judge template + wrapper (Phase 4) ──────────────
if ! $NO_JUDGE && [ -f "$TEMPLATE_DIR/judge-seed.md" ]; then
  sed \
    -e "s|{{SESSION_DIR}}|$SESSION_DIR|g" \
    -e "s|{{PROJECT_ROOT}}|$PROJECT_ROOT|g" \
    -e "s|{{NUM_PASSES}}|$TOTAL_WORKERS|g" \
    "$TEMPLATE_DIR/judge-seed.md" > "$SESSION_DIR/judge-seed.md"

  # Safe-substitute REVIEW_CONFIG into judge
  _REVIEW_CONFIG="$REVIEW_CONFIG" python3 -c "
import sys, os
with open(sys.argv[1]) as f: content = f.read()
content = content.replace('{{REVIEW_CONFIG}}', os.environ.get('_REVIEW_CONFIG', ''))
with open(sys.argv[1], 'w') as f: f.write(content)
" "$SESSION_DIR/judge-seed.md"

  cat > "$SESSION_DIR/run-judge.sh" << JEOF
#!/usr/bin/env bash
cd "$PROJECT_ROOT"
exec claude --model $WORKER_MODEL --dangerously-skip-permissions "\$(cat '$SESSION_DIR/judge-seed.md')"
JEOF
  chmod +x "$SESSION_DIR/run-judge.sh"
fi

# ── Create dedicated tmux session ────────────────────────────
NUM_WORKER_WINDOWS=$(( (TOTAL_WORKERS + 3) / 4 ))
echo "Creating tmux session: $REVIEW_SESSION (1 coordinator + $NUM_WORKER_WINDOWS worker windows)..."

tmux new-session -d -s "$REVIEW_SESSION" -n "coordinator" -c "$PROJECT_ROOT"

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
echo "  Material:    $MATERIAL_TYPES_STR"
echo "  Reviewing:   $DIFF_DESC ($DIFF_LINES lines)"
if [ -n "$REVIEW_SPEC" ] && [ "$REVIEW_SPEC" != "Review this material thoroughly for issues, gaps, and improvements." ]; then
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
echo "  Voting: graduated (confidence + votes)"
if ! $NO_JUDGE && [ -f "$SESSION_DIR/run-judge.sh" ]; then
echo "  Judge: enabled (adversarial validation)"
else
echo "  Judge: disabled"
fi
if [ -f "$SESSION_DIR/dep-graph.json" ]; then
echo "  Context: pre-gathered (static analysis, deps, tests)"
fi
echo "  Report: $SESSION_DIR/report.md"
if $VERIFY; then
echo "  Verify: enabled (verifier spawns after coordinator)"
fi
echo "════════════════════════════════════════════════════════════"

# ── Verification phase (spawns after coordinator completes) ───
if $VERIFY; then
  VERIFIER_ROLES_ARG=""
  [ -n "$VERIFY_ROLES" ] && VERIFIER_ROLES_ARG="Test as these user roles: $VERIFY_ROLES"

  cat > "$SESSION_DIR/verifier-seed.md" << VEOF
# Deep Review Verifier

You are the verification worker for a deep review session. Your job: walk through the verification checklist and confirm every enumerated path works correctly.

## Session

- Session dir: $SESSION_DIR
- Project root: $PROJECT_ROOT
- Report: $SESSION_DIR/report.md
- Checklist: $SESSION_DIR/verification-checklist.md

## Setup

1. Wait for the coordinator to finish: poll for \`$SESSION_DIR/review.done\` every 15 seconds.
2. Once it exists, read \`$SESSION_DIR/verification-checklist.md\`.
3. Deploy to a test slot:
   \`\`\`bash
   cd $PROJECT_ROOT
   bash .claude/scripts/worker/deploy-to-slot.sh --service static
   \`\`\`
4. Note the slot URL from the deploy output.

## Verification Protocol

For each checklist item, use the appropriate method:

### Chrome MCP (UI paths)
- Open the slot URL in Chrome MCP
- Login as each relevant user role
- Walk through each UI path, verify expected behavior
- Check browser console for errors (zero errors acceptable, warnings OK)
- Test both desktop and mobile viewports

### curl (API endpoints)
- Get auth tokens: \`bash .claude/scripts/autologin.sh staff --env test\`
- Execute each curl command against the test slot
- Verify response status codes and body structure

### Script (write & run)
- Write verification scripts to \`.claude/scripts/verify/\` directory
- Run them and capture output
- Scripts should test specific scenarios that are hard to verify manually

### Tests (unit/integration)
- Write test cases in \`src/tests/unit/\` or \`src/tests/isolated/\`
- Run with \`bun test <file>\` and verify they pass
- Focus on boundary conditions and error paths

### Code Review (read-only)
- Read the source files, trace callers
- Verify contracts are preserved
- Note any concerns

### Query (database)
- Run queries against the test database
- Verify data shape and content

$VERIFIER_ROLES_ARG

## Output

Write results to \`$SESSION_DIR/verification-results.md\`:

\`\`\`markdown
# Verification Results

**Session**: $(basename "$SESSION_DIR")
**Date**: <date>
**Slot**: <slot URL>

## Summary
- **Total paths**: <N>
- **Passed**: <N>
- **Failed**: <N>
- **Skipped**: <N> (with reason)

## Results by Method

### Chrome MCP
- [x] P1: <description> — PASS
- [ ] P2: <description> — FAIL: <what went wrong>

### curl
- [x] P10: <description> — PASS (200, response matched)
- [ ] P11: <description> — FAIL: got 500, expected 400

### Scripts Written
- \`verify-auth-roles.sh\`: Tests all auth role combinations — PASS
- \`verify-data-isolation.sh\`: Tests cross-project data leak — PASS

### Tests Written
- \`src/tests/unit/new-feature.test.ts\`: 5 tests — ALL PASS

### Code Review
- [x] P40: <description> — confirmed correct

### Query
- [x] P50: <description> — results match expected shape

## Failed Items (Detail)

### P2: <description>
**Expected**: ...
**Actual**: ...
**Evidence**: screenshot/console output/response body
**Suggested fix**: ...
\`\`\`

After writing results, create the completion marker:
\`\`\`bash
echo "done" > $SESSION_DIR/verify.done
\`\`\`

Then send a desktop notification:
\`\`\`bash
notify "Verification complete: <N> passed, <N> failed. Results: $SESSION_DIR/verification-results.md" "Deep Review Verify" "file://$SESSION_DIR/verification-results.md"
\`\`\`

## Rules

- **Test everything on the checklist** — don't skip items without a documented reason.
- **Write scripts and tests** — don't just eyeball things. Automate what you can.
- **Be specific in failure reports** — include exact error messages, response bodies, screenshots.
- **Zero console errors** — any console error is a failure.
- **Test data isolation** — verify users only see their own project's data.
- When finished, say "VERIFICATION COMPLETE" and stop.
VEOF

  cat > "$SESSION_DIR/run-verifier.sh" << RVEOF
#!/usr/bin/env bash
cd "$PROJECT_ROOT"

# Wait for coordinator to finish
echo "Verifier waiting for coordinator to complete..."
while [ ! -f "$SESSION_DIR/review.done" ]; do
  sleep 15
  echo "  ... still waiting ($(date +%H:%M:%S))"
done
echo "Coordinator done. Starting verification."

exec claude --model $WORKER_MODEL --dangerously-skip-permissions "\$(cat '$SESSION_DIR/verifier-seed.md')"
RVEOF
  chmod +x "$SESSION_DIR/run-verifier.sh"

  # Create verifier window in the review tmux session
  tmux new-window -d -t "$REVIEW_SESSION" -n "verifier" -c "$PROJECT_ROOT"
  sleep 0.5
  VERIFIER_PANE=$(tmux list-panes -t "$REVIEW_SESSION:verifier" -F '#{pane_id}' | head -1)
  echo "Launching verifier (will start after coordinator completes)..."
  tmux send-keys -t "$VERIFIER_PANE" "bash '$SESSION_DIR/run-verifier.sh'" Enter
fi
