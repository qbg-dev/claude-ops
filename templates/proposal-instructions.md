## Proposal Phase (MANDATORY — DO THIS FIRST)

Before writing ANY implementation code, produce a proposal document:

1. **Copy the template**:
   ```
   cp {{TEMPLATE_PATH}} claude_files/proposal.html
   ```

2. **Read and explore** the codebase to understand the full scope — architecture, existing patterns, files to modify, and risks.

3. **Edit `claude_files/proposal.html`** — replace ALL `[PLACEHOLDER]` content with your real analysis:

   - **Architecture**: Draw a Mermaid diagram showing how components interact. Replace the placeholder flowchart.
   - **UI Mockups** (if frontend): Write actual rendered HTML components inside `.mockup-frame` divs. Use the project design system tokens already scoped inside those frames (Inter font, `--primary: #268AED`, `--gold: #c8a24e`, radii 2-6px). Include every page/component you plan to build — headers, forms, tables, cards, modals. Delete this section if backend-only.
   - **Data Flow** (if backend): Draw a Mermaid sequence diagram of the request/data path. Include schema changes table. Delete this section if frontend-only.
   - **File Impact**: List every file you will create or modify, with a 1-sentence description of each change.
   - **Task Breakdown**: Break work into ordered phases with task IDs. Mark dependencies (blocked-by).
   - **Risks**: Identify what could go wrong and your mitigations.
   - **Open Questions**: List decisions you need from {{MISSION_AUTHORITY}}.
   - Replace `[WORKER_NAME]`, `[DATE]`, `[MISSION_AUTHORITY]` in the template header/footer.

4. **Open in browser** to verify rendering:
   ```
   open claude_files/proposal.html
   ```

5. **Send for approval**:
   ```
   fleet mail send "{{MISSION_AUTHORITY}}" "Proposal ready for review" "Proposal ready: claude_files/proposal.html\n\nPlease reply APPROVED, REVISE, or REJECT."
   ```

6. **WAIT for approval** before writing any implementation code. Check `fleet mail inbox` for the response.
   - **APPROVED**: Proceed with implementation as proposed.
   - **REVISE**: Update the proposal per feedback, re-open in browser, re-send for approval.
   - **REJECT**: Stop and discuss scope with {{MISSION_AUTHORITY}}.

**Do NOT skip this phase.** The proposal is your design contract — it prevents wasted work and ensures alignment before you write a single line of code.
