use crate::tmux;
use crate::worker::WorkerSnapshot;

#[derive(Debug)]
pub enum Action {
    Skip(String),
    Relaunch(String),
}

/// Core watchdog logic. 4 branches.
pub fn check(worker: &WorkerSnapshot, now_epoch: i64, cooldown_secs: i64) -> Action {
    // Only manage perpetual workers
    if worker.sleep_duration <= 0 {
        return Action::Skip("not perpetual".into());
    }

    // Skip ephemeral workers (deep-review, etc.)
    if worker.ephemeral {
        return Action::Skip("ephemeral".into());
    }

    // Explicit opt-out
    if worker.status == "standby" {
        return Action::Skip("standby".into());
    }

    // Don't relaunch too soon after last relaunch
    if worker.last_relaunch_epoch > 0 && (now_epoch - worker.last_relaunch_epoch) < cooldown_secs {
        return Action::Skip(format!(
            "cooldown ({}s since last relaunch)",
            now_epoch - worker.last_relaunch_epoch
        ));
    }

    // Explicit recycle request from `fleet recycle` — relaunch immediately
    if worker.status == "recycling" {
        return Action::Relaunch("recycling requested".into());
    }

    // Check if pane is alive and Claude is running
    if let Some(ref pane_id) = worker.pane_id {
        if tmux::is_pane_alive(pane_id) && tmux::is_claude_running(pane_id) {
            return Action::Skip("healthy".into());
        }
        if tmux::is_pane_alive(pane_id) {
            return Action::Relaunch("pane alive but Claude not running".into());
        }
        return Action::Relaunch("dead pane".into());
    }

    // No pane registered at all
    Action::Relaunch("no pane registered".into())
}
