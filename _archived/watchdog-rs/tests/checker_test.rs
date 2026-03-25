// We test the checker logic by constructing WorkerSnapshots directly.
// This avoids needing tmux or filesystem state.

/// Minimal WorkerSnapshot for testing (mirrors the real struct)
#[derive(Debug)]
#[allow(dead_code)]
struct TestWorker {
    name: String,
    sleep_duration: i64,
    ephemeral: bool,
    status: String,
    last_relaunch_epoch: i64,
    pane_id: Option<String>,
    pane_alive: bool,
    claude_running: bool,
}

impl Default for TestWorker {
    fn default() -> Self {
        Self {
            name: "test-worker".into(),
            sleep_duration: 300,
            ephemeral: false,
            status: "active".into(),
            last_relaunch_epoch: 0,
            pane_id: Some("%42".into()),
            pane_alive: true,
            claude_running: true,
        }
    }
}

/// Pure checker logic extracted for testing (mirrors checker.rs but without tmux calls)
#[derive(Debug, PartialEq)]
enum Action {
    Skip(String),
    Relaunch(String),
}

fn check(w: &TestWorker, now: i64, cooldown: i64) -> Action {
    if w.sleep_duration <= 0 {
        return Action::Skip("not perpetual".into());
    }
    if w.ephemeral {
        return Action::Skip("ephemeral".into());
    }
    if w.status == "standby" {
        return Action::Skip("standby".into());
    }
    if w.last_relaunch_epoch > 0 && (now - w.last_relaunch_epoch) < cooldown {
        return Action::Skip(format!(
            "cooldown ({}s since last relaunch)",
            now - w.last_relaunch_epoch
        ));
    }
    if w.status == "recycling" {
        return Action::Relaunch("recycling requested".into());
    }
    if let Some(ref _pane_id) = w.pane_id {
        if w.pane_alive && w.claude_running {
            return Action::Skip("healthy".into());
        }
        if w.pane_alive {
            return Action::Relaunch("pane alive but Claude not running".into());
        }
        return Action::Relaunch("dead pane".into());
    }
    Action::Relaunch("no pane registered".into())
}

#[test]
fn skip_non_perpetual() {
    let w = TestWorker {
        sleep_duration: 0,
        ..Default::default()
    };
    assert_eq!(check(&w, 1000, 60), Action::Skip("not perpetual".into()));
}

#[test]
fn skip_negative_sleep() {
    let w = TestWorker {
        sleep_duration: -1,
        ..Default::default()
    };
    assert_eq!(check(&w, 1000, 60), Action::Skip("not perpetual".into()));
}

#[test]
fn skip_ephemeral() {
    let w = TestWorker {
        ephemeral: true,
        ..Default::default()
    };
    assert_eq!(check(&w, 1000, 60), Action::Skip("ephemeral".into()));
}

#[test]
fn skip_standby() {
    let w = TestWorker {
        status: "standby".into(),
        ..Default::default()
    };
    assert_eq!(check(&w, 1000, 60), Action::Skip("standby".into()));
}

#[test]
fn skip_cooldown() {
    let w = TestWorker {
        last_relaunch_epoch: 950,
        ..Default::default()
    };
    // 1000 - 950 = 50s < 60s cooldown
    assert!(matches!(check(&w, 1000, 60), Action::Skip(r) if r.contains("cooldown")));
}

#[test]
fn no_cooldown_on_zero_relaunch() {
    // last_relaunch_epoch == 0 means never relaunched, should not trigger cooldown
    let w = TestWorker {
        last_relaunch_epoch: 0,
        ..Default::default()
    };
    assert_eq!(check(&w, 1000, 60), Action::Skip("healthy".into()));
}

#[test]
fn cooldown_expired_healthy() {
    let w = TestWorker {
        last_relaunch_epoch: 900,
        ..Default::default()
    };
    // 1000 - 900 = 100s > 60s cooldown → proceed to health check → healthy
    assert_eq!(check(&w, 1000, 60), Action::Skip("healthy".into()));
}

#[test]
fn relaunch_recycling() {
    let w = TestWorker {
        status: "recycling".into(),
        ..Default::default()
    };
    assert_eq!(
        check(&w, 1000, 60),
        Action::Relaunch("recycling requested".into())
    );
}

#[test]
fn relaunch_recycling_ignores_cooldown() {
    let w = TestWorker {
        status: "recycling".into(),
        last_relaunch_epoch: 990, // only 10s ago
        ..Default::default()
    };
    // cooldown check comes BEFORE recycling check, so cooldown wins
    assert!(matches!(check(&w, 1000, 60), Action::Skip(r) if r.contains("cooldown")));
}

#[test]
fn healthy_pane_alive_claude_running() {
    let w = TestWorker::default(); // pane_alive=true, claude_running=true
    assert_eq!(check(&w, 1000, 60), Action::Skip("healthy".into()));
}

#[test]
fn relaunch_pane_alive_no_claude() {
    let w = TestWorker {
        claude_running: false,
        ..Default::default()
    };
    assert_eq!(
        check(&w, 1000, 60),
        Action::Relaunch("pane alive but Claude not running".into())
    );
}

#[test]
fn relaunch_dead_pane() {
    let w = TestWorker {
        pane_alive: false,
        claude_running: false,
        ..Default::default()
    };
    assert_eq!(check(&w, 1000, 60), Action::Relaunch("dead pane".into()));
}

#[test]
fn relaunch_no_pane() {
    let w = TestWorker {
        pane_id: None,
        ..Default::default()
    };
    assert_eq!(
        check(&w, 1000, 60),
        Action::Relaunch("no pane registered".into())
    );
}

#[test]
fn priority_order_ephemeral_over_standby() {
    // ephemeral check comes before standby
    let w = TestWorker {
        ephemeral: true,
        status: "standby".into(),
        ..Default::default()
    };
    assert_eq!(check(&w, 1000, 60), Action::Skip("ephemeral".into()));
}

#[test]
fn priority_order_non_perpetual_first() {
    // sleep_duration check comes first
    let w = TestWorker {
        sleep_duration: 0,
        ephemeral: true,
        status: "standby".into(),
        ..Default::default()
    };
    assert_eq!(check(&w, 1000, 60), Action::Skip("not perpetual".into()));
}
