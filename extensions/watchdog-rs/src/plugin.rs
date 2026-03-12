use crate::worker::WorkerSnapshot;
use async_trait::async_trait;
use std::time::Duration;

/// Action a plugin can produce
#[derive(Debug)]
pub enum PluginAction {
    /// Desktop notification
    Notify(String),
    /// Structured log entry
    Log(String),
}

/// Plugin trait — implement this to add new behaviors
#[async_trait]
pub trait Plugin: Send + Sync {
    /// Human-readable name for logging
    fn name(&self) -> &str;

    /// How often this plugin should run
    fn interval(&self) -> Duration;

    /// Check a worker and optionally produce an action
    async fn check(&self, worker: &WorkerSnapshot) -> Option<PluginAction>;
}
