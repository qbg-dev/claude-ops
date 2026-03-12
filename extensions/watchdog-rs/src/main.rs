mod checker;
mod config;
mod install;
mod plugin;
mod plugins;
mod tmux;
mod worker;

use crate::checker::Action;
use crate::plugin::{Plugin, PluginAction};
use crate::worker::WorkerSnapshot;
use clap::{Parser, Subcommand};
use comfy_table::{Cell, Table};
use std::sync::Arc;
use std::time::Duration;
use tracing::{error, info, warn};

#[derive(Parser)]
#[command(name = "boring-watchdog", about = "Process watchdog for claude-fleet workers")]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    /// Run the watchdog daemon (default)
    Daemon,
    /// Single pass — check all workers once
    Once,
    /// Print worker status table
    Status,
    /// Install launchd plist
    Install,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let cfg = config::Config::load()?;

    // Set up logging
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&cfg.log_file)?;
    tracing_subscriber::fmt()
        .json()
        .with_writer(log_file)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    match cli.command.unwrap_or(Commands::Daemon) {
        Commands::Daemon => run_daemon(cfg).await,
        Commands::Once => run_once(&cfg).await,
        Commands::Status => run_status(&cfg),
        Commands::Install => install::install(),
    }
}

async fn run_daemon(cfg: config::Config) -> anyhow::Result<()> {
    info!("boring-watchdog daemon starting");

    let cfg = Arc::new(cfg);

    // Build plugins
    let plugins: Vec<Box<dyn Plugin>> = build_plugins(&cfg);
    let plugins = Arc::new(plugins);

    // Spawn plugin loops (each on their own interval)
    for (i, _) in plugins.iter().enumerate() {
        let cfg = Arc::clone(&cfg);
        let plugins = Arc::clone(&plugins);
        tokio::spawn(async move {
            let plugin = &plugins[i];
            loop {
                let workers = collect_perpetual_workers(&cfg);
                for worker in &workers {
                    match plugin.check(worker).await {
                        Some(PluginAction::Notify(msg)) => {
                            info!(plugin = plugin.name(), worker = %worker.name, "notify: {msg}");
                            tmux::notify_desktop("Watchdog", &msg);
                        }
                        Some(PluginAction::Log(msg)) => {
                            warn!(plugin = plugin.name(), worker = %worker.name, "{msg}");
                        }
                        None => {}
                    }
                }
                tokio::time::sleep(plugin.interval()).await;
            }
        });
    }

    // Core watchdog loop
    loop {
        run_core_pass(&cfg);
        tokio::time::sleep(Duration::from_secs(cfg.check_interval_secs)).await;
    }
}

async fn run_once(cfg: &config::Config) -> anyhow::Result<()> {
    info!("boring-watchdog single pass");

    // Core pass
    run_core_pass(cfg);

    // Plugin pass
    let plugins = build_plugins(cfg);
    let workers = collect_perpetual_workers(cfg);
    for plugin in &plugins {
        for worker in &workers {
            match plugin.check(worker).await {
                Some(PluginAction::Notify(msg)) => {
                    println!("[{}] NOTIFY {}: {msg}", plugin.name(), worker.name);
                }
                Some(PluginAction::Log(msg)) => {
                    println!("[{}] LOG {}: {msg}", plugin.name(), worker.name);
                }
                None => {}
            }
        }
    }

    Ok(())
}

fn run_core_pass(cfg: &config::Config) {
    let now = chrono::Utc::now().timestamp();
    let workers = collect_perpetual_workers(cfg);

    for worker in &workers {
        let action = checker::check(worker, now, cfg.cooldown_secs);
        match action {
            Action::Skip(reason) => {
                tracing::trace!(worker = %worker.name, reason, "skip");
            }
            Action::Relaunch(reason) => {
                info!(worker = %worker.name, reason, "relaunching");
                if let Err(e) = do_relaunch(worker) {
                    error!(worker = %worker.name, err = %e, "relaunch failed");
                }
            }
        }
    }
}

fn do_relaunch(worker: &WorkerSnapshot) -> anyhow::Result<()> {
    let worktree = worker.worktree.as_deref().unwrap_or(".");

    // Kill existing content if pane is alive
    if let Some(ref pane_id) = worker.pane_id {
        if tmux::is_pane_alive(pane_id) {
            let _ = tmux::kill_pane_content(pane_id);
        }
    }

    // Determine target pane
    let new_pane_id = if let Some(ref pane_id) = worker.pane_id {
        if tmux::is_pane_alive(pane_id) {
            // Reuse existing pane
            pane_id.clone()
        } else {
            // Pane is dead — create new one
            create_or_fallback(worker)?
        }
    } else {
        // No pane registered
        create_or_fallback(worker)?
    };

    // Launch claude
    tmux::launch_claude(&new_pane_id, worktree, &worker.model, &worker.permission_mode)?;

    // Update state
    worker.write_relaunch_state(&new_pane_id, "watchdog relaunch")?;

    info!(
        worker = %worker.name,
        pane_id = %new_pane_id,
        relaunch_count = worker.relaunch_count + 1,
        "relaunch complete"
    );

    Ok(())
}

fn create_or_fallback(worker: &WorkerSnapshot) -> anyhow::Result<String> {
    // Try to create pane in the correct window
    if let Some(ref window) = worker.window {
        let session = worker
            .tmux_session
            .as_deref()
            .unwrap_or("main");
        if tmux::window_exists(session, window) {
            return tmux::create_pane(session, window);
        }
    }

    // Fallback: use fleet start
    info!(worker = %worker.name, "no window available, using fleet start");
    tmux::fleet_start(&worker.name, &worker.project)?;

    // fleet start updates state.json with the new pane_id
    // Re-read it to get the pane_id
    let refreshed = worker::WorkerSnapshot::load(&worker.name, &worker.project, &worker.project_dir)?;
    refreshed
        .pane_id
        .ok_or_else(|| anyhow::anyhow!("fleet start did not set pane_id"))
}

fn run_status(cfg: &config::Config) -> anyhow::Result<()> {
    let mut table = Table::new();
    table.set_header(vec!["Worker", "Project", "Status", "Pane", "Alive", "Claude", "Sleep", "Relaunches"]);

    for (project, project_dir) in cfg.project_dirs() {
        let workers = worker::load_all_workers(&project, &project_dir);
        for w in workers {
            if w.sleep_duration <= 0 && !w.ephemeral {
                continue; // Skip non-perpetual in status view unless interesting
            }
            let pane_id = w.pane_id.as_deref().unwrap_or("-");
            let alive = if pane_id == "-" {
                "-".to_string()
            } else {
                if tmux::is_pane_alive(pane_id) { "yes" } else { "no" }.to_string()
            };
            let claude = if pane_id == "-" || alive == "no" {
                "-".to_string()
            } else {
                if tmux::is_claude_running(pane_id) { "yes" } else { "no" }.to_string()
            };

            table.add_row(vec![
                Cell::new(&w.name),
                Cell::new(&project),
                Cell::new(&w.status),
                Cell::new(pane_id),
                Cell::new(&alive),
                Cell::new(&claude),
                Cell::new(if w.sleep_duration > 0 {
                    format!("{}s", w.sleep_duration)
                } else {
                    "-".to_string()
                }),
                Cell::new(w.relaunch_count),
            ]);
        }
    }

    println!("{table}");
    Ok(())
}

fn collect_perpetual_workers(cfg: &config::Config) -> Vec<WorkerSnapshot> {
    let mut all = Vec::new();
    for (project, project_dir) in cfg.project_dirs() {
        let workers = worker::load_all_workers(&project, &project_dir);
        for w in workers {
            if w.sleep_duration > 0 && !w.ephemeral {
                all.push(w);
            }
        }
    }
    all
}

fn build_plugins(cfg: &config::Config) -> Vec<Box<dyn Plugin>> {
    let mut plugins: Vec<Box<dyn Plugin>> = Vec::new();

    // Unread mail notifier (only if Fleet Mail URL is configured)
    if let Some(ref url) = cfg.fleet_mail_url {
        plugins.push(Box::new(plugins::unread_mail::UnreadMailNotifier::new(
            url.clone(),
        )));
    }

    // Liveness monitor
    plugins.push(Box::new(plugins::liveness::LivenessMonitor::new(
        cfg.fleet_state_dir.clone(),
    )));

    plugins
}
