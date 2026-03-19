use crate::tmux;
use crate::worker::WorkerSnapshot;

#[derive(Debug)]
pub enum Action {
    Skip(String),
    Relaunch(String),
}

/// Core watchdog logic. Heartbeat is the sole liveness signal.
pub fn check(worker: &WorkerSnapshot, now_epoch: i64, cooldown_secs: i64, liveness_epoch: Option<i64>) -> Action {
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

    // Grace period after relaunch (180s for TUI init + seed injection)
    if worker.grace_until_epoch > 0 && now_epoch < worker.grace_until_epoch {
        return Action::Skip(format!(
            "grace period ({}s remaining)",
            worker.grace_until_epoch - now_epoch
        ));
    }

    // Explicit recycle request from `fleet recycle` — relaunch immediately
    if worker.status == "recycling" {
        return Action::Relaunch("recycling requested".into());
    }

    // HEARTBEAT is the sole liveness signal
    if let Some(liveness) = liveness_epoch {
        let stale_secs = now_epoch - liveness;
        if stale_secs < 120 {
            return Action::Skip("heartbeat fresh".into());
        }
        // Heartbeat stale — check if pane is at least alive
        if let Some(ref pane_id) = worker.pane_id {
            if !tmux::is_pane_alive(pane_id) {
                return Action::Relaunch(format!("dead pane + stale heartbeat ({}s)", stale_secs));
            }
        }
        return Action::Relaunch(format!("heartbeat stale ({}s)", stale_secs));
    }

    // No heartbeat file at all — fall back to pane check
    if let Some(ref pane_id) = worker.pane_id {
        if !tmux::is_pane_alive(pane_id) {
            return Action::Relaunch("dead pane, no heartbeat".into());
        }
        // Pane alive but no heartbeat — give benefit of doubt (hooks may not be installed yet)
        return Action::Skip("pane alive, no heartbeat file".into());
    }

    Action::Relaunch("no pane, no heartbeat".into())
}
