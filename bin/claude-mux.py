#!/usr/bin/env python3
"""claude-mux — Claude Code account multiplexer.

Switch between multiple Claude Code Max subscriptions by swapping
OAuth credentials in/out of the macOS Keychain.

Usage:
    claude-mux                     Interactive: probe all, pick one, switch
    claude-mux switch [email]      Switch (no arg = interactive pick)
    claude-mux save [email]        Save current keychain creds
    claude-mux check [email]       Probe exact /usage via tmux (default: active)
    claude-mux check-all           Probe all accounts in parallel
    claude-mux status              Quick view from cache (no probing)
    claude-mux resume [session_id] Check all (parallel), pick best, resume session
    claude-mux switchall <email>   Kill all Claude sessions, switch, resume all
    claude-mux gcal-sync [email]   Push cached usage → gcal events (no probing)
    claude-mux gcal-sync-all       Push all cached usage → gcal
    claude-mux gcal-set <email> <s%> <w%> <s_resets> <w_resets>  Direct gcal update
    claude-mux watch [minutes]     Daemon: probe all + update gcal (default: 15m)
    claude-mux refresh-daemon      Background token refresh loop

Accepts email, email prefix, or internal label for account identification.
All probing uses parallel tmux panes for speed.
"""

import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ACCOUNTS_DIR = Path.home() / ".claude" / "accounts"
CONFIG_PATH = ACCOUNTS_DIR / "config.json"
CACHE_PATH = ACCOUNTS_DIR / "usage_cache.json"
KEYCHAIN_SERVICE = "Claude Code-credentials"
KEYCHAIN_ACCOUNT = "wz"

# ── Helpers ──────────────────────────────────────────────────────────

def run(cmd, **kwargs):
    """Run a command, return stdout. Raises on failure unless check=False."""
    kwargs.setdefault("capture_output", True)
    kwargs.setdefault("text", True)
    kwargs.setdefault("check", True)
    return subprocess.run(cmd, **kwargs)


def load_config():
    with open(CONFIG_PATH) as f:
        return json.load(f)


def save_config(cfg):
    with open(CONFIG_PATH, "w") as f:
        json.dump(cfg, f, indent=2)
        f.write("\n")


def load_cache():
    try:
        with open(CACHE_PATH) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_cache(cache):
    with open(CACHE_PATH, "w") as f:
        json.dump(cache, f, indent=2)
        f.write("\n")


def keychain_read():
    """Read current credentials JSON from macOS Keychain."""
    r = run(["security", "find-generic-password",
             "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
            check=False)
    if r.returncode != 0:
        return None
    return r.stdout.strip()


def keychain_write(creds_json):
    """Write credentials JSON to macOS Keychain."""
    run(["security", "add-generic-password", "-U",
         "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT,
         "-w", creds_json])


def auth_status():
    """Run `claude auth status --json` and return parsed dict."""
    env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}
    r = run(["claude", "auth", "status", "--json"], env=env, check=False)
    if r.returncode != 0:
        return None
    try:
        return json.loads(r.stdout.strip())
    except json.JSONDecodeError:
        return None


def email_to_label(email, cfg):
    """Look up label for an email in config."""
    for label, info in cfg["accounts"].items():
        if info["email"] == email:
            return label
    return None


def resolve(identifier, cfg):
    """Resolve a label or email to a label. Returns (label, email) or (None, None)."""
    if identifier in cfg["accounts"]:
        return identifier, cfg["accounts"][identifier]["email"]
    # Try as email
    for label, info in cfg["accounts"].items():
        if info["email"] == identifier:
            return label, info["email"]
    # Try as email prefix (e.g. "alice" matches "alice@example.com")
    for label, info in cfg["accounts"].items():
        if info["email"].startswith(identifier):
            return label, info["email"]
    return None, None


def active_email(cfg):
    """Get the email of the active account."""
    label = cfg.get("active")
    if label and label in cfg["accounts"]:
        return cfg["accounts"][label]["email"]
    return None


def save_creds_file(label, creds_json):
    """Save credentials to ~/.claude/accounts/{label}.json with mode 600."""
    path = ACCOUNTS_DIR / f"{label}.json"
    path.write_text(creds_json + "\n")
    path.chmod(0o600)


def load_creds_file(label):
    """Load credentials from ~/.claude/accounts/{label}.json."""
    path = ACCOUNTS_DIR / f"{label}.json"
    if not path.exists():
        return None
    return path.read_text().strip()


def check_token_expiry(label):
    """Check if saved token is expired. Returns (expired: bool, hours_left: float)."""
    raw = load_creds_file(label)
    if not raw:
        return True, 0.0
    try:
        data = json.loads(raw)
        oauth = data.get("claudeAiOauth", {})
        expires_ms = oauth.get("expiresAt", 0)
        now_ms = time.time() * 1000
        hours_left = (expires_ms - now_ms) / 3_600_000
        return expires_ms < now_ms, hours_left
    except (json.JSONDecodeError, TypeError):
        return True, 0.0


# ── Commands ─────────────────────────────────────────────────────────

def cmd_save(args):
    """Save current keychain credentials to a label."""
    cfg = load_config()
    creds = keychain_read()
    if not creds:
        print("✗ No credentials found in Keychain.")
        return 1

    status = auth_status()
    if not status or not status.get("loggedIn"):
        print("✗ claude auth status failed—not logged in?")
        return 1

    email = status.get("email", "unknown")

    if args:
        label, _ = resolve(args[0], cfg)
        if not label:
            label = args[0]  # New label
    else:
        label = email_to_label(email, cfg)
        if not label:
            print(f"✗ No account configured for {email}. Pass a label explicitly.")
            return 1

    # Register in config if needed
    if label not in cfg["accounts"]:
        cfg["accounts"][label] = {
            "email": email,
            "session_cap": 1.0,
            "weekly_cap": 1.0,
        }
    cfg["active"] = label
    save_config(cfg)

    save_creds_file(label, creds)
    print(f"✓ Saved credentials for {email}")
    return 0


def cmd_switch(args):
    """Switch active account. No args = interactive pick."""
    if not args:
        return _interactive_pick()

    cfg = load_config()
    target, target_email = resolve(args[0], cfg)
    if not target:
        print(f"✗ Unknown account: {args[0]}")
        print(f"  Known: {', '.join(a['email'] for a in cfg['accounts'].values())}")
        return 1

    target_creds = load_creds_file(target)
    if not target_creds:
        print(f"✗ No saved credentials for {target_email}.")
        print(f"  Login then run: claude-mux save {target_email}")
        return 1

    # Auto-save current credentials (captures any refreshed tokens)
    current_label = cfg.get("active")
    if current_label and current_label != target:
        current_status = auth_status()
        expected_email = cfg["accounts"].get(current_label, {}).get("email")
        if current_status and current_status.get("email") == expected_email:
            current_creds = keychain_read()
            if current_creds:
                save_creds_file(current_label, current_creds)
                print(f"  Auto-saved refreshed creds for {expected_email}")

    # Swap in target credentials
    keychain_write(target_creds)

    # Verify
    status = auth_status()
    if not status or not status.get("loggedIn"):
        print(f"✗ Switch failed—auth status check failed.")
        return 1

    actual_email = status.get("email", "")
    expected_email = cfg["accounts"][target]["email"]
    if actual_email != expected_email:
        print(f"⚠ Email mismatch: expected {expected_email}, got {actual_email}")

    # Re-save after verify (claude auth status may have refreshed the token)
    refreshed_creds = keychain_read()
    if refreshed_creds:
        save_creds_file(target, refreshed_creds)

    cfg["active"] = target
    save_config(cfg)
    print(f"✓ Switched to {actual_email}")

    # Live usage probe
    print(f"  Checking usage...", end=" ", flush=True)
    result = _probe_usage(target)
    if result:
        cache = load_cache()
        cache[target] = result
        save_cache(cache)
        s = result.get("session_pct", "?")
        w = result.get("weekly_pct", "?")
        print(f"session {s}% | weekly {w}%")
    else:
        print("probe failed")

    # Chrome session check
    chrome_check(expected_email)
    return 0


def chrome_check(expected_email):
    """Navigate Chrome's claude.ai tab to settings so user can verify/switch account."""
    try:
        # Check if Chrome is running and has a claude.ai tab
        check_script = '''
        tell application "System Events"
            if not (exists process "Google Chrome") then return "not_running"
        end tell
        tell application "Google Chrome"
            repeat with w in windows
                repeat with t in tabs of w
                    if URL of t contains "claude.ai" then
                        return "found"
                    end if
                end repeat
            end repeat
            return "no_tab"
        end tell
        '''
        r = run(["osascript", "-e", check_script], check=False, timeout=5)
        result = r.stdout.strip()
        if result != "found":
            return

        # Navigate the claude.ai tab to settings (shows account + logout button)
        nav_script = '''
        tell application "Google Chrome"
            repeat with w in windows
                set tabIndex to 0
                repeat with t in tabs of w
                    set tabIndex to tabIndex + 1
                    if URL of t contains "claude.ai" then
                        set URL of t to "https://claude.ai/settings"
                        -- Bring this tab and window to front
                        set active tab index of w to tabIndex
                        set index of w to 1
                        activate
                        return "navigated"
                    end if
                end repeat
            end repeat
        end tell
        '''
        r = run(["osascript", "-e", nav_script], check=False, timeout=5)
        if r.stdout.strip() == "navigated":
            print(f"  → Chrome opened claude.ai/settings — verify account is {expected_email}")
            print(f"    If wrong: scroll down → Sign Out → log back in with {expected_email}")
    except (subprocess.TimeoutExpired, Exception):
        pass  # Chrome check is best-effort


def cmd_check(args):
    """Probe exact usage via /usage in a temp tmux pane."""
    cfg = load_config()
    if args:
        label, _ = resolve(args[0], cfg)
        if not label:
            print(f"✗ Unknown account: {args[0]}")
            return 1
    else:
        label = cfg.get("active")
        if not label:
            print("✗ No active account. Specify an email.")
            return 1

    original_label = cfg.get("active")
    swapped = False

    try:
        # Swap in target credentials if different from active
        if label != original_label:
            target_creds = load_creds_file(label)
            if not target_creds:
                print(f"✗ No saved credentials for {label}.")
                return 1
            # Save current first
            current_creds = keychain_read()
            keychain_write(target_creds)
            swapped = True

        result = _probe_usage(label)
        if result is None:
            print(f"✗ Failed to probe usage for {label}")
            return 1

        # Update cache
        cache = load_cache()
        cache[label] = result
        save_cache(cache)

        # Display
        _print_account_usage(label, cfg["accounts"][label], result)

        # Auto-add gcal events for exhausted accounts
        _gcal_notify_resets(label, result)
        return 0

    finally:
        # Restore original credentials
        if swapped and original_label:
            orig_creds = load_creds_file(original_label)
            if orig_creds:
                keychain_write(orig_creds)


def _probe_usage(label, pane_name=None):
    """Launch a temp tmux pane, run /usage, parse output.
    If pane_name is given, uses that (for parallel probing)."""
    own_pane = pane_name is None
    if own_pane:
        pane_name = "mux-probe"

    if own_pane:
        run(["tmux", "kill-window", "-t", pane_name], check=False)
        time.sleep(0.5)

    try:
        if own_pane:
            run(["tmux", "new-window", "-d", "-n", pane_name, "-c", "/tmp"])
            run(["tmux", "send-keys", "-t", pane_name,
                 "env -u CLAUDECODE claude --no-chrome", "Enter"])

        # Phase 1: Handle trust prompt
        for i in range(15):
            time.sleep(1)
            r = run(["tmux", "capture-pane", "-t", pane_name, "-p"], check=False)
            output = r.stdout
            if "trust this folder" in output.lower() or "Yes, I trust" in output:
                run(["tmux", "send-keys", "-t", pane_name, "Enter"])
                break
            if 'Try "' in output or "Claude Code" in output:
                break

        # Phase 2: Wait for initialization
        initialized = False
        for i in range(45):
            time.sleep(1)
            r = run(["tmux", "capture-pane", "-t", pane_name, "-p"], check=False)
            if 'Try "' in r.stdout:
                initialized = True
                break

        if not initialized:
            print(f"  ⚠ Claude Code didn't initialize in 60s for {label}")
            return None

        time.sleep(1)

        # Phase 3: Send /usage + select from autocomplete
        run(["tmux", "send-keys", "-t", pane_name, "/usage", "Enter"])
        time.sleep(2)
        run(["tmux", "send-keys", "-t", pane_name, "Enter"])
        time.sleep(5)

        # Capture and parse
        r = run(["tmux", "capture-pane", "-t", pane_name, "-p", "-S", "-80"], check=False)
        result = _parse_usage(r.stdout)

        # Cleanup
        run(["tmux", "send-keys", "-t", pane_name, "Escape"])
        time.sleep(1)
        run(["tmux", "send-keys", "-t", pane_name, "/exit", "Enter"])
        time.sleep(2)

        return result

    finally:
        if own_pane:
            time.sleep(0.5)
            run(["tmux", "kill-window", "-t", pane_name], check=False)


def _probe_all_parallel(labels_with_creds, original_active):
    """Probe accounts sequentially — one at a time.

    Claude Code reads credentials from the shared macOS Keychain live (not just
    at startup), so parallel probes all end up reporting the last-swapped account.
    Serial is the only correct approach with a single keychain entry.
    """
    results = {}
    errors = {}
    pane_name = "mux-probe"

    for label, creds in labels_with_creds:
        # Skip expired tokens — they'll hang on "Loading usage data..." forever
        expired, hours_left = check_token_expiry(label)
        if expired:
            email = label
            errors[label] = f"token expired ({-hours_left:.0f}h ago) — run: claude-mux login {label}"
            continue

        try:
            # Clean slate
            run(["tmux", "kill-window", "-t", pane_name], check=False)
            time.sleep(0.3)

            # Swap creds into keychain for this account
            keychain_write(creds)
            time.sleep(0.3)

            # Launch Claude
            run(["tmux", "new-window", "-d", "-n", pane_name, "-c", "/tmp"])
            run(["tmux", "send-keys", "-t", pane_name,
                 "env -u CLAUDECODE claude --no-chrome", "Enter"])

            # Handle trust prompt
            for i in range(15):
                time.sleep(1)
                r = run(["tmux", "capture-pane", "-t", pane_name, "-p"], check=False)
                output = r.stdout
                if "trust this folder" in output.lower() or "Yes, I trust" in output:
                    run(["tmux", "send-keys", "-t", pane_name, "Enter"])
                    break
                if 'Try "' in output or "Claude Code" in output:
                    break

            # Wait for init
            initialized = False
            for i in range(45):
                time.sleep(1)
                r = run(["tmux", "capture-pane", "-t", pane_name, "-p"], check=False)
                if 'Try "' in r.stdout:
                    initialized = True
                    break

            if not initialized:
                errors[label] = "didn't initialize in 60s"
                continue

            time.sleep(1)

            # Send /usage — opens a TUI panel that loads async
            run(["tmux", "send-keys", "-t", pane_name, "/usage", "Enter"])
            time.sleep(2)
            run(["tmux", "send-keys", "-t", pane_name, "Enter"])

            # Poll until usage data appears (look for "% used" pattern)
            result = None
            for i in range(15):
                time.sleep(2)
                r = run(["tmux", "capture-pane", "-t", pane_name, "-p", "-S", "-80"], check=False)
                result = _parse_usage(r.stdout)
                if result and result.get("session_pct") is not None:
                    break
            else:
                # Last attempt
                result = _parse_usage(r.stdout)
            if result:
                results[label] = result
                email = label  # for progress output
                s = result.get("session_pct", "?")
                w = result.get("weekly_pct", "?")
                print(f"  ✓ {email}: session {s}% | weekly {w}%")

            # Exit Claude
            run(["tmux", "send-keys", "-t", pane_name, "Escape"])
            time.sleep(1)
            run(["tmux", "send-keys", "-t", pane_name, "/exit", "Enter"])
            time.sleep(2)

        except Exception as e:
            errors[label] = str(e)
        finally:
            time.sleep(0.5)
            run(["tmux", "kill-window", "-t", pane_name], check=False)

    # Restore original keychain
    if original_active:
        orig_creds = load_creds_file(original_active)
        if orig_creds:
            keychain_write(orig_creds)

    return results, errors


def _parse_usage(output):
    """Parse /usage output into structured data."""
    result = {
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "session_pct": None,
        "session_resets": None,
        "weekly_pct": None,
        "weekly_resets": None,
        "sonnet_pct": None,
        "sonnet_resets": None,
        "status": "unknown",
    }

    lines = output.split("\n")

    # State machine: track which section we're in
    section = None
    for line in lines:
        stripped = line.strip()

        if "Current session" in stripped:
            section = "session"
            continue
        elif re.search(r"Current week.*all models", stripped, re.I):
            section = "weekly"
            continue
        elif re.search(r"Current week.*Sonnet", stripped, re.I):
            section = "sonnet"
            continue

        pct_match = re.search(r"(\d+)%\s*used", stripped)
        resets_match = re.search(r"Resets\s+(.+)", stripped)

        if section and pct_match:
            pct = int(pct_match.group(1))
            if section == "session":
                result["session_pct"] = pct
            elif section == "weekly":
                result["weekly_pct"] = pct
            elif section == "sonnet":
                result["sonnet_pct"] = pct

        if section and resets_match:
            resets_str = resets_match.group(1).strip()
            if section == "session":
                result["session_resets"] = resets_str
            elif section == "weekly":
                result["weekly_resets"] = resets_str
            elif section == "sonnet":
                result["sonnet_resets"] = resets_str
            section = None  # Reset after seeing resets line

    # Determine status
    if result["session_pct"] is not None:
        if result["session_pct"] >= 100:
            result["status"] = "session_exhausted"
        elif result["weekly_pct"] is not None and result["weekly_pct"] >= 100:
            result["status"] = "weekly_exhausted"
        else:
            result["status"] = "available"

    return result


def cmd_check_all(args):
    """Probe all accounts in parallel using separate tmux panes."""
    cfg = load_config()
    cache = load_cache()
    original_active = cfg.get("active")

    # Gather accounts with saved creds
    labels_with_creds = []
    for label in cfg["accounts"]:
        creds = load_creds_file(label)
        if not creds:
            email = cfg["accounts"][label]["email"]
            print(f"  ✗ No saved credentials for {email}, skipping")
            continue
        labels_with_creds.append((label, creds))

    if not labels_with_creds:
        print("No accounts with saved credentials.")
        return 1

    n = len(labels_with_creds)
    emails = ", ".join(cfg["accounts"][l]["email"] for l, _ in labels_with_creds)
    print(f"Probing {n} account(s) in parallel: {emails}...")

    results, errors = _probe_all_parallel(labels_with_creds, original_active)

    for label, err in errors.items():
        email = cfg["accounts"].get(label, {}).get("email", label)
        print(f"  ✗ {email}: {err}")

    for label, result in results.items():
        cache[label] = result

    save_cache(cache)
    print()
    _print_table(cfg, cache)

    # Auto-add gcal events for exhausted accounts
    for label, data in results.items():
        _gcal_notify_resets(label, data)

    return 0


def _interactive_pick(force_probe=False):
    """Probe all accounts in parallel, show table, let user pick one to switch to."""
    cfg = load_config()
    cache = load_cache()

    if not force_probe and cache:
        print("Use cached data or re-probe all accounts?")
        print("  1) Use cache (fast)")
        print("  2) Re-probe all (slow but accurate)")
        choice = input("Choice [1]: ").strip()
        if choice == "2":
            cmd_check_all([])
            cache = load_cache()
    else:
        cmd_check_all([])
        cache = load_cache()

    cfg = load_config()  # reload in case check-all changed active
    print()
    _print_table(cfg, cache)
    print()

    labels = list(cfg["accounts"].keys())
    for i, label in enumerate(labels, 1):
        email = cfg["accounts"][label]["email"]
        print(f"  {i}) {email}")

    print()
    choice = input("Pick account number (or email): ").strip()
    try:
        idx = int(choice) - 1
        if 0 <= idx < len(labels):
            return cmd_switch([labels[idx]])
        else:
            print("✗ Invalid choice")
            return 1
    except ValueError:
        resolved, _ = resolve(choice, cfg)
        if resolved:
            return cmd_switch([resolved])
        print("✗ Invalid choice")
        return 1


def cmd_pick(args):
    """Interactive: check-all then pick an account. (Alias for `switch` with no args)"""
    return _interactive_pick()


def cmd_status(args):
    """Quick view from cached data, with Keychain verification."""
    cfg = load_config()
    cache = load_cache()

    # Verify what's actually in the Keychain matches config's active label
    config_active = cfg.get("active")
    config_email = active_email(cfg)
    status = auth_status()
    actual_email = status.get("email") if status and status.get("loggedIn") else None

    if actual_email and config_email and actual_email != config_email:
        # Keychain doesn't match config — find the real account and fix
        real_label = email_to_label(actual_email, cfg)
        if real_label:
            print(f"⚠ Keychain has {actual_email} but config says {config_email}")
            print(f"  Correcting active → {real_label}")
            cfg["active"] = real_label
            save_config(cfg)
        else:
            print(f"⚠ Keychain has {actual_email} (not in config) but config says {config_email}")
    elif not actual_email and config_email:
        print(f"⚠ Auth check failed — can't verify Keychain matches config ({config_email})")

    if not cache:
        print("No cached usage data. Run `claude-mux check-all` first.")
        return 0

    _print_table(cfg, cache)
    return 0


def _find_latest_session():
    """Find the most recently modified session JSONL file."""
    projects_dir = Path.home() / ".claude" / "projects"
    if not projects_dir.exists():
        return None
    # Find all .jsonl files, pick most recent
    sessions = list(projects_dir.rglob("*.jsonl"))
    if not sessions:
        return None
    latest = max(sessions, key=lambda p: p.stat().st_mtime)
    return latest.stem  # session ID is the filename without .jsonl


def _score_account(label, acct_cfg, usage_data):
    """Score an account by available headroom. Higher = more available. Returns None if unusable."""
    s_pct = usage_data.get("session_pct")
    w_pct = usage_data.get("weekly_pct")
    s_cap = acct_cfg.get("session_cap", 1.0) * 100
    w_cap = acct_cfg.get("weekly_cap", 1.0) * 100

    if s_pct is None or w_pct is None:
        return None  # Couldn't probe, skip
    if s_pct >= 100 or s_pct >= s_cap:
        return None  # Session exhausted or at cap
    if w_pct >= 100 or w_pct >= w_cap:
        return None  # Weekly exhausted or at cap

    # Score: weighted combination of remaining session + weekly headroom
    session_room = s_cap - s_pct
    weekly_room = w_cap - w_pct
    return session_room * 0.6 + weekly_room * 0.4


def cmd_resume(args):
    """Check all accounts in parallel, pick best, switch, and resume session."""
    cfg = load_config()

    # Determine session ID
    session_id = args[0] if args else None
    if not session_id:
        session_id = _find_latest_session()
    if not session_id:
        print("✗ No session ID provided and couldn't find a recent session.")
        return 1

    print(f"Session: {session_id}")
    print()

    # Probe all accounts in parallel
    original_active = cfg.get("active")
    cache = load_cache()

    labels_with_creds = []
    for label in cfg["accounts"]:
        creds = load_creds_file(label)
        email = cfg["accounts"][label]["email"]
        if not creds:
            print(f"  {email}: no saved credentials, skipping")
            continue
        labels_with_creds.append((label, creds))

    if not labels_with_creds:
        print("✗ No accounts with saved credentials.")
        return 1

    emails = ", ".join(cfg["accounts"][l]["email"] for l, _ in labels_with_creds)
    print(f"Probing {len(labels_with_creds)} account(s) in parallel: {emails}...")

    probed, errors = _probe_all_parallel(labels_with_creds, original_active)

    for label, err in errors.items():
        email = cfg["accounts"].get(label, {}).get("email", label)
        print(f"  ✗ {email}: {err}")

    for label, result in probed.items():
        cache[label] = result
        email = cfg["accounts"].get(label, {}).get("email", label)
        s = result.get("session_pct", "?")
        w = result.get("weekly_pct", "?")
        print(f"  ✓ {email}: session {s}% | weekly {w}%")

    save_cache(cache)

    if not probed:
        print("\n✗ Couldn't probe any accounts.")
        return 1

    # Score and rank
    scores = []
    for label, data in probed.items():
        acct_cfg = cfg["accounts"][label]
        score = _score_account(label, acct_cfg, data)
        cap_info = f"caps: {int(acct_cfg.get('session_cap',1)*100)}%/{int(acct_cfg.get('weekly_cap',1)*100)}%"
        if score is not None:
            scores.append((score, label, data, cap_info))

    if not scores:
        print("\n✗ All accounts exhausted or at cap.")
        _print_table(cfg, cache)
        return 1

    scores.sort(reverse=True)  # Highest score first
    best_score, best_label, best_data, _ = scores[0]

    print()
    print(f"{'Email':<38} {'Session':<10} {'Weekly':<10} {'Headroom':<10} {'Caps'}")
    print("-" * 80)
    for score, label, data, cap_info in scores:
        email = cfg["accounts"][label]["email"]
        marker = "→ " if label == best_label else "  "
        s = f"{data.get('session_pct', '?')}%"
        w = f"{data.get('weekly_pct', '?')}%"
        print(f"{marker}{email:<38} {s:<10} {w:<10} {score:<10.0f} {cap_info}")

    # Show unavailable accounts too
    for label in cfg["accounts"]:
        if label not in [s[1] for s in scores] and label in probed:
            data = probed[label]
            acct_cfg = cfg["accounts"][label]
            email = acct_cfg["email"]
            cap_info = f"caps: {int(acct_cfg.get('session_cap',1)*100)}%/{int(acct_cfg.get('weekly_cap',1)*100)}%"
            s = f"{data.get('session_pct', '?')}%"
            w = f"{data.get('weekly_pct', '?')}%"
            print(f"  {email:<38} {s:<10} {w:<10} {'—':<10} {cap_info} ✗")

    best_email = cfg["accounts"][best_label]["email"]
    print(f"\nBest: {best_email} (session {best_data.get('session_pct')}%, weekly {best_data.get('weekly_pct')}%)")

    # Switch to best account
    target_creds = load_creds_file(best_label)
    if not target_creds:
        print(f"✗ No saved credentials for {best_email}")
        return 1

    # Auto-save current before switching
    if original_active and original_active != best_label:
        current_creds = keychain_read()
        if current_creds:
            save_creds_file(original_active, current_creds)

    keychain_write(target_creds)

    # Verify
    status = auth_status()
    if not status or not status.get("loggedIn"):
        print(f"✗ Auth verification failed after switch")
        return 1

    # Re-save refreshed creds
    refreshed = keychain_read()
    if refreshed:
        save_creds_file(best_label, refreshed)

    cfg["active"] = best_label
    save_config(cfg)

    print(f"✓ Switched to {best_email}")
    print(f"\nLaunching: claude --resume {session_id}")

    # Exec into claude --resume (replaces this process)
    env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}
    os.execvpe("claude", ["claude", "--resume", session_id], env)


def cmd_refresh_daemon(args):
    """Background token refresh loop — keeps all accounts' tokens fresh."""
    print("claude-mux refresh-daemon starting (Ctrl+C to stop)")
    cfg = load_config()

    while True:
        original_active = cfg.get("active")
        print(f"\n[{datetime.now().strftime('%H:%M:%S')}] Refreshing tokens...")

        for label in cfg["accounts"]:
            email = cfg["accounts"][label]["email"]
            if label == original_active:
                status = auth_status()
                if status and status.get("loggedIn"):
                    refreshed = keychain_read()
                    if refreshed:
                        save_creds_file(label, refreshed)
                    print(f"  ✓ {email} (active) — refreshed")
                else:
                    print(f"  ✗ {email} (active) — auth failed")
                continue

            target_creds = load_creds_file(label)
            if not target_creds:
                print(f"  - {email} — no saved creds, skip")
                continue

            keychain_write(target_creds)
            status = auth_status()
            if status and status.get("loggedIn"):
                refreshed = keychain_read()
                if refreshed:
                    save_creds_file(label, refreshed)
                print(f"  ✓ {email} — refreshed")
            else:
                print(f"  ✗ {email} — auth failed")

        if original_active:
            orig_creds = load_creds_file(original_active)
            if orig_creds:
                keychain_write(orig_creds)

        print(f"Next refresh in 4 hours.")
        try:
            time.sleep(4 * 3600)
        except KeyboardInterrupt:
            print("\nDaemon stopped.")
            return 0


# ── Watch daemon: live gcal usage tracking ───────────────────────────

GCAL_TRACKING = ACCOUNTS_DIR / "gcal_tracking.json"


def _gcal_update_event(event_id, summary, description, start_dt, end_dt, timezone_str, color_id="6"):
    """Update (PATCH) an existing Google Calendar event."""
    import urllib.request

    token = _gcal_get_token()
    event = {
        "summary": summary,
        "description": description,
        "colorId": color_id,
        "start": {"dateTime": start_dt, "timeZone": timezone_str},
        "end": {"dateTime": end_dt, "timeZone": timezone_str},
    }
    data = json.dumps(event).encode()
    req = urllib.request.Request(
        f"https://www.googleapis.com/calendar/v3/calendars/primary/events/{event_id}",
        data=data,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="PATCH",
    )
    try:
        resp = urllib.request.urlopen(req)
        return json.loads(resp.read()).get("id")
    except Exception as e:
        print(f"  ⚠ gcal update failed: {e}")
        return None


def _gcal_create_event_full(summary, description, start_dt, end_dt, timezone_str, color_id="6"):
    """Create a Google Calendar event with explicit start/end. Returns event ID."""
    import urllib.request

    token = _gcal_get_token()
    event = {
        "summary": summary,
        "description": description,
        "colorId": color_id,
        "start": {"dateTime": start_dt, "timeZone": timezone_str},
        "end": {"dateTime": end_dt, "timeZone": timezone_str},
        "reminders": {"useDefault": False, "overrides": [{"method": "popup", "minutes": 0}]},
    }
    data = json.dumps(event).encode()
    req = urllib.request.Request(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events",
        data=data,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        resp = urllib.request.urlopen(req)
        result = json.loads(resp.read())
        return result.get("id")
    except Exception as e:
        print(f"  ⚠ gcal create failed: {e}")
        return None


def _gcal_delete_event(event_id):
    """Delete a Google Calendar event."""
    import urllib.request

    token = _gcal_get_token()
    req = urllib.request.Request(
        f"https://www.googleapis.com/calendar/v3/calendars/primary/events/{event_id}",
        headers={"Authorization": f"Bearer {token}"},
        method="DELETE",
    )
    try:
        urllib.request.urlopen(req)
        return True
    except Exception:
        return False


def _build_reset_end_dt(reset_str):
    """Parse a reset string into an end datetime ISO string and timezone.
    Returns (iso_str, tz) or (None, None)."""
    dt_str, tz = _parse_reset_datetime(reset_str)
    if not dt_str:
        return None, None
    return dt_str, tz


def _usage_bar(pct):
    """Small text usage bar."""
    if pct is None:
        return "?"
    filled = min(pct, 100) // 10
    return "█" * filled + "░" * (10 - filled) + f" {pct}%"


def _color_for_pct(pct):
    """Pick gcal color ID based on usage percentage."""
    if pct is None:
        return "8"   # graphite (unknown)
    if pct >= 100:
        return "11"  # tomato (exhausted)
    if pct >= 80:
        return "6"   # tangerine (high)
    if pct >= 50:
        return "5"   # banana (moderate)
    return "2"       # sage (low)


def _update_tracking_events(label, usage_data, cfg):
    """Create or update gcal events tracking usage for an account."""
    try:
        tracking = json.loads(GCAL_TRACKING.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        tracking = {}

    if label not in tracking:
        tracking[label] = {}

    acct = cfg["accounts"].get(label, {})
    email = acct.get("email", label)
    s_cap = int(acct.get("session_cap", 1.0) * 100)
    w_cap = int(acct.get("weekly_cap", 1.0) * 100)

    s_pct = usage_data.get("session_pct")
    w_pct = usage_data.get("weekly_pct")
    s_resets = usage_data.get("session_resets", "")
    w_resets = usage_data.get("weekly_resets", "")
    son_pct = usage_data.get("sonnet_pct")

    now = datetime.now()
    now_iso = now.strftime("%Y-%m-%dT%H:%M:%S")

    # ── Session event: spans from now to session reset ──
    if s_pct is not None and s_resets:
        s_end, s_tz = _build_reset_end_dt(s_resets)
        # Skip if reset time already passed (start would be after end)
        if s_end and s_end > now_iso:
            s_color = _color_for_pct(s_pct)
            s_status = "EXHAUSTED" if s_pct >= 100 else f"{s_pct}% used"
            s_summary = f"⚡ {email} session: {s_status} (cap {s_cap}%)"
            s_desc = (
                f"Account: {email}\n"
                f"Session: {_usage_bar(s_pct)}\n"
                f"Cap: {s_cap}%\n"
                f"Resets: {s_resets}\n"
                f"\nclaude-mux switch {email}"
            )

            existing_id = tracking[label].get("session_event_id")
            existing_resets = tracking[label].get("session_resets")

            # If reset time changed, delete old event and create new
            if existing_id and existing_resets != s_resets:
                _gcal_delete_event(existing_id)
                existing_id = None

            if existing_id:
                _gcal_update_event(existing_id, s_summary, s_desc, now_iso, s_end, s_tz, s_color)
            else:
                new_id = _gcal_create_event_full(s_summary, s_desc, now_iso, s_end, s_tz, s_color)
                if new_id:
                    tracking[label]["session_event_id"] = new_id

            tracking[label]["session_resets"] = s_resets
            tracking[label]["session_pct"] = s_pct

    # ── Weekly event: spans from now to weekly reset ──
    if w_pct is not None and w_resets:
        w_end, w_tz = _build_reset_end_dt(w_resets)
        if w_end and w_end > now_iso:
            w_color = _color_for_pct(w_pct)
            w_status = "EXHAUSTED" if w_pct >= 100 else f"{w_pct}% used"
            sonnet_str = f" | Sonnet: {son_pct}%" if son_pct is not None else ""
            w_summary = f"📊 {email} weekly: {w_status} (cap {w_cap}%){sonnet_str}"
            w_desc = (
                f"Account: {email}\n"
                f"Weekly: {_usage_bar(w_pct)}\n"
                f"Cap: {w_cap}%\n"
                f"Resets: {w_resets}\n"
            )
            if son_pct is not None:
                w_desc += f"Sonnet: {_usage_bar(son_pct)}\n"
            w_desc += f"\nclaude-mux switch {email}"

            existing_id = tracking[label].get("weekly_event_id")
            existing_resets = tracking[label].get("weekly_resets")

            if existing_id and existing_resets != w_resets:
                _gcal_delete_event(existing_id)
                existing_id = None

            if existing_id:
                _gcal_update_event(existing_id, w_summary, w_desc, now_iso, w_end, w_tz, w_color)
            else:
                new_id = _gcal_create_event_full(w_summary, w_desc, now_iso, w_end, w_tz, w_color)
                if new_id:
                    tracking[label]["weekly_event_id"] = new_id

            tracking[label]["weekly_resets"] = w_resets
            tracking[label]["weekly_pct"] = w_pct

    tracking[label]["last_updated"] = datetime.now(timezone.utc).isoformat()
    GCAL_TRACKING.write_text(json.dumps(tracking, indent=2) + "\n")


def cmd_gcal_sync(args):
    """Push cached usage data to gcal events. No probing—just reads cache."""
    cfg = load_config()
    cache = load_cache()
    if args:
        label, _ = resolve(args[0], cfg)
        if not label:
            print(f"✗ Unknown account: {args[0]}")
            return 1
    else:
        label = cfg.get("active")

    if not label:
        print("✗ No account specified and no active account.")
        return 1
    if label not in cache:
        email = cfg["accounts"].get(label, {}).get("email", label)
        print(f"✗ No cached data for {email}. Run `claude-mux check {email}` first.")
        return 1

    email = cfg["accounts"].get(label, {}).get("email", label)
    data = cache[label]
    s = data.get("session_pct", "?")
    w = data.get("weekly_pct", "?")
    print(f"Syncing {email} (session {s}% | weekly {w}%) → gcal...", end=" ", flush=True)
    _update_tracking_events(label, data, cfg)
    print("done")
    return 0


def cmd_gcal_sync_all(args):
    """Push all cached usage data to gcal events."""
    cfg = load_config()
    cache = load_cache()

    for label in cfg["accounts"]:
        email = cfg["accounts"][label]["email"]
        if label not in cache:
            print(f"  {email}: no cached data, skip")
            continue
        data = cache[label]
        s = data.get("session_pct", "?")
        w = data.get("weekly_pct", "?")
        print(f"  {email} (session {s}% | weekly {w}%)...", end=" ", flush=True)
        try:
            _update_tracking_events(label, data, cfg)
            print("✓")
        except Exception as e:
            print(f"✗ {e}")

    return 0


def cmd_gcal_set(args):
    """Direct gcal update: claude-mux gcal-set <email> <s%> <w%> <s_resets> <w_resets> [sonnet%]"""
    if len(args) < 5:
        print("Usage: claude-mux gcal-set <email> <session%> <weekly%> <session_resets> <weekly_resets> [sonnet%]")
        print('Example: claude-mux gcal-set alice@example.com 35 67 "4pm (America/Chicago)" "Feb 26 at 10am (America/Chicago)"')
        return 1

    cfg = load_config()
    label, _ = resolve(args[0], cfg)
    if not label:
        label = args[0]  # Allow raw label for backwards compat
    try:
        s_pct = int(args[1])
        w_pct = int(args[2])
    except ValueError:
        print("✗ session% and weekly% must be integers")
        return 1

    s_resets = args[3]
    w_resets = args[4]
    son_pct = int(args[5]) if len(args) > 5 else None
    data = {
        "session_pct": s_pct,
        "weekly_pct": w_pct,
        "session_resets": s_resets,
        "weekly_resets": w_resets,
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "status": "session_exhausted" if s_pct >= 100 else ("weekly_exhausted" if w_pct >= 100 else "available"),
    }
    if son_pct is not None:
        data["sonnet_pct"] = son_pct

    # Update cache too
    cache = load_cache()
    cache[label] = data
    save_cache(cache)

    email = cfg["accounts"].get(label, {}).get("email", label)
    print(f"Pushing {email} (session {s_pct}% | weekly {w_pct}%) → gcal...", end=" ", flush=True)
    _update_tracking_events(label, data, cfg)
    _gcal_notify_resets(label, data)
    print("done")
    return 0


def cmd_watch(args):
    """Watch daemon: probe all accounts every N minutes, update gcal events."""
    interval = 15  # default minutes
    if args:
        try:
            interval = int(args[0])
        except ValueError:
            pass

    print(f"claude-mux watch daemon starting (every {interval}m, Ctrl+C to stop)")
    print(f"Tracking file: {GCAL_TRACKING}")

    while True:
        cfg = load_config()
        original_active = cfg.get("active")
        cache = load_cache()
        ts = datetime.now().strftime("%H:%M:%S")
        print(f"\n[{ts}] Probing all accounts in parallel...")

        labels_with_creds = []
        for label in cfg["accounts"]:
            email = cfg["accounts"][label]["email"]
            creds = load_creds_file(label)
            if not creds:
                print(f"  {email}: no saved creds, skip")
                continue
            labels_with_creds.append((label, creds))

        if labels_with_creds:
            results, errors = _probe_all_parallel(labels_with_creds, original_active)

            for label, err in errors.items():
                email = cfg["accounts"].get(label, {}).get("email", label)
                print(f"  ✗ {email}: {err}")

            for label, result in results.items():
                cache[label] = result
                email = cfg["accounts"].get(label, {}).get("email", label)
                s = result.get("session_pct", "?")
                w = result.get("weekly_pct", "?")
                print(f"  ✓ {email}: session {s}% | weekly {w}%")

                # Update gcal tracking events
                try:
                    _update_tracking_events(label, result, cfg)
                    print(f"    📅 gcal updated")
                except Exception as e:
                    print(f"    ⚠ gcal update failed: {e}")

                # Also fire one-time reset notifications
                _gcal_notify_resets(label, result)

        save_cache(cache)
        _print_table(cfg, cache)

        print(f"\nNext check in {interval}m. Ctrl+C to stop.")
        try:
            time.sleep(interval * 60)
        except KeyboardInterrupt:
            print("\nWatch daemon stopped.")
            return 0


# ── Google Calendar integration ──────────────────────────────────────

GCAL_OAUTH_CREDS = Path.home() / ".gmail-mcp" / "gcp-oauth.keys.json"
GCAL_TOKENS = Path.home() / ".config" / "google-calendar-mcp" / "tokens.json"
GCAL_EVENTS_LOG = ACCOUNTS_DIR / "gcal_events.json"


def _gcal_get_token():
    """Get a fresh Google Calendar access token, refreshing if needed."""
    import urllib.request
    import urllib.parse

    creds = json.loads(GCAL_OAUTH_CREDS.read_text())
    installed = creds.get("installed", creds.get("web", {}))
    tokens = json.loads(GCAL_TOKENS.read_text())

    data = urllib.parse.urlencode({
        "client_id": installed["client_id"],
        "client_secret": installed["client_secret"],
        "refresh_token": tokens["normal"]["refresh_token"],
        "grant_type": "refresh_token",
    }).encode()

    req = urllib.request.Request("https://oauth2.googleapis.com/token", data=data)
    resp = urllib.request.urlopen(req)
    result = json.loads(resp.read())

    # Update stored token
    tokens["normal"]["access_token"] = result["access_token"]
    GCAL_TOKENS.write_text(json.dumps(tokens, indent=2))

    return result["access_token"]


def _gcal_create_event(summary, description, start_dt, timezone_str, duration_min=5, color_id="6"):
    """Create a Google Calendar event. Returns event link or None."""
    import urllib.request

    token = _gcal_get_token()

    # Build end time
    from datetime import timedelta
    end_dt = (datetime.fromisoformat(start_dt) + timedelta(minutes=duration_min)).isoformat()

    event = {
        "summary": summary,
        "description": description,
        "colorId": color_id,
        "start": {"dateTime": start_dt, "timeZone": timezone_str},
        "end": {"dateTime": end_dt, "timeZone": timezone_str},
        "reminders": {"useDefault": False, "overrides": [{"method": "popup", "minutes": 0}]},
    }

    data = json.dumps(event).encode()
    req = urllib.request.Request(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events",
        data=data,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        resp = urllib.request.urlopen(req)
        result = json.loads(resp.read())
        return result.get("htmlLink")
    except Exception as e:
        print(f"  ⚠ gcal create failed: {e}")
        return None


def _parse_reset_datetime(reset_str):
    """Parse reset strings like '4pm (America/Chicago)' or 'Feb 26 at 10am (America/Chicago)'.
    Returns (iso_datetime_str, timezone_str) or (None, None)."""
    tz_match = re.search(r'\(([^)]+)\)', reset_str)
    tz = tz_match.group(1) if tz_match else "America/Chicago"
    time_part = re.sub(r'\s*\([^)]+\)\s*', '', reset_str).strip()

    now = datetime.now()

    # Pattern: "4pm" or "3:59pm" (today)
    m = re.match(r'^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$', time_part, re.I)
    if m:
        hour = int(m.group(1))
        minute = int(m.group(2) or 0)
        if m.group(3).lower() == 'pm' and hour < 12:
            hour += 12
        if m.group(3).lower() == 'am' and hour == 12:
            hour = 0
        dt = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        return dt.strftime("%Y-%m-%dT%H:%M:%S"), tz

    # Pattern: "Feb 26 at 10am" or "Feb 26 at 3pm"
    m = re.match(r'^(\w+)\s+(\d{1,2})\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)$', time_part, re.I)
    if m:
        import calendar
        month_name = m.group(1)
        day = int(m.group(2))
        hour = int(m.group(3))
        minute = int(m.group(4) or 0)
        if m.group(5).lower() == 'pm' and hour < 12:
            hour += 12
        if m.group(5).lower() == 'am' and hour == 12:
            hour = 0
        # Find month number
        month_num = None
        for i, name in enumerate(calendar.month_abbr):
            if name.lower() == month_name[:3].lower():
                month_num = i
                break
        if month_num is None:
            return None, None
        year = now.year
        dt = datetime(year, month_num, day, hour, minute)
        return dt.strftime("%Y-%m-%dT%H:%M:%S"), tz

    return None, None


def _gcal_notify_resets(label, usage_data):
    """If account is exhausted, create gcal events for reset times. Deduplicates."""
    # Load event log to avoid duplicates
    try:
        event_log = json.loads(GCAL_EVENTS_LOG.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        event_log = {}

    email = ""
    try:
        cfg = load_config()
        email = cfg["accounts"].get(label, {}).get("email", label)
    except Exception:
        email = label

    created = []

    for kind, pct_key, resets_key in [
        ("session", "session_pct", "session_resets"),
        ("weekly", "weekly_pct", "weekly_resets"),
    ]:
        pct = usage_data.get(pct_key)
        resets = usage_data.get(resets_key)
        if pct is None or pct < 100 or not resets:
            continue

        dedup_key = f"{label}:{kind}:{resets}"
        if dedup_key in event_log:
            continue  # Already created

        dt_str, tz = _parse_reset_datetime(resets)
        if not dt_str:
            continue

        summary = f"🔓 {email} {kind} resets"
        desc = f"Claude Max {kind} limit resets for {email}.\nclaude-mux switch {email}"
        link = _gcal_create_event(summary, desc, dt_str, tz)
        if link:
            event_log[dedup_key] = {
                "created_at": datetime.now(timezone.utc).isoformat(),
                "link": link,
            }
            created.append((kind, resets, link))

    if created:
        GCAL_EVENTS_LOG.write_text(json.dumps(event_log, indent=2) + "\n")
        for kind, resets, link in created:
            print(f"  📅 {label} {kind} reset → gcal (resets {resets})")

    return created


# ── switchall: scan tmux, swap all Claude sessions ───────────────────

def _find_claude_panes():
    """Find all tmux panes running Claude Code. Returns list of dicts."""
    # List all panes with their PIDs
    r = run(["tmux", "list-panes", "-a", "-F",
             "#{session_name}:#{window_index}.#{pane_index} #{pane_pid}"],
            check=False)
    if r.returncode != 0:
        return []

    panes = []
    for line in r.stdout.strip().split("\n"):
        if not line.strip():
            continue
        parts = line.strip().split()
        if len(parts) < 2:
            continue
        pane_target, pane_pid = parts[0], parts[1]

        # Check if this pane has a claude child process
        r2 = run(["pgrep", "-P", pane_pid], check=False)
        if r2.returncode != 0:
            continue

        child_pids = r2.stdout.strip().split("\n")
        for cpid in child_pids:
            cpid = cpid.strip()
            if not cpid:
                continue
            r3 = run(["ps", "-o", "command=", "-p", cpid], check=False)
            cmd_line = r3.stdout.strip()
            if "claude" in cmd_line.lower() and "claude-mux" not in cmd_line:
                panes.append({
                    "pane": pane_target,
                    "pane_pid": pane_pid,
                    "claude_pid": cpid,
                    "cmd": cmd_line,
                })
                break

    return panes


def _extract_session_id(pane_target):
    """Extract the session ID from a running Claude Code pane by capturing its scrollback."""
    r = run(["tmux", "capture-pane", "-t", pane_target, "-p", "-S", "-200"],
            check=False)
    if r.returncode != 0:
        return None

    output = r.stdout
    # Look for session ID pattern (UUID in the status bar or scrollback)
    # Session files are named like: a6d27295-c768-4c1e-85af-4c8a5aaf9a82.jsonl
    uuids = re.findall(r'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})', output)
    if uuids:
        # Return the last one found (most likely the current session)
        return uuids[-1]
    return None


def cmd_switchall(args):
    """Scan all tmux panes for Claude processes, switch account, resume all sessions."""
    if not args:
        print("Usage: claude-mux switchall <email>")
        print("  Finds all Claude Code sessions in tmux, kills them,")
        print("  switches to <email>, and resumes each session.")
        return 1

    cfg = load_config()
    target, target_email = resolve(args[0], cfg)

    if not target:
        print(f"✗ Unknown account: {args[0]}")
        print(f"  Known: {', '.join(a['email'] for a in cfg['accounts'].values())}")
        return 1

    target_creds = load_creds_file(target)
    if not target_creds:
        print(f"✗ No saved credentials for {target_email}.")
        return 1

    # Step 1: Find all Claude panes
    print("Scanning tmux panes for Claude Code sessions...")
    panes = _find_claude_panes()

    if not panes:
        print("No Claude Code sessions found in tmux.")
        print(f"Switching account to {target_email} anyway...")
        return cmd_switch([target])

    print(f"Found {len(panes)} Claude Code session(s):")
    sessions = []
    for p in panes:
        session_id = _extract_session_id(p["pane"])
        sessions.append({**p, "session_id": session_id})
        sid_str = session_id[:12] + "..." if session_id else "unknown"
        print(f"  {p['pane']}  pid={p['claude_pid']}  session={sid_str}")

    # Step 2: Confirm
    print(f"\nWill kill all {len(panes)} Claude process(es), switch to {target_email},")
    print(f"and resume each session. Proceed? [y/N] ", end="", flush=True)
    confirm = input().strip().lower()
    if confirm not in ("y", "yes"):
        print("Aborted.")
        return 0

    # Step 3: Save current creds
    current_label = cfg.get("active")
    if current_label:
        current_creds = keychain_read()
        if current_creds:
            save_creds_file(current_label, current_creds)
            current_email = cfg["accounts"].get(current_label, {}).get("email", current_label)
            print(f"\nSaved {current_email} credentials")

    # Step 4: Kill all Claude processes (sends SIGTERM to let them save state)
    print("Killing Claude processes...")
    for s in sessions:
        run(["kill", s["claude_pid"]], check=False)
    time.sleep(3)  # Let them clean up

    # Step 5: Switch credentials
    keychain_write(target_creds)
    status = auth_status()
    if not status or not status.get("loggedIn"):
        print(f"✗ Auth failed after switch!")
        return 1

    refreshed = keychain_read()
    if refreshed:
        save_creds_file(target, refreshed)
    cfg["active"] = target
    save_config(cfg)
    print(f"✓ Switched to {target_email}")

    # Step 6: Resume each session in its original pane
    print(f"\nResuming sessions...")
    for s in sessions:
        pane = s["pane"]
        sid = s["session_id"]

        if not sid:
            print(f"  {pane}: no session ID found, skipping resume")
            continue

        # Wait for the shell to be ready in the pane
        time.sleep(1)

        # Launch claude --resume in the pane
        resume_cmd = f"env -u CLAUDECODE claude --resume {sid}"
        run(["tmux", "send-keys", "-t", pane, resume_cmd, "Enter"])
        print(f"  {pane}: launched `claude --resume {sid[:12]}...`")

        # Wait for it to initialize, then send "continue"
        time.sleep(8)

        # Check if trust prompt appeared
        r = run(["tmux", "capture-pane", "-t", pane, "-p"], check=False)
        if "trust" in r.stdout.lower():
            run(["tmux", "send-keys", "-t", pane, "Enter"])
            time.sleep(3)

        # Send "continue" to kick off the conversation
        run(["tmux", "send-keys", "-t", pane, "-l", "continue"])
        time.sleep(0.5)
        run(["tmux", "send-keys", "-t", pane, "Enter"])
        print(f"  {pane}: sent 'continue'")

    print(f"\n✓ All {len(sessions)} session(s) resumed on {target_email}")
    return 0


# ── Display helpers ──────────────────────────────────────────────────

def _cap_indicator(pct, cap):
    """Return status indicator for a usage percentage vs cap."""
    if pct is None:
        return "?"
    threshold = cap * 100
    if pct >= 100:
        return "✗ exhausted"
    if pct >= threshold:
        return f"✗ cap ({int(threshold)}%)"
    if pct >= threshold * 0.9:
        return f"⚠ near cap ({int(threshold)}%)"
    if pct >= 80:
        return "⚠ high"
    return "✓"


def _print_account_usage(label, acct_cfg, data):
    """Print usage for a single account."""
    email = acct_cfg["email"]
    s_cap = acct_cfg.get("session_cap", 1.0)
    w_cap = acct_cfg.get("weekly_cap", 1.0)

    s_pct = data.get("session_pct")
    w_pct = data.get("weekly_pct")
    son_pct = data.get("sonnet_pct")

    s_resets = data.get("session_resets", "")
    w_resets = data.get("weekly_resets", "")

    s_ind = _cap_indicator(s_pct, s_cap)
    w_ind = _cap_indicator(w_pct, w_cap)

    print(f"{email}:")
    s_str = f"{s_pct}%" if s_pct is not None else "?"
    w_str = f"{w_pct}%" if w_pct is not None else "?"

    print(f"  Session: {s_str:>4} used  (resets {s_resets})  cap: {int(s_cap*100)}%  {s_ind}")
    print(f"  Weekly:  {w_str:>4} used  (resets {w_resets})  cap: {int(w_cap*100)}%  {w_ind}")
    if son_pct is not None:
        print(f"  Sonnet:  {son_pct:>3}% used")


def _print_table(cfg, cache):
    """Print a table of all accounts with cached data."""
    active = cfg.get("active", "")
    print(f"{'#':<3} {'Email':<38} {'Session':<10} {'Weekly':<10} {'Status'}")
    print("-" * 85)

    for i, (label, acct) in enumerate(cfg["accounts"].items(), 1):
        marker = "→" if label == active else " "
        email = acct["email"]
        data = cache.get(label, {})
        s_cap = acct.get("session_cap", 1.0)
        w_cap = acct.get("weekly_cap", 1.0)

        s_pct = data.get("session_pct")
        w_pct = data.get("weekly_pct")
        s_str = f"{s_pct}%" if s_pct is not None else "—"
        w_str = f"{w_pct}%" if w_pct is not None else "—"

        status = data.get("status", "no data")
        if status == "available":
            if s_pct is not None and s_pct >= s_cap * 100:
                status = f"cap reached ({int(s_cap*100)}%)"
            elif w_pct is not None and w_pct >= w_cap * 100:
                status = f"weekly cap ({int(w_cap*100)}%)"
            elif s_pct is not None and s_pct >= 100:
                status = "session exhausted"
            elif w_pct is not None and w_pct >= 100:
                status = "weekly exhausted"
            else:
                status = "✓ available"
        elif status == "session_exhausted":
            resets = data.get("session_resets", "")
            status = f"✗ session exhausted (resets {resets})"
        elif status == "weekly_exhausted":
            resets = data.get("weekly_resets", "")
            status = f"✗ weekly exhausted (resets {resets})"

        # Age indicator
        age = ""
        if "checked_at" in data:
            try:
                dt = datetime.fromisoformat(data["checked_at"])
                mins = int((datetime.now(timezone.utc) - dt).total_seconds() / 60)
                if mins < 60:
                    age = f" ({mins}m ago)"
                else:
                    age = f" ({mins // 60}h ago)"
            except Exception:
                pass

        print(f"{marker}{i:<2} {email:<38} {s_str:<10} {w_str:<10} {status}{age}")


# ── Main ─────────────────────────────────────────────────────────────

COMMANDS = {
    "save": cmd_save,
    "switch": cmd_switch,
    "check": cmd_check,
    "check-all": cmd_check_all,
    "pick": cmd_pick,
    "status": cmd_status,
    "resume": cmd_resume,
    "switchall": cmd_switchall,
    "gcal-sync": cmd_gcal_sync,
    "gcal-sync-all": cmd_gcal_sync_all,
    "gcal-set": cmd_gcal_set,
    "watch": cmd_watch,
    "refresh-daemon": cmd_refresh_daemon,
}

def main():
    if len(sys.argv) < 2:
        # Default: show status (quick cache view)
        return cmd_status([])

    cmd = sys.argv[1]
    args = sys.argv[2:]

    if cmd in ("-h", "--help", "help"):
        print(__doc__)
        return 0

    handler = COMMANDS.get(cmd)
    if not handler:
        print(f"✗ Unknown command: {cmd}")
        print(f"  Available: {', '.join(COMMANDS.keys())}")
        return 1

    return handler(args) or 0


if __name__ == "__main__":
    sys.exit(main())
