# Failure Modes & Antipatterns

Observed from production harness runs and prompt/tool log analysis.

## Known Antipatterns

| Antipattern | Symptom | Fix |
|---|---|---|
| **Empty learnings** | Agent completes 8 features but `learnings: []` is empty | Make "append 1+ learning" an explicit step in the feature cycle, not just a suggestion |
| **Step mismatch** | Test/optimization tasks forced into backend->tool->richcard->css cycle | Allow per-feature `steps` override in the progress file. Use archetype-appropriate cycles. |
| **Unverified visual** | `chrome_verified: false` on "completed" features | Stop hook gate: if feature is `completed` but `chrome_verified: false`, block with "verify visually" |
| **Progress file bloat** | 500+ line JSON after 20 features with verbose notes | Prune completed features to summary-only on each `/clear` (seed script extracts essentials, continue script can compact) |
| **Session count stuck at 0** | Agent never needed `/clear` despite 8 features | Not necessarily bad — features may be well-scoped. But verify the continue script works before going autonomous. |
| **Harness not self-tested** | Broken hook at 3am, 6 hours of compute wasted | Always run the self-test sequence in `scripts.md` before going autonomous |
| **Flat feature list for 20+ items** | Agent has no sense of priority tiers, works on polish before core | Use `phase` grouping. Phase 1 must complete before Phase 2 starts. |
| **Description only in harness.md** | After `/clear`, agent re-reads a 200-line file to find feature context | Put a `description` per feature in the progress JSON. Seed script includes it directly. |

---

## Production Insights (from prompt/tool log analysis)

These emerged from analyzing ~16K prompts across harness sessions:

### Rollback Tracking Gap

**Signal:** ~16K rollback-related signals in tool logs, but progress files don't track reverts.

When a feature gets marked `completed` but later breaks (dependency conflict, merge issue, API change), the agent rolls it back—but the progress file still says `completed`. Next session picks it up as done.

**Fix:** Add a `rollbacks` array to the progress schema:
```json
{
  "rollbacks": [
    {"feature": "billing", "reason": "API changed after deploy", "reverted_at": "2026-02-22T03:00:00Z"}
  ]
}
```
Seed script should flag rolled-back features. Stop hook should warn if a "completed" feature was recently reverted.

### Context Pressure Detection

**Signal:** Only ~10 manual `/clear` resets across all sessions, despite heavy context accumulation.

Agents rarely self-initiate `/clear` even when context is heavy. They keep working with degraded performance (slower responses, missed patterns, repeated mistakes) instead of resetting.

**Fix:** Stop hook should monitor for context pressure signals:
- Compaction messages in the transcript
- 2+ features completed since last `/clear`
- Session age > 2 hours
- Rising error rate in recent tool calls

When detected, inject: "Context is heavy. Run `bash .claude/scripts/{name}-continue.sh` to reset."

### Feature Health Verification

**Signal:** ~212 "still not working" messages appearing after features marked `completed`.

Features get marked done based on the agent's self-report, not verified evidence. The `test_evidence` field exists but isn't gated on.

**Fix:** Gate completion on `test_evidence`:
- Stop hook: if marking a feature `completed` but `test_evidence` is empty, block with "Add test evidence before marking complete"
- Require at least one concrete verification (curl output, build success, test pass) not just "it works"
- Consider a `verification_method` enum: `curl`, `build`, `test`, `visual`, `manual`

### Stop Hook = Autonomy Mechanism

**Insight:** The stop hook is not "a hook" — it is THE mechanism that makes autonomous operation possible.

Without the stop hook, Claude stops after every feature to ask "should I continue?" With it, Claude is contractually obligated to keep working. Every other piece (progress file, seed script, CLAUDE.md) is supporting infrastructure. The stop hook is the engine.

**Implications:**
- Test the stop hook more thoroughly than anything else
- The stop hook should be the first thing built, not the last
- Stop hook failures should be treated as P0 (they halt all autonomous work)
- Consider a "stop hook health check" in the self-test sequence

### Planner/Executor Pattern

**Insight:** All successful harnesses implicitly follow a planner/executor split, but it's never made explicit.

The harness (CLAUDE.md + progress.json + harness.md) is the **plan**. The agent executing features is the **executor**. The stop hook is the **scheduler**. The seed script is the **state restore**.

Making this explicit helps design new harnesses:
1. **Plan** — What are we building? (mission, features, architecture rules)
2. **Execute** — How does each unit of work proceed? (step cycle, commit pattern)
3. **Schedule** — What happens between units? (stop hook: next feature, idle exploration)
4. **Restore** — How do we recover state? (seed script: progress + learnings + context)

---

## Diagnostic Quick Reference

| Symptom | Likely Cause | Check |
|---|---|---|
| Agent stops despite infinite hook | Escape hatch file exists | `ls /tmp/claude_allow_stop_*` |
| Agent repeats completed work | Progress file not read at session start | Check seed script outputs progress |
| Features marked done but broken | No test evidence gate | Add `test_evidence` requirement to stop hook |
| Agent never /clears | No context pressure detection | Add compaction/age check to stop hook |
| Progress file conflicts between sessions | Two harnesses writing same file | Check dispatch routing is correct |

---

## Team/Swarm Failure Modes

| Failure | Symptom | Fix |
|---------|---------|-----|
| **Worker divergence** | Worker goes off-task, works on unrelated code | Lead monitors via TaskList; sends correction via SendMessage. Add guardrails to worker prompt. |
| **Team state desync** | progress.json and TaskList disagree on task status | Lead is source of truth. Re-sync: read progress.json, recreate TaskCreate entries for pending tasks. |
| **Worker crash** | Task tool agent dies mid-task | Lead detects via idle timeout or TaskList showing stuck task. Respawn worker for same task. |
| **Rotation during swarm** | Session rotates while workers active | Must TeamDelete before rotation. Workers receive shutdown_request, lead waits for responses, syncs progress, then rotates. |
| **File conflicts** | Two workers edit same file | Use `isolation: "worktree"` for workers on potentially overlapping files. Or use beads claims for file locks. |
| **Stale worker assignment** | Worker assigned to task that was already completed | Lead checks progress.json before assigning. TaskCreate includes latest status. |
| **Team creation fails** | TeamCreate unavailable or errors | Fallback to solo mode. Log warning, proceed sequentially. Harness still works. |

## Monitor Agent Failure Modes

| Failure | Symptom | Fix |
|---------|---------|-----|
| **Poll daemon outlives target** | Target agent completes, but poll daemon keeps sending `[POLL]` messages every N seconds forever | The daemon loop must check if the target harness is `status=done` and self-terminate. Or: monitor agent should `kill` the daemon PID when it detects completion. Find daemon: `pgrep -af 'sleep 45'` then trace parent. |
| **Session namer infinite cycle** | Stop hook fires on every response demanding session name. Writing the file satisfies it once, but it fires again next response. Monitor gets trapped in write→respond→write loop. | Bug in session_namer.sh — it doesn't check if the file already exists. Fix: add `[ -f /tmp/claude_session_name_$SESSION_ID ] && exit 0` guard at top. |
| **Monitor can't self-terminate** | Monitor agent wants to stop but poll daemon keeps injecting prompts, and stop hook keeps blocking | Monitor must kill its own daemon: find PID via `pgrep -af 'sleep.*INTERVAL'`, kill it, then create escape hatch `touch /tmp/claude_allow_stop_$SESSION_ID` |
| **Monitor burns tokens on idle target** | Target at shell prompt, all work done, but monitor keeps polling and responding "." for hours | Daemon should count consecutive "unchanged" captures. After N consecutive identical captures (e.g., 10), self-terminate with a final message. |

---

## Continuous-Loop Failure Modes

| Failure | Symptom | Fix |
|---------|---------|-----|
| **Metrics not recorded** | Round completes but `state.metrics_history` is empty | Make measurement an explicit task step with validation, not optional |
| **evolve-harness never resets** | Harness "completes" instead of looping | evolve-harness task must set its own status back to `pending` and add new tasks |
| **Compaction drops learnings** | After context compaction, agent starts from scratch | Add PreCompact hook that reminds agent to save learnings to progress.json before compaction |
| **Monitor creates duplicate panes** | `monitor-agent.sh` splits new panes instead of reusing layout | Use `--pane` flag: `monitor-agent.sh --pane h:bi-opt.1 h:bi-opt.0 120 "mission"` |
| **tmux steals focus** | `tmux new-window` switches user to new window | Always use `-d` flag: `tmux new-window -d`, `tmux split-window -d` |
| **No before/after delta** | Agent improves things but can't quantify improvement | Baseline task must run identical queries before and after, stored in `state.metrics_history` |
