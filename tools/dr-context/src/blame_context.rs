use regex::Regex;
use serde::Serialize;
use serde_json;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::Path;
use std::process::Command;

use crate::util;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[cfg_attr(test, derive(serde::Deserialize))]
pub struct BlameEntry {
    pub new_in_diff: usize,
    pub pre_existing: usize,
    pub ratio_new: f64,
}

/// Build blame context for changed files.
///
/// Parses the diff material to find changed files, runs `git blame --porcelain`
/// on each, classifies lines as new (in commit range) vs pre-existing.
///
/// When `base_ref` is provided, all commits in `base_ref..HEAD` are counted as "new".
/// Without it, only the HEAD commit is counted as "new" (backward-compatible).
pub fn run(
    project_root: &str,
    material_file: &str,
    out_path: &str,
    base_ref: Option<&str>,
) -> Result<String, Box<dyn std::error::Error>> {
    let content = fs::read_to_string(material_file)?;
    // Capture b/ path (new name) to handle renames correctly (#5)
    // Use .+ instead of \S+ to handle filenames with spaces (#21)
    let diff_re = Regex::new(r"^diff --git a/.+ b/(.+)")?;

    // Parse diff to find changed file names (use HashSet for O(1) dedup — #16)
    let mut seen = HashSet::new();
    let mut changed_files: Vec<String> = Vec::new();
    for line in content.lines() {
        if let Some(cap) = diff_re.captures(line) {
            if let Some(m) = cap.get(1) {
                let file = m.as_str().to_string();
                if seen.insert(file.clone()) {
                    changed_files.push(file);
                }
            }
        }
    }

    // Collect all "new" commit SHAs (#2: multi-commit support)
    let new_shas = get_new_shas(project_root, base_ref);
    if new_shas.is_empty() {
        eprintln!("WARN: could not determine any new commit SHAs — blame data may be inaccurate");
    }

    let mut result: BTreeMap<String, BlameEntry> = BTreeMap::new();

    // Cap at 30 files (same as Python)
    for filepath in changed_files.iter().take(30) {
        let full_path = Path::new(project_root).join(filepath);
        if !full_path.exists() {
            continue;
        }

        if let Some(entry) = blame_file(project_root, filepath, &new_shas) {
            result.insert(filepath.clone(), entry);
        }
    }

    let json = serde_json::to_string_pretty(&result)?;
    fs::write(out_path, &json)?;
    Ok(format!("    {} files blame-analyzed", result.len()))
}

/// Collect commit SHAs that should be considered "new".
///
/// With base_ref: all commits in base_ref..HEAD (multi-commit branches).
/// Without: only HEAD commit (backward-compatible single-commit mode).
fn get_new_shas(project_root: &str, base_ref: Option<&str>) -> HashSet<String> {
    let mut shas = HashSet::new();

    match base_ref {
        Some(base) => {
            // Multi-commit: get all SHAs in range
            let range = format!("{}..HEAD", base);
            let mut cmd = Command::new("git");
            cmd.args(["rev-list", &range]).current_dir(project_root);
            if let Ok(output) = util::run_cmd(cmd, util::CMD_TIMEOUT) {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    let trimmed = line.trim();
                    if trimmed.len() >= 8 && trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
                        shas.insert(trimmed[..8].to_string());
                    }
                }
            }
        }
        None => {
            // Single-commit: HEAD only
            let mut cmd = Command::new("git");
            cmd.args(["rev-parse", "HEAD"]).current_dir(project_root);
            if let Ok(output) = util::run_cmd(cmd, util::CMD_TIMEOUT) {
                let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if s.len() >= 8 {
                    shas.insert(s[..8].to_string());
                }
            }
        }
    }

    shas
}

/// Banker's rounding (round half to even) to match Python's `round()` (#17).
fn round_half_even(value: f64, decimals: u32) -> f64 {
    let factor = 10f64.powi(decimals as i32);
    let scaled = value * factor;
    let floored = scaled.floor();
    let frac = scaled - floored;

    let rounded = if (frac - 0.5).abs() < 1e-9 {
        // Exactly halfway — round to even
        if floored as i64 % 2 == 0 {
            floored
        } else {
            floored + 1.0
        }
    } else {
        scaled.round()
    };

    rounded / factor
}

fn blame_file(
    project_root: &str,
    filepath: &str,
    new_shas: &HashSet<String>,
) -> Option<BlameEntry> {
    let mut cmd = Command::new("git");
    cmd.args(["blame", "--porcelain", filepath])
        .current_dir(project_root);
    let output = util::run_cmd(cmd, util::CMD_TIMEOUT).ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut new_lines: usize = 0;
    let mut old_lines: usize = 0;

    for line in stdout.lines() {
        // Skip content lines (prefixed with tab in porcelain format)
        if line.starts_with('\t') {
            continue;
        }
        // Lines starting with a 40-char hex SHA (porcelain format)
        if line.len() >= 40 {
            let first_word = line.split_whitespace().next().unwrap_or("");
            if first_word.len() >= 40 && first_word.chars().all(|c| c.is_ascii_hexdigit()) {
                let sha8 = &first_word[..8];
                if new_shas.contains(sha8) || sha8 == "00000000" {
                    new_lines += 1;
                } else {
                    old_lines += 1;
                }
            }
        }
    }

    let total = new_lines + old_lines;
    if total == 0 {
        return None;
    }

    Some(BlameEntry {
        new_in_diff: new_lines,
        pre_existing: old_lines,
        ratio_new: round_half_even(new_lines as f64 / total as f64, 2),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;
    use tempfile::TempDir;

    fn setup_git_project() -> TempDir {
        let dir = TempDir::new().unwrap();
        let root = dir.path();

        Command::new("git")
            .args(["init"])
            .current_dir(root)
            .output()
            .unwrap();
        Command::new("git")
            .args(["config", "user.email", "test@test.com"])
            .current_dir(root)
            .output()
            .unwrap();
        Command::new("git")
            .args(["config", "user.name", "test"])
            .current_dir(root)
            .output()
            .unwrap();

        // Create a file with pre-existing content
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/old.ts"), "line1\nline2\nline3\n").unwrap();

        Command::new("git")
            .args(["add", "-A"])
            .current_dir(root)
            .output()
            .unwrap();
        Command::new("git")
            .args(["commit", "-m", "initial"])
            .current_dir(root)
            .output()
            .unwrap();

        // Add new content (will be HEAD)
        fs::write(
            root.join("src/old.ts"),
            "line1\nline2\nline3\nnew_line4\nnew_line5\n",
        )
        .unwrap();

        Command::new("git")
            .args(["add", "-A"])
            .current_dir(root)
            .output()
            .unwrap();
        Command::new("git")
            .args(["commit", "-m", "add new lines"])
            .current_dir(root)
            .output()
            .unwrap();

        // Generate a diff material file
        let diff_output = Command::new("git")
            .args(["diff", "HEAD~1..HEAD"])
            .current_dir(root)
            .output()
            .unwrap();
        fs::write(
            root.join("material.txt"),
            String::from_utf8_lossy(&diff_output.stdout).as_ref(),
        )
        .unwrap();

        dir
    }

    #[test]
    fn test_blame_basic() {
        let dir = setup_git_project();
        let root = dir.path().to_str().unwrap();
        let material = dir.path().join("material.txt").to_string_lossy().to_string();
        let out = dir.path().join("blame.json");

        let result = run(root, &material, out.to_str().unwrap(), None);
        assert!(result.is_ok(), "blame failed: {:?}", result);

        let json: BTreeMap<String, BlameEntry> =
            serde_json::from_str(&fs::read_to_string(&out).unwrap()).unwrap();
        assert!(json.contains_key("src/old.ts"));

        let entry = &json["src/old.ts"];
        // 5 total lines: 3 pre-existing + 2 new (HEAD)
        assert_eq!(entry.new_in_diff, 2, "expected 2 new lines");
        assert_eq!(entry.pre_existing, 3, "expected 3 pre-existing lines");
        assert!(
            entry.ratio_new > 0.0 && entry.ratio_new < 1.0,
            "ratio should be between 0 and 1, got {}",
            entry.ratio_new
        );
    }

    #[test]
    fn test_blame_no_diff_files() {
        let dir = TempDir::new().unwrap();
        let root = dir.path();

        Command::new("git")
            .args(["init"])
            .current_dir(root)
            .output()
            .unwrap();
        Command::new("git")
            .args(["config", "user.email", "test@test.com"])
            .current_dir(root)
            .output()
            .unwrap();
        Command::new("git")
            .args(["config", "user.name", "test"])
            .current_dir(root)
            .output()
            .unwrap();

        // Empty material file (no diffs)
        let material = root.join("material.txt");
        fs::write(&material, "just some content, no diff headers").unwrap();
        let out = root.join("blame.json");

        let result = run(
            root.to_str().unwrap(),
            material.to_str().unwrap(),
            out.to_str().unwrap(),
            None,
        );
        assert!(result.is_ok());
        assert!(result.unwrap().contains("0 files blame-analyzed"));
    }

    #[test]
    fn test_blame_caps_at_30() {
        // Create a git repo with 35+ files, modify all, verify output capped at 30
        let dir = TempDir::new().unwrap();
        let root = dir.path();

        Command::new("git")
            .args(["init"])
            .current_dir(root)
            .output()
            .unwrap();
        Command::new("git")
            .args(["config", "user.email", "test@test.com"])
            .current_dir(root)
            .output()
            .unwrap();
        Command::new("git")
            .args(["config", "user.name", "test"])
            .current_dir(root)
            .output()
            .unwrap();

        fs::create_dir_all(root.join("src")).unwrap();

        // Create 35 files with initial content
        for i in 0..35 {
            fs::write(
                root.join(format!("src/file{}.ts", i)),
                format!("old_line_{}\n", i),
            )
            .unwrap();
        }
        Command::new("git")
            .args(["add", "-A"])
            .current_dir(root)
            .output()
            .unwrap();
        Command::new("git")
            .args(["commit", "-m", "initial"])
            .current_dir(root)
            .output()
            .unwrap();

        // Modify all 35 files
        for i in 0..35 {
            fs::write(
                root.join(format!("src/file{}.ts", i)),
                format!("old_line_{}\nnew_line_{}\n", i, i),
            )
            .unwrap();
        }
        Command::new("git")
            .args(["add", "-A"])
            .current_dir(root)
            .output()
            .unwrap();
        Command::new("git")
            .args(["commit", "-m", "modify all"])
            .current_dir(root)
            .output()
            .unwrap();

        // Generate diff
        let diff = Command::new("git")
            .args(["diff", "HEAD~1..HEAD"])
            .current_dir(root)
            .output()
            .unwrap();
        let material = root.join("material.txt");
        fs::write(
            &material,
            String::from_utf8_lossy(&diff.stdout).as_ref(),
        )
        .unwrap();

        let out = root.join("blame.json");
        let result = run(
            root.to_str().unwrap(),
            material.to_str().unwrap(),
            out.to_str().unwrap(),
            None,
        );
        assert!(result.is_ok(), "blame failed: {:?}", result);

        let json: BTreeMap<String, BlameEntry> =
            serde_json::from_str(&fs::read_to_string(&out).unwrap()).unwrap();
        assert!(
            json.len() <= 30,
            "should cap at 30 files, got {}",
            json.len()
        );
        assert!(!json.is_empty(), "should have some blame results");
    }

    #[test]
    fn test_blame_multi_commit() {
        // Test that base_ref correctly counts intermediate commits as "new"
        let dir = TempDir::new().unwrap();
        let root = dir.path();

        Command::new("git")
            .args(["init"])
            .current_dir(root)
            .output()
            .unwrap();
        Command::new("git")
            .args(["config", "user.email", "test@test.com"])
            .current_dir(root)
            .output()
            .unwrap();
        Command::new("git")
            .args(["config", "user.name", "test"])
            .current_dir(root)
            .output()
            .unwrap();

        fs::create_dir_all(root.join("src")).unwrap();

        // Base commit
        fs::write(root.join("src/multi.ts"), "base_line\n").unwrap();
        Command::new("git")
            .args(["add", "-A"])
            .current_dir(root)
            .output()
            .unwrap();
        Command::new("git")
            .args(["commit", "-m", "base"])
            .current_dir(root)
            .output()
            .unwrap();

        // Tag the base
        Command::new("git")
            .args(["tag", "base-tag"])
            .current_dir(root)
            .output()
            .unwrap();

        // Commit 2 (intermediate)
        fs::write(root.join("src/multi.ts"), "base_line\ncommit2_line\n").unwrap();
        Command::new("git")
            .args(["add", "-A"])
            .current_dir(root)
            .output()
            .unwrap();
        Command::new("git")
            .args(["commit", "-m", "commit2"])
            .current_dir(root)
            .output()
            .unwrap();

        // Commit 3 (HEAD)
        fs::write(
            root.join("src/multi.ts"),
            "base_line\ncommit2_line\ncommit3_line\n",
        )
        .unwrap();
        Command::new("git")
            .args(["add", "-A"])
            .current_dir(root)
            .output()
            .unwrap();
        Command::new("git")
            .args(["commit", "-m", "commit3"])
            .current_dir(root)
            .output()
            .unwrap();

        // Generate diff from base
        let diff = Command::new("git")
            .args(["diff", "base-tag..HEAD"])
            .current_dir(root)
            .output()
            .unwrap();
        let material = root.join("material.txt");
        fs::write(
            &material,
            String::from_utf8_lossy(&diff.stdout).as_ref(),
        )
        .unwrap();

        let out = root.join("blame.json");

        // Without base_ref: only HEAD counted as new (1 line)
        run(
            root.to_str().unwrap(),
            material.to_str().unwrap(),
            out.to_str().unwrap(),
            None,
        )
        .unwrap();
        let json: BTreeMap<String, BlameEntry> =
            serde_json::from_str(&fs::read_to_string(&out).unwrap()).unwrap();
        let entry = &json["src/multi.ts"];
        assert_eq!(entry.new_in_diff, 1, "without base_ref, only HEAD line is new");
        assert_eq!(entry.pre_existing, 2, "base + commit2 are pre-existing");

        // With base_ref: both commit2 and commit3 lines are new
        run(
            root.to_str().unwrap(),
            material.to_str().unwrap(),
            out.to_str().unwrap(),
            Some("base-tag"),
        )
        .unwrap();
        let json2: BTreeMap<String, BlameEntry> =
            serde_json::from_str(&fs::read_to_string(&out).unwrap()).unwrap();
        let entry2 = &json2["src/multi.ts"];
        assert_eq!(
            entry2.new_in_diff, 2,
            "with base_ref, both commit2 and commit3 lines are new"
        );
        assert_eq!(entry2.pre_existing, 1, "only base line is pre-existing");
    }

    #[test]
    fn test_blame_renamed_file() {
        // Test that renamed files are handled correctly (#5)
        let dir = TempDir::new().unwrap();
        let root = dir.path();

        Command::new("git")
            .args(["init"])
            .current_dir(root)
            .output()
            .unwrap();
        Command::new("git")
            .args(["config", "user.email", "test@test.com"])
            .current_dir(root)
            .output()
            .unwrap();
        Command::new("git")
            .args(["config", "user.name", "test"])
            .current_dir(root)
            .output()
            .unwrap();

        fs::create_dir_all(root.join("src")).unwrap();

        // Create and commit original file
        fs::write(root.join("src/original.ts"), "content\n").unwrap();
        Command::new("git")
            .args(["add", "-A"])
            .current_dir(root)
            .output()
            .unwrap();
        Command::new("git")
            .args(["commit", "-m", "initial"])
            .current_dir(root)
            .output()
            .unwrap();

        // Rename the file
        Command::new("git")
            .args(["mv", "src/original.ts", "src/renamed.ts"])
            .current_dir(root)
            .output()
            .unwrap();
        Command::new("git")
            .args(["add", "-A"])
            .current_dir(root)
            .output()
            .unwrap();
        Command::new("git")
            .args(["commit", "-m", "rename"])
            .current_dir(root)
            .output()
            .unwrap();

        // Generate diff with rename detection
        let diff = Command::new("git")
            .args(["diff", "-M", "HEAD~1..HEAD"])
            .current_dir(root)
            .output()
            .unwrap();
        let material = root.join("material.txt");
        let diff_str = String::from_utf8_lossy(&diff.stdout);
        fs::write(&material, diff_str.as_ref()).unwrap();

        // The diff header for renames is:
        // diff --git a/src/original.ts b/src/renamed.ts
        // Our regex should capture b/src/renamed.ts (the new name)
        let out = root.join("blame.json");
        let result = run(
            root.to_str().unwrap(),
            material.to_str().unwrap(),
            out.to_str().unwrap(),
            None,
        );
        assert!(result.is_ok());

        let json: BTreeMap<String, BlameEntry> =
            serde_json::from_str(&fs::read_to_string(&out).unwrap()).unwrap();
        // Should contain renamed.ts (new name), not original.ts (old name)
        assert!(
            !json.contains_key("src/original.ts"),
            "should not contain old name"
        );
        // renamed.ts should be present if the file exists on disk
        if root.join("src/renamed.ts").exists() {
            assert!(
                json.contains_key("src/renamed.ts"),
                "should contain new name after rename"
            );
        }
    }
}
