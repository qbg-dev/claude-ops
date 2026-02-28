#!/usr/bin/env python3
"""Time-window inbox scan and acceptance emoji counting.

Reads harness inbox.jsonl for recent messages and acceptance.md for pass/fail summary.
Extracted from pre-tool-context-injector.sh lines 228-407.
"""
import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone


def parse_ts(ts_str):
    """Parse ISO timestamp string to epoch seconds."""
    try:
        dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
        return dt.timestamp()
    except (ValueError, TypeError):
        return None


def scan_inbox(harness_dir, scan_window, max_messages, now):
    """Scan inbox.jsonl for recent messages, grouped by sender."""
    inbox_path = os.path.join(harness_dir, "inbox.jsonl")
    if not os.path.exists(inbox_path):
        return []

    recent_msgs = []
    try:
        with open(inbox_path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                    ts = msg.get("ts", "")
                    if ts:
                        epoch = parse_ts(ts)
                        if epoch is not None and (now - epoch) <= scan_window:
                            recent_msgs.append(msg)
                except json.JSONDecodeError:
                    pass
    except OSError:
        pass

    if not recent_msgs:
        return []

    by_sender = {}
    for msg in recent_msgs:
        sender = msg.get("from", "unknown")
        by_sender.setdefault(sender, []).append(msg)

    lines = []
    total = 0
    for sender, msgs in sorted(by_sender.items()):
        for msg in msgs[-max_messages:]:
            if total >= max_messages:
                break
            mtype = msg.get("type", "?").upper()
            content = msg.get("content", msg.get("description", ""))
            if len(content) > 100:
                content = content[:100] + "..."
            lines.append(f"- {mtype} from {sender}: {content}")
            total += 1
        if total >= max_messages:
            break

    if not lines:
        return []

    remaining = len(recent_msgs) - total
    header = f"[Inbox] {len(recent_msgs)} recent message(s)"
    if remaining > 0:
        header += f" — and {remaining} more, read inbox.jsonl directly"
    return [header] + lines


def scan_acceptance(harness_dir):
    """Scan acceptance.md for emoji counts and failing criteria."""
    acceptance_path = os.path.join(harness_dir, "acceptance.md")
    if not os.path.exists(acceptance_path):
        return []

    try:
        with open(acceptance_path) as f:
            content = f.read()
    except OSError:
        return []

    pass_count = content.count("\u2705")      # check
    fail_count = content.count("\u274c")      # cross
    untested_count = content.count("\u2b1c")  # white square
    regressed_count = content.count("\U0001f504")  # arrows
    total_count = pass_count + fail_count + untested_count + regressed_count
    if total_count == 0:
        return []

    summary = f"[Acceptance] {pass_count}/{total_count} passing"
    parts = []
    if fail_count:
        parts.append(f"{fail_count} failing")
    if regressed_count:
        parts.append(f"{regressed_count} regressed")
    if untested_count:
        parts.append(f"{untested_count} untested")
    if parts:
        summary += ", " + ", ".join(parts)

    lines = [summary]

    failing_criteria = []
    for line in content.split("\n"):
        if "\u274c" in line or "\U0001f504" in line:
            cells = [c.strip() for c in line.split("|") if c.strip()]
            if len(cells) >= 3:
                crit_num = cells[0]
                crit_name = cells[1]
                status = "\u274c" if "\u274c" in line else "\U0001f504"
                failing_criteria.append(f"- {status} {crit_num}: {crit_name}")

    for fc in failing_criteria[:3]:
        lines.append(fc)

    return lines


def main():
    parser = argparse.ArgumentParser(description="Inbox scan + acceptance summary")
    parser.add_argument("--window", type=int, default=1800, help="Scan window in seconds")
    parser.add_argument("--max", type=int, default=20, help="Max messages to show")
    parser.add_argument("--acceptance", action="store_true", default=True, dest="acceptance")
    parser.add_argument("--no-acceptance", action="store_false", dest="acceptance")
    args = parser.parse_args()

    harness = os.environ.get("HARNESS", "")
    harness_dir = os.environ.get("HARNESS_DIR", "")

    if not harness or not harness_dir:
        sys.exit(0)

    now = time.time()
    all_lines = []

    # 1. Inbox messages
    all_lines.extend(scan_inbox(harness_dir, args.window, args.max, now))

    # 2. Acceptance summary
    if args.acceptance:
        all_lines.extend(scan_acceptance(harness_dir))

    if all_lines:
        print("\n".join(all_lines))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.exit(0)
