use glob::glob;
use serde::Serialize;
use serde_json;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

#[derive(Serialize, Debug, Clone)]
#[cfg_attr(test, derive(serde::Deserialize))]
pub struct CoverageEntry {
    pub has_tests: bool,
    pub test_files: Vec<String>,
}

/// Check test coverage for changed files by looking for sibling test files.
///
/// Matches patterns: **/{name}.test.*, **/{name}.spec.*, **/__tests__/{name}.*
/// Equivalent to the inline Python test-coverage script in deep-review.sh.
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

    let root = Path::new(project_root);
    let mut coverage: BTreeMap<String, CoverageEntry> = BTreeMap::new();

    for cf in &changed_files {
        let basename = Path::new(cf)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("");

        if basename.is_empty() {
            coverage.insert(
                cf.to_string(),
                CoverageEntry {
                    has_tests: false,
                    test_files: Vec::new(),
                },
            );
            continue;
        }

        let patterns = [
            format!("**/tests/**/{}.test.*", basename),
            format!("**/tests/**/{}.spec.*", basename),
            format!("**/__tests__/{}.*", basename),
            format!("**/{}.test.*", basename),
            format!("**/{}.spec.*", basename),
        ];

        let mut found_tests: Vec<String> = Vec::new();
        for pattern in &patterns {
            let full_pattern = root.join(pattern).to_string_lossy().to_string();
            if let Ok(entries) = glob(&full_pattern) {
                for entry in entries.flatten() {
                    if let Ok(rel) = entry.strip_prefix(root) {
                        let rel_str = rel.to_string_lossy().to_string();
                        if !found_tests.contains(&rel_str) {
                            found_tests.push(rel_str);
                        }
                    }
                }
            }
        }
        found_tests.truncate(5);

        coverage.insert(
            cf.to_string(),
            CoverageEntry {
                has_tests: !found_tests.is_empty(),
                test_files: found_tests,
            },
        );
    }

    let tested = coverage.values().filter(|v| v.has_tests).count();
    let total = coverage.len();

    let json = serde_json::to_string_pretty(&coverage)?;
    fs::write(out_path, &json)?;
    Ok(format!("    {}/{} files have tests", tested, total))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn setup_project() -> TempDir {
        let dir = TempDir::new().unwrap();
        let root = dir.path();

        // Source files
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/utils.ts"), "export function util() {}").unwrap();
        fs::write(root.join("src/handler.ts"), "export function handle() {}").unwrap();
        fs::write(root.join("src/no-test.ts"), "export function orphan() {}").unwrap();

        // Test files
        fs::create_dir_all(root.join("src/tests/unit")).unwrap();
        fs::write(root.join("src/tests/unit/utils.test.ts"), "test('utils')").unwrap();
        fs::write(root.join("src/handler.spec.ts"), "test('handler')").unwrap();

        dir
    }

    #[test]
    fn test_coverage_finds_tests() {
        let dir = setup_project();
        let root = dir.path().to_str().unwrap();
        let out = dir.path().join("test-coverage.json");

        let result = run(root, "src/utils.ts\nsrc/handler.ts", out.to_str().unwrap());
        assert!(result.is_ok());
        assert!(result.unwrap().contains("2/2 files have tests"));

        let json: BTreeMap<String, CoverageEntry> =
            serde_json::from_str(&fs::read_to_string(&out).unwrap()).unwrap();
        assert!(json["src/utils.ts"].has_tests);
        assert!(json["src/handler.ts"].has_tests);
    }

    #[test]
    fn test_coverage_no_tests() {
        let dir = setup_project();
        let root = dir.path().to_str().unwrap();
        let out = dir.path().join("test-coverage.json");

        let result = run(root, "src/no-test.ts", out.to_str().unwrap());
        assert!(result.is_ok());
        assert!(result.unwrap().contains("0/1 files have tests"));

        let json: BTreeMap<String, CoverageEntry> =
            serde_json::from_str(&fs::read_to_string(&out).unwrap()).unwrap();
        assert!(!json["src/no-test.ts"].has_tests);
        assert!(json["src/no-test.ts"].test_files.is_empty());
    }

    #[test]
    fn test_coverage_empty_input() {
        let dir = setup_project();
        let root = dir.path().to_str().unwrap();
        let out = dir.path().join("test-coverage.json");

        let result = run(root, "", out.to_str().unwrap());
        assert!(result.is_ok());
        assert!(result.unwrap().contains("0/0"));
    }

    #[test]
    fn test_coverage_truncates_at_5() {
        let dir = TempDir::new().unwrap();
        let root = dir.path();

        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/foo.ts"), "").unwrap();

        // Create 7 test files matching "foo"
        for i in 0..7 {
            let dir_name = format!("tests{}", i);
            fs::create_dir_all(root.join(&dir_name)).unwrap();
            fs::write(root.join(format!("{}/foo.test.ts", dir_name)), "").unwrap();
        }

        let out = root.join("test-coverage.json");
        run(root.to_str().unwrap(), "src/foo.ts", out.to_str().unwrap()).unwrap();

        let json: BTreeMap<String, CoverageEntry> =
            serde_json::from_str(&fs::read_to_string(&out).unwrap()).unwrap();
        assert!(
            json["src/foo.ts"].test_files.len() <= 5,
            "should cap at 5, got {}",
            json["src/foo.ts"].test_files.len()
        );
    }
}
