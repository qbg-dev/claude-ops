#!/usr/bin/env python3
"""Tests for claude-mux CLI.

Run: python3 ~/.claude/scripts/test_claude_mux.py
  or python3 -m pytest ~/.claude/scripts/test_claude_mux.py -v
"""

import json
import os
import subprocess
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock, call, patch

# Import the module under test
import importlib.util
spec = importlib.util.spec_from_file_location("claude_mux", Path.home() / ".claude/scripts/claude-mux.py")
cm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cm)


# ── Fixtures ─────────────────────────────────────────────────────────

SAMPLE_USAGE_OUTPUT = """
 ▐▛███▜▌   Claude Code v2.1.50
▝▜█████▛▘  Opus 4.6 · Claude Max
  ▘▘ ▝▝    /private/tmp

❯ /usage
─────────────────────────────────────────────────────────
  Settings:  Status   Config   Usage

  Current session
  ██████████████████████████▌                        53% used
  Resets 4pm (America/Chicago)

  Current week (all models)
  ███████████████████████████████████████████████    94% used
  Resets Feb 26 at 10am (America/Chicago)

  Current week (Sonnet only)
  ▌                                                  1% used
  Resets Feb 26 at 3pm (America/Chicago)

  Extra usage
  Extra usage not enabled

  Esc to cancel
"""

SAMPLE_USAGE_EXHAUSTED = """
  Current session
  ██████████████████████████████████████████████████ 100% used
  Resets 3:59pm (America/Chicago)

  Current week (all models)
  ██████████████████████████████████████████████████ 100% used
  Resets Feb 26 at 10am (America/Chicago)

  Current week (Sonnet only)
  ▌                                                  1% used
  Resets Feb 26 at 3pm (America/Chicago)
"""

SAMPLE_USAGE_ZERO = """
  Current session
  ▌                                                  0% used
  Resets 8pm (America/Chicago)

  Current week (all models)
  ▌                                                  0% used
  Resets Mar 2 at 3pm (America/Chicago)

  Current week (Sonnet only)
  ▌                                                  0% used
  Resets Mar 2 at 3pm (America/Chicago)
"""

SAMPLE_CONFIG = {
    "accounts": {
        "work": {"email": "alice@work.example.com", "session_cap": 1.0, "weekly_cap": 1.0},
        "personal": {"email": "alice.dev@gmail.example.com", "session_cap": 0.90, "weekly_cap": 0.93},
        "main": {"email": "alice@example.com", "session_cap": 1.0, "weekly_cap": 1.0},
    },
    "active": "main",
}

SAMPLE_CREDS = '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-abc","refreshToken":"sk-ant-ort01-xyz","expiresAt":9999999999999,"scopes":["scope1"],"subscriptionType":"max","rateLimitTier":"default_claude_max_20x"}}'


class TempAccountsDir:
    """Context manager that redirects claude-mux to a temp directory."""

    def __enter__(self):
        self.tmpdir = tempfile.mkdtemp()
        self.orig_accounts = cm.ACCOUNTS_DIR
        self.orig_config = cm.CONFIG_PATH
        self.orig_cache = cm.CACHE_PATH
        self.orig_tracking = cm.GCAL_TRACKING
        self.orig_events_log = cm.GCAL_EVENTS_LOG

        cm.ACCOUNTS_DIR = Path(self.tmpdir)
        cm.CONFIG_PATH = Path(self.tmpdir) / "config.json"
        cm.CACHE_PATH = Path(self.tmpdir) / "usage_cache.json"
        cm.GCAL_TRACKING = Path(self.tmpdir) / "gcal_tracking.json"
        cm.GCAL_EVENTS_LOG = Path(self.tmpdir) / "gcal_events.json"

        # Write default config
        cm.CONFIG_PATH.write_text(json.dumps(SAMPLE_CONFIG, indent=2))
        cm.CACHE_PATH.write_text("{}")

        return Path(self.tmpdir)

    def __exit__(self, *args):
        cm.ACCOUNTS_DIR = self.orig_accounts
        cm.CONFIG_PATH = self.orig_config
        cm.CACHE_PATH = self.orig_cache
        cm.GCAL_TRACKING = self.orig_tracking
        cm.GCAL_EVENTS_LOG = self.orig_events_log

        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)


# ── Pure function tests ──────────────────────────────────────────────

class TestParseUsage(unittest.TestCase):
    """Test _parse_usage with various /usage outputs."""

    def test_normal_usage(self):
        result = cm._parse_usage(SAMPLE_USAGE_OUTPUT)
        self.assertEqual(result["session_pct"], 53)
        self.assertEqual(result["weekly_pct"], 94)
        self.assertEqual(result["sonnet_pct"], 1)
        self.assertEqual(result["session_resets"], "4pm (America/Chicago)")
        self.assertEqual(result["weekly_resets"], "Feb 26 at 10am (America/Chicago)")
        self.assertEqual(result["sonnet_resets"], "Feb 26 at 3pm (America/Chicago)")
        self.assertEqual(result["status"], "available")

    def test_exhausted_usage(self):
        result = cm._parse_usage(SAMPLE_USAGE_EXHAUSTED)
        self.assertEqual(result["session_pct"], 100)
        self.assertEqual(result["weekly_pct"], 100)
        self.assertEqual(result["status"], "session_exhausted")

    def test_zero_usage(self):
        result = cm._parse_usage(SAMPLE_USAGE_ZERO)
        self.assertEqual(result["session_pct"], 0)
        self.assertEqual(result["weekly_pct"], 0)
        self.assertEqual(result["sonnet_pct"], 0)
        self.assertEqual(result["status"], "available")

    def test_empty_output(self):
        result = cm._parse_usage("")
        self.assertIsNone(result["session_pct"])
        self.assertIsNone(result["weekly_pct"])
        self.assertEqual(result["status"], "unknown")

    def test_partial_output_session_only(self):
        output = """
  Current session
  ██████████████████████████▌                        53% used
  Resets 4pm (America/Chicago)
"""
        result = cm._parse_usage(output)
        self.assertEqual(result["session_pct"], 53)
        self.assertIsNone(result["weekly_pct"])
        self.assertEqual(result["session_resets"], "4pm (America/Chicago)")

    def test_high_usage_near_cap(self):
        output = """
  Current session
  █████████████████████████████████████████████      88% used
  Resets 5pm (America/Chicago)

  Current week (all models)
  █████████████████████████████████████████████      92% used
  Resets Feb 28 at 10am (America/Chicago)

  Current week (Sonnet only)
  ███                                                5% used
  Resets Feb 28 at 3pm (America/Chicago)
"""
        result = cm._parse_usage(output)
        self.assertEqual(result["session_pct"], 88)
        self.assertEqual(result["weekly_pct"], 92)
        self.assertEqual(result["sonnet_pct"], 5)
        self.assertEqual(result["status"], "available")


class TestParseResetDatetime(unittest.TestCase):
    """Test _parse_reset_datetime with various reset strings."""

    def test_simple_pm(self):
        dt, tz = cm._parse_reset_datetime("4pm (America/Chicago)")
        self.assertIsNotNone(dt)
        self.assertEqual(tz, "America/Chicago")
        self.assertIn("T16:00:00", dt)

    def test_time_with_minutes(self):
        dt, tz = cm._parse_reset_datetime("3:59pm (America/Chicago)")
        self.assertIsNotNone(dt)
        self.assertIn("T15:59:00", dt)

    def test_am_time(self):
        dt, tz = cm._parse_reset_datetime("10am (America/Chicago)")
        self.assertIsNotNone(dt)
        self.assertIn("T10:00:00", dt)

    def test_12pm(self):
        dt, tz = cm._parse_reset_datetime("12pm (America/Chicago)")
        self.assertIsNotNone(dt)
        self.assertIn("T12:00:00", dt)

    def test_12am(self):
        dt, tz = cm._parse_reset_datetime("12am (America/Chicago)")
        self.assertIsNotNone(dt)
        self.assertIn("T00:00:00", dt)

    def test_date_and_time(self):
        dt, tz = cm._parse_reset_datetime("Feb 26 at 10am (America/Chicago)")
        self.assertIsNotNone(dt)
        self.assertIn("-02-26T10:00:00", dt)
        self.assertEqual(tz, "America/Chicago")

    def test_date_with_minutes(self):
        dt, tz = cm._parse_reset_datetime("Mar 2 at 2:59pm (America/Chicago)")
        self.assertIsNotNone(dt)
        self.assertIn("-03-02T14:59:00", dt)

    def test_no_timezone(self):
        dt, tz = cm._parse_reset_datetime("4pm")
        self.assertIsNotNone(dt)
        self.assertEqual(tz, "America/Chicago")  # default

    def test_garbage_input(self):
        dt, tz = cm._parse_reset_datetime("not a time string")
        self.assertIsNone(dt)
        self.assertIsNone(tz)

    def test_empty_string(self):
        dt, tz = cm._parse_reset_datetime("")
        self.assertIsNone(dt)
        self.assertIsNone(tz)


class TestScoreAccount(unittest.TestCase):
    """Test _score_account headroom scoring."""

    def test_fresh_account(self):
        score = cm._score_account("test", {"session_cap": 1.0, "weekly_cap": 1.0},
                                  {"session_pct": 0, "weekly_pct": 0})
        self.assertIsNotNone(score)
        self.assertEqual(score, 100 * 0.6 + 100 * 0.4)  # 100

    def test_half_used(self):
        score = cm._score_account("test", {"session_cap": 1.0, "weekly_cap": 1.0},
                                  {"session_pct": 50, "weekly_pct": 50})
        self.assertEqual(score, 50 * 0.6 + 50 * 0.4)  # 50

    def test_exhausted_returns_none(self):
        score = cm._score_account("test", {"session_cap": 1.0, "weekly_cap": 1.0},
                                  {"session_pct": 100, "weekly_pct": 50})
        self.assertIsNone(score)

    def test_at_cap_returns_none(self):
        score = cm._score_account("test", {"session_cap": 0.9, "weekly_cap": 0.93},
                                  {"session_pct": 91, "weekly_pct": 50})
        self.assertIsNone(score)

    def test_weekly_at_cap_returns_none(self):
        score = cm._score_account("test", {"session_cap": 1.0, "weekly_cap": 0.93},
                                  {"session_pct": 50, "weekly_pct": 94})
        self.assertIsNone(score)

    def test_missing_data_returns_none(self):
        score = cm._score_account("test", {"session_cap": 1.0, "weekly_cap": 1.0},
                                  {"session_pct": None, "weekly_pct": None})
        self.assertIsNone(score)

    def test_cap_respects_personal_limits(self):
        # personal: session_cap=0.9, weekly_cap=0.93
        # at 85% session, 90% weekly — still under cap
        score = cm._score_account("personal",
                                  {"session_cap": 0.9, "weekly_cap": 0.93},
                                  {"session_pct": 85, "weekly_pct": 90})
        self.assertIsNotNone(score)
        self.assertGreater(score, 0)

    def test_higher_headroom_scores_higher(self):
        score_fresh = cm._score_account("a", {"session_cap": 1.0, "weekly_cap": 1.0},
                                        {"session_pct": 10, "weekly_pct": 10})
        score_used = cm._score_account("b", {"session_cap": 1.0, "weekly_cap": 1.0},
                                       {"session_pct": 80, "weekly_pct": 80})
        self.assertGreater(score_fresh, score_used)


class TestCapIndicator(unittest.TestCase):
    """Test _cap_indicator display."""

    def test_low_usage(self):
        self.assertEqual(cm._cap_indicator(20, 1.0), "✓")

    def test_high_usage(self):
        self.assertIn("high", cm._cap_indicator(85, 1.0))

    def test_exhausted(self):
        self.assertIn("exhausted", cm._cap_indicator(100, 1.0))

    def test_at_cap(self):
        self.assertIn("cap", cm._cap_indicator(91, 0.9))

    def test_near_cap(self):
        result = cm._cap_indicator(82, 0.9)
        self.assertIn("near cap", result)

    def test_none_returns_question(self):
        self.assertEqual(cm._cap_indicator(None, 1.0), "?")


class TestUsageBar(unittest.TestCase):
    """Test _usage_bar text rendering."""

    def test_zero(self):
        bar = cm._usage_bar(0)
        self.assertIn("0%", bar)
        self.assertIn("░" * 10, bar)

    def test_fifty(self):
        bar = cm._usage_bar(50)
        self.assertIn("50%", bar)
        self.assertEqual(bar.count("█"), 5)

    def test_hundred(self):
        bar = cm._usage_bar(100)
        self.assertIn("100%", bar)
        self.assertEqual(bar.count("█"), 10)

    def test_none(self):
        self.assertEqual(cm._usage_bar(None), "?")


class TestColorForPct(unittest.TestCase):
    """Test _color_for_pct gcal color selection."""

    def test_low(self):
        self.assertEqual(cm._color_for_pct(20), "2")      # sage

    def test_moderate(self):
        self.assertEqual(cm._color_for_pct(60), "5")      # banana

    def test_high(self):
        self.assertEqual(cm._color_for_pct(85), "6")      # tangerine

    def test_exhausted(self):
        self.assertEqual(cm._color_for_pct(100), "11")    # tomato

    def test_none(self):
        self.assertEqual(cm._color_for_pct(None), "8")    # graphite


class TestEmailToLabel(unittest.TestCase):
    """Test email_to_label lookup."""

    def test_found(self):
        self.assertEqual(cm.email_to_label("alice@work.example.com", SAMPLE_CONFIG), "work")
        self.assertEqual(cm.email_to_label("alice.dev@gmail.example.com", SAMPLE_CONFIG), "personal")
        self.assertEqual(cm.email_to_label("alice@example.com", SAMPLE_CONFIG), "main")

    def test_not_found(self):
        self.assertIsNone(cm.email_to_label("unknown@example.com", SAMPLE_CONFIG))


class TestResolve(unittest.TestCase):
    """Test resolve() — accepts label, email, or email prefix."""

    def test_resolve_by_label(self):
        label, email = cm.resolve("work", SAMPLE_CONFIG)
        self.assertEqual(label, "work")
        self.assertEqual(email, "alice@work.example.com")

    def test_resolve_by_email(self):
        label, email = cm.resolve("alice@work.example.com", SAMPLE_CONFIG)
        self.assertEqual(label, "work")
        self.assertEqual(email, "alice@work.example.com")

    def test_resolve_by_email_prefix(self):
        label, email = cm.resolve("alice", SAMPLE_CONFIG)
        self.assertEqual(label, "work")
        self.assertEqual(email, "alice@work.example.com")

    def test_resolve_full_personal_email(self):
        label, email = cm.resolve("alice.dev@gmail.example.com", SAMPLE_CONFIG)
        self.assertEqual(label, "personal")
        self.assertEqual(email, "alice.dev@gmail.example.com")

    def test_resolve_unknown(self):
        label, email = cm.resolve("nonexistent@example.com", SAMPLE_CONFIG)
        self.assertIsNone(label)
        self.assertIsNone(email)


class TestActiveEmail(unittest.TestCase):
    """Test active_email() helper."""

    def test_returns_email(self):
        self.assertEqual(cm.active_email(SAMPLE_CONFIG), "alice@example.com")

    def test_no_active(self):
        cfg = {"accounts": SAMPLE_CONFIG["accounts"]}
        self.assertIsNone(cm.active_email(cfg))


# ── Config / cache file tests ────────────────────────────────────────

class TestConfigIO(unittest.TestCase):
    """Test config and cache file operations."""

    def test_load_save_config(self):
        with TempAccountsDir():
            cfg = cm.load_config()
            self.assertEqual(cfg["active"], "main")
            self.assertIn("work", cfg["accounts"])

            cfg["active"] = "work"
            cm.save_config(cfg)

            cfg2 = cm.load_config()
            self.assertEqual(cfg2["active"], "work")

    def test_load_save_cache(self):
        with TempAccountsDir():
            cache = cm.load_cache()
            self.assertEqual(cache, {})

            cache["work"] = {"session_pct": 50, "weekly_pct": 30}
            cm.save_cache(cache)

            cache2 = cm.load_cache()
            self.assertEqual(cache2["work"]["session_pct"], 50)

    def test_save_creds_file_permissions(self):
        with TempAccountsDir() as tmpdir:
            cm.save_creds_file("test", SAMPLE_CREDS)
            path = tmpdir / "test.json"
            self.assertTrue(path.exists())
            self.assertEqual(oct(path.stat().st_mode & 0o777), "0o600")

    def test_load_creds_file(self):
        with TempAccountsDir() as tmpdir:
            cm.save_creds_file("test", SAMPLE_CREDS)
            loaded = cm.load_creds_file("test")
            self.assertEqual(loaded, SAMPLE_CREDS)

    def test_load_missing_creds_file(self):
        with TempAccountsDir():
            self.assertIsNone(cm.load_creds_file("nonexistent"))


# ── Command tests (mocked externals) ────────────────────────────────

class TestCmdSave(unittest.TestCase):
    """Test save command."""

    @patch.object(cm, 'auth_status', return_value={"loggedIn": True, "email": "alice@example.com"})
    @patch.object(cm, 'keychain_read', return_value=SAMPLE_CREDS)
    def test_save_auto_detect_label(self, mock_kr, mock_as):
        with TempAccountsDir() as tmpdir:
            result = cm.cmd_save([])
            self.assertEqual(result, 0)
            self.assertTrue((tmpdir / "main.json").exists())

    @patch.object(cm, 'auth_status', return_value={"loggedIn": True, "email": "new@example.com"})
    @patch.object(cm, 'keychain_read', return_value=SAMPLE_CREDS)
    def test_save_explicit_label(self, mock_kr, mock_as):
        with TempAccountsDir() as tmpdir:
            result = cm.cmd_save(["newacct"])
            self.assertEqual(result, 0)
            self.assertTrue((tmpdir / "newacct.json").exists())
            cfg = cm.load_config()
            self.assertIn("newacct", cfg["accounts"])

    @patch.object(cm, 'keychain_read', return_value=None)
    def test_save_no_keychain(self, mock_kr):
        with TempAccountsDir():
            result = cm.cmd_save([])
            self.assertEqual(result, 1)

    @patch.object(cm, 'auth_status', return_value=None)
    @patch.object(cm, 'keychain_read', return_value=SAMPLE_CREDS)
    def test_save_auth_failed(self, mock_kr, mock_as):
        with TempAccountsDir():
            result = cm.cmd_save([])
            self.assertEqual(result, 1)


class TestCmdSwitch(unittest.TestCase):
    """Test switch command."""

    @patch.object(cm, 'chrome_check')
    @patch.object(cm, '_probe_usage', return_value={"session_pct": 20, "weekly_pct": 40})
    @patch.object(cm, 'auth_status')
    @patch.object(cm, 'keychain_write')
    @patch.object(cm, 'keychain_read', return_value=SAMPLE_CREDS)
    def test_switch_success(self, mock_kr, mock_kw, mock_as, mock_probe, mock_chrome):
        mock_as.side_effect = [
            # First call: verify current account for auto-save
            {"loggedIn": True, "email": "alice@example.com"},
            # Second call: verify target account
            {"loggedIn": True, "email": "alice@work.example.com"},
        ]
        with TempAccountsDir() as tmpdir:
            cm.save_creds_file("work", SAMPLE_CREDS)
            cm.save_creds_file("main", SAMPLE_CREDS)
            result = cm.cmd_switch(["work"])
            self.assertEqual(result, 0)
            cfg = cm.load_config()
            self.assertEqual(cfg["active"], "work")

    @patch.object(cm, 'chrome_check')
    @patch.object(cm, '_probe_usage', return_value={"session_pct": 20, "weekly_pct": 40})
    @patch.object(cm, 'auth_status')
    @patch.object(cm, 'keychain_write')
    @patch.object(cm, 'keychain_read', return_value=SAMPLE_CREDS)
    def test_switch_by_email(self, mock_kr, mock_kw, mock_as, mock_probe, mock_chrome):
        mock_as.side_effect = [
            {"loggedIn": True, "email": "alice@example.com"},
            {"loggedIn": True, "email": "alice@work.example.com"},
        ]
        with TempAccountsDir() as tmpdir:
            cm.save_creds_file("work", SAMPLE_CREDS)
            cm.save_creds_file("main", SAMPLE_CREDS)
            result = cm.cmd_switch(["alice@work.example.com"])
            self.assertEqual(result, 0)
            cfg = cm.load_config()
            self.assertEqual(cfg["active"], "work")

    @patch.object(cm, 'chrome_check')
    @patch.object(cm, '_probe_usage', return_value={"session_pct": 10, "weekly_pct": 5})
    @patch.object(cm, 'auth_status')
    @patch.object(cm, 'keychain_write')
    @patch.object(cm, 'keychain_read', return_value=SAMPLE_CREDS)
    def test_switch_by_email_prefix(self, mock_kr, mock_kw, mock_as, mock_probe, mock_chrome):
        mock_as.side_effect = [
            {"loggedIn": True, "email": "alice@example.com"},
            {"loggedIn": True, "email": "alice@work.example.com"},
        ]
        with TempAccountsDir() as tmpdir:
            cm.save_creds_file("work", SAMPLE_CREDS)
            cm.save_creds_file("main", SAMPLE_CREDS)
            result = cm.cmd_switch(["alice"])
            self.assertEqual(result, 0)
            cfg = cm.load_config()
            self.assertEqual(cfg["active"], "work")

    @patch('builtins.input', return_value="1")
    @patch.object(cm, 'chrome_check')
    @patch.object(cm, '_probe_usage', return_value={"session_pct": 10, "weekly_pct": 5})
    @patch.object(cm, '_gcal_notify_resets')
    @patch.object(cm, '_probe_all_parallel')
    @patch.object(cm, 'auth_status', return_value={"loggedIn": True, "email": "alice@work.example.com"})
    @patch.object(cm, 'keychain_write')
    @patch.object(cm, 'keychain_read', return_value=SAMPLE_CREDS)
    def test_switch_no_args_interactive(self, mock_kr, mock_kw, mock_as, mock_parallel, mock_gcal, mock_probe, mock_chrome, mock_input):
        """switch with no args enters interactive pick mode."""
        mock_parallel.return_value = (
            {"work": {"session_pct": 10, "weekly_pct": 5, "status": "available",
                         "checked_at": datetime.now(timezone.utc).isoformat()}},
            {},
        )
        with TempAccountsDir() as tmpdir:
            cm.save_creds_file("work", SAMPLE_CREDS)
            cm.save_creds_file("personal", SAMPLE_CREDS)
            cm.save_creds_file("main", SAMPLE_CREDS)
            # Input "1" selects first account (work)
            result = cm.cmd_switch([])
            self.assertEqual(result, 0)

    def test_switch_unknown_label(self):
        with TempAccountsDir():
            result = cm.cmd_switch(["nonexistent"])
            self.assertEqual(result, 1)

    def test_switch_no_saved_creds(self):
        with TempAccountsDir():
            result = cm.cmd_switch(["work"])
            self.assertEqual(result, 1)


class TestCmdStatus(unittest.TestCase):
    """Test status command."""

    def test_status_empty_cache(self):
        with TempAccountsDir():
            result = cm.cmd_status([])
            self.assertEqual(result, 0)

    def test_status_with_cache(self):
        with TempAccountsDir():
            cache = {
                "work": {
                    "session_pct": 30, "weekly_pct": 50,
                    "checked_at": datetime.now(timezone.utc).isoformat(),
                    "status": "available",
                }
            }
            cm.save_cache(cache)
            result = cm.cmd_status([])
            self.assertEqual(result, 0)


class TestCmdCheck(unittest.TestCase):
    """Test check command."""

    @patch.object(cm, '_gcal_notify_resets')
    @patch.object(cm, '_probe_usage')
    def test_check_active(self, mock_probe, mock_gcal):
        mock_probe.return_value = {
            "session_pct": 45, "weekly_pct": 60, "sonnet_pct": 2,
            "session_resets": "8pm (America/Chicago)",
            "weekly_resets": "Mar 2 at 3pm (America/Chicago)",
            "sonnet_resets": "Mar 2 at 3pm (America/Chicago)",
            "checked_at": datetime.now(timezone.utc).isoformat(),
            "status": "available",
        }
        with TempAccountsDir():
            result = cm.cmd_check([])
            self.assertEqual(result, 0)
            cache = cm.load_cache()
            self.assertEqual(cache["main"]["session_pct"], 45)

    @patch.object(cm, '_probe_usage', return_value=None)
    def test_check_probe_failure(self, mock_probe):
        with TempAccountsDir():
            result = cm.cmd_check([])
            self.assertEqual(result, 1)

    def test_check_unknown_label(self):
        with TempAccountsDir():
            result = cm.cmd_check(["nonexistent"])
            self.assertEqual(result, 1)


class TestCmdGcalSet(unittest.TestCase):
    """Test gcal-set command."""

    @patch.object(cm, '_gcal_notify_resets')
    @patch.object(cm, '_update_tracking_events')
    def test_gcal_set_updates_cache_and_events(self, mock_track, mock_notify):
        with TempAccountsDir():
            result = cm.cmd_gcal_set([
                "work", "45", "67",
                "8pm (America/Chicago)",
                "Mar 2 at 3pm (America/Chicago)",
                "5",
            ])
            self.assertEqual(result, 0)
            cache = cm.load_cache()
            self.assertEqual(cache["work"]["session_pct"], 45)
            self.assertEqual(cache["work"]["weekly_pct"], 67)
            self.assertEqual(cache["work"]["sonnet_pct"], 5)
            mock_track.assert_called_once()
            mock_notify.assert_called_once()

    def test_gcal_set_too_few_args(self):
        with TempAccountsDir():
            result = cm.cmd_gcal_set(["work", "45"])
            self.assertEqual(result, 1)

    def test_gcal_set_invalid_pct(self):
        with TempAccountsDir():
            result = cm.cmd_gcal_set(["work", "abc", "67", "8pm", "Mar 2"])
            self.assertEqual(result, 1)


class TestCmdGcalSync(unittest.TestCase):
    """Test gcal-sync command."""

    @patch.object(cm, '_update_tracking_events')
    def test_sync_from_cache(self, mock_track):
        with TempAccountsDir():
            cache = {"work": {"session_pct": 30, "weekly_pct": 50}}
            cm.save_cache(cache)
            cfg = cm.load_config()
            cfg["active"] = "work"
            cm.save_config(cfg)

            result = cm.cmd_gcal_sync([])
            self.assertEqual(result, 0)
            mock_track.assert_called_once()

    def test_sync_no_cache(self):
        with TempAccountsDir():
            cfg = cm.load_config()
            cfg["active"] = "work"
            cm.save_config(cfg)

            result = cm.cmd_gcal_sync([])
            self.assertEqual(result, 1)

    @patch.object(cm, '_update_tracking_events')
    def test_sync_explicit_label(self, mock_track):
        with TempAccountsDir():
            cache = {"personal": {"session_pct": 80, "weekly_pct": 89}}
            cm.save_cache(cache)
            result = cm.cmd_gcal_sync(["personal"])
            self.assertEqual(result, 0)


class TestCmdGcalSyncAll(unittest.TestCase):
    """Test gcal-sync-all command."""

    @patch.object(cm, '_update_tracking_events')
    def test_sync_all(self, mock_track):
        with TempAccountsDir():
            cache = {
                "work": {"session_pct": 10, "weekly_pct": 5},
                "main": {"session_pct": 100, "weekly_pct": 100},
            }
            cm.save_cache(cache)
            result = cm.cmd_gcal_sync_all([])
            self.assertEqual(result, 0)
            # Called for work and main (not personal — no cache)
            self.assertEqual(mock_track.call_count, 2)


class TestCmdCheckAll(unittest.TestCase):
    """Test check-all command."""

    @patch.object(cm, '_gcal_notify_resets')
    @patch.object(cm, '_probe_all_parallel')
    def test_check_all_parallel(self, mock_parallel, mock_gcal):
        mock_parallel.return_value = (
            {
                "work": {"session_pct": 10, "weekly_pct": 5, "status": "available",
                            "checked_at": datetime.now(timezone.utc).isoformat()},
                "main": {"session_pct": 100, "weekly_pct": 100, "status": "session_exhausted",
                           "session_resets": "4pm (America/Chicago)",
                           "weekly_resets": "Feb 26 at 10am (America/Chicago)",
                           "checked_at": datetime.now(timezone.utc).isoformat()},
            },
            {},  # no errors
        )
        with TempAccountsDir() as tmpdir:
            cm.save_creds_file("work", SAMPLE_CREDS)
            cm.save_creds_file("main", SAMPLE_CREDS)
            result = cm.cmd_check_all([])
            self.assertEqual(result, 0)
            cache = cm.load_cache()
            self.assertEqual(cache["work"]["session_pct"], 10)
            self.assertEqual(cache["main"]["session_pct"], 100)

    def test_check_all_no_creds(self):
        with TempAccountsDir():
            result = cm.cmd_check_all([])
            self.assertEqual(result, 1)


# ── Tmux pane scanner tests ─────────────────────────────────────────

class TestFindClaudePanes(unittest.TestCase):
    """Test _find_claude_panes tmux scanning."""

    @patch.object(cm, 'run')
    def test_finds_claude_processes(self, mock_run):
        # Mock tmux list-panes
        mock_run.side_effect = [
            MagicMock(returncode=0, stdout="h:1.0 12345\nh:1.1 12346\n"),
            # pgrep for pane 1
            MagicMock(returncode=0, stdout="12350\n"),
            # ps for child
            MagicMock(returncode=0, stdout="claude --dangerously-skip-permissions --model opus\n"),
            # pgrep for pane 2
            MagicMock(returncode=0, stdout="12351\n"),
            # ps for child
            MagicMock(returncode=0, stdout="vim somefile.py\n"),
        ]
        panes = cm._find_claude_panes()
        self.assertEqual(len(panes), 1)
        self.assertEqual(panes[0]["pane"], "h:1.0")

    @patch.object(cm, 'run')
    def test_no_tmux(self, mock_run):
        mock_run.return_value = MagicMock(returncode=1, stdout="")
        panes = cm._find_claude_panes()
        self.assertEqual(panes, [])

    @patch.object(cm, 'run')
    def test_excludes_claude_mux(self, mock_run):
        mock_run.side_effect = [
            MagicMock(returncode=0, stdout="h:1.0 12345\n"),
            MagicMock(returncode=0, stdout="12350\n"),
            MagicMock(returncode=0, stdout="python3 claude-mux.py check\n"),
        ]
        panes = cm._find_claude_panes()
        self.assertEqual(len(panes), 0)


class TestExtractSessionId(unittest.TestCase):
    """Test _extract_session_id from pane scrollback."""

    @patch.object(cm, 'run')
    def test_finds_uuid(self, mock_run):
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout="some output\n  📝 a6d27295-c768-4c1e-85af-4c8a5aaf9a82.jsonl\nmore output\n",
        )
        sid = cm._extract_session_id("h:1.0")
        self.assertEqual(sid, "a6d27295-c768-4c1e-85af-4c8a5aaf9a82")

    @patch.object(cm, 'run')
    def test_no_uuid(self, mock_run):
        mock_run.return_value = MagicMock(returncode=0, stdout="no uuid here\n")
        sid = cm._extract_session_id("h:1.0")
        self.assertIsNone(sid)

    @patch.object(cm, 'run')
    def test_tmux_error(self, mock_run):
        mock_run.return_value = MagicMock(returncode=1, stdout="")
        sid = cm._extract_session_id("h:1.0")
        self.assertIsNone(sid)


# ── Gcal notify dedup tests ─────────────────────────────────────────

class TestGcalNotifyResets(unittest.TestCase):
    """Test _gcal_notify_resets deduplication."""

    @patch.object(cm, '_gcal_create_event', return_value="https://calendar.google.com/event/abc")
    def test_creates_events_for_exhausted(self, mock_create):
        with TempAccountsDir():
            data = {
                "session_pct": 100,
                "session_resets": "4pm (America/Chicago)",
                "weekly_pct": 100,
                "weekly_resets": "Feb 26 at 10am (America/Chicago)",
            }
            created = cm._gcal_notify_resets("main", data)
            self.assertEqual(len(created), 2)
            self.assertEqual(mock_create.call_count, 2)

    @patch.object(cm, '_gcal_create_event')
    def test_skips_non_exhausted(self, mock_create):
        with TempAccountsDir():
            data = {"session_pct": 50, "weekly_pct": 60}
            created = cm._gcal_notify_resets("main", data)
            self.assertEqual(len(created), 0)
            mock_create.assert_not_called()

    @patch.object(cm, '_gcal_create_event', return_value="https://calendar.google.com/event/abc")
    def test_deduplicates(self, mock_create):
        with TempAccountsDir():
            data = {
                "session_pct": 100,
                "session_resets": "4pm (America/Chicago)",
                "weekly_pct": 50,
            }
            # First call creates
            cm._gcal_notify_resets("main", data)
            self.assertEqual(mock_create.call_count, 1)

            # Second call with same reset time is deduped
            cm._gcal_notify_resets("main", data)
            self.assertEqual(mock_create.call_count, 1)  # still 1


# ── Find latest session test ─────────────────────────────────────────

class TestFindLatestSession(unittest.TestCase):
    """Test _find_latest_session."""

    def test_finds_most_recent(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            projects = Path(tmpdir) / ".claude" / "projects" / "test-project"
            projects.mkdir(parents=True)

            old = projects / "old-session-id.jsonl"
            new = projects / "new-session-id.jsonl"
            old.write_text("{}")
            import time as t
            t.sleep(0.1)
            new.write_text("{}")

            # Patch Path.home at the module level
            original = cm.Path.home
            cm.Path.home = staticmethod(lambda: Path(tmpdir))
            try:
                result = cm._find_latest_session()
                self.assertEqual(result, "new-session-id")
            finally:
                cm.Path.home = original


# ── Integration: round-trip save → switch ────────────────────────────

class TestRoundTrip(unittest.TestCase):
    """Test save → switch round trip with mocked externals."""

    @patch.object(cm, 'chrome_check')
    @patch.object(cm, '_probe_usage', return_value={"session_pct": 5, "weekly_pct": 1})
    @patch.object(cm, 'auth_status')
    @patch.object(cm, 'keychain_write')
    @patch.object(cm, 'keychain_read', return_value=SAMPLE_CREDS)
    def test_save_then_switch(self, mock_kr, mock_kw, mock_as, mock_probe, mock_chrome):
        mock_as.return_value = {"loggedIn": True, "email": "alice@work.example.com"}

        with TempAccountsDir() as tmpdir:
            # Save work
            result = cm.cmd_save(["work"])
            self.assertEqual(result, 0)
            self.assertTrue((tmpdir / "work.json").exists())

            # Save main
            mock_as.return_value = {"loggedIn": True, "email": "alice@example.com"}
            result = cm.cmd_save(["main"])
            self.assertEqual(result, 0)

            # Switch to work
            mock_as.side_effect = [
                {"loggedIn": True, "email": "alice@example.com"},  # auto-save verify
                {"loggedIn": True, "email": "alice@work.example.com"},  # target verify
            ]
            result = cm.cmd_switch(["work"])
            self.assertEqual(result, 0)
            cfg = cm.load_config()
            self.assertEqual(cfg["active"], "work")


if __name__ == "__main__":
    unittest.main(verbosity=2)
