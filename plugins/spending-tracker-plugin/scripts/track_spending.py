#!/usr/bin/env python3
"""
Claude Code Spending Tracker

Called by statusline-command.sh on every statusline refresh.
Tracks per-session costs with file-based locking to handle concurrent calls.

Storage: {data_dir}/sessions.json — maps session_id → {cost, first_seen, last_updated}
         {data_dir}/sessions.json.lock — flock-based lock file
         Also reads legacy data from ~/.claude/spending_data/daily.json for all-time totals.

Commands:
  add-session --session-id ID --cost DOLLARS
    Upserts session cost. Returns {"delta_added": float} (the new spend since last update).
    Also records the delta with timestamp for accurate hourly rate tracking.

  get --format json
    Returns {"daily_total", "weekly_total", "hourly_total", "monthly_total",
             "all_time_total", "session_count", "active_sessions_1h"}
    - daily/weekly/monthly use LOCAL timezone boundaries (not UTC)
    - weekly is a rolling 7-day window (not calendar week)
    - hourly is actual incremental spend in the last 60 minutes (not session totals)
"""

import argparse
import fcntl
import json
import os
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timedelta

MAX_LOCK_WAIT = 2.0  # seconds — statusline must be fast
LOCK_POLL_INTERVAL = 0.05
# Prune sessions older than 90 days on write
PRUNE_AGE_DAYS = 90
# Keep deltas for 24h (only need 1h for display, but 24h gives headroom)
DELTA_RETENTION_SECS = 86400
# Legacy data directory (old tracker with daily.json)
LEGACY_DATA_DIR = os.path.expanduser("~/.claude/spending_data")


@contextmanager
def file_lock(lock_path: str, timeout: float = MAX_LOCK_WAIT):
    """Acquire an exclusive flock with timeout. Yields True if acquired, False if timed out."""
    lock_fd = None
    acquired = False
    try:
        lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o644)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
                break
            except (IOError, OSError):
                time.sleep(LOCK_POLL_INTERVAL)
        yield acquired
    finally:
        if lock_fd is not None:
            if acquired:
                try:
                    fcntl.flock(lock_fd, fcntl.LOCK_UN)
                except (IOError, OSError):
                    pass
            os.close(lock_fd)


def load_db(db_path: str) -> dict:
    """Load sessions DB. Returns {"sessions": {id: {...}}, "version": 1}."""
    if not os.path.exists(db_path):
        return {"version": 1, "sessions": {}}
    try:
        with open(db_path, "r") as f:
            data = json.load(f)
        if not isinstance(data, dict) or "sessions" not in data:
            # Corrupt or old format — start fresh but back up
            backup = db_path + f".bak.{int(time.time())}"
            os.rename(db_path, backup)
            return {"version": 1, "sessions": {}}
        return data
    except (json.JSONDecodeError, IOError, UnicodeDecodeError, ValueError):
        # Corrupt file — back up and start fresh
        if os.path.exists(db_path):
            backup = db_path + f".bak.{int(time.time())}"
            try:
                os.rename(db_path, backup)
            except OSError:
                pass
        return {"version": 1, "sessions": {}}


def save_db(db_path: str, data: dict):
    """Atomic write: write to temp file then rename."""
    tmp_path = db_path + ".tmp"
    try:
        with open(tmp_path, "w") as f:
            json.dump(data, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, db_path)
    except (IOError, OSError) as e:
        # Clean up temp file if rename failed
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise e


def prune_old_sessions(data: dict) -> int:
    """Remove sessions older than PRUNE_AGE_DAYS and stale deltas."""
    now = time.time()
    cutoff = now - (PRUNE_AGE_DAYS * 86400)
    to_remove = [
        sid for sid, info in data["sessions"].items()
        if info.get("last_updated", info.get("first_seen", 0)) < cutoff
    ]
    for sid in to_remove:
        del data["sessions"][sid]
    # Also prune old deltas
    if "deltas" in data:
        delta_cutoff = now - DELTA_RETENTION_SECS
        data["deltas"] = [e for e in data["deltas"] if e["t"] >= delta_cutoff]
    return len(to_remove)


def load_legacy_daily_totals() -> dict:
    """Load the old tracker's daily.json for historical all-time totals.
    Returns {date_str: total_cost} dict."""
    legacy_file = os.path.join(LEGACY_DATA_DIR, "daily.json")
    if not os.path.exists(legacy_file):
        return {}
    try:
        with open(legacy_file, "r") as f:
            data = json.load(f)
        return {k: v.get("total_cost", 0) for k, v in data.items() if isinstance(v, dict)}
    except (json.JSONDecodeError, IOError):
        return {}


def cmd_add_session(args, data_dir: str):
    """Add or update a session's cost. Print delta."""
    db_path = os.path.join(data_dir, "sessions.json")
    lock_path = db_path + ".lock"

    session_id = args.session_id
    new_cost = args.cost

    if new_cost < 0:
        print(json.dumps({"error": "cost must be non-negative", "delta_added": 0}))
        return

    with file_lock(lock_path) as acquired:
        if not acquired:
            # Lock timeout — don't block statusline, just report zero delta
            print(json.dumps({"delta_added": 0, "warning": "lock_timeout"}))
            return

        data = load_db(db_path)
        now = time.time()

        existing = data["sessions"].get(session_id)
        if existing:
            old_cost = existing.get("cost", 0)
            delta = max(0, new_cost - old_cost)  # Cost should only go up
            existing["cost"] = max(new_cost, old_cost)
            existing["last_updated"] = now
        else:
            delta = new_cost
            data["sessions"][session_id] = {
                "cost": new_cost,
                "first_seen": now,
                "last_updated": now,
            }

        # Record delta for accurate hourly rate tracking
        if delta > 0:
            if "deltas" not in data:
                data["deltas"] = []
            data["deltas"].append({"t": now, "d": round(delta, 8)})
            # Prune stale deltas inline (cheap — list is small)
            delta_cutoff = now - DELTA_RETENTION_SECS
            data["deltas"] = [e for e in data["deltas"] if e["t"] >= delta_cutoff]

        # Periodic prune (roughly every 100 sessions)
        if len(data["sessions"]) > 100 and hash(session_id) % 20 == 0:
            prune_old_sessions(data)

        save_db(db_path, data)

    print(json.dumps({"delta_added": round(delta, 8)}))


def cmd_get(args, data_dir: str):
    """Read totals without locking (read-only, eventual consistency is fine)."""
    db_path = os.path.join(data_dir, "sessions.json")
    data = load_db(db_path)
    sessions = data.get("sessions", {})
    deltas = data.get("deltas", [])
    now = time.time()

    # ── Fix #1: LOCAL timezone boundaries (not UTC) ──
    local_now = datetime.now()
    day_start = local_now.replace(
        hour=0, minute=0, second=0, microsecond=0
    ).timestamp()
    # ── Fix #2: rolling 7-day window (not calendar week) ──
    week_start = (
        local_now - timedelta(days=7)
    ).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    month_start = local_now.replace(
        day=1, hour=0, minute=0, second=0, microsecond=0
    ).timestamp()
    hour_ago = now - 3600

    daily_total = 0.0
    weekly_total = 0.0
    monthly_total = 0.0
    all_time_total = 0.0
    active_1h = 0

    for sid, info in sessions.items():
        cost = info.get("cost", 0)
        first_seen = info.get("first_seen", 0)
        last_updated = info.get("last_updated", first_seen)

        all_time_total += cost

        # A session counts toward a period if it was first seen in that period
        if first_seen >= month_start:
            monthly_total += cost
        if first_seen >= week_start:
            weekly_total += cost
        if first_seen >= day_start:
            daily_total += cost
        if last_updated >= hour_ago:
            active_1h += 1

    # ── Fix #3: hourly = actual incremental deltas, not session totals ──
    hourly_total = sum(e["d"] for e in deltas if e["t"] >= hour_ago)

    # ── Merge legacy tracker data (old ~/.claude/spending_data/daily.json) ──
    legacy_daily = load_legacy_daily_totals()
    legacy_all_time = sum(legacy_daily.values())
    # Add legacy daily entries that fall within current periods
    for date_str, cost in legacy_daily.items():
        try:
            entry_ts = datetime.strptime(date_str, "%Y-%m-%d").replace(
                hour=0, minute=0, second=0, microsecond=0
            ).timestamp()
        except ValueError:
            continue
        if entry_ts >= month_start:
            monthly_total += cost
        if entry_ts >= week_start:
            weekly_total += cost
        if entry_ts >= day_start:
            daily_total += cost

    result = {
        "hourly_total": round(hourly_total, 4),
        "daily_total": round(daily_total, 4),
        "weekly_total": round(weekly_total, 4),
        "monthly_total": round(monthly_total, 4),
        "all_time_total": round(all_time_total + legacy_all_time, 4),
        "session_count": len(sessions),
        "active_sessions_1h": active_1h,
    }

    if args.format == "json":
        print(json.dumps(result))
    else:
        print(f"Hourly:    ${result['hourly_total']:.2f}  ({active_1h} active sessions)")
        print(f"Daily:     ${result['daily_total']:.2f}")
        print(f"Weekly:    ${result['weekly_total']:.2f}")
        print(f"Monthly:   ${result['monthly_total']:.2f}")
        print(f"All-time:  ${result['all_time_total']:.2f}  ({result['session_count']} sessions)")


def cmd_history(args, data_dir: str):
    """Show recent sessions sorted by cost (descending)."""
    db_path = os.path.join(data_dir, "sessions.json")
    data = load_db(db_path)
    sessions = data.get("sessions", {})

    items = sorted(sessions.items(), key=lambda x: x[1].get("cost", 0), reverse=True)
    limit = args.limit or 20

    for sid, info in items[:limit]:
        cost = info.get("cost", 0)
        first = datetime.fromtimestamp(info.get("first_seen", 0)).strftime("%Y-%m-%d %H:%M")
        last = datetime.fromtimestamp(info.get("last_updated", 0)).strftime("%H:%M")
        print(f"  ${cost:>8.4f}  {first}–{last}  {sid[:16]}…")


def cmd_reset(args, data_dir: str):
    """Reset all data (with confirmation)."""
    db_path = os.path.join(data_dir, "sessions.json")
    lock_path = db_path + ".lock"

    if not args.yes:
        print("Pass --yes to confirm reset")
        return

    with file_lock(lock_path) as acquired:
        if not acquired:
            print(json.dumps({"error": "lock_timeout"}))
            return
        backup = db_path + f".bak.{int(time.time())}"
        if os.path.exists(db_path):
            os.rename(db_path, backup)
            print(json.dumps({"reset": True, "backup": backup}))
        else:
            print(json.dumps({"reset": True, "note": "no data to reset"}))


def main():
    parser = argparse.ArgumentParser(description="Claude Code Spending Tracker")
    parser.add_argument("--data-dir", required=True, help="Directory for data storage")

    sub = parser.add_subparsers(dest="command")

    add_p = sub.add_parser("add-session")
    add_p.add_argument("--session-id", required=True)
    add_p.add_argument("--cost", type=float, required=True)

    get_p = sub.add_parser("get")
    get_p.add_argument("--format", choices=["json", "text"], default="text")

    hist_p = sub.add_parser("history")
    hist_p.add_argument("--limit", type=int, default=20)

    reset_p = sub.add_parser("reset")
    reset_p.add_argument("--yes", action="store_true")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    # Ensure data dir exists
    os.makedirs(args.data_dir, exist_ok=True)

    if args.command == "add-session":
        cmd_add_session(args, args.data_dir)
    elif args.command == "get":
        cmd_get(args, args.data_dir)
    elif args.command == "history":
        cmd_history(args, args.data_dir)
    elif args.command == "reset":
        cmd_reset(args, args.data_dir)


if __name__ == "__main__":
    main()
