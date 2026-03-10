use regex::Regex;
use serde::Serialize;
use serde_json;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::process::Command;

#[derive(Serialize, Debug, Clone)]
#[cfg_attr(test, derive(serde::Deserialize))]
pub struct DepEntry {
    pub imported_by: Vec<String>,
    pub imports: Vec<String>,
    pub churn_30d: usize,
}

/// Build a dependency graph for changed files.
///
/// For each file: find callers (grep), parse imports (regex), count git churn.
/// Equivalent to the inline Python dep-graph script in deep-review.sh.
pub fn run(
    project_root: &str,
    changed_files_str: &str,
    out_path: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    let changed_files: Vec<&str> = changed_files_str
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();

    let import_re = Regex::new(r#"from\s+['"]([^'"]+)['"]"#)?;
    let mut graph: BTreeMap<String, DepEntry> = BTreeMap::new();

    for cf in &changed_files {
        let mut entry = DepEntry {
            imported_by: Vec::new(),
            imports: Vec::new(),
            churn_30d: 0,
        };

        // Extract basename without extension for caller search
        let basename = Path::new(cf)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("");

        if !basename.is_empty() {
            // Find callers: grep for imports of this file
            let pattern = format!("from.*['\"].*{}['\"]", regex::escape(basename));
            if let Ok(output) = Command::new("grep")
                .args([
                    "-rn",
                    "--include=*.ts",
                    "--include=*.tsx",
                    "--include=*.js",
                    &pattern,
                    project_root,
                ])
                .output()
            {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    // Skip self-imports
                    if line.contains(*cf) {
                        continue;
                    }
                    let parts: Vec<&str> = line.splitn(3, ':').collect();
                    if parts.len() >= 2 {
                        if let Ok(rel) = pathdiff(parts[0], project_root) {
                            entry.imported_by.push(format!("{}:{}", rel, parts[1]));
                        }
                    }
                }
                entry.imported_by.truncate(20);
            }
        }

        // Parse imports from the file itself
        let full_path = Path::new(project_root).join(cf);
        if full_path.exists() {
            if let Ok(content) = fs::read_to_string(&full_path) {
                let mut imports: Vec<String> = import_re
                    .captures_iter(&content)
                    .filter_map(|cap| cap.get(1).map(|m| m.as_str().to_string()))
                    .collect();
                imports.truncate(20);
                entry.imports = imports;
            }
        }

        // Git churn (commits in last 30 days)
        if let Ok(output) = Command::new("git")
            .args(["log", "--oneline", "--since=30 days ago", "--", cf])
            .current_dir(project_root)
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            entry.churn_30d = stdout.lines().filter(|l| !l.is_empty()).count();
        }

        graph.insert(cf.to_string(), entry);
    }

    let json = serde_json::to_string_pretty(&graph)?;
    fs::write(out_path, &json)?;
    Ok(format!("    {} files mapped", graph.len()))
}

/// Compute relative path from `base` to `path`.
fn pathdiff(path: &str, base: &str) -> Result<String, Box<dyn std::error::Error>> {
    let p = Path::new(path);
    let b = Path::new(base);
    match p.strip_prefix(b) {
        Ok(rel) => Ok(rel.to_string_lossy().to_string()),
        Err(_) => Ok(path.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn setup_project() -> TempDir {
        let dir = TempDir::new().unwrap();
        let root = dir.path();

        // Initialize git repo
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

        // Create source files
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(
            root.join("src/foo.ts"),
            r#"import { bar } from './bar';
import { baz } from '../lib/baz';
export function foo() { return bar(); }
"#,
        )
        .unwrap();
        fs::write(
            root.join("src/bar.ts"),
            r#"export function bar() { return 42; }
"#,
        )
        .unwrap();
        fs::write(
            root.join("src/caller.ts"),
            r#"import { foo } from './foo';
console.log(foo());
"#,
        )
        .unwrap();

        // Initial commit
        Command::new("git")
            .args(["add", "-A"])
            .current_dir(root)
            .output()
            .unwrap();
        Command::new("git")
            .args(["commit", "-m", "init"])
            .current_dir(root)
            .output()
            .unwrap();

        dir
    }

    #[test]
    fn test_dep_graph_basic() {
        let dir = setup_project();
        let root = dir.path().to_str().unwrap();
        let out = dir.path().join("dep-graph.json");

        let result = run(root, "src/foo.ts", out.to_str().unwrap());
        assert!(result.is_ok());
        assert!(result.unwrap().contains("1 files mapped"));

        let json: BTreeMap<String, DepEntry> =
            serde_json::from_str(&fs::read_to_string(&out).unwrap()).unwrap();
        let entry = &json["src/foo.ts"];

        // foo.ts imports bar and baz
        assert!(entry.imports.contains(&"./bar".to_string()));
        assert!(entry.imports.contains(&"../lib/baz".to_string()));

        // caller.ts imports foo
        assert!(
            entry.imported_by.iter().any(|s| s.contains("caller.ts")),
            "Expected caller.ts in imported_by, got: {:?}",
            entry.imported_by
        );
    }

    #[test]
    fn test_dep_graph_truncates() {
        let dir = setup_project();
        let root = dir.path();

        // Create a file with 25 imports
        let mut content = String::new();
        for i in 0..25 {
            content.push_str(&format!("import {{ x{i} }} from './mod{i}';\n"));
        }
        fs::write(root.join("src/many.ts"), &content).unwrap();
        Command::new("git")
            .args(["add", "-A"])
            .current_dir(root)
            .output()
            .unwrap();
        Command::new("git")
            .args(["commit", "-m", "add many"])
            .current_dir(root)
            .output()
            .unwrap();

        let out = root.join("dep-graph.json");
        run(root.to_str().unwrap(), "src/many.ts", out.to_str().unwrap()).unwrap();

        let json: BTreeMap<String, DepEntry> =
            serde_json::from_str(&fs::read_to_string(&out).unwrap()).unwrap();
        let entry = &json["src/many.ts"];
        assert!(
            entry.imports.len() <= 20,
            "imports should be capped at 20, got {}",
            entry.imports.len()
        );
    }

    #[test]
    fn test_dep_graph_empty_files() {
        let dir = setup_project();
        let root = dir.path().to_str().unwrap();
        let out = dir.path().join("dep-graph.json");

        let result = run(root, "", out.to_str().unwrap());
        assert!(result.is_ok());
        assert!(result.unwrap().contains("0 files mapped"));
    }

    #[test]
    fn test_dep_graph_nonexistent_file() {
        let dir = setup_project();
        let root = dir.path().to_str().unwrap();
        let out = dir.path().join("dep-graph.json");

        let result = run(root, "does/not/exist.ts", out.to_str().unwrap());
        assert!(result.is_ok());

        let json: BTreeMap<String, DepEntry> =
            serde_json::from_str(&fs::read_to_string(&out).unwrap()).unwrap();
        let entry = &json["does/not/exist.ts"];
        assert!(entry.imports.is_empty());
        assert_eq!(entry.churn_30d, 0);
    }
}
