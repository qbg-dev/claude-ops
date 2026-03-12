# Pipeline Programs

A program is a declarative multi-phase agent pipeline. Each program file exports a default function that returns a `Program` object. The pipeline engine compiles it into fleet workers, tmux sessions, hooks, and seeds.

## File Convention

```
programs/{name}.program.ts    # Program declaration
```

The default export must be a function: `(opts) => Program`.

## Program Structure

```typescript
import type { Program } from "../engine/program/types";

export default function myProgram(opts: MyOpts): Program {
  return {
    name: "my-program",
    description: "What this pipeline does",
    phases: [ /* Phase[] */ ],
    defaults: { model: "sonnet", effort: "high", permission: "bypassPermissions" },
    material: { scope: opts.scope, spec: opts.spec },
  };
}
```

## Phases

Each phase has agents that run in parallel. Phases execute sequentially, gated by Stop hooks.

```typescript
{
  name: "review",
  description: "Parallel review workers",
  agents: [ /* AgentSpec[] or DynamicAgents */ ],
  gate: "coordinator",       // which agent's Stop triggers next phase
                              // "all" = wait for all agents, default = last agent
  layout: { panesPerWindow: 4, algorithm: "tiled" },
  prelaunch: [ /* BridgeAction[] — run before agents launch */ ],
  hooks: [ /* PipelineHook[] — installed on ALL agents in this phase */ ],
  next: 0,                   // override default i+1 transition (enables cycles)
  convergence: {             // stop condition for cyclic phases
    check: "test $(cat score.txt) -ge 80",  // exit 0 = converged
    maxIterations: 5,
  },
}
```

### Static Agents

```typescript
agents: [{
  name: "worker-1",
  role: "reviewer",
  model: "sonnet",         // optional, inherits from defaults
  seed: { template: "deep-review/worker-seed.md" },  // or { inline: "..." }
  window: "workers-1",     // tmux window name
  vars: { PASS_NUMBER: "1", SPECIALIZATION: "security" },
  hooks: [ /* PipelineHook[] — per-agent hooks */ ],
}]
```

### Dynamic Agents

```typescript
agents: {
  generator: "generateWorkers",  // exported function name in this file
  estimate: 8,                   // window pre-allocation hint
  fallback: [ /* AgentSpec[] */ ],
}
```

The generator function signature: `(state: ProgramPipelineState, defaults: ProgramDefaults) => AgentSpec[]`

## Graph-Native Programs

Programs can use the graph API instead of `Phase[]` for more flexible topologies (conditional edges, cycles, composition).

```typescript
import type { Program } from "../engine/program/types";
import { graph } from "../engine/program/graph";

export default function myProgram(opts: MyOpts): Program {
  const g = graph("my-program", "description")
    .node("step-a", { agents: [...] })
    .node("step-b", { agents: [...] })
    .edge("step-a", "step-b")
    .edge("step-b", "$end")  // $end = pipeline complete
    .defaults({ model: "sonnet" })
    .build();

  return { name: g.name, phases: [], graph: g, defaults: g.defaults };
}
```

### Conditional Edges

```typescript
.edge("evaluate", "generate", {
  condition: `test $(cat score.txt) -lt 80`,  // bash: exit 0 = take edge
  maxIterations: 5,                           // cycle safety valve
  label: "score below threshold",
})
.edge("evaluate", "$end", { label: "converged", priority: 1 })
```

Edges from a node are evaluated in priority order (lower = first). First condition that exits 0 wins. `maxIterations` prevents infinite back-edge cycles.

### Composition via embed()

```typescript
const full = graph("meta-pipeline")
  .embed(subGraphA, { prefix: "a" })   // nodes become a.nodeX
  .embed(subGraphB, { prefix: "b" })
  .edge("a.output", "b.input")         // explicit cross-subgraph wiring
  .entry("a.start")
  .build();
```

`embed()` flattens a sub-graph's nodes with prefixed names and preserves internal edges. No auto-wiring — all cross-subgraph connections must be explicit.

### Legacy Compatibility

Programs using `Phase[]` work unchanged. The compiler auto-converts via `phasesToGraph()` when needed. Programs can migrate to graph-native at their own pace.

## Seeds

Three forms:

| Form | Example | When |
|------|---------|------|
| `template` | `{ template: "deep-review/worker-seed.md" }` | Reusable templates in `~/.claude-fleet/templates/` |
| `inline` | `{ inline: "You are a reviewer..." }` | One-off prompts |
| `generator` | `{ generator: "buildSeed" }` | Complex prompt logic |

Templates use Handlebars (`noEscape: true` for markdown). Features:
- `{{VAR}}` substitution from `agent.vars` and state variables
- `{{> partial}}` includes from `templates/fragments/*.md` (e.g. `{{> fleet-tools}}`, `{{> severity-guide}}`)
- `{{#if VAR}}...{{/if}}`, `{{#each items}}...{{/each}}` for conditionals/loops
- Unresolved `{{VAR}}` preserved literally (resolved later at bridge time)

Standard variables: `{{SESSION_DIR}}`, `{{WORK_DIR}}`, `{{PROJECT_ROOT}}`, `{{MATERIAL_FILE}}`, `{{SCOPE}}`, `{{SPEC}}`, plus any key from `agent.vars`.

## Hook Types

### Phase-Level Hooks

Installed on ALL agents in the phase:

```typescript
phase.hooks = [{
  event: "Stop",
  type: "command",
  description: "Verify TypeScript compiles",
  check: "bun build src/server.ts --outdir /tmp/check --target bun",
  blocking: true,
}]
```

### Per-Agent Hooks

Installed on a specific agent only:

```typescript
agent.hooks = [{
  event: "PreToolUse",
  type: "command",
  description: "Block write operations (read-only agent)",
  matcher: "Edit|Write|Bash",        // regex matching tool names
  command: "echo 'BLOCKED' >&2; exit 1",
  blocking: true,
}]
```

### Hook Fields

| Field | Type | Description |
|-------|------|-------------|
| `event` | HookEvent | Claude Code event (18 types: Stop, PreToolUse, PostToolUse, etc.) |
| `type` | "command" \| "prompt" \| "agent" | What the hook does |
| `command` | string | Shell script to run (for type:"command") |
| `prompt` | string | Text to inject (for type:"prompt"/"agent") |
| `matcher` | string | Regex for tool names (PreToolUse/PostToolUse only) |
| `blocking` | boolean | Gate (true) vs inject (false). Default: true for Stop |
| `check` | string | Bash condition: exit 0=pass, non-zero=block |
| `description` | string | Human-readable label |

### Available Events

`SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `Notification`, `Stop`, `SubagentStart`, `SubagentStop`, `TeammateIdle`, `TaskCompleted`, `InstructionsLoaded`, `ConfigChange`, `PreCompact`, `WorktreeCreate`, `WorktreeRemove`

## Phase Transitions

### Linear (default)

Phase 0 → Phase 1 → Phase 2 → done. Each gate agent's Stop hook launches the next phase's bridge.

### Branching

```typescript
{ name: "check", next: 3 }  // skip Phase 2, jump to Phase 3
```

### Cyclic (with convergence)

```typescript
{
  name: "evaluate",
  next: 0,                          // cycle back to Phase 0
  convergence: {
    check: "test $(cat score.txt) -ge 80",  // exit 0 = stop cycling
    maxIterations: 5,               // safety valve
  },
}
```

The Stop hook checks convergence: if converged or max iterations reached, proceed to `next+1`; otherwise cycle back to `next`.

## Prelaunch Actions

Run during bridge, before agents in the next phase launch:

```typescript
prelaunch: [
  { type: "parse-output", agent: "auditor", file: "result.json" },
  { type: "context-prepass" },          // static analysis (deep-review specific)
  { type: "shuffle-material" },         // randomize material ordering
  { type: "custom", handler: "myPrep" }, // call exported function
]
```

For `parse-output`: the engine looks for `parse_{agent_name}_output` function in the program file (dashes→underscores). If not found, it reads the file as JSON into `state.phaseState`.

## State Variables

Available in seeds and at runtime via `ProgramPipelineState`:

| Variable | Description |
|----------|-------------|
| `sessionDir` | Session working directory |
| `projectRoot` | Git repository root |
| `workDir` | Working directory (may be worktree) |
| `material` | Collected diff/content info |
| `phaseState` | Per-phase key-value store |
| `cycleCount` | Iterations per cyclic phase |
| `defaults` | Model, effort, permission defaults |

## CLI Usage

```bash
fleet pipeline <name> [opts]

# Common options
--scope <scope>       Git diff scope (HEAD, branch, SHA range)
--spec <text>         Description of what to analyze
--dry-run             Print manifest without launching
--session-name <n>    Custom tmux session name
--notify <target>     Notify on completion

# Deep-review specific
--passes <n>          Passes per focus area
--verify              Enable verification phase
--no-judge            Skip judge
--max-workers <n>     Worker budget cap
```

`--dry-run` produces the manifest (phase layout, hook chain, windows) without creating tmux sessions or fleet workers.

## Examples

| Program | Pattern | Description |
|---------|---------|-------------|
| `deep-review` | Dynamic + linear | Role designer → workers (dynamic count) → verification |
| `pre-release` | Linear + check gate | Audit → parallel checks (with TS compile gate) → deploy verdict |
| `eval-loop` | Graph: cyclic | Generate → evaluate → cycle back (conditional back-edge + $end) |
| `full-release` | Graph: composed | embed(eval-loop) → embed(pre-release), cross-subgraph wiring |
| `guard-rails` | Per-agent hooks | Read-only reader, guarded writer, full-access coordinator |
| `research-lab` | Linear (simple) | Parallel research workers → coordinator summary |

## Testing

```bash
# Dry run — produces manifest without launching
fleet pipeline my-program --dry-run

# Verify manifest looks correct, then launch
fleet pipeline my-program --scope HEAD
```
