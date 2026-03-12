use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Static config from config.json (set at worker creation, rarely changes)
#[derive(Debug, Deserialize, Default)]
pub struct WorkerConfig {
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub permission_mode: Option<String>,
    pub sleep_duration: Option<i64>,
    pub window: Option<String>,
    pub worktree: Option<String>,
    pub branch: Option<String>,
    pub ephemeral: Option<bool>,
    pub meta: Option<WorkerMeta>,
}

#[derive(Debug, Deserialize, Default)]
pub struct WorkerMeta {
    pub project: Option<String>,
}

/// Runtime state from state.json (updated frequently by fleet CLI and watchdog)
#[derive(Debug, Deserialize, Serialize, Default, Clone)]
pub struct WorkerState {
    pub status: Option<String>,
    pub pane_id: Option<String>,
    pub tmux_session: Option<String>,
    pub last_relaunch: Option<RelaunchInfo>,
    pub relaunch_count: Option<u32>,
    pub custom: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize, Serialize, Default, Clone)]
pub struct RelaunchInfo {
    pub at: Option<String>,
    pub reason: Option<String>,
}

/// Combined snapshot of a worker for the checker
#[derive(Debug)]
pub struct WorkerSnapshot {
    pub name: String,
    pub project: String,
    pub project_dir: PathBuf,
    pub worker_dir: PathBuf,

    // From config.json
    pub sleep_duration: i64,
    pub window: Option<String>,
    pub worktree: Option<String>,
    pub model: String,
    pub permission_mode: String,
    pub ephemeral: bool,

    // From state.json
    pub status: String,
    pub pane_id: Option<String>,
    pub tmux_session: Option<String>,
    pub last_relaunch_epoch: i64,
    pub relaunch_count: u32,

    // From token file
    pub token: Option<String>,
}

impl WorkerSnapshot {
    pub fn load(name: &str, project: &str, project_dir: &Path) -> Result<Self> {
        let worker_dir = project_dir.join(name);

        let config: WorkerConfig = {
            let path = worker_dir.join("config.json");
            if path.exists() {
                let raw = std::fs::read_to_string(&path)?;
                serde_json::from_str(&raw).unwrap_or_default()
            } else {
                WorkerConfig::default()
            }
        };

        let state: WorkerState = {
            let path = worker_dir.join("state.json");
            if path.exists() {
                let raw = std::fs::read_to_string(&path)?;
                serde_json::from_str(&raw).unwrap_or_default()
            } else {
                WorkerState::default()
            }
        };

        let token = {
            let path = worker_dir.join("token");
            if path.exists() {
                std::fs::read_to_string(&path).ok().map(|t| t.trim().to_string())
            } else {
                None
            }
        };

        // Parse last_relaunch timestamp to epoch
        let last_relaunch_epoch = state
            .last_relaunch
            .as_ref()
            .and_then(|r| r.at.as_ref())
            .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
            .map(|dt| dt.timestamp())
            .unwrap_or(0);

        // Parse sleep_until from custom field
        let _sleep_until = state
            .custom
            .as_ref()
            .and_then(|c| c.get("sleep_until"))
            .and_then(|v| v.as_str())
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.timestamp());

        Ok(WorkerSnapshot {
            name: name.to_string(),
            project: project.to_string(),
            project_dir: project_dir.to_path_buf(),
            worker_dir,
            sleep_duration: config.sleep_duration.unwrap_or(0),
            window: config.window,
            worktree: config.worktree,
            model: config.model.unwrap_or_else(|| "sonnet".to_string()),
            permission_mode: config.permission_mode.unwrap_or_else(|| "default".to_string()),
            ephemeral: config.ephemeral.unwrap_or(false),
            status: state.status.unwrap_or_else(|| "unknown".to_string()),
            pane_id: state.pane_id,
            tmux_session: state.tmux_session,
            last_relaunch_epoch,
            relaunch_count: state.relaunch_count.unwrap_or(0),
            token,
        })
    }

    /// Update state.json after a relaunch
    pub fn write_relaunch_state(&self, new_pane_id: &str, reason: &str) -> Result<()> {
        let state_path = self.worker_dir.join("state.json");
        let now = chrono::Utc::now().to_rfc3339();

        // Read existing state to preserve other fields
        let mut state: serde_json::Value = if state_path.exists() {
            let raw = std::fs::read_to_string(&state_path)?;
            serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!({}))
        } else {
            serde_json::json!({})
        };

        state["status"] = serde_json::json!("active");
        state["pane_id"] = serde_json::json!(new_pane_id);
        state["last_relaunch"] = serde_json::json!({
            "at": now,
            "reason": reason,
        });
        state["relaunch_count"] = serde_json::json!(self.relaunch_count + 1);

        std::fs::write(&state_path, serde_json::to_string_pretty(&state)?)?;
        Ok(())
    }
}

/// Load all worker snapshots for a project
pub fn load_all_workers(project: &str, project_dir: &Path) -> Vec<WorkerSnapshot> {
    let Ok(entries) = std::fs::read_dir(project_dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|e| e.path().is_dir() && e.path().join("config.json").exists())
        .filter_map(|e| {
            let name = e.file_name().to_str()?.to_string();
            WorkerSnapshot::load(&name, project, project_dir).ok()
        })
        .collect()
}
