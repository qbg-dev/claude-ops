# Program API — Comprehensive Reference

A program is a declarative multi-agent pipeline. Each `.program.ts` file exports a default function returning a `Program`. The engine compiles it into fleet workers, tmux sessions, hooks, seeds, and Fleet Mail accounts.

## Mental Model: Two Modes

### Pipeline Mode (ephemeral workers)

One-shot phases transition via Stop hooks → bridge. Workers are ephemeral (`sleepDuration: null`)—watchdog ignores them. Good for: code review, eval loops, one-time analysis.

```
Phase 0 (planning) → Stop hook → bridge → Phase 1 (workers) → Stop hook → bridge → Phase 2 (verification) → done
```

### Lab Mode (perpetual workers)

Perpetual workers driven by watchdog respawn. The PI calls `round_stop()` → checkpoint → watchdog respawns → PI reads checkpoint, spawns students, iterates. Good for: research labs, monitoring, continuous optimization.

```
PI spawns → works → round_stop() → [sleep 1200s] → watchdog respawn → read checkpoint → works → round_stop() → ...
```

Both modes use the same program API. The difference is `sleepDuration` on the worker spec.

---

## Program Structure

```typescript
import type { Program } from "../engine/program/types";

export default function myProgram(opts: MyOpts): Program {
  return {
    name: "my-program",
    description: "What this pipeline does",
    phases: [ /* Phase[] */ ],    // or use graph: for graph-native
    graph: /* ProgramGraph */,    // optional, takes precedence
    defaults: { model: "sonnet", effort: "high", permission: "bypassPermissions" },
    material: { scope: opts.scope, spec: opts.spec },
  };
}
```

### Graph-Native Programs (recommended)

```typescript
import { graph } from "../engine/program/graph";

const g = graph("my-program", "description")
  .node("step-a", { agents: [...] })
  .node("step-b", { agents: [...] })
  .edge("step-a", "step-b")
  .edge("step-b", "$end")
  .defaults({ model: "sonnet" })
  .build();

return { name: g.name, phases: [], graph: g, defaults: g.defaults };
```

### Legacy Phase[] Programs

Programs using `Phase[]` work unchanged. The compiler auto-converts via `phasesToGraph()`. Programs can migrate to graph-native at their own pace.

---

## The 18 Lifecycle Events

Every Claude Code agent emits these events. Hooks can intercept any of them.

| Event | When it fires | Data available | Common hook actions |
|-------|--------------|----------------|---------------------|
| `SessionStart` | Agent begins | Session info | Register dynamic hooks, inject context |
| `SessionEnd` | Agent exits | Final state | Cleanup, send completion message |
| `UserPromptSubmit` | Before processing prompt | Prompt text | Modify/validate prompt |
| `PreToolUse` | Before any tool call | Tool name, params | Block tools, inject warnings |
| `PostToolUse` | After successful tool call | Tool name, result | Log, validate output |
| `PostToolUseFailure` | After failed tool call | Tool name, error | Custom error handling |
| `PermissionRequest` | Tool needs permission | Tool, reason | Auto-approve/deny |
| `Notification` | Agent notification | Message | Forward to Fleet Mail |
| `Stop` | Agent stops normally | Exit info | Phase transitions (bridge) |
| `SubagentStart` | Subagent spawned | Subagent info | Inject subagent context |
| `SubagentStop` | Subagent completed | Result | Collect subagent output |
| `TeammateIdle` | Teammate waiting | Teammate info | Assign work |
| `TaskCompleted` | Task finished | Task result | Trigger next steps |
| `InstructionsLoaded` | CLAUDE.md loaded | Instructions | Modify loaded instructions |
| `ConfigChange` | Config updated | Old/new config | Validate config |
| `PreCompact` | Before context compaction | Context size | Re-inject critical state |
| `WorktreeCreate` | Git worktree created | Worktree path | Setup worktree hooks |
| `WorktreeRemove` | Git worktree removed | Worktree path | Cleanup |

---

## Hook Action Types (5 types)

```typescript
interface PipelineHook {
  event: HookEvent;
  type: "command" | "prompt" | "agent" | "launch" | "message";
  command?: string;       // for type:"command"
  prompt?: string;        // for type:"prompt"/"agent"
  matcher?: string;       // regex for tool names (PreToolUse/PostToolUse)
  blocking?: boolean;     // gate vs inject (default: true for Stop)
  check?: string;         // bash condition: exit 0=pass, non-zero=block
  description?: string;

  // For type:"launch"
  workers?: AgentSpec[] | string;  // inline specs or node name ref

  // For type:"message"
  to?: string;
  subject?: string;
  body?: string;
}
```

### command
Shell script. Exit 0 = allow, exit 1 = block. Stdout = context injection.
```typescript
{ event: "PreToolUse", type: "command", matcher: "Edit|Write",
  command: "echo 'BLOCKED: read-only agent' >&2; exit 1", blocking: true }
```

### prompt
Inject text into agent context (non-blocking).
```typescript
{ event: "PreCompact", type: "prompt",
  prompt: "CRITICAL STATE: Current hypotheses: {{HYPOTHESES}}" }
```

### agent
Like `prompt` but for subagent context injection.

### launch
Launch workers on this event. Generates bridge call or `fleet create` script.
```typescript
{ event: "Stop", type: "launch", workers: "research-students" }
// Or inline: workers: [{ name: "worker-1", role: "analyst", seed: { inline: "..." } }]
```

### message
Send Fleet Mail via curl against the Fleet Mail API.
```typescript
{ event: "Stop", type: "message",
  to: "ht-kung", subject: "Results ready", body: "Analysis complete. Check notebook." }
```

---

## Worker Lifecycle — Pipeline vs Perpetual

### Pipeline Workers (`sleepDuration: null | undefined`)

- `ephemeral: true` in fleet config
- Watchdog skips them entirely
- Bridge manages transitions via Stop hooks
- Cleaned up after pipeline completes (cleanup.sh)
- Lifecycle: launch → work → Stop → bridge transitions → done

### Perpetual Workers (`sleepDuration: 1200`)

- `ephemeral: false` in fleet config
- Watchdog manages lifecycle
- `round_stop()` checkpoints state, then worker exits
- Watchdog detects exit → waits `sleep_duration` seconds → respawns
- Worker reads handoff.md + checkpoint on restart
- Lifecycle: launch → work → `round_stop()` → [sleep] → watchdog respawn → read checkpoint → work → ...

```typescript
agents: [{
  name: "ht-kung",
  role: "professor",
  model: "opus",
  sleepDuration: 1200,  // 20-minute cycles, watchdog-managed
  seed: { template: "research-lab/professor-seed.md" },
}]
```

### Watchdog Respawn Flow

1. Liveness check every 30s
2. Detects bare shell (agent died or called `round_stop()`)
3. If `sleep_duration > 0` and enough time elapsed → respawn
4. Graceful shutdown (90s grace period)
5. Kill agent → relaunch in same pane
6. Re-inject seed → spawn hooks fire
7. Worker reads last checkpoint from `~/.claude/fleet/{project}/{worker}/checkpoints/`

### Crash Recovery

Watchdog detects bare shell (agent died without `round_stop()`) → immediate restart. Worker reads last `save_checkpoint()` data. Crash-loop protection: max 3 restarts per hour.

### Memory-Leak Recycling

Even perpetual workers get force-restarted after `maxCycleSec` (default 24h) to prevent memory leaks in long-running Claude Code sessions.

---

## What the Compiler Does (No Surprises)

The compiler walks the program declaration and produces:

1. **Stop hooks** → bash scripts in `~/.claude/fleet/{project}/{worker}/hooks/`
   - Each gate agent's Stop triggers the next node's bridge
   - Graph edges with conditions become if/elif chains in the script
   - Back-edges respect `maxIterations`

2. **Infrastructure hooks** → 45 from `hooks/manifest.json` (always active)
   - Safety gates, context injection, event publishing
   - Installed by `setup-hooks.sh`

3. **Bridge process** → background bun process
   - Entry: `bun bridge.ts <session-dir> --node <node-name>` (graph-native)
   - Or: `bun bridge.ts <session-dir> <phase-index>` (legacy compat)
   - Re-imports program file, provisions fleet dirs, resolves dynamic agents

4. **State variables** → available in seeds via `{{VAR}}`
   - `SESSION_DIR`, `PROJECT_ROOT`, `WORK_DIR`, `TEMPLATE_DIR`
   - `MATERIAL_FILE`, `MATERIAL_TYPE`, `DIFF_DESC`, `MATERIAL_TYPES`
   - `REVIEW_SPEC`, `REVIEW_CONFIG`, `COORDINATOR_NAME`
   - `NUM_PASSES`, `NUM_FOCUS`, `PASSES_PER_FOCUS`, `FOCUS_LIST`, `ROLE_NAMES`
   - Plus any key from `agent.vars`

5. **Fleet Mail accounts** → auto-provisioned at `{worker}@{project}`
   - Token stored in `~/.claude/fleet/{project}/{worker}/token`
   - `FLEET_MAIL_URL` and `FLEET_MAIL_TOKEN` exported in launch wrapper

6. **Ephemeral flag** → `true` by default
   - Set to `false` when `sleepDuration` is a positive number
   - Watchdog only manages workers with `ephemeral: false`

7. **Parse-output naming** → `parse_{agent_name}_output` (dashes→underscores)
   - Convention-based: bridge looks for exported function matching the agent name
   - Override via `parser` field on `BridgeAction`

8. **Seed resolution** → `state.templateDir` > `FLEET_DIR/templates`
   - Handlebars compilation with `noEscape: true` (markdown, not HTML)
   - `helperMissing` preserves `{{UNRESOLVED}}` for bridge-time resolution
   - Partials from `templates/fragments/*.md` (e.g. `{{> fleet-tools}}`)

---

## Agents

### Static Agents

```typescript
agents: [{
  name: "worker-1",
  role: "reviewer",
  model: "sonnet",              // optional, inherits from defaults
  seed: { template: "deep-review/worker-seed.md" },
  window: "workers-1",          // tmux window name
  vars: { PASS_NUMBER: "1" },   // template variables
  hooks: [ /* per-agent hooks */ ],
  sleepDuration: null,           // null/undefined = ephemeral (default)
}]
```

### Dynamic Agents

```typescript
agents: {
  generator: "generateWorkers",  // exported function name
  estimate: 8,                   // window pre-allocation hint
  fallback: [ /* AgentSpec[] */ ],
}
```

Generator signature: `(state: ProgramPipelineState, defaults: ProgramDefaults) => AgentSpec[]`

### Seeds

| Form | Example | When |
|------|---------|------|
| `template` | `{ template: "deep-review/worker-seed.md" }` | Reusable templates |
| `inline` | `{ inline: "You are a reviewer..." }` | One-off prompts |
| `generator` | `{ generator: "buildSeed" }` | Complex prompt logic (bridge-time) |

Templates use Handlebars:
- `{{VAR}}` substitution
- `{{> partial}}` includes from `templates/fragments/*.md`
- `{{#if VAR}}...{{/if}}`, `{{#each items}}...{{/each}}`
- Unresolved `{{VAR}}` preserved literally (resolved at bridge time)

---

## State System

### ProgramPipelineState

Persisted as `pipeline-state.json` in the session directory.

| Field | Type | Description |
|-------|------|-------------|
| `programPath` | string | Path to program file |
| `opts` | Record | Original options passed to program function |
| `sessionDir` | string | Session working directory |
| `projectRoot` | string | Git repository root |
| `workDir` | string | Working directory (may be worktree) |
| `fleetProject` | string | Fleet project name |
| `defaults` | ProgramDefaults | Model, effort, permission |
| `phaseState` | Record | Per-node key-value store |
| `cycleCount` | Record | Iteration counter per cyclic phase |
| `ext` | Record | Program-specific state (replaces hardcoded fields) |
| `compiledPhases` | CompiledPhase[] | Updated as deferred phases compile |
| `nodeIndexMap` | Record | Node name → stable index (graph programs) |
| `material` | object | Collected diff/content info |

### ext — Program-specific state

Programs should use `state.ext` for domain-specific data instead of polluting the core type:

```typescript
// Writing
if (!state.ext) state.ext = {};
state.ext.roleResult = { useDynamicRoles: true, focusAreas: [...] };
state.ext.hypotheses = ["H1: ...", "H2: ..."];

// Reading (in buildStateVars or generators)
const roleResult = (state.ext?.roleResult as RoleResult) || state.roleResult;  // ext first, legacy fallback
```

### phaseState — Per-node key-value store

```typescript
state.phaseState["review"] = { workerNames: [...], compiled: true };
state.phaseState["planning"] = { roleDesignComplete: true };
```

---

## Prelaunch Actions

Run during bridge, before agents in the next phase launch:

```typescript
prelaunch: [
  { type: "parse-output", agent: "auditor", file: "result.json" },
  { type: "parse-output", agent: "custom-agent", file: "out.json", parser: "myCustomParser" },
  { type: "context-prepass" },
  { type: "shuffle-material" },
  { type: "custom", handler: "myPrep" },
]
```

For `parse-output`: the engine looks for an exported function matching `parse_{agent_name}_output` (dashes→underscores). Override with the `parser` field. If no parser found, reads the file as JSON into `state.phaseState`.

---

## Graph Features

### Conditional Edges

```typescript
.edge("evaluate", "generate", {
  condition: `test $(cat score.txt) -lt 80`,
  maxIterations: 5,
  label: "score below threshold",
  priority: 0,
})
.edge("evaluate", "$end", { label: "converged", priority: 1 })
```

Edges evaluated in priority order (lower first). First condition exiting 0 wins. `maxIterations` prevents infinite cycles.

### Composition via embed()

```typescript
const full = graph("meta-pipeline")
  .embed(subGraphA, { prefix: "a" })
  .embed(subGraphB, { prefix: "b" })
  .edge("a.output", "b.input")
  .entry("a.start")
  .build();
```

`embed()` flattens sub-graph nodes with prefixed names. Internal edges preserved. No auto-wiring—all cross-subgraph connections must be explicit.

---

## Patterns

### Linear Pipeline
```
A → B → C → done
```
Standard Phase[] or graph with sequential edges.

### Fan-out / Fan-in
```
A → [B, C, D] → E
```
Node A has one agent. Node B has multiple agents with `gate: "all"`. All must stop before E launches.

### Cycle with Convergence
```
generate → evaluate → [score < 80? → generate] or [$end]
```
Graph back-edge with `maxIterations` + conditional forward edge.

### Guard Rails (per-agent hooks)
```typescript
agent.hooks = [
  { event: "PreToolUse", type: "command", matcher: "Edit|Write|Bash",
    command: "echo 'BLOCKED' >&2; exit 1", blocking: true }
]
```
Read-only agents, tool restrictions, permission differentiation per agent.

### Watchdog-Driven Lab (perpetual PI + one-shot students)
```
PI (perpetual, sleepDuration: 1200)
  → spawns students dynamically via create_worker()
  → students message back via Fleet Mail
  → PI reads results on next cycle (watchdog respawn)
  → iterates until research questions answered
```

The graph has a single entry node (the PI). Students are created at runtime, not declared in the graph. Communication is via Fleet Mail, not phase transitions.

### Message Passing
```typescript
// Via message hooks
{ event: "Stop", type: "message", to: "ht-kung", subject: "Results", body: "Done" }

// Or via MCP tools at runtime
mail_send(to: "ht-kung", subject: "Results", body: "Analysis complete")
```

### Dynamic Worker Creation
Students spawn assistants via `create_worker()` MCP tool at runtime. Not declared in the program graph.

---

## CLI Reference

```bash
fleet pipeline <name> [opts]

# Common options
--scope <scope>       Git diff scope (HEAD, branch, SHA range)
--spec <text>         Description of what to analyze
--dry-run             Print manifest without launching
--session-name <n>    Custom tmux session name
--notify <target>     Notify on completion
--model <model>       Default model (sonnet, opus, haiku)

# Deep-review specific
--passes <n>          Passes per focus area
--verify              Enable verification phase
--no-judge            Skip judge
--max-workers <n>     Worker budget cap
```

### Session Directory

```
/tmp/fleet-pipeline-{hash}/
├── pipeline-state.json     # Persisted state
├── manifest.md             # Human-readable pipeline overview
├── hooks/                  # Generated hook scripts
│   └── {agent}/
│       └── phase-N-stop.sh
├── {agent}-seed.md         # Generated seeds
├── run-{agent}.sh          # Launch wrappers
├── bridge-N.log            # Bridge transition logs
└── cleanup.sh              # Ephemeral worker cleanup
```

---

## Examples

| Program | Pattern | Description |
|---------|---------|-------------|
| `deep-review` | Dynamic + linear | Role designer → workers (dynamic count) → verification |
| `eval-loop` | Graph: cyclic | Generate → evaluate → cycle back (conditional + $end) |
| `full-release` | Graph: composed | embed(eval-loop) → embed(pre-release), cross-subgraph |
| `guard-rails` | Per-agent hooks | Read-only reader, guarded writer, full-access coordinator |
| `research-lab` | Watchdog-driven | Perpetual PI + dynamic students + Fleet Mail + recursive delegation |
| `dx-feedback` | Single-phase | Pre-push DX quality check — diff vs REVIEW.md + README conventions |
