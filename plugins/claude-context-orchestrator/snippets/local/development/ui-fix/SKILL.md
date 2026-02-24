---
name: "UI Fix & Review"
description: "Triggered when user shares a URL or screenshot of a broken/ugly UI. Systematically diagnose visual issues, check design consistency, simplify, and fix."
pattern: "\\b(UIFIX)\\b[.,;:!?]?"
---

# UI Fix & Review Workflow

You've been given a URL, screenshot, or description of a UI that needs fixing. Follow this systematic process.

## Step 0: Gather Context

**Required inputs** (at least one):
- A URL to view the page (use WebFetch or open in browser)
- A screenshot (read the image file)
- A description of what's wrong

**If a URL is provided**: Fetch/screenshot it first so you can SEE the problem. Don't guess.

**If a screenshot is provided**: Read it with the Read tool to visually inspect.

## Step 1: Identify the Problem

Before touching code, diagnose what's actually wrong. Check in this priority order:

### 1a. Consistency Violations
- Does this page match the rest of the app's design language?
- Are CSS variables being used (not hardcoded colors/spacing)?
- Are shared components being used (`.btn`, `.card`, `.data-table`, etc.) instead of one-off styles?
- Does dark mode work (`[data-theme="dark"]`)?
- Is `border-radius: 0` respected (project convention)?
- Is the accent color correct (muted gold `#c8a24e` or whatever the project uses)?

### 1b. Layout & Spacing Issues
- Inconsistent padding/margins (should use spacing scale: 4/8/12/16/24/32px)
- Elements not aligned to a grid
- Content overflowing containers
- Awkward whitespace or cramped elements
- Scrollbars appearing where they shouldn't

### 1c. Responsiveness
- Does it work on mobile widths (375px, 414px)?
- Does it work on tablet (768px)?
- Are tables horizontally scrollable on small screens?
- Are touch targets at least 44px?

### 1d. Visual Hierarchy
- Is it clear what's primary vs secondary?
- Are headings properly sized and weighted?
- Is there too much visual noise (too many borders, shadows, colors)?
- Are interactive elements obviously clickable?

### 1e. Simplification Opportunities
- Can elements be removed entirely without losing function?
- Are there redundant labels/titles/descriptions?
- Can a complex layout be flattened?
- Are there unnecessary animations or decorations?
- Is information density appropriate (not too sparse, not too cramped)?

### 1f. Common Anti-Patterns
- Text on low-contrast backgrounds
- Tiny font sizes (< 13px)
- Inconsistent icon sizes or styles
- Mixed alignment (some left, some center)
- Orphaned elements floating in empty space
- Excessive nesting of cards/containers

## Step 2: If You Can't See the Problem

If the UI looks reasonable to you, **ask the user** before making changes:

> I've reviewed the page and it looks [description]. A few things I notice:
> - [observation 1]
> - [observation 2]
>
> What specifically feels broken or off to you? Is it:
> 1. A specific element that looks wrong?
> 2. The overall layout/spacing?
> 3. Inconsistency with other pages?
> 4. Something that works but feels "off"?

Don't make changes blind. Bad "fixes" are worse than the original.

## Step 3: Fix

When fixing:

1. **Read the actual source files** before editing. Understand what CSS/components are in play.
2. **Use existing design tokens/variables**—never hardcode values that should come from the design system.
3. **Prefer CSS fixes over markup changes** when possible (less risk of breaking functionality).
4. **Fix the root cause**, not symptoms. If spacing is wrong because a component isn't using the shared `.card` class, add the class—don't add `margin-top: 16px` inline.
5. **Test dark mode** after changes.
6. **Check at least 2 breakpoints** (mobile + desktop) after changes.

## Step 4: Verify

After fixing:
- Build the admin UI if applicable (`./scripts/build-admin.sh`)
- Provide a before/after summary
- Include the URL or steps to verify the fix
