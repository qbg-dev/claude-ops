use serde::Serialize;
use serde_json;
use std::fs;
use std::path::Path;

#[derive(Serialize)]
struct SessionMeta {
    session_id: String,
    num_chunks: usize,
    num_workers: usize,
    lines: usize,
    created_at: String,
}

/// Split material into chunks and generate randomized orderings for each worker.
///
/// Splits at diff boundaries, section headers, and file markers.
/// Each worker gets the same chunks in a different random order.
/// Equivalent to the inline Python shuffle script in deep-review.sh.
pub fn run(
    material_file: &str,
    session_dir: &str,
    num_workers_str: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    let num_workers: usize = num_workers_str.parse()?;
    let content = fs::read_to_string(material_file)?;

    // Split into chunks at natural boundaries
    let mut chunks: Vec<String> = Vec::new();
    let mut current: Vec<&str> = Vec::new();

    for line in content.lines() {
        if (line.starts_with("diff --git ")
            || line.starts_with("## ")
            || line.starts_with("═══ "))
            && !current.is_empty()
        {
            chunks.push(current.join("\n"));
            current.clear();
        }
        current.push(line);
    }
    if !current.is_empty() {
        chunks.push(current.join("\n"));
    }

    // If content didn't split well, treat the whole thing as one chunk
    if chunks.len() <= 1 {
        chunks = vec![content.clone()];
    }

    let num_chunks = chunks.len();
    let lines = content.lines().count();

    // Generate randomized orderings using a simple Fisher-Yates with seed
    for i in 1..=num_workers {
        let mut shuffled = chunks.clone();
        // Deterministic shuffle using worker index as seed
        // Simple LCG PRNG seeded with worker number
        let mut rng_state: u64 = (i as u64)
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        for j in (1..shuffled.len()).rev() {
            rng_state = rng_state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            let k = (rng_state >> 33) as usize % (j + 1);
            shuffled.swap(j, k);
        }

        let outpath = Path::new(session_dir).join(format!("material-pass-{}.txt", i));
        fs::write(&outpath, shuffled.join("\n"))?;
    }

    // Write session metadata
    let now = chrono_lite_utc_now();
    let session_id = Path::new(session_dir)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown")
        .to_string();

    let meta = SessionMeta {
        session_id,
        num_chunks,
        num_workers,
        lines,
        created_at: now,
    };
    let meta_path = Path::new(session_dir).join("meta.json");
    fs::write(&meta_path, serde_json::to_string_pretty(&meta)?)?;

    Ok(format!("  Split into {} chunks", num_chunks))
}

/// Simple UTC timestamp without pulling in chrono crate.
fn chrono_lite_utc_now() -> String {
    use std::process::Command;
    Command::new("date")
        .args(["-u", "+%Y-%m-%dT%H:%M:%SZ"])
        .output()
        .ok()
        .and_then(|o| {
            String::from_utf8(o.stdout)
                .ok()
                .map(|s| s.trim().to_string())
        })
        .unwrap_or_else(|| "unknown".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn test_shuffle_splits_at_diff_boundaries() {
        let dir = TempDir::new().unwrap();
        let root = dir.path();

        let material = "diff --git a/foo.ts b/foo.ts\n+line1\n+line2\ndiff --git a/bar.ts b/bar.ts\n+line3\n";
        let material_path = root.join("material.txt");
        fs::write(&material_path, material).unwrap();

        let result = run(
            material_path.to_str().unwrap(),
            root.to_str().unwrap(),
            "3",
        );
        assert!(result.is_ok());
        assert!(result.unwrap().contains("Split into 2 chunks"));

        // Check all 3 worker files exist
        for i in 1..=3 {
            let path = root.join(format!("material-pass-{}.txt", i));
            assert!(path.exists(), "material-pass-{}.txt should exist", i);
            let content = fs::read_to_string(&path).unwrap();
            // Each worker file should contain both chunks (just in different order)
            assert!(content.contains("foo.ts") && content.contains("bar.ts"));
        }

        // Check meta.json
        let meta_path = root.join("meta.json");
        assert!(meta_path.exists());
        let meta: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&meta_path).unwrap()).unwrap();
        assert_eq!(meta["num_chunks"], 2);
        assert_eq!(meta["num_workers"], 3);
    }

    #[test]
    fn test_shuffle_no_split_points() {
        let dir = TempDir::new().unwrap();
        let root = dir.path();

        let material = "just some content\nwith no diff markers\nor section headers\n";
        let material_path = root.join("material.txt");
        fs::write(&material_path, material).unwrap();

        let result = run(
            material_path.to_str().unwrap(),
            root.to_str().unwrap(),
            "2",
        );
        assert!(result.is_ok());
        assert!(result.unwrap().contains("Split into 1 chunks"));
    }

    #[test]
    fn test_shuffle_deterministic_per_worker() {
        let dir = TempDir::new().unwrap();
        let root = dir.path();

        let material =
            "diff --git a/a.ts b/a.ts\nA\ndiff --git a/b.ts b/b.ts\nB\ndiff --git a/c.ts b/c.ts\nC\n";
        let material_path = root.join("material.txt");
        fs::write(&material_path, material).unwrap();

        // Run twice
        run(
            material_path.to_str().unwrap(),
            root.to_str().unwrap(),
            "2",
        )
        .unwrap();
        let first_pass1 = fs::read_to_string(root.join("material-pass-1.txt")).unwrap();
        let first_pass2 = fs::read_to_string(root.join("material-pass-2.txt")).unwrap();

        run(
            material_path.to_str().unwrap(),
            root.to_str().unwrap(),
            "2",
        )
        .unwrap();
        let second_pass1 = fs::read_to_string(root.join("material-pass-1.txt")).unwrap();
        let second_pass2 = fs::read_to_string(root.join("material-pass-2.txt")).unwrap();

        // Same seed → same output
        assert_eq!(first_pass1, second_pass1, "shuffle should be deterministic");
        assert_eq!(first_pass2, second_pass2, "shuffle should be deterministic");

        // Different workers should (usually) have different orderings
        // With 3 chunks, the probability of identical order is 1/6
        // We don't assert inequality since it's probabilistic
    }
}
