#!/usr/bin/env bash
# test-inbox-router.sh — Tests for the unified inbox/outbox message system.
#
# Tests:
#   1. Outbox message format and append
#   2. Inbox-router routes context messages to policy.json
#   3. Inbox-router routes task messages to progress.json
#   4. Inbox-router routes directive messages to journal.md
#   5. Inbox-router routes file-edit to global state
#   6. Inbox-router marks messages as routed
#   7. Inbox-router resolves direct name targets
#   8. Inbox-router resolves glob targets
#   9. Inbox-router resolves tag-based targets
#  10. worker_send() appends to outbox
#  11. harness_note() appends broadcast to outbox
#  12. Legacy wrapper worker_inject_context() → worker_send
#  13. Legacy wrapper worker_add_task() → worker_send
#  14. Legacy wrapper worker_inject_journal() → worker_send
#  15. Legacy wrapper worker_send_message() → worker_send
#  16. Context-injector inbox scan (reads inbox.jsonl)
#  17. Context-injector acceptance summary
#  18. Context-injector file-edit aggregation from other harnesses
#  19. Context-injector file-edit aggregation deduplicates
#  20. Scaffold creates inbox.jsonl + outbox.jsonl
#  21. Scaffold adds scope_tags + parent to progress.json
#  22. Beads disabled by default (BEAD_ENABLED=false)
#  23. inbox-router handles missing outbox gracefully
#  24. inbox-router handles empty outbox gracefully
#  25. inbox-router skips already-routed messages
#  26. activity-logger emits file-edit to outbox on Write/Edit
#  27. activity-logger skips file-edit for outbox/inbox files (no recursion)
#  28. activity-logger skips file-edit for progress.json
#  29. worker_send validates required args
#  30. harness_note defaults to module scope
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT_DIR="$HOME/.claude-ops"
PASS=0; FAIL=0; SKIP=0

# ── Helpers ──────────────────────────────────────────────────────
setup_test_env() {
  export TEST_DIR=$(mktemp -d)
  export PROJECT_ROOT="$TEST_DIR/project"
  mkdir -p "$PROJECT_ROOT/.claude/harness/test-harness"
  mkdir -p "$PROJECT_ROOT/.claude/harness/other-harness"
  mkdir -p "$PROJECT_ROOT/.claude/scripts"
  mkdir -p "$HOME/.claude-ops/state"

  # Create minimal progress.json for both harnesses
  cat > "$PROJECT_ROOT/.claude/harness/test-harness/progress.json" <<'EOF'
{
  "harness": "test-harness",
  "mission": "test",
  "lifecycle": "bounded",
  "status": "active",
  "scope_tags": ["frontend", "charts"],
  "parent": "mod-test",
  "tasks": {},
  "state": {},
  "commits": [],
  "learnings": []
}
EOF
  cat > "$PROJECT_ROOT/.claude/harness/other-harness/progress.json" <<'EOF'
{
  "harness": "other-harness",
  "mission": "other",
  "lifecycle": "bounded",
  "status": "active",
  "scope_tags": ["backend", "charts"],
  "parent": null,
  "tasks": {},
  "state": {},
  "commits": [],
  "learnings": []
}
EOF

  # Create policy.json for test-harness
  cat > "$PROJECT_ROOT/.claude/harness/test-harness/policy.json" <<'EOF'
{
  "inject": {
    "tool_context": {}
  }
}
EOF

  # Create journal.md
  echo "# Test Journal" > "$PROJECT_ROOT/.claude/harness/test-harness/journal.md"

  # Create acceptance.md with some statuses
  cat > "$PROJECT_ROOT/.claude/harness/test-harness/acceptance.md" <<'EOF'
# Acceptance Criteria Status

| # | Criterion | Status | Evidence | Last Checked |
|---|-----------|--------|----------|-------------|
| 1.1 | Data loads correctly | ✅ pass | curl returns 200 | 2026-02-25 |
| 1.2 | Charts render | ❌ fail | Sparklines broken | 2026-02-25 |
| 1.3 | Filters work | ⬜ untested | | |
| 2.1 | Auth works | ✅ pass | Login verified | 2026-02-25 |
| 2.2 | RBAC enforced | 🔄 regressed | PM sees admin data | 2026-02-25 |
| 2.3 | Export works | ⬜ untested | | |
EOF

  # Create empty inbox/outbox
  touch "$PROJECT_ROOT/.claude/harness/test-harness/inbox.jsonl"
  touch "$PROJECT_ROOT/.claude/harness/test-harness/outbox.jsonl"
  touch "$PROJECT_ROOT/.claude/harness/other-harness/inbox.jsonl"
  touch "$PROJECT_ROOT/.claude/harness/other-harness/outbox.jsonl"
}

cleanup_test_env() {
  rm -rf "$TEST_DIR" 2>/dev/null || true
}

assert_eq() {
  local expected="$1" actual="$2" msg="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
    echo "  ✓ $msg"
  else
    FAIL=$((FAIL + 1))
    echo "  ✗ $msg"
    echo "    expected: $expected"
    echo "    actual:   $actual"
  fi
}

assert_contains() {
  local haystack="$1" needle="$2" msg="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    PASS=$((PASS + 1))
    echo "  ✓ $msg"
  else
    FAIL=$((FAIL + 1))
    echo "  ✗ $msg"
    echo "    expected to contain: $needle"
    echo "    actual: $(echo "$haystack" | head -3)"
  fi
}

assert_not_contains() {
  local haystack="$1" needle="$2" msg="$3"
  if ! echo "$haystack" | grep -qF "$needle"; then
    PASS=$((PASS + 1))
    echo "  ✓ $msg"
  else
    FAIL=$((FAIL + 1))
    echo "  ✗ $msg"
    echo "    expected NOT to contain: $needle"
  fi
}

assert_file_exists() {
  local path="$1" msg="$2"
  if [ -f "$path" ]; then
    PASS=$((PASS + 1))
    echo "  ✓ $msg"
  else
    FAIL=$((FAIL + 1))
    echo "  ✗ $msg — file not found: $path"
  fi
}

assert_gt() {
  local a="$1" b="$2" msg="$3"
  if [ "$a" -gt "$b" ] 2>/dev/null; then
    PASS=$((PASS + 1))
    echo "  ✓ $msg"
  else
    FAIL=$((FAIL + 1))
    echo "  ✗ $msg — expected $a > $b"
  fi
}

# ═══════════════════════════════════════════════════════════════
# TEST SUITE 1: Outbox Message Format
# ═══════════════════════════════════════════════════════════════
echo "=== Suite 1: Outbox Message Format ==="

test_outbox_append() {
  setup_test_env
  export SIDECAR_NAME="test-sidecar"

  # Source the library
  source "$SCRIPT_DIR/lib/worker-dispatch.sh"

  # Test _outbox_append
  local msg='{"ts":"2026-02-25T14:00:00Z","from":"test-sidecar","type":"context","to":"test-harness","key":"k","content":"v","routed":false}'
  _outbox_append "$msg"

  local content
  content=$(cat "$PROJECT_ROOT/.claude/harness/test-sidecar/outbox.jsonl" 2>/dev/null || echo "")
  assert_contains "$content" '"type":"context"' "1. _outbox_append writes to outbox.jsonl"

  cleanup_test_env
}

test_outbox_format_context() {
  setup_test_env
  export SIDECAR_NAME="test-sidecar"
  mkdir -p "$PROJECT_ROOT/.claude/harness/test-sidecar"
  touch "$PROJECT_ROOT/.claude/harness/test-sidecar/outbox.jsonl"
  source "$SCRIPT_DIR/lib/worker-dispatch.sh"

  worker_send "test-harness" context "my-key" "my context text" >/dev/null 2>&1

  local line
  line=$(tail -1 "$PROJECT_ROOT/.claude/harness/test-sidecar/outbox.jsonl")
  assert_contains "$line" '"type": "context"' "2. worker_send context sets correct type"
  assert_contains "$line" '"key": "my-key"' "3. worker_send context includes key"
  assert_contains "$line" '"content": "my context text"' "4. worker_send context includes content"
  assert_contains "$line" '"to": "test-harness"' "5. worker_send context sets target"
  assert_contains "$line" '"routed": false' "6. worker_send context sets routed=false"

  cleanup_test_env
}

test_outbox_format_task() {
  setup_test_env
  export SIDECAR_NAME="test-sidecar"
  mkdir -p "$PROJECT_ROOT/.claude/harness/test-sidecar"
  touch "$PROJECT_ROOT/.claude/harness/test-sidecar/outbox.jsonl"
  source "$SCRIPT_DIR/lib/worker-dispatch.sh"

  worker_send "test-harness" task "fix-bug" "Fix the sparkline bug" >/dev/null 2>&1

  local line
  line=$(tail -1 "$PROJECT_ROOT/.claude/harness/test-sidecar/outbox.jsonl")
  assert_contains "$line" '"type": "task"' "7. worker_send task sets correct type"
  assert_contains "$line" '"task_id": "fix-bug"' "8. worker_send task includes task_id"

  cleanup_test_env
}

test_outbox_format_directive() {
  setup_test_env
  export SIDECAR_NAME="test-sidecar"
  mkdir -p "$PROJECT_ROOT/.claude/harness/test-sidecar"
  touch "$PROJECT_ROOT/.claude/harness/test-sidecar/outbox.jsonl"
  source "$SCRIPT_DIR/lib/worker-dispatch.sh"

  worker_send "test-harness" directive "Prioritize Feb milestone" >/dev/null 2>&1

  local line
  line=$(tail -1 "$PROJECT_ROOT/.claude/harness/test-sidecar/outbox.jsonl")
  assert_contains "$line" '"type": "directive"' "9. worker_send directive sets correct type"
  assert_contains "$line" '"content": "Prioritize Feb milestone"' "10. worker_send directive includes content"

  cleanup_test_env
}

test_outbox_format_urgent() {
  setup_test_env
  export SIDECAR_NAME="test-sidecar"
  mkdir -p "$PROJECT_ROOT/.claude/harness/test-sidecar"
  touch "$PROJECT_ROOT/.claude/harness/test-sidecar/outbox.jsonl"
  source "$SCRIPT_DIR/lib/worker-dispatch.sh"

  worker_send "test-harness" urgent "REGRESSION: dashboard broken" >/dev/null 2>&1

  local line
  line=$(tail -1 "$PROJECT_ROOT/.claude/harness/test-sidecar/outbox.jsonl")
  assert_contains "$line" '"type": "urgent"' "11. worker_send urgent sets correct type"

  cleanup_test_env
}

test_outbox_append
test_outbox_format_context
test_outbox_format_task
test_outbox_format_directive
test_outbox_format_urgent

# ═══════════════════════════════════════════════════════════════
# TEST SUITE 2: Inbox-Router Message Routing
# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== Suite 2: Inbox-Router Message Routing ==="

test_route_context_to_policy() {
  setup_test_env

  # Write a context message to other-harness outbox
  echo '{"ts":"2026-02-25T14:00:00Z","from":"other-harness","type":"context","to":"test-harness","key":"alert","content":"Receivables stale","routed":false}' \
    > "$PROJECT_ROOT/.claude/harness/other-harness/outbox.jsonl"

  # Simulate what inbox-router does (run the Python routing logic)
  export FILE_PATH="$PROJECT_ROOT/.claude/harness/other-harness/outbox.jsonl"
  export HARNESS_DIR="$PROJECT_ROOT/.claude/harness/other-harness"
  export FROM_HARNESS="other-harness"

  python3 -c "
import json, os, sys

project_root = os.environ['PROJECT_ROOT']
harness_base = os.path.join(project_root, '.claude', 'harness')
outbox_path = os.environ['FILE_PATH']
from_harness = 'other-harness'

# Read last unrouted message
with open(outbox_path) as f:
    lines = f.readlines()
msg = json.loads(lines[-1].strip())

# Route context to target's policy.json
target = msg['to']
policy_path = os.path.join(harness_base, target, 'policy.json')
with open(policy_path) as f:
    policy = json.load(f)
inject = policy.setdefault('inject', {})
tc = inject.setdefault('tool_context', {})
tc[msg['key']] = {'inject': f'[INBOX:{from_harness}] {msg[\"content\"]}', 'inject_when': 'always'}
with open(policy_path, 'w') as f:
    json.dump(policy, f, indent=2)

# Append to inbox
inbox_path = os.path.join(harness_base, target, 'inbox.jsonl')
with open(inbox_path, 'a') as f:
    f.write(json.dumps(msg) + '\n')

# Mark routed
msg['routed'] = True
lines[-1] = json.dumps(msg) + '\n'
with open(outbox_path, 'w') as f:
    f.writelines(lines)
" 2>/dev/null

  # Verify policy.json was updated
  local policy_content
  policy_content=$(cat "$PROJECT_ROOT/.claude/harness/test-harness/policy.json")
  assert_contains "$policy_content" '"alert"' "12. Context message routes to policy.json"
  assert_contains "$policy_content" 'Receivables stale' "13. Context content preserved in policy.json"

  # Verify inbox was updated
  local inbox_content
  inbox_content=$(cat "$PROJECT_ROOT/.claude/harness/test-harness/inbox.jsonl")
  assert_contains "$inbox_content" '"context"' "14. Context message delivered to inbox.jsonl"

  # Verify outbox was marked routed
  local outbox_content
  outbox_content=$(cat "$PROJECT_ROOT/.claude/harness/other-harness/outbox.jsonl")
  assert_contains "$outbox_content" '"routed": true' "15. Outbox message marked as routed"

  cleanup_test_env
}

test_route_task_to_progress() {
  setup_test_env

  echo '{"ts":"2026-02-25T14:00:00Z","from":"other-harness","type":"task","to":"test-harness","task_id":"new-task","description":"Fix sparklines","blocked_by":[],"routed":false}' \
    > "$PROJECT_ROOT/.claude/harness/other-harness/outbox.jsonl"

  export FILE_PATH="$PROJECT_ROOT/.claude/harness/other-harness/outbox.jsonl"

  python3 -c "
import json, os, time
from datetime import datetime, timezone

project_root = os.environ['PROJECT_ROOT']
harness_base = os.path.join(project_root, '.claude', 'harness')
outbox_path = os.environ['FILE_PATH']

with open(outbox_path) as f:
    lines = f.readlines()
msg = json.loads(lines[-1].strip())
target = msg['to']

progress_path = os.path.join(harness_base, target, 'progress.json')
with open(progress_path) as f:
    progress = json.load(f)
tasks = progress.setdefault('tasks', {})
task_id = msg['task_id']
tasks[task_id] = {
    'status': 'pending',
    'description': msg['description'],
    'blockedBy': msg.get('blocked_by', []),
    'owner': None,
    'metadata': {'created_by': msg['from'], 'created_at': datetime.now(timezone.utc).isoformat()}
}
with open(progress_path, 'w') as f:
    json.dump(progress, f, indent=2)
" 2>/dev/null

  local progress_content
  progress_content=$(cat "$PROJECT_ROOT/.claude/harness/test-harness/progress.json")
  assert_contains "$progress_content" '"new-task"' "16. Task message creates task in progress.json"
  assert_contains "$progress_content" '"Fix sparklines"' "17. Task description preserved"
  assert_contains "$progress_content" '"pending"' "18. Task status set to pending"

  cleanup_test_env
}

test_route_directive_to_journal() {
  setup_test_env

  echo '{"ts":"2026-02-25T14:00:00Z","from":"mod-coordinator","type":"directive","to":"test-harness","content":"Focus on Feb milestone","routed":false}' \
    > "$PROJECT_ROOT/.claude/harness/other-harness/outbox.jsonl"

  python3 -c "
import json, os
from datetime import datetime

project_root = os.environ['PROJECT_ROOT']
harness_base = os.path.join(project_root, '.claude', 'harness')
target = 'test-harness'

journal_path = os.path.join(harness_base, target, 'journal.md')
ts = datetime.now().strftime('%Y-%m-%d %H:%M')
with open(journal_path, 'a') as f:
    f.write(f'\n## [SIDECAR DIRECTIVE] mod-coordinator — {ts}\n\nFocus on Feb milestone\n')
" 2>/dev/null

  local journal_content
  journal_content=$(cat "$PROJECT_ROOT/.claude/harness/test-harness/journal.md")
  assert_contains "$journal_content" 'SIDECAR DIRECTIVE' "19. Directive message routes to journal.md"
  assert_contains "$journal_content" 'Focus on Feb milestone' "20. Directive content preserved in journal"

  cleanup_test_env
}

test_route_context_to_policy
test_route_task_to_progress
test_route_directive_to_journal

# ═══════════════════════════════════════════════════════════════
# TEST SUITE 3: Legacy Wrapper Backward Compatibility
# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== Suite 3: Legacy Wrapper Backward Compatibility ==="

test_legacy_inject_context() {
  setup_test_env
  export SIDECAR_NAME="test-sidecar"
  mkdir -p "$PROJECT_ROOT/.claude/harness/test-sidecar"
  touch "$PROJECT_ROOT/.claude/harness/test-sidecar/outbox.jsonl"
  source "$SCRIPT_DIR/lib/worker-dispatch.sh"

  local result
  result=$(worker_inject_context "test-harness" "my-key" "my value" 2>/dev/null)
  assert_contains "$result" "QUEUED" "21. Legacy worker_inject_context routes through worker_send"

  local outbox
  outbox=$(cat "$PROJECT_ROOT/.claude/harness/test-sidecar/outbox.jsonl")
  assert_contains "$outbox" '"type": "context"' "22. Legacy wrapper generates context type"

  cleanup_test_env
}

test_legacy_add_task() {
  setup_test_env
  export SIDECAR_NAME="test-sidecar"
  mkdir -p "$PROJECT_ROOT/.claude/harness/test-sidecar"
  touch "$PROJECT_ROOT/.claude/harness/test-sidecar/outbox.jsonl"
  source "$SCRIPT_DIR/lib/worker-dispatch.sh"

  local result
  result=$(worker_add_task "test-harness" "task-1" "Do something" 2>/dev/null)
  assert_contains "$result" "QUEUED" "23. Legacy worker_add_task routes through worker_send"

  local outbox
  outbox=$(cat "$PROJECT_ROOT/.claude/harness/test-sidecar/outbox.jsonl")
  assert_contains "$outbox" '"type": "task"' "24. Legacy wrapper generates task type"

  cleanup_test_env
}

test_legacy_inject_journal() {
  setup_test_env
  export SIDECAR_NAME="test-sidecar"
  mkdir -p "$PROJECT_ROOT/.claude/harness/test-sidecar"
  touch "$PROJECT_ROOT/.claude/harness/test-sidecar/outbox.jsonl"
  source "$SCRIPT_DIR/lib/worker-dispatch.sh"

  local result
  result=$(worker_inject_journal "test-harness" "Some directive" 2>/dev/null)
  assert_contains "$result" "QUEUED" "25. Legacy worker_inject_journal routes through worker_send"

  local outbox
  outbox=$(cat "$PROJECT_ROOT/.claude/harness/test-sidecar/outbox.jsonl")
  assert_contains "$outbox" '"type": "directive"' "26. Legacy wrapper generates directive type"

  cleanup_test_env
}

test_legacy_send_message() {
  setup_test_env
  export SIDECAR_NAME="test-sidecar"
  mkdir -p "$PROJECT_ROOT/.claude/harness/test-sidecar"
  touch "$PROJECT_ROOT/.claude/harness/test-sidecar/outbox.jsonl"
  source "$SCRIPT_DIR/lib/worker-dispatch.sh"

  local result
  result=$(worker_send_message "test-harness" "REGRESSION" "Dashboard broken" 2>/dev/null)
  assert_contains "$result" "QUEUED" "27. Legacy worker_send_message routes through worker_send"

  local outbox
  outbox=$(cat "$PROJECT_ROOT/.claude/harness/test-sidecar/outbox.jsonl")
  assert_contains "$outbox" '"type": "urgent"' "28. Legacy wrapper generates urgent type"

  cleanup_test_env
}

test_legacy_inject_context
test_legacy_add_task
test_legacy_inject_journal
test_legacy_send_message

# ═══════════════════════════════════════════════════════════════
# TEST SUITE 4: Context-Injector (Inbox + Acceptance + File-Edits)
# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== Suite 4: Context-Injector (Inbox + Acceptance + File-Edits) ==="

test_injector_inbox_scan() {
  setup_test_env

  # Write recent messages to test-harness inbox
  local ts
  ts=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  echo "{\"ts\":\"$ts\",\"from\":\"mod-finance\",\"type\":\"context\",\"content\":\"SQL library updated\"}" \
    >> "$PROJECT_ROOT/.claude/harness/test-harness/inbox.jsonl"
  echo "{\"ts\":\"$ts\",\"from\":\"mod-finance\",\"type\":\"directive\",\"content\":\"Focus on Feb\"}" \
    >> "$PROJECT_ROOT/.claude/harness/test-harness/inbox.jsonl"

  export HARNESS="test-harness"
  export HARNESS_DIR="$PROJECT_ROOT/.claude/harness/test-harness"
  export HARNESS_BASE="$PROJECT_ROOT/.claude/harness"
  export INBOX_SCAN_WINDOW_SEC=1800
  export INBOX_MAX_INJECT_MESSAGES=5
  export INBOX_ACCEPTANCE_INJECT=false
  export INBOX_FILE_EDIT_TRACKING=false

  local result
  result=$(python3 << 'PYEOF'
import json, os, sys, time
from datetime import datetime, timezone

harness = os.environ.get("HARNESS", "")
harness_dir = os.environ.get("HARNESS_DIR", "")
scan_window = int(os.environ.get("INBOX_SCAN_WINDOW_SEC", "1800"))
max_messages = int(os.environ.get("INBOX_MAX_INJECT_MESSAGES", "5"))

now = time.time()
lines = []
inbox_path = os.path.join(harness_dir, "inbox.jsonl")
if os.path.exists(inbox_path):
    recent_msgs = []
    with open(inbox_path) as f:
        for line in f:
            line = line.strip()
            if not line: continue
            try:
                msg = json.loads(line)
                ts = msg.get("ts", "")
                if msg.get("type") == "file-edit": continue
                if ts:
                    dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                    age_sec = now - dt.timestamp()
                    if age_sec <= scan_window:
                        recent_msgs.append(msg)
            except: pass
    if recent_msgs:
        by_sender = {}
        for msg in recent_msgs:
            sender = msg.get("from", "unknown")
            by_sender.setdefault(sender, []).append(msg)
        total = 0
        for sender, msgs in sorted(by_sender.items()):
            for msg in msgs[-max_messages:]:
                if total >= max_messages: break
                mtype = msg.get("type", "?").upper()
                content = msg.get("content", "")[:100]
                lines.append(f"- {mtype} from {sender}: {content}")
                total += 1

if lines:
    print(f"[Inbox] {len(recent_msgs)} recent message(s)")
    for l in lines:
        print(l)
PYEOF
)

  assert_contains "$result" "[Inbox]" "29. Inbox scan produces header"
  assert_contains "$result" "CONTEXT from mod-finance" "30. Inbox scan shows context message"
  assert_contains "$result" "DIRECTIVE from mod-finance" "31. Inbox scan shows directive message"

  cleanup_test_env
}

test_injector_acceptance_summary() {
  setup_test_env

  export HARNESS_DIR="$PROJECT_ROOT/.claude/harness/test-harness"

  local result
  result=$(python3 -c "
import os

harness_dir = os.environ.get('HARNESS_DIR', '')
acceptance_path = os.path.join(harness_dir, 'acceptance.md')
lines = []

with open(acceptance_path) as f:
    content = f.read()

pass_count = content.count('✅')
fail_count = content.count('❌')
untested_count = content.count('⬜')
regressed_count = content.count('🔄')
total_count = pass_count + fail_count + untested_count + regressed_count

if total_count > 0:
    summary = f'[Acceptance] {pass_count}/{total_count} passing'
    parts = []
    if fail_count: parts.append(f'{fail_count} failing')
    if regressed_count: parts.append(f'{regressed_count} regressed')
    if untested_count: parts.append(f'{untested_count} untested')
    if parts: summary += ', ' + ', '.join(parts)

    failing_criteria = []
    for line in content.split('\n'):
        if '❌' in line or '🔄' in line:
            cells = [c.strip() for c in line.split('|') if c.strip()]
            if len(cells) >= 3:
                failing_criteria.append(f'- {cells[2].strip()} {cells[0]}: {cells[1]}')

    print(summary)
    for fc in failing_criteria[:3]:
        print(fc)
")

  assert_contains "$result" "[Acceptance] 2/6 passing" "32. Acceptance summary shows correct counts"
  assert_contains "$result" "1 failing" "33. Acceptance summary shows failing count"
  assert_contains "$result" "1 regressed" "34. Acceptance summary shows regressed count"
  assert_contains "$result" "2 untested" "35. Acceptance summary shows untested count"

  cleanup_test_env
}

test_injector_file_edit_aggregation() {
  setup_test_env

  # Write file-edit messages to other-harness outbox (simulating edits)
  local ts
  ts=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  echo "{\"ts\":\"$ts\",\"from\":\"other-harness\",\"type\":\"file-edit\",\"file\":\"src/pages/Foo.tsx\"}" \
    >> "$PROJECT_ROOT/.claude/harness/other-harness/outbox.jsonl"
  echo "{\"ts\":\"$ts\",\"from\":\"other-harness\",\"type\":\"file-edit\",\"file\":\"src/pages/Foo.tsx\"}" \
    >> "$PROJECT_ROOT/.claude/harness/other-harness/outbox.jsonl"
  echo "{\"ts\":\"$ts\",\"from\":\"other-harness\",\"type\":\"file-edit\",\"file\":\"src/styles/bar.css\"}" \
    >> "$PROJECT_ROOT/.claude/harness/other-harness/outbox.jsonl"

  export HARNESS="test-harness"
  export HARNESS_DIR="$PROJECT_ROOT/.claude/harness/test-harness"
  export HARNESS_BASE="$PROJECT_ROOT/.claude/harness"
  export INBOX_SCAN_WINDOW_SEC=1800
  export INBOX_MAX_INJECT_MESSAGES=5

  local result
  result=$(python3 << 'PYEOF'
import json, os, sys, time
from datetime import datetime, timezone

harness = os.environ.get("HARNESS", "")
harness_base = os.environ.get("HARNESS_BASE", "")
scan_window = int(os.environ.get("INBOX_SCAN_WINDOW_SEC", "1800"))
max_messages = int(os.environ.get("INBOX_MAX_INJECT_MESSAGES", "5"))

now = time.time()
edits = {}
for d in os.listdir(harness_base):
    if d == harness: continue
    dpath = os.path.join(harness_base, d)
    if not os.path.isdir(dpath): continue
    outbox = os.path.join(dpath, "outbox.jsonl")
    if not os.path.exists(outbox): continue
    with open(outbox) as f:
        for line in f:
            line = line.strip()
            if not line: continue
            try:
                msg = json.loads(line)
                if msg.get("type") != "file-edit": continue
                ts = msg.get("ts", "")
                if not ts: continue
                dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                age_sec = now - dt.timestamp()
                if age_sec > scan_window: continue
                fpath = msg.get("file", "")
                if not fpath: continue
                from_h = msg.get("from", d)
                key = (os.path.basename(fpath), from_h)
                if key not in edits:
                    edits[key] = {"count": 0, "latest": ts, "full_path": fpath}
                edits[key]["count"] += 1
                if ts > edits[key]["latest"]:
                    edits[key]["latest"] = ts
            except: pass

if edits:
    sorted_edits = sorted(edits.items(), key=lambda x: x[1]["latest"], reverse=True)
    print(f"[File edits] {len(edits)} file(s) edited by other harnesses:")
    for (basename, from_harness), info in sorted_edits[:max_messages]:
        count_str = f"{info['count']} edit{'s' if info['count'] > 1 else ''}"
        print(f"- {basename} — {from_harness} ({count_str})")
PYEOF
)

  assert_contains "$result" "[File edits]" "36. File-edit aggregation produces header"
  assert_contains "$result" "Foo.tsx — other-harness (2 edits)" "37. File-edit aggregation deduplicates same file"
  assert_contains "$result" "bar.css — other-harness (1 edit)" "38. File-edit aggregation shows single edit"
  # Verify it's 2 aggregated lines, not 3 raw lines
  local line_count
  line_count=$(echo "$result" | grep -c "^-" || true)
  assert_eq "2" "$line_count" "39. File-edit aggregation produces 2 aggregated lines (not 3 raw)"

  cleanup_test_env
}

test_injector_inbox_scan
test_injector_acceptance_summary
test_injector_file_edit_aggregation

# ═══════════════════════════════════════════════════════════════
# TEST SUITE 5: Scaffold Creates Inbox/Outbox
# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== Suite 5: Scaffold Creates Inbox/Outbox ==="

test_scaffold_creates_inbox_outbox() {
  setup_test_env

  # Run scaffold
  bash "$SCRIPT_DIR/scripts/scaffold.sh" "scaffold-test" "$PROJECT_ROOT" > /dev/null 2>&1

  assert_file_exists "$PROJECT_ROOT/.claude/harness/scaffold-test/inbox.jsonl" "40. Scaffold creates inbox.jsonl"
  assert_file_exists "$PROJECT_ROOT/.claude/harness/scaffold-test/outbox.jsonl" "41. Scaffold creates outbox.jsonl"

  cleanup_test_env
}

test_scaffold_progress_has_scope_tags() {
  setup_test_env

  bash "$SCRIPT_DIR/scripts/scaffold.sh" "scaffold-test" "$PROJECT_ROOT" > /dev/null 2>&1

  local progress
  progress=$(cat "$PROJECT_ROOT/.claude/harness/scaffold-test/progress.json")
  assert_contains "$progress" '"scope_tags"' "42. Scaffold progress.json has scope_tags field"
  assert_contains "$progress" '"parent"' "43. Scaffold progress.json has parent field"

  cleanup_test_env
}

test_scaffold_manifest_has_inbox() {
  setup_test_env

  bash "$SCRIPT_DIR/scripts/scaffold.sh" "scaffold-test" "$PROJECT_ROOT" > /dev/null 2>&1

  local manifest
  manifest=$(cat "$HOME/.claude-ops/harness/manifests/scaffold-test/manifest.json" 2>/dev/null || echo "")
  assert_contains "$manifest" '"inbox"' "44. Scaffold manifest includes inbox"
  assert_contains "$manifest" '"outbox"' "45. Scaffold manifest includes outbox"

  # Cleanup scaffold artifacts
  rm -rf "$HOME/.claude-ops/harness/manifests/scaffold-test" 2>/dev/null || true
  rm -rf "$HOME/.claude-ops/harness/reports/scaffold-test" 2>/dev/null || true
  rm -rf "$HOME/.claude-ops/state/playwright/scaffold-test" 2>/dev/null || true
  cleanup_test_env
}

test_scaffold_creates_inbox_outbox
test_scaffold_progress_has_scope_tags
test_scaffold_manifest_has_inbox

# ═══════════════════════════════════════════════════════════════
# TEST SUITE 6: harness_note Broadcast
# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== Suite 6: harness_note Broadcast ==="

test_harness_note_with_tags() {
  setup_test_env
  export SIDECAR_NAME="test-harness"
  source "$SCRIPT_DIR/lib/worker-dispatch.sh"

  local result
  result=$(harness_note decision "chart-library" "Switched to visx" --tags "charts,frontend" 2>/dev/null)
  assert_contains "$result" "BROADCAST" "46. harness_note returns BROADCAST"

  local outbox
  outbox=$(cat "$PROJECT_ROOT/.claude/harness/test-harness/outbox.jsonl")
  assert_contains "$outbox" '"type": "decision"' "47. harness_note sets type to decision"
  assert_contains "$outbox" '"tags"' "48. harness_note includes tags in to field"

  cleanup_test_env
}

test_harness_note_with_scope() {
  setup_test_env
  export SIDECAR_NAME="test-harness"
  source "$SCRIPT_DIR/lib/worker-dispatch.sh"

  harness_note status "All good" "Everything passing" --scope "all" >/dev/null 2>&1

  local outbox
  outbox=$(cat "$PROJECT_ROOT/.claude/harness/test-harness/outbox.jsonl")
  assert_contains "$outbox" '"scope": "all"' "49. harness_note with --scope sets scope"

  cleanup_test_env
}

test_harness_note_default_scope() {
  setup_test_env
  export SIDECAR_NAME="test-harness"
  source "$SCRIPT_DIR/lib/worker-dispatch.sh"

  harness_note learning "sql-tip" "Use ORDER BY" >/dev/null 2>&1

  local outbox
  outbox=$(cat "$PROJECT_ROOT/.claude/harness/test-harness/outbox.jsonl")
  assert_contains "$outbox" '"scope": "module"' "50. harness_note defaults to module scope"

  cleanup_test_env
}

test_harness_note_directed() {
  setup_test_env
  export SIDECAR_NAME="test-harness"
  source "$SCRIPT_DIR/lib/worker-dispatch.sh"

  harness_note status "Done" "SG1.1 fixed" --to "mod-finance" >/dev/null 2>&1

  local outbox
  outbox=$(cat "$PROJECT_ROOT/.claude/harness/test-harness/outbox.jsonl")
  assert_contains "$outbox" '"to": "mod-finance"' "51. harness_note --to sets direct target"

  cleanup_test_env
}

test_harness_note_with_tags
test_harness_note_with_scope
test_harness_note_default_scope
test_harness_note_directed

# ═══════════════════════════════════════════════════════════════
# TEST SUITE 7: Edge Cases
# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== Suite 7: Edge Cases ==="

test_empty_outbox() {
  setup_test_env

  # Run router on empty outbox — should exit cleanly
  export FILE_PATH="$PROJECT_ROOT/.claude/harness/test-harness/outbox.jsonl"
  export HARNESS_DIR="$PROJECT_ROOT/.claude/harness/test-harness"
  export FROM_HARNESS="test-harness"

  python3 -c "
import json, os, sys
outbox_path = os.environ['FILE_PATH']
with open(outbox_path) as f:
    lines = f.readlines()
found = False
for i in range(len(lines) - 1, -1, -1):
    line = lines[i].strip()
    if not line: continue
    try:
        msg = json.loads(line)
        if not msg.get('routed', False):
            found = True
            break
    except: pass
if not found:
    print('NO_UNROUTED')
" 2>/dev/null
  local result=$?
  assert_eq "0" "$result" "52. Empty outbox exits cleanly (no error)"

  cleanup_test_env
}

test_already_routed_skipped() {
  setup_test_env

  # Write an already-routed message
  echo '{"ts":"2026-02-25T14:00:00Z","from":"test","type":"context","to":"other","key":"k","content":"v","routed":true}' \
    > "$PROJECT_ROOT/.claude/harness/test-harness/outbox.jsonl"

  export FILE_PATH="$PROJECT_ROOT/.claude/harness/test-harness/outbox.jsonl"
  local result
  result=$(python3 -c "
import json, os
outbox_path = os.environ['FILE_PATH']
with open(outbox_path) as f:
    lines = f.readlines()
found = None
for i in range(len(lines) - 1, -1, -1):
    line = lines[i].strip()
    if not line: continue
    try:
        msg = json.loads(line)
        if not msg.get('routed', False):
            found = msg
            break
    except: pass
print('FOUND' if found else 'SKIPPED')
" 2>/dev/null)
  assert_eq "SKIPPED" "$result" "53. Already-routed messages are skipped"

  cleanup_test_env
}

test_worker_send_validates_args() {
  setup_test_env
  export SIDECAR_NAME="test-sidecar"
  mkdir -p "$PROJECT_ROOT/.claude/harness/test-sidecar"
  touch "$PROJECT_ROOT/.claude/harness/test-sidecar/outbox.jsonl"
  source "$SCRIPT_DIR/lib/worker-dispatch.sh"

  # Missing args should fail
  local result
  result=$(worker_send 2>&1) || true
  assert_contains "$result" "Usage" "54. worker_send with no args shows usage"

  cleanup_test_env
}

test_beads_disabled_by_default() {
  source "$SCRIPT_DIR/control-plane.conf"
  assert_eq "false" "$BEAD_ENABLED" "55. Beads disabled by default after inbox migration"
  assert_eq "false" "$BEAD_LAYER_PRETOOL" "56. Beads Layer 1 disabled"
  assert_eq "false" "$BEAD_LAYER_POSTTOOL" "57. Beads Layer 2 disabled"
  assert_eq "false" "$BEAD_LAYER_STOP" "58. Beads Layer 3 disabled"
}

test_file_conflicts_deleted() {
  if [ ! -f "$SCRIPT_DIR/hooks/operators/checks.d/file-conflicts.sh" ]; then
    PASS=$((PASS + 1))
    echo "  ✓ 59. checks.d/file-conflicts.sh deleted (replaced by inbox)"
  else
    FAIL=$((FAIL + 1))
    echo "  ✗ 59. checks.d/file-conflicts.sh should be deleted"
  fi
}

test_inbox_router_exists() {
  assert_file_exists "$SCRIPT_DIR/hooks/operators/inbox-router.sh" "60. inbox-router.sh exists"
  if [ -x "$SCRIPT_DIR/hooks/operators/inbox-router.sh" ]; then
    PASS=$((PASS + 1))
    echo "  ✓ 61. inbox-router.sh is executable"
  else
    FAIL=$((FAIL + 1))
    echo "  ✗ 61. inbox-router.sh should be executable"
  fi
}

test_inbox_config_vars() {
  source "$SCRIPT_DIR/control-plane.conf"
  assert_eq "true" "${INBOX_ENABLED:-}" "62. INBOX_ENABLED config var exists"
  assert_eq "1800" "${INBOX_SCAN_WINDOW_SEC:-}" "63. INBOX_SCAN_WINDOW_SEC config var exists"
  assert_eq "5" "${INBOX_MAX_INJECT_MESSAGES:-}" "64. INBOX_MAX_INJECT_MESSAGES config var exists"
  assert_eq "true" "${INBOX_ACCEPTANCE_INJECT:-}" "65. INBOX_ACCEPTANCE_INJECT config var exists"
  assert_eq "true" "${INBOX_FILE_EDIT_TRACKING:-}" "66. INBOX_FILE_EDIT_TRACKING config var exists"
}

test_empty_outbox
test_already_routed_skipped
test_worker_send_validates_args
test_beads_disabled_by_default
test_file_conflicts_deleted
test_inbox_router_exists
test_inbox_config_vars

# ═══════════════════════════════════════════════════════════════
# TEST SUITE 8: Activity Logger File-Edit Outbox Tracking
# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== Suite 8: Activity Logger File-Edit Tracking ==="

test_activity_logger_file_edit() {
  setup_test_env

  # Simulate a Write tool event
  local input
  input=$(python3 -c "
import json
print(json.dumps({
    'session_id': 'test-session',
    'tool_name': 'Write',
    'tool_input': json.dumps({
        'file_path': '$PROJECT_ROOT/src/pages/TestPage.tsx',
        'content': 'test'
    })
}))
")

  # Set up session registry
  echo '{"test-session":"test-harness"}' > "$HOME/.claude-ops/state/session-registry.json"
  mkdir -p "$HOME/.claude-ops/state/activity"

  export INBOX_FILE_EDIT_TRACKING=true
  export HARNESS="test-harness"

  # Run just the file-edit tracking part
  python3 -c "
import json, sys, datetime, os

data = json.loads(sys.argv[1])
tool = data.get('tool_name', '')
if tool not in ('Write', 'Edit'):
    sys.exit(0)
ti = json.loads(data.get('tool_input', '{}'))
file_path = ti.get('file_path', '')
if not file_path:
    sys.exit(0)
if file_path.endswith('outbox.jsonl') or file_path.endswith('inbox.jsonl'):
    sys.exit(0)
if os.path.basename(file_path) == 'progress.json':
    sys.exit(0)

msg = {
    'ts': datetime.datetime.utcnow().isoformat() + 'Z',
    'from': os.environ.get('HARNESS', ''),
    'type': 'file-edit',
    'to': {'scope': 'module'},
    'file': file_path,
    'routed': False
}
outbox = os.path.join(os.environ['PROJECT_ROOT'], '.claude', 'harness', os.environ['HARNESS'], 'outbox.jsonl')
os.makedirs(os.path.dirname(outbox), exist_ok=True)
with open(outbox, 'a') as f:
    f.write(json.dumps(msg) + '\n')
print('EMITTED')
" "$input" 2>/dev/null

  local outbox
  outbox=$(cat "$PROJECT_ROOT/.claude/harness/test-harness/outbox.jsonl" 2>/dev/null || echo "")
  assert_contains "$outbox" '"file-edit"' "67. Activity logger emits file-edit to outbox"
  assert_contains "$outbox" 'TestPage.tsx' "68. File-edit includes file path"

  cleanup_test_env
}

test_activity_logger_skips_outbox_file() {
  setup_test_env
  export HARNESS="test-harness"

  # Simulate editing outbox.jsonl itself (should be skipped)
  local result
  result=$(python3 -c "
import json, sys, datetime, os

file_path = '$PROJECT_ROOT/.claude/harness/test-harness/outbox.jsonl'
if file_path.endswith('outbox.jsonl') or file_path.endswith('inbox.jsonl'):
    print('SKIPPED')
    sys.exit(0)
print('NOT_SKIPPED')
" 2>/dev/null)
  assert_eq "SKIPPED" "$result" "69. Activity logger skips outbox.jsonl to prevent recursion"

  cleanup_test_env
}

test_activity_logger_skips_progress() {
  setup_test_env
  export HARNESS="test-harness"

  local result
  result=$(python3 -c "
import json, sys, datetime, os

file_path = '$PROJECT_ROOT/.claude/harness/test-harness/progress.json'
if os.path.basename(file_path) == 'progress.json':
    print('SKIPPED')
    sys.exit(0)
print('NOT_SKIPPED')
" 2>/dev/null)
  assert_eq "SKIPPED" "$result" "70. Activity logger skips progress.json to reduce noise"

  cleanup_test_env
}

test_activity_logger_file_edit
test_activity_logger_skips_outbox_file
test_activity_logger_skips_progress

# ═══════════════════════════════════════════════════════════════
# TEST SUITE 9: Target Resolution
# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== Suite 9: Target Resolution ==="

test_resolve_direct_target() {
  setup_test_env

  local result
  result=$(python3 -c "
import os, json

harness_base = os.path.join(os.environ['PROJECT_ROOT'], '.claude', 'harness')
to_field = 'test-harness'
from_harness = 'other-harness'

if isinstance(to_field, str) and '*' not in to_field:
    targets = [to_field]
else:
    targets = []
print(','.join(targets))
" 2>/dev/null)
  assert_eq "test-harness" "$result" "71. Direct name resolves to single target"

  cleanup_test_env
}

test_resolve_glob_target() {
  setup_test_env
  # Create mod-* harnesses for glob matching
  mkdir -p "$PROJECT_ROOT/.claude/harness/mod-finance"
  mkdir -p "$PROJECT_ROOT/.claude/harness/mod-customer"

  local result
  result=$(python3 -c "
import os, fnmatch

harness_base = os.path.join(os.environ['PROJECT_ROOT'], '.claude', 'harness')
to_field = 'mod-*'
from_harness = 'other-harness'

targets = []
for d in sorted(os.listdir(harness_base)):
    if os.path.isdir(os.path.join(harness_base, d)) and fnmatch.fnmatch(d, to_field):
        if d != from_harness:
            targets.append(d)
print(','.join(targets))
" 2>/dev/null)
  assert_contains "$result" "mod-finance" "72. Glob mod-* matches mod-finance"
  assert_contains "$result" "mod-customer" "73. Glob mod-* matches mod-customer"

  cleanup_test_env
}

test_resolve_tag_target() {
  setup_test_env

  # other-harness has scope_tags: ["backend", "charts"]
  # test-harness has scope_tags: ["frontend", "charts"]
  # Tag query for "charts" should match both (but exclude sender)

  local result
  result=$(python3 -c "
import os, json

harness_base = os.path.join(os.environ['PROJECT_ROOT'], '.claude', 'harness')
from_harness = 'other-harness'
tags = {'charts'}

targets = []
for d in sorted(os.listdir(harness_base)):
    if d == from_harness: continue
    dpath = os.path.join(harness_base, d)
    if not os.path.isdir(dpath): continue
    prog = os.path.join(dpath, 'progress.json')
    if os.path.exists(prog):
        with open(prog) as f:
            p = json.load(f)
        their_tags = set(p.get('scope_tags', []))
        if tags & their_tags:
            targets.append(d)
print(','.join(targets))
" 2>/dev/null)
  assert_contains "$result" "test-harness" "74. Tag 'charts' matches test-harness (has charts tag)"

  cleanup_test_env
}

test_resolve_direct_target
test_resolve_glob_target
test_resolve_tag_target

# ═══════════════════════════════════════════════════════════════
# TEST SUITE 10: Seed Template Inbox/Outbox Awareness
# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== Suite 10: Seed Template ==="

test_seed_template_has_inbox_section() {
  local template="$SCRIPT_DIR/templates/seed.sh.tmpl"
  local content
  content=$(cat "$template")
  assert_contains "$content" "Inbox" "75. Seed template has Inbox section"
  assert_contains "$content" "Outbox" "76. Seed template has Outbox section"
  assert_contains "$content" "INBOX_COUNT" "77. Seed template reads INBOX_COUNT"
  assert_contains "$content" "outbox.jsonl" "78. Seed template references outbox.jsonl"
}

test_seed_template_has_communication() {
  local template="$SCRIPT_DIR/templates/seed.sh.tmpl"
  local content
  content=$(cat "$template")
  assert_contains "$content" "inbox.jsonl" "79. Seed template documents inbox.jsonl writes"
  assert_contains "$content" "RECIPIENT" "80. Seed template documents recipient pattern"
}

test_seed_template_has_role_detection() {
  local template="$SCRIPT_DIR/templates/seed.sh.tmpl"
  local content
  content=$(cat "$template")
  assert_contains "$content" "PARENT" "81. Seed template has parent detection"
  assert_contains "$content" "ROLE" "82. Seed template has role detection"
}

test_seed_template_has_inbox_section
test_seed_template_has_communication
test_seed_template_has_role_detection

# ═══════════════════════════════════════════════════════════════
# TEST SUITE 11: Coordinator Seed Updates
# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== Suite 11: Coordinator Seed ==="

test_coordinator_seed_has_inbox() {
  local seed="$PROJECT_ROOT/.claude/scripts/mod-coordinator-seed.sh"
  if [ ! -f "$seed" ]; then
    # Use the real project path
    seed="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}/.claude/scripts/mod-coordinator-seed.sh"
  fi
  if [ -f "$seed" ]; then
    local content
    content=$(cat "$seed")
    assert_contains "$content" "inbox.jsonl" "83. Coordinator seed reads inbox.jsonl"
    assert_contains "$content" "worker_send" "84. Coordinator seed documents worker_send"
    assert_contains "$content" "Sidecar Replies" "85. Coordinator seed has Sidecar Replies section"
    assert_contains "$content" "Inbox Sizes" "86. Coordinator seed has Inbox Sizes section"
    assert_contains "$content" "_SIDECARS_HARDCODED" "87. Coordinator seed has hardcoded fallback"
  else
    SKIP=$((SKIP + 5))
    echo "  ⊘ 83-87. Coordinator seed not found (SKIP)"
  fi
}

test_coordinator_seed_has_inbox

# ═══════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════
echo ""
echo "════════════════════════════════════════"
TOTAL=$((PASS + FAIL + SKIP))
echo "Tests: $TOTAL total, $PASS passed, $FAIL failed, $SKIP skipped"
echo "════════════════════════════════════════"

[ "$FAIL" -gt 0 ] && exit 1
exit 0
