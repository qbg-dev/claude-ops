use crate::plugin::{Plugin, PluginAction};
use crate::worker::WorkerSnapshot;
use async_trait::async_trait;
use std::path::PathBuf;
use std::time::Duration;
use tracing::debug;

pub struct LivenessMonitor {
    state_dir: PathBuf,
}

impl LivenessMonitor {
    pub fn new(state_dir: PathBuf) -> Self {
        Self { state_dir }
    }

    fn read_liveness(&self, worker_name: &str) -> Option<i64> {
        let path = self
            .state_dir
            .join("watchdog-runtime")
            .join(worker_name)
            .join("liveness");
        let raw = std::fs::read_to_string(path).ok()?;
        raw.trim().parse().ok()
    }
}

#[async_trait]
impl Plugin for LivenessMonitor {
    fn name(&self) -> &str {
        "liveness"
    }

    fn interval(&self) -> Duration {
        Duration::from_secs(60)
    }

    async fn check(&self, worker: &WorkerSnapshot) -> Option<PluginAction> {
        // Only monitor workers that are supposed to be active
        if worker.status != "active" {
            return None;
        }

        let liveness = self.read_liveness(&worker.name)?;
        let now = chrono::Utc::now().timestamp();
        let stale_sec = now - liveness;
        let threshold = worker.sleep_duration.max(1200);

        if stale_sec > threshold {
            debug!(
                worker = %worker.name,
                stale_sec,
                threshold,
                "heartbeat stale"
            );
            Some(PluginAction::Log(format!(
                "{}: heartbeat stale {}s (threshold {}s)",
                worker.name, stale_sec, threshold,
            )))
        } else {
            None
        }
    }
}
