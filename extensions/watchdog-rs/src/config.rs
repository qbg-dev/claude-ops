use anyhow::{Context, Result};
use serde::Deserialize;
use std::env;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Config {
    pub check_interval_secs: u64,
    pub cooldown_secs: i64,
    pub fleet_dir: PathBuf,
    pub fleet_state_dir: PathBuf,
    pub fleet_mail_url: Option<String>,
    pub log_file: PathBuf,
}

#[derive(Debug, Deserialize, Default)]
struct FleetDefaults {
    fleet_mail_url: Option<String>,
}

impl Config {
    pub fn load() -> Result<Self> {
        let home = env::var("HOME").context("HOME not set")?;
        let fleet_dir = PathBuf::from(
            env::var("CLAUDE_FLEET_DIR")
                .unwrap_or_else(|_| format!("{home}/.claude/fleet")),
        );
        let fleet_state_dir = PathBuf::from(
            env::var("CLAUDE_FLEET_STATE_DIR")
                .unwrap_or_else(|_| format!("{home}/.claude-fleet/state")),
        );
        let log_file = fleet_state_dir.join("watchdog.log");

        // Read fleet defaults for mail URL
        let defaults_path = fleet_dir.join("defaults.json");
        let fleet_mail_url = if defaults_path.exists() {
            let raw = std::fs::read_to_string(&defaults_path)?;
            let defaults: FleetDefaults = serde_json::from_str(&raw).unwrap_or_default();
            defaults.fleet_mail_url
        } else {
            None
        };
        let fleet_mail_url = env::var("FLEET_MAIL_URL").ok().or(fleet_mail_url);

        Ok(Config {
            check_interval_secs: env::var("WATCHDOG_CHECK_INTERVAL")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(30),
            cooldown_secs: env::var("WATCHDOG_COOLDOWN")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(60),
            fleet_dir,
            fleet_state_dir,
            fleet_mail_url,
            log_file,
        })
    }

    /// Discover all project directories under fleet_dir
    pub fn project_dirs(&self) -> Vec<(String, PathBuf)> {
        let mut projects = Vec::new();
        let Ok(entries) = std::fs::read_dir(&self.fleet_dir) else {
            return projects;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() && path.join("fleet.json").exists() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    projects.push((name.to_string(), path));
                }
            }
        }
        projects
    }
}
