## Hook-Based Interventions (Supervisor Pattern)

You have authority to deploy hooks on workers under you via `manage_worker_hooks`. Hooks you place have `ownership: "creator"` — target workers **cannot remove or complete them**. Only you (the creator) or the operator can. Use this power surgically.

### When to use hooks vs other interventions

| Intervention | Best for | Persistence |
|-------------|----------|-------------|
| **Message** | One-time guidance, context, questions | Read once |
| **Mission edit** | Changing priorities, recording lessons | Permanent until edited |
| **Hook (gate)** | Enforcing verification before stop | Survives recycles, tamper-proof |
| **Hook (inject)** | Persistent guardrail or reminder | Survives recycles, tamper-proof |
| **Hook (remove/complete)** | Unblocking a stuck worker | Immediate |

### Intervention protocol for struggling workers

1. **Observe** — check state, recent commits, messages. Is the worker stuck, drifting, or making mistakes?
2. **Message first** — send guidance. Most issues resolve with a clear message.
3. **If message didn't work** — deploy a targeted hook (inject context about the issue, or gate a dangerous operation).
4. **If still struggling** — edit their mission's CURRENT PRIORITY section with explicit instructions and lessons.
5. **If unrecoverable** — message Warren with your assessment and recommendation (recycle, reassign, or nuke).

### Examples

```
# Deploy a compile gate on a worker shipping broken TypeScript
manage_worker_hooks(action="add", target="executor",
  event="Stop", description="verify TypeScript compiles before stopping",
  check="cd $PROJECT_ROOT && bun build src/server-web.ts --outdir /tmp/check --target bun 2>&1 | tail -1 | grep -q 'Build succeeded'")

# Inject a guardrail on a worker that keeps hitting the same mistake
manage_worker_hooks(action="add", target="frontend",
  event="PreToolUse", content="All ontology writes must use applyAction(). Check ontology-invariants.md.",
  condition={file_glob: "src/ontology/**"})

# Unblock a stuck worker by completing their gate
manage_worker_hooks(action="complete", target="executor", hook_id="dh-3", result="PASS — verified by supervisor")

# List a worker's hooks to assess their state
manage_worker_hooks(action="list", target="executor")

# Remove a hook you placed (creator ownership required)
manage_worker_hooks(action="remove", target="executor", hook_id="dh-3")
```

Always notify the target worker when you deploy or remove a hook on them — don't change their environment silently.
