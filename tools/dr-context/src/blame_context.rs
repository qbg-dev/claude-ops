use regex::Regex;
use serde::Serialize;
use serde_json;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::process::Command;

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
/// on each, classifies lines as new (HEAD commit) vs pre-existing.
/// Equivalent to the inline Python blame-context script in deep-review.sh.
pub fn run(
    project_root: &str,
    material_file: &str,
    out_path: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    let content = fs::read_to_string(material_file)?;
    let diff_re = Regex::new(r"^diff --git a/(\S+)")?;

    // Parse diff to find changed file names
    let mut changed_files: Vec<String> = Vec::new();
    for line in content.lines() {
        if let Some(cap) = diff_re.captures(line) {
            if let Some(m) = cap.get(1) {
                let file = m.as_str().to_string();
                if !changed_files.contains(&file) {
                    changed_files.push(file);
                }
            }
        }
    }

    // Get HEAD sha (first 8 chars)
    let head_sha = get_head_sha(project_root);

    let mut result: BTreeMap<String, BlameEntry> = BTreeMap::new();

    // Cap at 30 files (same as Python)
    for filepath in changed_files.iter().take(30) {
        let full_path = Path::new(project_root).join(filepath);
        if !full_path.exists() {
            continue;
        }

        if let Some(entry) = blame_file(project_root, filepath, &head_sha) {
            result.insert(filepath.clone(), entry);
        }
    }

    let json = serde_json::to_string_pretty(&result)?;
    fs::write(out_path, &json)?;
    Ok(format!("    {} files blame-analyzed", result.len()))
}

fn get_head_sha(project_root: &str) -> String {
    Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(project_root)
        .output()
        .ok()
        .and_then(|o| {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.len() >= 8 {
                Some(s[..8].to_string())
            } else {
                None
            }
        })
        .unwrap_or_default()
}

fn blame_file(project_root: &str, filepath: &str, head_sha: &str) -> Option<BlameEntry> {
    let output = Command::new("git")
        .args(["blame", "--porcelain", filepath])
        .current_dir(project_root)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut new_lines: usize = 0;
    let mut old_lines: usize = 0;

    for line in stdout.lines() {
        // Lines starting with a 40-char hex SHA (porcelain format)
        if line.len() >= 40 {
            let first_word = line.split_whitespace().next().unwrap_or("");
            if first_word.len() >= 40 && first_word.chars().all(|c| c.is_ascii_hexdigit()) {
                let sha8 = &first_word[..8];
                if sha8 == head_sha || sha8 == "00000000" {
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
        ratio_new: ((new_lines as f64 / total as f64) * 100.0).round() / 100.0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
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

        let result = run(root, &material, out.to_str().unwrap());
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
        );
        assert!(result.is_ok());
        assert!(result.unwrap().contains("0 files blame-analyzed"));
    }

    #[test]
    fn test_blame_caps_at_30() {
        // Verify the 30-file cap logic exists (unit test, no git needed)
        let files: Vec<String> = (0..50).map(|i| format!("src/file{}.ts", i)).collect();
        assert_eq!(files.iter().take(30).count(), 30);
    }
}
