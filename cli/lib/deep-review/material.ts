/**
 * Material collection: git diff generation, content file reading, codebase scanning, auto-skip.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, appendFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import type { DeepReviewConfig, MaterialResult } from "./types";

const HOME = process.env.HOME || "/tmp";

/** Default ignore patterns for codebase scanning (beyond .gitignore) */
const CODEBASE_IGNORE_DIRS = new Set([
  "node_modules", "dist", "build", ".git", ".next", ".nuxt", ".cache",
  ".turbo", "coverage", "__pycache__", ".mypy_cache", ".pytest_cache",
  "vendor", "target", ".gradle", ".idea", ".vscode", ".claude",
]);

/** Source file extensions to include in codebase scans */
const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rs", ".go", ".java", ".kt", ".swift",
  ".c", ".cpp", ".h", ".hpp", ".cs",
  ".rb", ".php", ".lua", ".sh", ".bash", ".zsh",
  ".sql", ".graphql", ".gql",
  ".html", ".css", ".scss", ".less", ".svelte", ".vue",
  ".json", ".yaml", ".yml", ".toml", ".xml",
  ".md", ".mdx",
  ".Dockerfile", ".dockerfile",
]);

/** Generate git diff based on scope type */
function generateDiff(scope: string, sessionDir: string, projectRoot: string): { lines: number; descPart: string } {
  const diffTmp = join(sessionDir, "_diff.patch");

  if (scope === "uncommitted") {
    const d1 = Bun.spawnSync(["git", "diff"], { cwd: projectRoot });
    const d2 = Bun.spawnSync(["git", "diff", "--cached"], { cwd: projectRoot });
    let content = d1.stdout.toString() + d2.stdout.toString();

    // Include untracked files
    const untracked = Bun.spawnSync(["git", "ls-files", "--others", "--exclude-standard"], { cwd: projectRoot });
    for (const f of untracked.stdout.toString().trim().split("\n").filter(Boolean)) {
      content += `diff --git a/${f} b/${f}\nnew file mode 100644\n--- /dev/null\n+++ b/${f}\n`;
      try {
        const fileContent = readFileSync(join(projectRoot, f), "utf-8");
        content += fileContent.split("\n").map((l) => `+${l}`).join("\n") + "\n";
      } catch {}
    }
    writeFileSync(diffTmp, content);
    return { lines: content.split("\n").length, descPart: "uncommitted changes" };
  }

  if (scope.startsWith("pr:")) {
    const prNum = scope.slice(3);
    const result = Bun.spawnSync(["gh", "pr", "diff", prNum], { cwd: projectRoot });
    writeFileSync(diffTmp, result.stdout.toString());
    return { lines: result.stdout.toString().split("\n").length, descPart: `PR #${prNum}` };
  }

  if (scope.includes("..")) {
    const result = Bun.spawnSync(["git", "diff", scope], { cwd: projectRoot });
    writeFileSync(diffTmp, result.stdout.toString());
    return { lines: result.stdout.toString().split("\n").length, descPart: scope };
  }

  // Check if it's a reachable commit that's an ancestor (branch base)
  const verifyResult = Bun.spawnSync(["git", "rev-parse", "--verify", `${scope}^{commit}`], { cwd: projectRoot, stderr: "pipe" });
  const scopeRev = Bun.spawnSync(["git", "rev-parse", scope], { cwd: projectRoot, stderr: "pipe" }).stdout.toString().trim();
  const mergeBase = Bun.spawnSync(["git", "merge-base", scope, "HEAD"], { cwd: projectRoot, stderr: "pipe" }).stdout.toString().trim();

  if (verifyResult.exitCode === 0 && scopeRev !== mergeBase) {
    // Branch base — try 3-dot first, fallback to 2-dot
    let result = Bun.spawnSync(["git", "diff", `${scope}...HEAD`], { cwd: projectRoot, stderr: "pipe" });
    let content = result.stdout.toString();

    if (!content.trim()) {
      result = Bun.spawnSync(["git", "diff", `${scope}..HEAD`], { cwd: projectRoot, stderr: "pipe" });
      content = result.stdout.toString();
    }

    if (!content.trim()) {
      // Check commits ahead
      const countResult = Bun.spawnSync(["git", "rev-list", `${scope}..HEAD`, "--count"], { cwd: projectRoot, stderr: "pipe" });
      const commitsAhead = parseInt(countResult.stdout.toString().trim(), 10) || 0;
      if (commitsAhead > 0) {
        console.log(`WARN: ${commitsAhead} commits ahead but tree content identical. Fallback to per-commit diffs...`);
        const revList = Bun.spawnSync(["git", "rev-list", "--reverse", `${scope}..HEAD`], { cwd: projectRoot });
        for (const sha of revList.stdout.toString().trim().split("\n").filter(Boolean)) {
          const show = Bun.spawnSync(["git", "show", sha], { cwd: projectRoot, stderr: "pipe" });
          content += show.stdout.toString();
        }
      }
    }

    writeFileSync(diffTmp, content);
    return { lines: content.split("\n").length, descPart: `changes since ${scope}` };
  }

  // Specific commit
  const showResult = Bun.spawnSync(["git", "show", scope], { cwd: projectRoot, stderr: "pipe" });
  writeFileSync(diffTmp, showResult.stdout.toString());
  return { lines: showResult.stdout.toString().split("\n").length, descPart: `commit ${scope}` };
}

/**
 * Gather all tracked source files in the project, respecting .gitignore.
 * Returns files grouped by top-level directory (module).
 */
function gatherCodebaseFiles(projectRoot: string): Map<string, string[]> {
  // Use git ls-files for .gitignore-aware listing
  const result = Bun.spawnSync(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: projectRoot, stderr: "pipe" },
  );
  const allFiles = result.stdout.toString().trim().split("\n").filter(Boolean);

  const moduleMap = new Map<string, string[]>();

  for (const file of allFiles) {
    // Skip files in ignored directories
    const parts = file.split("/");
    if (parts.some(p => CODEBASE_IGNORE_DIRS.has(p))) continue;

    // Skip non-source files (binary, lockfiles, etc.)
    const ext = "." + file.split(".").pop()!;
    const baseName = basename(file);
    if (
      !SOURCE_EXTENSIONS.has(ext) &&
      !baseName.startsWith(".") &&
      baseName !== "Dockerfile" &&
      baseName !== "Makefile" &&
      baseName !== "Rakefile" &&
      baseName !== "Gemfile"
    ) continue;

    // Skip lockfiles
    const lockfileNames = new Set([
      "bun.lock", "bun.lockb", "package-lock.json", "yarn.lock",
      "pnpm-lock.yaml", "Cargo.lock", "Gemfile.lock", "poetry.lock", "composer.lock",
    ]);
    if (lockfileNames.has(baseName)) continue;

    // Group by top-level directory (module)
    const topDir = parts.length > 1 ? parts[0] : ".";
    if (!moduleMap.has(topDir)) moduleMap.set(topDir, []);
    moduleMap.get(topDir)!.push(file);
  }

  return moduleMap;
}

/**
 * Collect codebase material — scans all source files, chunks by module.
 * Each module chunk becomes a separate material file for parallel review.
 */
export function collectCodebaseMaterial(
  _config: DeepReviewConfig,
  sessionDir: string,
  projectRoot: string,
): MaterialResult {
  console.log("Scanning codebase...");
  const moduleMap = gatherCodebaseFiles(projectRoot);

  if (moduleMap.size === 0) {
    throw new Error("No source files found in codebase");
  }

  // Build the full material file (all modules concatenated)
  const materialFile = join(sessionDir, "material-full.txt");
  const allFiles: string[] = [];
  const moduleChunksDir = join(sessionDir, "chunks");
  mkdirSync(moduleChunksDir, { recursive: true });

  // Sort modules by file count (largest first) for better work distribution
  const sortedModules = [...moduleMap.entries()].sort((a, b) => b[1].length - a[1].length);

  let totalLines = 0;
  const moduleStats: { name: string; files: number; lines: number }[] = [];

  for (const [moduleName, files] of sortedModules) {
    const chunkFile = join(moduleChunksDir, `${moduleName.replace(/\//g, "__")}.txt`);
    let chunkContent = "";

    for (const file of files) {
      const fullPath = join(projectRoot, file);
      if (!existsSync(fullPath)) continue;

      try {
        const content = readFileSync(fullPath, "utf-8");
        // Skip very large files (>10K lines) — likely generated
        const lineCount = content.split("\n").length;
        if (lineCount > 10_000) {
          console.log(`  Skipping ${file} (${lineCount} lines — likely generated)`);
          continue;
        }

        const header = `═══ FILE: ${file} ═══\n`;
        const fileBlock = header + content + "\n\n";
        appendFileSync(materialFile, fileBlock);
        chunkContent += fileBlock;
        allFiles.push(file);
        totalLines += lineCount;
      } catch {
        // Skip files that can't be read (binary, permission issues)
      }
    }

    if (chunkContent) {
      writeFileSync(chunkFile, chunkContent);
      moduleStats.push({ name: moduleName, files: files.length, lines: chunkContent.split("\n").length });
    }
  }

  // Write module index for workers
  const indexContent = moduleStats
    .map(m => `${m.name}: ${m.files} files, ${m.lines} lines`)
    .join("\n");
  writeFileSync(join(sessionDir, "module-index.txt"), indexContent);

  console.log(`  Modules: ${moduleStats.length}`);
  for (const m of moduleStats) {
    console.log(`    ${m.name}: ${m.files} files, ${m.lines} lines`);
  }
  console.log(`  Total: ${allFiles.length} files, ${totalLines} lines`);

  return {
    hasDiff: false,
    hasContent: false,
    materialType: "code_listing",
    materialFile,
    materialTypesStr: "codebase",
    diffDesc: `full codebase (${allFiles.length} files, ${moduleStats.length} modules)`,
    diffLines: totalLines,
    changedFiles: allFiles,
  };
}

/** Collect all material (additive: diff + content files) */
export function collectMaterial(config: DeepReviewConfig, sessionDir: string, projectRoot: string): MaterialResult {
  // Codebase mode: scan all source files instead of generating diffs
  if (config.scope === "codebase") {
    return collectCodebaseMaterial(config, sessionDir, projectRoot);
  }

  const hasDiff = !!config.scope;
  const hasContent = config.contentFiles.length > 0;
  const materialFile = join(sessionDir, "material-full.txt");
  const diffDescParts: string[] = [];
  const materialTypes: string[] = [];
  const changedFiles: string[] = [];

  // 1. Diff
  if (hasDiff) {
    console.log("Generating diff...");
    const { lines, descPart } = generateDiff(config.scope, sessionDir, projectRoot);
    const diffTmp = join(sessionDir, "_diff.patch");

    if (existsSync(diffTmp) && lines > 1) {
      const diffContent = readFileSync(diffTmp, "utf-8");
      appendFileSync(materialFile, `═══ GIT DIFF ═══\n${diffContent}\n`);
      materialTypes.push("diff");
      console.log(`  Diff: ${lines} lines`);

      // Extract changed file paths
      const pathMatches = diffContent.matchAll(/^diff --git a\/(.+?) b\//gm);
      for (const m of pathMatches) changedFiles.push(m[1]);

      unlinkSync(diffTmp);
    } else if (!hasContent) {
      throw new Error("Empty diff and no content files — nothing to review");
    } else {
      console.log("  (diff is empty, reviewing content only)");
      if (existsSync(diffTmp)) unlinkSync(diffTmp);
    }
    diffDescParts.push(descPart);
  }

  // 2. Content files
  if (hasContent) {
    console.log("Collecting content files...");
    const contentFileNames: string[] = [];
    for (let cf of config.contentFiles) {
      cf = cf.trim().replace(/^["']|["']$/g, "");
      cf = cf.replace(/^~/, HOME);
      if (!cf.startsWith("/")) cf = join(projectRoot, cf);
      if (!existsSync(cf)) {
        throw new Error(`Content file not found: ${cf}`);
      }
      console.log(`  + ${cf}`);
      appendFileSync(materialFile, `═══ FILE: ${basename(cf)} ═══\n${readFileSync(cf, "utf-8")}\n`);
      contentFileNames.push(basename(cf));
    }
    diffDescParts.push(contentFileNames.join(", "));
    materialTypes.push("content");
  }

  const diffDesc = diffDescParts.join(" + ");
  const materialContent = existsSync(materialFile) ? readFileSync(materialFile, "utf-8") : "";
  const diffLines = materialContent.split("\n").length;
  console.log(`Material: ${diffLines} lines (${diffDesc})`);

  // Detect material type
  let materialType: MaterialResult["materialType"];
  if (hasDiff && !hasContent) {
    materialType = "code_diff";
  } else if (!hasDiff && hasContent) {
    const firstFile = config.contentFiles[0]?.trim() || "";
    if (/\.(json|yaml|yml|toml|xml)$/i.test(firstFile)) {
      materialType = "config";
    } else {
      materialType = "document";
    }
  } else if (hasDiff && hasContent) {
    materialType = "mixed";
  } else {
    materialType = "code_diff";
  }
  console.log(`Material type: ${materialType}`);

  return {
    hasDiff,
    hasContent,
    materialType,
    materialFile,
    materialTypesStr: materialTypes.join("+"),
    diffDesc,
    diffLines,
    changedFiles: [...new Set(changedFiles)],
  };
}

/** Check if material should be auto-skipped */
export function shouldAutoSkip(material: MaterialResult, config: DeepReviewConfig): string | null {
  // Never auto-skip codebase scans or code listings
  if (config.scope === "codebase" || material.materialType === "code_listing") return null;
  if (config.force || !material.hasDiff || material.hasContent) return null;

  const content = readFileSync(material.materialFile, "utf-8");

  // Check if ALL changed files are lockfiles
  const changedPaths = material.changedFiles;
  if (changedPaths.length > 0) {
    const lockfileNames = new Set([
      "bun.lock", "bun.lockb", "package-lock.json", "yarn.lock",
      "pnpm-lock.yaml", "Cargo.lock", "Gemfile.lock", "poetry.lock", "composer.lock",
    ]);
    const allLockfiles = changedPaths.every((p) => lockfileNames.has(basename(p)));
    if (allLockfiles) {
      return "AUTO-SKIP: All changed files are lockfiles. Use --force to override.";
    }
  }

  // Check if diff is all whitespace-only changes
  const addRemoveLines = content.match(/^\+[^+]|^-[^-]/gm) || [];
  const substantiveLines = addRemoveLines.filter((l) => !/^\+\s*$|^-\s*$/.test(l));
  if (substantiveLines.length < 5 && !config.spec) {
    return "AUTO-SKIP: <5 substantive diff lines and no --spec. Use --force to override.";
  }

  return null;
}
