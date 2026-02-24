---
name: Implementation Handoff Document
description: Generate a visual, screenshot-heavy HTML document that summarizes what was implemented in a session. Shows before/after comparisons, lists features delivered, and serves as a handoff or demo document for stakeholders. Uses the generating-html base template. Supports English and Chinese. Keywords - implementation doc, handoff document, delivery report, feature summary, demo doc, IMPLDOC.
---

# Implementation Handoff Document

Generate a single-page HTML document that visually communicates what was built/changed. Screenshot-heavy, minimal text. Uses the **generating-html** base template and CSS classes.

## Workflow

1. **Capture before-state** (if starting fresh): Take screenshots of current UI state BEFORE making changes. Save as `{feature}-before.png`.
2. **After implementation**: Take screenshots of the new state. Save as `{feature}-after.png`.
3. **Follow the generating-html workflow**: Read base template → Write → Edit content section only.
4. **Save** to `claude_files/html/{name}-handoff.html`
5. **Open**: `open claude_files/html/{name}-handoff.html`

**If before screenshots don't exist**: Only show the "after" state. Don't fake before/after—just show what was built.

## Content Structure

Map to the generating-html journey arc:

### HOOK → Delivery Summary
```html
<div class="important-always-visible">
    <h2>Delivery Summary</h2>
    <p><strong>Delivered N features for [Project].</strong></p>
    <ul>
        <li><strong>Date:</strong> YYYY-MM-DD</li>
        <li><strong>Scope:</strong> One-line summary</li>
    </ul>
</div>
```

### INSIGHT → Feature Cards with Screenshots
Each feature: heading + 1-2 sentence description + screenshot(s). Use `.two-column-layout` for before/after pairs.

**Single screenshot (new feature):**
```html
<h2>Feature Name <code style="font-size:12px;padding:2px 8px;border-radius:10px">New</code></h2>
<p>One sentence describing what it does.</p>
<img src="../../feature-screenshot.png" style="width:100%;max-width:800px;border-radius:8px;border:1px solid var(--border-color);margin:12px 0">
```

**Before/After (updated feature):**
```html
<h2>Feature Name <code style="font-size:12px;padding:2px 8px;border-radius:10px">Updated</code></h2>
<p>What changed.</p>
<div class="two-column-layout">
    <div>
        <h3>Before</h3>
        <img src="../../feature-before.png" style="width:100%;border-radius:8px;border:1px solid var(--border-color)">
    </div>
    <div>
        <h3>After</h3>
        <img src="../../feature-after.png" style="width:100%;border-radius:8px;border:1px solid var(--border-color)">
    </div>
</div>
```

### EVIDENCE → Technical Summary (collapsed)
```html
<div class="collapsible" data-collapsible="closed">
    <div class="collapsible-header">
        <span>Technical Details</span>
        <span class="arrow">▶</span>
    </div>
    <div class="collapsible-content">
        <ul>
            <li><code>src/file.ts</code> — what changed</li>
        </ul>
    </div>
</div>
```

### ACTION → Pending Items (optional)
```html
<div class="card priority">
    <h3>Pending Items</h3>
    <ul>
        <li>Item requiring follow-up</li>
    </ul>
</div>
```

## Content Rules

1. **Screenshots > Words**: Every feature MUST have at least one screenshot. If none exists, take one first (via Playwright or manual).
2. **Max 2 sentences per feature**: Name it, describe it, show the screenshot.
3. **Before/After when possible**: Use `.two-column-layout`. If no "before" screenshot exists, just show the final state.
4. **Code goes in collapsible**: No code in the main body.
5. **Language**: Chinese (中文) for Baozheng stakeholders, English for qbg internal/tech.

## Chinese Conventions

When writing in Chinese:
- Hook heading: `功能交付报告` or `实施文档`
- Feature badges: `新功能` / `优化` / `修复`
- Date format: `2026年2月11日`
- Technical Details: `技术细节`
- Pending Items: `待办事项`
- Delivery count: `交付 N 项功能`
- Before/After: `变更前` / `变更后`

## Screenshot Tips

**Finding existing screenshots:**
```bash
ls *.png | head -20
ls screenshots/ docs/screenshots/ qa-screenshots/ 2>/dev/null
```

**Taking new screenshots** (via Playwright MCP):
- Navigate to the page, take snapshot, then `browser_take_screenshot`

**Image paths**: Use relative paths from `claude_files/html/` (typically `../../screenshot.png` for project-root PNGs).

**For self-contained sharing** (email/WeChat):
```bash
base64 -i screenshot.png | tr -d '\n'
# Then: <img src="data:image/png;base64,{{BASE64}}">
```
Only embed base64 when explicitly sharing outside the project.
