#!/usr/bin/env python3
"""
Daily Claude Code Harness Audit

Analyzes today's Claude Code prompts across all projects, identifies patterns,
proposes harness improvements, and sends a digest to Nexus (#general).

Runs daily at 10 PM EST via launchd.
"""

import json
import os
import re
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

# --- Configuration ---
PROMPTS_DIR = Path.home() / ".claude" / "prompts"
LOG_FILE = Path.home() / ".claude" / "logs" / "harness-audit.log"
NEXUS_CLI = Path.home() / "bin" / "nexus"
NEXUS_ROOM = "general"

# "Continue" variants (typos observed in real usage)
CONTINUE_PATTERNS = re.compile(
    r"^\s*(continue|ccontinue|conintue|contyinue|contniue|contiune|"
    r"contineu|coninue|conitnue|contunue|contnue|cont|"
    r"go on|keep going|go ahead|proceed)\s*[.!]?\s*$",
    re.IGNORECASE,
)

# Keyword categories for action analysis
ACTION_KEYWORDS = {
    "mock": re.compile(r"\bmock\b", re.IGNORECASE),
    "check": re.compile(r"\bcheck\b", re.IGNORECASE),
    "fix": re.compile(r"\bfix\b", re.IGNORECASE),
    "deploy": re.compile(r"\bdeploy\b", re.IGNORECASE),
    "test": re.compile(r"\btest\b", re.IGNORECASE),
    "refactor": re.compile(r"\brefactor\b", re.IGNORECASE),
    "add": re.compile(r"\badd\b", re.IGNORECASE),
    "remove": re.compile(r"\bremove\b", re.IGNORECASE),
    "debug": re.compile(r"\bdebug\b", re.IGNORECASE),
    "build": re.compile(r"\bbuild\b", re.IGNORECASE),
}


def log(msg: str) -> None:
    """Log to both stdout and log file."""
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    try:
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(LOG_FILE, "a") as f:
            f.write(line + "\n")
    except Exception:
        pass


def load_prompts(target_date: date) -> list[dict]:
    """Load all prompts for the target date, deduplicated by prompt_hash."""
    target_str = target_date.isoformat()
    seen_hashes = set()
    prompts = []

    if not PROMPTS_DIR.exists():
        log(f"Prompts directory not found: {PROMPTS_DIR}")
        return prompts

    for jsonl_file in PROMPTS_DIR.glob("*/prompts.jsonl"):
        try:
            with open(jsonl_file) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                        ts = entry.get("timestamp", "")
                        if ts[:10] != target_str:
                            continue
                        phash = entry.get("prompt_hash", "")
                        if phash and phash in seen_hashes:
                            continue
                        if phash:
                            seen_hashes.add(phash)
                        prompts.append(entry)
                    except json.JSONDecodeError:
                        continue
        except Exception as e:
            log(f"Error reading {jsonl_file}: {e}")

    return prompts


def load_historical_keywords(end_date: date, days: int = 7) -> set[str]:
    """Load keywords from the last N days (exclusive of end_date) for novelty detection.

    Optimized: only extracts keywords (not full entries) and scans files once
    with a date-range check instead of per-day iteration.
    """
    date_range = set()
    for day_offset in range(1, days + 1):
        date_range.add((end_date - timedelta(days=day_offset)).isoformat())

    keywords = set()
    for jsonl_file in PROMPTS_DIR.glob("*/prompts.jsonl"):
        try:
            with open(jsonl_file) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        # Quick date check before full parse
                        # timestamp field is near the start: {"timestamp":"2026-02-13T...
                        ts_start = line.find('"timestamp":"')
                        if ts_start == -1:
                            continue
                        ts_val_start = ts_start + 13
                        date_part = line[ts_val_start:ts_val_start + 10]
                        if date_part not in date_range:
                            continue
                        entry = json.loads(line)
                        prompt_text = entry.get("prompt", "")
                        keywords |= extract_keywords(prompt_text)
                    except (json.JSONDecodeError, IndexError):
                        continue
        except Exception:
            continue
    return keywords


def extract_keywords(prompt_text: str) -> set[str]:
    """Extract significant words from a prompt.

    Filters out stopwords, hex-like strings, and gibberish (must contain a vowel
    and not look like a hash/token).
    """
    words = re.findall(r"\b[a-zA-Z]{4,}\b", prompt_text.lower())
    stopwords = {
        "the", "and", "for", "that", "this", "with", "from", "have", "are",
        "was", "were", "been", "being", "has", "had", "does", "did", "will",
        "would", "could", "should", "may", "might", "can", "shall", "not",
        "but", "you", "your", "they", "them", "their", "what", "which",
        "who", "whom", "how", "when", "where", "why", "all", "each",
        "every", "both", "few", "more", "most", "other", "some", "such",
        "than", "too", "very", "just", "also", "now", "here", "there",
        "then", "once", "about", "into", "over", "after", "before",
        "between", "under", "again", "further", "only", "same", "any",
        "our", "out", "its", "let", "use", "make", "like", "get", "see",
        "one", "two", "new", "way", "want", "need", "try", "look",
        "file", "line", "code", "page", "data", "name", "type", "true",
        "false", "null", "none", "string", "number", "function", "return",
        "import", "export", "const", "class", "async", "await", "error",
        "value", "index", "array", "object", "props", "state", "event",
        "component", "element", "style", "text", "list", "item", "button",
        "input", "form", "table", "content", "container", "wrapper",
        "response", "request", "handler", "route", "path", "query",
        "result", "message", "status", "config", "option", "param",
        "default", "current", "update", "create", "delete", "fetch",
        "send", "load", "save", "read", "write", "open", "close",
        "start", "stop", "init", "setup", "clean", "clear", "reset",
        "show", "hide", "toggle", "enable", "disable", "active",
        "please", "thanks", "okay", "sure", "right", "think", "know",
        "something", "anything", "everything", "nothing", "thing",
        "already", "still", "instead", "actually", "really", "basically",
        "should", "going", "using", "doing", "making", "getting",
        "adding", "working", "running", "looking", "trying", "setting",
    }
    # Must contain at least one vowel (filters hex hashes, random strings)
    vowel_re = re.compile(r"[aeiou]")
    # Filter out hex-like patterns (e.g., "aadeaa", "abced")
    hex_re = re.compile(r"^[a-f0-9]+$")
    result = set()
    for w in words:
        if w in stopwords:
            continue
        if not vowel_re.search(w):
            continue
        if hex_re.match(w):
            continue
        # Skip very long words (likely encoded/URLs)
        if len(w) > 20:
            continue
        result.add(w)
    return result


def normalize_short_prompt(text: str) -> str:
    """Normalize a short prompt for repeat detection."""
    return re.sub(r"\s+", " ", text.strip().lower().rstrip(".!?"))


def analyze_prompts(prompts: list[dict], historical_keywords: set[str]) -> dict:
    """Analyze prompts and return structured findings."""
    total = len(prompts)
    if total == 0:
        return {"total": 0}

    # --- Basic counts ---
    questions = sum(1 for p in prompts if p.get("is_question"))
    slash_commands = sum(1 for p in prompts if p.get("is_slash_command"))
    code_blocks = sum(1 for p in prompts if p.get("has_code_block"))

    # --- Continue count ---
    continue_count = 0
    for p in prompts:
        text = p.get("prompt", "")
        if CONTINUE_PATTERNS.match(text):
            continue_count += 1

    # --- Per-project breakdown ---
    by_project = Counter(p.get("project", "unknown") for p in prompts)

    # --- Action keyword counts ---
    action_counts = defaultdict(int)
    for p in prompts:
        text = p.get("prompt", "")
        for keyword, pattern in ACTION_KEYWORDS.items():
            if pattern.search(text):
                action_counts[keyword] += 1

    # --- Average prompt length ---
    char_counts = [p.get("char_count", 0) for p in prompts]
    avg_chars = sum(char_counts) / total if total > 0 else 0
    word_counts = [p.get("word_count", 0) for p in prompts]
    avg_words = sum(word_counts) / total if total > 0 else 0

    # --- Most repeated short prompts (potential macro candidates) ---
    short_prompts = Counter()
    for p in prompts:
        text = p.get("prompt", "")
        wc = p.get("word_count", 0)
        if 1 <= wc <= 12:  # Short prompts only
            normalized = normalize_short_prompt(text)
            if normalized and not CONTINUE_PATTERNS.match(text):
                short_prompts[normalized] += 1
    # Filter to those repeated 2+ times
    repeated_short = [
        (prompt, count)
        for prompt, count in short_prompts.most_common(10)
        if count >= 2
    ]

    # --- Top 3 longest prompts ---
    sorted_by_length = sorted(prompts, key=lambda p: p.get("char_count", 0), reverse=True)
    longest = []
    for p in sorted_by_length[:3]:
        text = p.get("prompt", "")
        preview = text[:80].replace("\n", " ") + ("..." if len(text) > 80 else "")
        longest.append({
            "chars": p.get("char_count", 0),
            "words": p.get("word_count", 0),
            "project": p.get("project", "?"),
            "preview": preview,
        })

    # --- Novel keywords (in today but not in last 7 days) ---
    today_keywords = set()
    for p in prompts:
        today_keywords |= extract_keywords(p.get("prompt", ""))

    novel_keywords = today_keywords - historical_keywords
    # Filter to interesting ones (4+ chars, sorted alphabetically)
    novel_keywords = sorted([k for k in novel_keywords if len(k) >= 4])[:15]

    # --- Hour distribution ---
    hour_dist = Counter(p.get("hour", 0) for p in prompts)

    return {
        "total": total,
        "questions": questions,
        "question_pct": round(100 * questions / total, 1) if total else 0,
        "slash_commands": slash_commands,
        "code_blocks": code_blocks,
        "continue_count": continue_count,
        "continue_pct": round(100 * continue_count / total, 1) if total else 0,
        "by_project": by_project.most_common(),
        "action_counts": dict(sorted(action_counts.items(), key=lambda x: -x[1])),
        "avg_chars": round(avg_chars),
        "avg_words": round(avg_words),
        "repeated_short": repeated_short[:5],
        "longest": longest,
        "novel_keywords": novel_keywords,
        "hour_dist": sorted(hour_dist.items()),
    }


def generate_proposals_heuristic(analysis: dict) -> list[str]:
    """Generate basic heuristic proposals as fallback."""
    proposals = []
    if analysis.get("continue_pct", 0) > 10:
        proposals.append(f"Continue tax is {analysis['continue_pct']}%")
    repeated = analysis.get("repeated_short", [])
    if repeated:
        proposals.append(f'"{repeated[0][0]}" repeated {repeated[0][1]}x -- macro candidate')
    actions = analysis.get("action_counts", {})
    if actions.get("mock", 0) > 3:
        proposals.append(f'"mock" appeared {actions["mock"]}x')
    if not proposals:
        proposals.append("No strong patterns detected -- harness operating normally")
    return proposals[:5]


def generate_proposals_with_claude(analysis: dict, prompts: list[dict]) -> list[str]:
    """Spawn a Claude Code instance to reason about harness improvements.

    Falls back to heuristics if Claude is unavailable.
    """
    # Build a sample of today's prompts for Claude to reason over
    sample_prompts = []
    for p in prompts[:100]:  # Cap at 100 to avoid token explosion
        text = p.get("prompt", "")
        if text.startswith("<task-notification>"):
            continue
        preview = text[:200] + ("..." if len(text) > 200 else "")
        sample_prompts.append(f"[{p.get('project','?')}] {preview}")

    analysis_summary = json.dumps({
        "total": analysis.get("total", 0),
        "continue_count": analysis.get("continue_count", 0),
        "continue_pct": analysis.get("continue_pct", 0),
        "question_pct": analysis.get("question_pct", 0),
        "action_counts": analysis.get("action_counts", {}),
        "repeated_short": analysis.get("repeated_short", []),
        "novel_keywords": analysis.get("novel_keywords", []),
        "avg_words": analysis.get("avg_words", 0),
    }, indent=2)

    prompt = f"""You are analyzing a developer's Claude Code usage for today to propose harness improvements.

## Statistics
{analysis_summary}

## Sample of today's prompts (up to 100)
{chr(10).join(sample_prompts)}

## Current harness
- CLAUDE.md files provide project context and rules
- Hooks: prompt logger, ECHO loop (auto-continue chains), CHECKEND (deferred verification), stop-check (post-change verification)
- Snippets: 50+ keyword-triggered context injections (SAVE, DEPLOY, CHECK, WECHAT, PBCOPY, etc.)
- Skills: frontend-design, feature-dev, ralph-loop, document-skills

## Your task
Based on the patterns above, propose 3-5 SPECIFIC, ACTIONABLE improvements to the harness. Focus on:
1. Repeated prompts that should become macros/snippets/hooks
2. Friction points where the developer is fighting the tool
3. Missing CLAUDE.md rules that would prevent recurring issues
4. New hooks or stop-hook checks that would automate verification
5. Snippet/skill gaps for topics that came up repeatedly today

Be concrete: name the exact file to change, the rule to add, or the snippet to create. Keep each proposal to 1-2 sentences. No fluff."""

    try:
        # Remove CLAUDECODE env var to avoid nested-session check
        clean_env = {k: v for k, v in os.environ.items() if "CLAUDE" not in k.upper()}
        clean_env["PATH"] = os.environ.get("PATH", f"{Path.home() / '.local' / 'bin'}:/usr/local/bin:/usr/bin:/bin")
        clean_env["HOME"] = os.environ.get("HOME", str(Path.home()))
        result = subprocess.run(
            ["claude", "-p", prompt, "--model", "haiku"],
            capture_output=True,
            text=True,
            timeout=120,
            env=clean_env,
        )
        if result.returncode == 0 and result.stdout.strip():
            # Parse Claude's response into proposal lines
            response = result.stdout.strip()
            log(f"Claude response ({len(response)} chars)")
            # Split into lines, filter to substantive ones
            lines = [l.strip() for l in response.split("\n") if l.strip()]
            proposals = []
            for line in lines:
                # Keep lines that look like proposals (numbered, bulleted, or substantial)
                if (line[0:1].isdigit() or line.startswith("-") or line.startswith("*")
                        or len(line) > 30):
                    # Strip leading number/bullet
                    cleaned = re.sub(r"^[\d]+[.):\s]+", "", line)
                    cleaned = re.sub(r"^[-*]\s+", "", cleaned)
                    if cleaned and len(cleaned) > 15:
                        proposals.append(cleaned)
            if proposals:
                return proposals[:5]
            # If parsing failed, return raw truncated
            return [response[:300]]
        else:
            log(f"Claude failed (rc={result.returncode}): {result.stderr[:200]}")
    except FileNotFoundError:
        log("Claude CLI not found, falling back to heuristics")
    except subprocess.TimeoutExpired:
        log("Claude timed out after 120s, falling back to heuristics")
    except Exception as e:
        log(f"Claude error: {e}, falling back to heuristics")

    return generate_proposals_heuristic(analysis)


def generate_proposals(analysis: dict, prompts: list[dict] | None = None) -> list[str]:
    """Generate improvement proposals. Uses Claude if available, else heuristics."""
    if prompts is not None and len(prompts) > 0:
        return generate_proposals_with_claude(analysis, prompts)
    return generate_proposals_heuristic(analysis)


def format_message(target_date: date, analysis: dict, proposals: list[str]) -> str:
    """Format the Nexus digest message."""
    date_str = target_date.strftime("%Y-%m-%d (%A)")

    if analysis["total"] == 0:
        return (
            f"Claude Code Daily Audit -- {date_str}\n\n"
            "No prompts recorded today.\n\n"
            "-- Sent from Joshua (automated)"
        )

    lines = [f"Claude Code Daily Audit -- {date_str}\n"]

    # Summary line
    lines.append(
        f"Prompts: {analysis['total']} "
        f"({analysis['question_pct']}% questions, "
        f"{analysis['slash_commands']} slash cmds)"
    )
    lines.append(
        f"Continue tax: {analysis['continue_count']} "
        f"({analysis['continue_pct']}%)"
    )
    lines.append(f"Avg length: {analysis['avg_words']} words / {analysis['avg_chars']} chars")

    # Project breakdown
    projects = analysis.get("by_project", [])
    if projects:
        proj_parts = [f"{name}: {count}" for name, count in projects[:5]]
        lines.append(f"Projects: {', '.join(proj_parts)}")

    # Action keywords
    actions = analysis.get("action_counts", {})
    if actions:
        action_parts = [f"{k}({v})" for k, v in list(actions.items())[:6]]
        lines.append(f"Actions: {' '.join(action_parts)}")

    # Top repeated short prompts
    repeated = analysis.get("repeated_short", [])
    if repeated:
        lines.append("\nTop repeats:")
        for prompt, count in repeated[:3]:
            display = prompt[:50] + ("..." if len(prompt) > 50 else "")
            lines.append(f"  {count}x \"{display}\"")

    # Longest prompts
    longest = analysis.get("longest", [])
    if longest:
        lines.append(f"\nLongest: {longest[0]['chars']} chars ({longest[0]['project']})")

    # Novel keywords
    novel = analysis.get("novel_keywords", [])
    if novel:
        lines.append(f"New keywords: {', '.join(novel[:8])}")

    # Proposals
    lines.append("\nProposals:")
    for i, proposal in enumerate(proposals, 1):
        lines.append(f"  {i}. {proposal}")

    # Sign off
    lines.append("\n\n-- Sent from Joshua (automated)")

    return "\n".join(lines)


def send_to_nexus(message: str) -> bool:
    """Send message to Nexus #general via CLI."""
    try:
        result = subprocess.run(
            [str(NEXUS_CLI), "send", "-r", NEXUS_ROOM, message],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode == 0:
            log("Nexus message sent successfully")
            return True
        else:
            log(f"Nexus send failed (rc={result.returncode}): {result.stderr}")
            return False
    except subprocess.TimeoutExpired:
        log("Nexus send timed out")
        return False
    except FileNotFoundError:
        log(f"Nexus CLI not found at {NEXUS_CLI}")
        return False
    except Exception as e:
        log(f"Nexus send error: {e}")
        return False


def main():
    target_date = date.today()

    # Allow override via CLI arg: python3 daily-harness-audit.py 2026-02-13
    if len(sys.argv) > 1:
        try:
            target_date = date.fromisoformat(sys.argv[1])
        except ValueError:
            log(f"Invalid date: {sys.argv[1]}, using today")

    log(f"Starting daily harness audit for {target_date}")

    # Step 1: Collect today's prompts
    prompts = load_prompts(target_date)
    log(f"Loaded {len(prompts)} prompts for {target_date}")

    # Step 2: Load historical keywords for novelty detection
    historical_keywords = load_historical_keywords(target_date, days=7)
    log(f"Loaded {len(historical_keywords)} historical keywords (last 7 days)")

    # Step 3: Analyze patterns
    analysis = analyze_prompts(prompts, historical_keywords)

    # Step 4: Generate proposals (Claude-powered if available, else heuristics)
    proposals = generate_proposals(analysis, prompts)

    # Step 5: Format and send
    message = format_message(target_date, analysis, proposals)
    log(f"Message:\n{message}")

    success = send_to_nexus(message)
    if success:
        log("Audit complete -- message sent")
    else:
        log("Audit complete -- message send FAILED")

    # Also dump analysis as JSON for debugging
    analysis_file = Path.home() / ".claude" / "logs" / "harness-audit-latest.json"
    try:
        with open(analysis_file, "w") as f:
            json.dump(
                {
                    "date": target_date.isoformat(),
                    "analysis": {
                        k: v for k, v in analysis.items()
                        if k != "by_project"  # Counter tuples aren't JSON-friendly
                    },
                    "by_project": dict(analysis.get("by_project", [])),
                    "proposals": proposals,
                },
                f,
                indent=2,
                ensure_ascii=False,
            )
    except Exception as e:
        log(f"Failed to write analysis JSON: {e}")

    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
