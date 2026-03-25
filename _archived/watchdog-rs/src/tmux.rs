use anyhow::{bail, Result};
use std::process::Command;
use std::thread;
use std::time::Duration;
use tracing::{debug, warn};

// TUI indicators that Claude Code is running
const TUI_INDICATORS: &[&str] = &[
    "bypass permissions",
    "❯",
    "Plan:",
    "claude-code",
    "Thinking",
    "Tool:",
];

// --- Queries (read-only) ---

pub fn is_pane_alive(pane_id: &str) -> bool {
    if pane_id.is_empty() {
        return false;
    }
    let output = Command::new("tmux")
        .args(["list-panes", "-a", "-F", "#{pane_id}"])
        .output();
    match output {
        Ok(o) => String::from_utf8_lossy(&o.stdout)
            .lines()
            .any(|line| line.trim() == pane_id),
        Err(_) => false,
    }
}

pub fn capture_pane(pane_id: &str, lines: usize) -> Option<String> {
    let output = Command::new("tmux")
        .args([
            "capture-pane",
            "-t",
            pane_id,
            "-p",
            "-S",
            &format!("-{lines}"),
        ])
        .output()
        .ok()?;
    if output.status.success() {
        Some(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        None
    }
}

pub fn is_claude_running(pane_id: &str) -> bool {
    let Some(content) = capture_pane(pane_id, 5) else {
        return false;
    };
    TUI_INDICATORS.iter().any(|ind| content.contains(ind))
}

pub fn pane_pid(pane_id: &str) -> Option<u32> {
    let output = Command::new("tmux")
        .args(["display-message", "-t", pane_id, "-p", "#{pane_pid}"])
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&output.stdout);
    s.trim().parse().ok()
}

pub fn window_exists(session: &str, window: &str) -> bool {
    let output = Command::new("tmux")
        .args(["list-windows", "-t", session, "-F", "#{window_name}"])
        .output();
    match output {
        Ok(o) => String::from_utf8_lossy(&o.stdout)
            .lines()
            .any(|line| line.trim() == window),
        Err(_) => false,
    }
}

/// Create a new tmux window in the given session
pub fn create_window(session: &str, window: &str) -> Result<()> {
    let status = Command::new("tmux")
        .args(["new-window", "-t", session, "-n", window, "-d"])
        .status()?;
    if !status.success() {
        bail!("new-window failed for {session}:{window}");
    }
    debug!(session, window, "Created new tmux window");
    Ok(())
}

// --- Actions (write) ---

/// Fault-tolerant Enter: try normal Enter first, fall back to hex 0d
pub fn send_enter(pane_id: &str) -> Result<()> {
    for attempt in 0..3 {
        if attempt == 0 {
            // Try normal Enter
            let status = Command::new("tmux")
                .args(["send-keys", "-t", pane_id, "Enter"])
                .status();
            if matches!(status, Ok(s) if s.success()) {
                return Ok(());
            }
        } else {
            // Fall back to hex 0d
            let status = Command::new("tmux")
                .args(["send-keys", "-t", pane_id, "-H", "0d"])
                .status();
            if matches!(status, Ok(s) if s.success()) {
                return Ok(());
            }
        }
        thread::sleep(Duration::from_millis(500));
    }
    bail!("send_enter failed after 3 attempts for pane {pane_id}")
}

pub fn send_keys(pane_id: &str, keys: &str) -> Result<()> {
    for attempt in 0..3 {
        let status = Command::new("tmux")
            .args(["send-keys", "-t", pane_id, keys])
            .status();
        if matches!(status, Ok(s) if s.success()) {
            return Ok(());
        }
        if attempt < 2 {
            thread::sleep(Duration::from_millis(300));
        }
    }
    bail!("send_keys failed after 3 attempts for pane {pane_id}")
}

/// For large text, use load-buffer + paste-buffer. For short text, send-keys.
pub fn send_text(pane_id: &str, text: &str) -> Result<()> {
    if text.len() > 200 {
        // Write to temp file, load as tmux buffer, paste
        let tmp = std::env::temp_dir().join("boring-watchdog-buf.txt");
        std::fs::write(&tmp, text)?;
        Command::new("tmux")
            .args(["load-buffer", tmp.to_str().unwrap()])
            .status()?;
        Command::new("tmux")
            .args(["paste-buffer", "-t", pane_id])
            .status()?;
        let _ = std::fs::remove_file(&tmp);
        Ok(())
    } else {
        send_keys(pane_id, text)
    }
}

/// Kill whatever is running in a pane. Escalates: C-c → exit → SIGTERM
pub fn kill_pane_content(pane_id: &str) -> Result<()> {
    // Step 1: C-c C-c
    let _ = Command::new("tmux")
        .args(["send-keys", "-t", pane_id, "C-c", "C-c"])
        .status();
    thread::sleep(Duration::from_millis(500));

    // Step 2: "exit" + Enter
    let _ = send_keys(pane_id, "exit");
    let _ = send_enter(pane_id);
    thread::sleep(Duration::from_secs(1));

    // Step 3: If still alive, SIGTERM the pane pid
    if is_claude_running(pane_id) {
        if let Some(pid) = pane_pid(pane_id) {
            warn!(pane_id, pid, "Claude still running after exit, sending SIGTERM");
            let _ = Command::new("kill").args(["-15", &pid.to_string()]).status();
            thread::sleep(Duration::from_secs(1));
        }
    }
    Ok(())
}

/// Create a new pane in the given window, return the pane_id
pub fn create_pane(session: &str, window: &str) -> Result<String> {
    let target = format!("{session}:{window}");
    let output = Command::new("tmux")
        .args(["split-window", "-t", &target, "-P", "-F", "#{pane_id}"])
        .output()?;
    if !output.status.success() {
        bail!(
            "split-window failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let pane_id = String::from_utf8_lossy(&output.stdout).trim().to_string();

    // Re-tile the window
    let _ = Command::new("tmux")
        .args(["select-layout", "-t", &target, "tiled"])
        .status();

    debug!(pane_id, window, "Created new pane");
    Ok(pane_id)
}

/// Poll until Claude TUI prompt appears, or timeout
pub fn wait_for_prompt(pane_id: &str, timeout: Duration) -> Result<()> {
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        if is_claude_running(pane_id) {
            return Ok(());
        }
        thread::sleep(Duration::from_secs(2));
    }
    bail!("Timed out waiting for Claude prompt in pane {pane_id}")
}

/// macOS desktop notification
pub fn notify_desktop(title: &str, message: &str) {
    let script = format!(
        "display notification \"{}\" with title \"{}\"",
        message.replace('\"', "\\\""),
        title.replace('\"', "\\\""),
    );
    let _ = Command::new("osascript").args(["-e", &script]).status();
}

/// Launch claude in a pane with full worker context (env vars, flags, worker dir)
pub fn launch_claude(
    pane_id: &str,
    worktree: &str,
    model: &str,
    permission_mode: &str,
    worker_name: &str,
    worker_dir: &str,
    reasoning_effort: &str,
) -> Result<()> {
    let perm_flag = if permission_mode == "bypassPermissions" {
        "--dangerously-skip-permissions".to_string()
    } else {
        format!("--permission-mode {permission_mode}")
    };

    let cmd = format!(
        "cd {worktree} && CLAUDE_CODE_SKIP_PROJECT_LOCK=1 WORKER_NAME={name} claude --model {model} --effort {effort} {perm} --add-dir {wdir}",
        worktree = shell_escape(worktree),
        name = shell_escape(worker_name),
        model = shell_escape(model),
        effort = shell_escape(reasoning_effort),
        perm = perm_flag,
        wdir = shell_escape(worker_dir),
    );
    send_keys(pane_id, &cmd)?;
    send_enter(pane_id)?;
    Ok(())
}

/// Wait for Claude TUI to be ready, then inject seed template via fleet CLI
pub fn inject_seed(pane_id: &str, worker_name: &str, worktree: &str) -> Result<()> {
    // Wait for TUI prompt
    if let Err(_) = wait_for_prompt(pane_id, Duration::from_secs(90)) {
        warn!(pane_id, worker_name, "TUI not ready after 90s — skipping seed injection");
        return Ok(());
    }

    thread::sleep(Duration::from_secs(2));

    // Generate seed via fleet MCP module (same path as fleet start)
    let fleet_dir = std::env::var("CLAUDE_FLEET_DIR")
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_default();
            format!("{home}/.claude-fleet")
        });

    let seed_script = format!(
        r#"const {{ generateSeedContent }} = await import('{fleet_dir}/mcp/worker-fleet/index.ts'); process.stdout.write(generateSeedContent());"#,
        fleet_dir = fleet_dir,
    );

    let output = Command::new("bun")
        .args(["-e", &seed_script])
        .env("WORKER_NAME", worker_name)
        .env("PROJECT_ROOT", worktree)
        .env("_FLEET_OPS_DIR", &fleet_dir)
        .output();

    let seed = match output {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout).to_string();
            if s.is_empty() {
                format!("Watchdog respawn. You are worker {worker_name}. Read mission.md, then start your next cycle.")
            } else {
                s
            }
        }
        _ => {
            warn!(worker_name, "seed generation failed — using fallback");
            format!("Watchdog respawn. You are worker {worker_name}. Read mission.md, then start your next cycle.")
        }
    };

    // Inject seed via tmux buffer
    send_text(pane_id, &seed)?;
    thread::sleep(Duration::from_secs(4));
    send_enter(pane_id)?;

    // Retry enter if prompt still visible
    thread::sleep(Duration::from_secs(3));
    if let Some(content) = capture_pane(pane_id, 3) {
        if content.contains("❯") {
            send_enter(pane_id)?;
        }
    }

    Ok(())
}

/// Use fleet start as fallback when we can't create the pane ourselves
pub fn fleet_start(worker: &str, project: &str) -> Result<()> {
    let status = Command::new("fleet")
        .args(["start", worker, "-p", project])
        .status()?;
    if !status.success() {
        bail!("fleet start {worker} -p {project} failed");
    }
    Ok(())
}

fn shell_escape(s: &str) -> String {
    // Quote if string contains spaces, quotes, or shell glob characters
    if s.contains(' ') || s.contains('\'') || s.contains('[') || s.contains(']')
        || s.contains('*') || s.contains('?') || s.contains('{') || s.contains('}')
    {
        format!("'{}'", s.replace('\'', "'\\''"))
    } else {
        s.to_string()
    }
}
