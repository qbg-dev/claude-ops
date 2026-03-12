/**
 * Attack vectors per specialization and default focus area lists.
 */

export const ATTACK_VECTORS: Record<string, string> = {
  security:
    'Trace every user-controlled input (URL params, request body, headers, JWT claims, cookie values) to where it is used in SQL queries, shell commands, file paths, or HTML output. Check: parameterized queries or raw string interpolation? Ownership checks on resource access (IDOR)? Rate limits on LLM-invoking endpoints? Auth on every route? CSRF protection? Error messages leaking internal details?',
  logic:
    'For each changed conditional branch: what if the condition is inverted? Off-by-one? What if input is empty, null, undefined, NaN, or an unexpected type? Are all switch/if-else branches covered? Is there implicit fallthrough? Does the change affect loop termination? Are comparisons correct (=== vs ==, < vs <=)?',
  "error-handling":
    'For each try/catch: what specific exceptions can the try block throw? Does the catch handle all of them? Is there a finally block that should exist? Are there async operations without .catch()? Are error messages leaked to the client (should return generic message, log real error)? Does error recovery leave the system in a consistent state?',
  "data-integrity":
    'Check all writes: are they atomic? Is there rollback on failure? Could concurrent writes race? Is cache invalidated after writes? Are there silent truncations (string length, number overflow)? Non-atomic read-modify-write patterns? Missing database transactions?',
  performance:
    'Check for: N+1 query patterns (loop with DB call inside). Unbounded result sets (missing LIMIT/pagination). Unnecessary re-renders or re-computations. Blocking I/O on hot paths. Memory leaks (event listeners not cleaned up, growing arrays). Missing indexes on queried columns. Large payloads without streaming.',
  "ux-impact":
    'Check for: missing loading states during async operations. Error messages that are unhelpful or expose internals. Race conditions visible to users (double-click, stale data). Accessibility gaps (missing aria labels, keyboard nav). Misleading UI text or labels. State not cleared on navigation. Missing confirmation for destructive actions.',
  architecture:
    'Check for: circular dependencies between modules. God functions doing too many things. Abstraction leaks (implementation details exposed to callers). Wrong layer (business logic in routes, DB queries in UI). Tight coupling that makes testing hard. Missing separation of concerns.',
  completeness:
    'Check for: partial migrations (old pattern in some files, new in others). Missing error states or edge cases. TODO/FIXME left behind. Incomplete cleanup of removed features. Missing documentation for public APIs. Untested code paths.',
  correctness:
    "Check for: logical consistency — do claims match the evidence? Contradictions between sections. Factual accuracy — are numbers, dates, versions correct? Unstated assumptions that may be wrong. Circular reasoning. Conclusions that don't follow from premises.",
  feasibility:
    'Check for: implementation complexity underestimated. Dependencies on systems/APIs/people not accounted for. Resource requirements (time, compute, cost) not realistic. Blockers not identified. Ordering issues — does step 3 depend on step 5? Scope creep risks.',
  risks:
    'Check for: single points of failure. What happens if an external dependency goes down? Failure modes not discussed. Security implications of the proposed approach. Operational burden of maintaining this. Rollback strategy if things go wrong.',
  improvement:
    'Look for: real improvements to reliability, readability, or maintainability. Patterns that could be simplified. Duplicated logic that could be extracted. Missing abstractions that would reduce complexity. Better error messages or logging.',
  "silent-failure":
    'Find every try-catch, .catch(), error callback, optional chaining (?.), null coalescing (??), and fallback/default value. For each: (1) Is the error logged with context? (2) Does the user get actionable feedback or is it swallowed? (3) Is the catch specific or catch-all? (4) Empty catch blocks? (5) Does error recovery leave consistent state? (6) Fallbacks that mask real problems? Every silent swallow is critical.',
  "claude-md":
    "Read ALL CLAUDE.md files in the project (root, .claude/, subdirectories). For each changed file, check: does the change comply with every applicable rule? Cross-reference: 'CLAUDE.md rule X requires Y, but the change does Z.' Only report EXPLICIT violations, not general best practices.",
};

export function getAttackVectors(focus: string): string {
  return (
    ATTACK_VECTORS[focus] ||
    "Review thoroughly using your specialization lens. Look for issues that a generalist might miss. Trace implications across the codebase."
  );
}

export const DEFAULT_DIFF_FOCUS = [
  "security",
  "logic",
  "error-handling",
  "data-integrity",
  "architecture",
  "performance",
  "ux-impact",
  "completeness",
];

export const DEFAULT_CONTENT_FOCUS = [
  "correctness",
  "completeness",
  "feasibility",
  "risks",
];

export const DEFAULT_MIXED_FOCUS = [
  "security",
  "logic",
  "correctness",
  "completeness",
  "feasibility",
  "risks",
];

export const DEFAULT_CODEBASE_FOCUS = [
  "security",
  "architecture",
  "error-handling",
  "data-integrity",
  "performance",
  "completeness",
];
