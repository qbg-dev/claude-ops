use anyhow::{bail, Context, Result};
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

const LABEL: &str = "com.tmux-agents.watchdog";

pub fn install() -> Result<()> {
    let home = env::var("HOME").context("HOME not set")?;
    let plist_dir = PathBuf::from(&home).join("Library/LaunchAgents");
    let plist_path = plist_dir.join(format!("{LABEL}.plist"));

    // Find the binary
    let binary = env::current_exe().context("cannot determine binary path")?;
    let binary_str = binary.to_str().context("binary path not UTF-8")?;

    let log_dir = PathBuf::from(&home).join(".claude-fleet/state");
    fs::create_dir_all(&log_dir)?;

    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{binary_str}</string>
        <string>daemon</string>
    </array>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>{log_dir}/watchdog-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>{log_dir}/watchdog-stderr.log</string>
</dict>
</plist>"#,
        log_dir = log_dir.display(),
    );

    // Unload existing if present
    let _ = Command::new("launchctl")
        .args(["bootout", &format!("gui/{}", &uid()), &plist_path.to_string_lossy()])
        .status();

    fs::write(&plist_path, &plist)?;
    println!("Wrote plist to {}", plist_path.display());

    // Load
    let status = Command::new("launchctl")
        .args(["bootstrap", &format!("gui/{}", &uid()), &plist_path.to_string_lossy()])
        .status();

    match status {
        Ok(s) if s.success() => {
            println!("Loaded {LABEL} via launchctl bootstrap");
        }
        _ => {
            // Fallback to legacy load
            let status = Command::new("launchctl")
                .args(["load", &plist_path.to_string_lossy()])
                .status()?;
            if !status.success() {
                bail!("Failed to load plist");
            }
            println!("Loaded {LABEL} via launchctl load (legacy)");
        }
    }

    Ok(())
}

fn uid() -> String {
    let output = std::process::Command::new("id").args(["-u"]).output();
    match output {
        Ok(o) => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        Err(_) => "501".to_string(), // fallback
    }
}
