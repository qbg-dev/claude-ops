---
name: "Parallel Prototype Orchestration"
description: "Build and compare multiple web app prototypes simultaneously using Claude Code Agent Teams. Design first, spawn parallel builder teammates, serve all variants, then iterate or finalize."
pattern: "\\b(PROTOTYPE)\\b[.,;:!?]?"
---

# Parallel Prototype Orchestration

Build and compare multiple web app prototypes simultaneously using Claude Code Agent Teams. Design first, spawn parallel builder teammates, serve all variants, then iterate or finalize.

## When to Use

- User says "PROTOTYPE", "WEBAPP", or wants to explore multiple approaches
- Need to compare different design directions
- Want rapid parallel development with live preview
- Requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in settings

## Overview

1. **Propose** n prototype variants (default: 3)
2. **Create team** and spawn builder teammates in parallel
3. **Assign tasks** via shared task list
4. **Serve** all prototypes on different ports with live preview
5. **Select** the winning prototype, iterate, or kill all servers

---

## Phase 1: Design Variants

Before spawning any teammates, design multiple distinct approaches. Each variant should explore a different:

- **Visual style** (minimal vs rich, dark vs light)
- **Interaction pattern** (modals vs inline, tabs vs panels)
- **Architecture approach** (SPA vs multi-page, stateful vs stateless)
- **Feature focus** (speed vs features, simplicity vs power)

### Variant Proposal Template

Present variants to the user in this format:

```
## Prototype Variants

### Variant A: [Name] - [One-liner]
**Focus**: [Primary design goal]
**Visual**: [Style description]
**Interaction**: [How user interacts]
**Trade-off**: [What it optimizes for vs sacrifices]

### Variant B: [Name] - [One-liner]
**Focus**: [Primary design goal]
**Visual**: [Style description]
**Interaction**: [How user interacts]
**Trade-off**: [What it optimizes for vs sacrifices]

### Variant C: [Name] - [One-liner]
**Focus**: [Primary design goal]
**Visual**: [Style description]
**Interaction**: [How user interacts]
**Trade-off**: [What it optimizes for vs sacrifices]

Which variants would you like me to build? (A/B/C/all/suggest more)
```

### Example Variants for a Note-Taking App

```
### Variant A: "Zen" - Distraction-free writing
**Focus**: Minimal UI, maximum focus
**Visual**: White background, single centered column, no sidebar
**Interaction**: Everything via keyboard shortcuts, hidden toolbar
**Trade-off**: Speed over discoverability

### Variant B: "Dashboard" - Power user's command center
**Focus**: Information density, quick navigation
**Visual**: Dark theme, three-column layout, visible sidebar
**Interaction**: Click-driven with command palette (Cmd+K)
**Trade-off**: Features over simplicity

### Variant C: "Mobile-First" - Touch-optimized responsive
**Focus**: Works great on all devices
**Visual**: Large touch targets, bottom navigation, swipe gestures
**Interaction**: Thumb-friendly actions, pull-to-refresh
**Trade-off**: Mobile experience over desktop power features
```

---

## Phase 2: Create Team & Spawn Builders

Once user approves variants, use Agent Teams to build in parallel.

### Step 1: Create the Team

Use `TeamCreate` with:
- `team_name`: "prototype-sprint"
- `description`: "Parallel prototype development—comparing N variants"

### Step 2: Create Tasks for Each Variant

Use `TaskCreate` for each variant:

```
subject: "Build Variant A: {Name}"
description: |
  Build a working prototype implementing this design direction.

  ## Design Spec
  {Full design specification from Phase 1}

  ## Tech Stack
  - Frontend: React + Vite (or user-specified)
  - Styling: Tailwind CSS
  - Backend: FastAPI (if needed)

  ## Requirements
  1. Run on port {assigned_port}
  2. Create in: src/prototypes/variant-{letter}/
  3. Include a launcher script
  4. Core features only—no gold plating
  5. Add Cmd+S (save) and Cmd+/ (help) keyboard shortcuts

  ## Success Criteria
  - App runs on http://localhost:{port}
  - Core user flow works end-to-end
  - No console errors
  - Clean, readable code
activeForm: "Building Variant A prototype"
```

### Step 3: Spawn Teammates (Parallel)

Spawn all builder teammates in a **single message** using multiple `Task` tool calls:

```
Task (for each variant, all in parallel):
  subagent_type: "general-purpose"
  team_name: "prototype-sprint"
  name: "builder-a"
  mode: "bypassPermissions"
  prompt: |
    You are building Prototype Variant A: "{Name}".

    {Full design spec, tech stack, port assignment}

    1. Check TaskList and claim your task with TaskUpdate (set owner and status)
    2. Create src/prototypes/variant-a/ with full project structure
    3. Build the prototype to spec
    4. Start the dev server on port {port} in background
    5. Mark task completed via TaskUpdate when done
    6. Send a message to the lead with the URL and a brief summary
```

### Port Assignment

| Variant | Frontend Port | Backend Port |
|---------|--------------|--------------|
| A       | 5173         | 8001         |
| B       | 5174         | 8002         |
| C       | 5175         | 8003         |
| D       | 5176         | 8004         |
| E       | 5177         | 8005         |

---

## Phase 3: Monitor & Coordinate

### Tracking Progress

Use native Agent Teams controls:

- **Shift+Up/Down**—cycle through teammates to see their progress
- **Ctrl+T**—toggle the shared task list view
- **Enter**—view a selected teammate's full session
- **TaskList**—check task statuses programmatically

Teammates send messages automatically when they complete tasks. Messages are delivered to the lead without polling.

### Status Dashboard (Show to User)

```
## Prototype Status

| Variant | Teammate  | Status   | URL                    |
|---------|-----------|----------|------------------------|
| A       | builder-a | Building | http://localhost:5173  |
| B       | builder-b | Running  | http://localhost:5174  |
| C       | builder-c | Building | http://localhost:5175  |
```

### Opening Prototypes

When a teammate reports completion:

1. Verify the dev server is running on the assigned port
2. Open in browser: `open http://localhost:{port}`
3. Notify user

Once all prototypes are ready:

```bash
open http://localhost:5173 http://localhost:5174 http://localhost:5175
```

---

## Phase 4: Selection & Iteration

### Presenting Options

Once all prototypes are running, ask the user:

```
## All Prototypes Ready!

A) Variant A "{Name}"—http://localhost:5173
B) Variant B "{Name}"—http://localhost:5174
C) Variant C "{Name}"—http://localhost:5175

**What would you like to do?**

1. **Select winner**—Choose one to continue developing
2. **Iterate**—Request changes to specific variants
3. **Combine**—Merge features from multiple variants
4. **More variants**—Generate more prototype ideas
5. **Kill all**—Stop all servers and clean up
```

### Choice 1: Select Winner

1. Send `shutdown_request` to non-winning teammates via `SendMessage`
2. Continue development with winning teammate
3. Clean up team when done: `TeamDelete`

### Choice 2: Iterate

Message the specific teammate:

```
SendMessage:
  type: "message"
  recipient: "builder-a"
  content: "Add a collapsible sidebar. Reference builder-b's implementation at src/prototypes/variant-b/src/components/Sidebar.tsx"
  summary: "Add sidebar to Variant A"
```

### Choice 3: Combine

1. Create a new task combining specs from multiple variants
2. Spawn a new teammate `builder-combined`
3. Reference existing code from other variants

### Choice 4: More Variants

1. Return to Phase 1—design more variants
2. Create additional tasks and spawn new teammates
3. Keep existing prototypes running

### Choice 5: Kill All

```bash
for port in 5173 5174 5175 5176 5177 8001 8002 8003 8004 8005; do
  lsof -ti:$port | xargs kill -9 2>/dev/null
done
```

Then shut down teammates and clean up:

```
SendMessage: type: "shutdown_request" to each teammate
TeamDelete (after all teammates shut down)
```

---

## Project Structure

```
project/
├── src/
│   └── prototypes/
│       ├── variant-a/
│       │   ├── frontend/
│       │   │   ├── src/
│       │   │   ├── package.json
│       │   │   └── vite.config.js
│       │   ├── backend/          # if needed
│       │   │   ├── server.py
│       │   │   └── requirements.txt
│       │   └── launcher.sh
│       ├── variant-b/
│       │   └── ...
│       └── variant-c/
│           └── ...
└── package.json
```

---

## Teammate Instructions Template

Use this template when spawning builder teammates via the `Task` tool:

```markdown
# Prototype Builder: Variant {LETTER} - "{NAME}"

## Context
You are building one of {N} parallel prototypes. Your variant focuses on:
{VARIANT_FOCUS}

## Design Specification

### Visual Design
{VISUAL_SPEC}

### User Interactions
{INTERACTION_SPEC}

### Data Models (if applicable)
{DATA_MODELS}

### API Endpoints (if applicable)
{API_ENDPOINTS}

## Technical Requirements

### Stack
- Frontend: React 18 + Vite 5
- Styling: {STYLE_CHOICE}
- Backend: {BACKEND_CHOICE}
- Database: {DB_CHOICE}

### Port Configuration
- Frontend dev server: {FRONTEND_PORT}
- Backend server: {BACKEND_PORT}

### File Location
Create all files in: `src/prototypes/variant-{letter}/`

### Launcher Script
Create `launcher.sh` that:
1. Installs dependencies (if not present)
2. Starts backend (if applicable)
3. Starts frontend dev server on assigned port
4. Opens browser to frontend URL

## Implementation Order
1. Claim task from TaskList via TaskUpdate
2. Set up project structure
3. Build core UI shell
4. Implement main user flow
5. Add keyboard shortcuts Cmd+S, Cmd+/
6. Start dev server in background
7. Mark task completed via TaskUpdate
8. Message the lead with URL and summary

## Completion Criteria
- App runs on http://localhost:{FRONTEND_PORT}
- Core user flow works
- Keyboard shortcuts functional
- No console errors
- launcher.sh works
```

---

## Server Management

| Action | Command |
|--------|---------|
| Kill by port | `lsof -ti:{port} \| xargs kill -9` |
| Kill all | Loop through ports 5173-5177, 8001-8005 |
| Check running | `lsof -i :5173-5177 -i :8001-8005 \| grep LISTEN` |

---

## Quick Reference

### Agent Teams Controls

| Action | Control |
|--------|---------|
| Navigate teammates | Shift+Up/Down |
| View teammate session | Enter |
| Interrupt teammate | Escape |
| Toggle task list | Ctrl+T |
| Delegate mode (lead only coordinates) | Shift+Tab |
| Message teammate | Select with Shift+Up/Down, then type |

### Agent Teams Tools

| Action | Tool |
|--------|------|
| Create team | `TeamCreate` |
| Create task | `TaskCreate` |
| Spawn teammate | `Task` with `team_name` param |
| Check tasks | `TaskList` |
| Update task | `TaskUpdate` |
| Message teammate | `SendMessage` type: "message" |
| Broadcast to all | `SendMessage` type: "broadcast" |
| Shut down teammate | `SendMessage` type: "shutdown_request" |
| Delete team | `TeamDelete` |

### Default Ports

| Variant | Frontend | Backend |
|---------|----------|---------|
| A | 5173 | 8001 |
| B | 5174 | 8002 |
| C | 5175 | 8003 |
| D | 5176 | 8004 |
| E | 5177 | 8005 |

---

## Workflow Summary

```
User Request
    |
    v
Phase 1: Design -----> Present n variant proposals, user approves
    |
    v
Phase 2: Spawn ------> TeamCreate + TaskCreate + parallel Task calls
    |
    v
Phase 3: Monitor ----> Shift+Up/Down, Ctrl+T, auto messages from teammates
    |
    v
Phase 4: Select -----> Winner / Iterate / Combine / More / Kill
    |
    v
Cleanup -------------> shutdown_request to teammates, then TeamDelete
```

---

## Rules

**DO:**
- Design multiple distinct variants before building
- Spawn all teammates in parallel (single message, multiple Task tool calls)
- Assign unique ports to each prototype
- Use TaskList to track progress
- Open all prototypes in browser when ready
- Clean up team and servers when done
- Use `bypassPermissions` mode for builder teammates to avoid blocking on prompts

**DON'T:**
- Build without user approval on variants
- Use overlapping ports
- Forget to kill servers and shut down teammates after selection
- Spawn sequentially when parallel is possible
- Have two teammates edit the same file (causes overwrites)
- Spawn more than 3 teammates unless user requests it (token cost scales linearly)
