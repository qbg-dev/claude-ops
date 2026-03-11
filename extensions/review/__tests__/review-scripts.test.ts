import { describe, test, expect } from "bun:test";
import { existsSync, readlinkSync, lstatSync } from "fs";
import { join, resolve } from "path";

const FLEET_DIR = resolve(join(import.meta.dir, "../../.."));
const EXT_DIR = resolve(join(import.meta.dir, ".."));

// ── Helper ──────────────────────────────────────────────────────────

function run(script: string, ...args: string[]) {
  const result = Bun.spawnSync(["bash", join(EXT_DIR, script), ...args], {
    cwd: FLEET_DIR,
    env: { ...process.env, NO_COLOR: "1" },
  });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  };
}

// ── Manifest ────────────────────────────────────────────────────────

describe("manifest.json", () => {
  const manifestPath = join(EXT_DIR, "manifest.json");

  test("exists", () => {
    expect(existsSync(manifestPath)).toBe(true);
  });

  test("is valid JSON with required fields", () => {
    const manifest = JSON.parse(
      require("fs").readFileSync(manifestPath, "utf-8")
    );
    expect(manifest.name).toBe("review");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof manifest.description).toBe("string");
    expect(manifest.scripts).toBeDefined();
  });

  test("all declared scripts exist", () => {
    const manifest = JSON.parse(
      require("fs").readFileSync(manifestPath, "utf-8")
    );
    for (const [, relPath] of Object.entries(manifest.scripts)) {
      const scriptPath = join(EXT_DIR, relPath as string);
      expect(existsSync(scriptPath)).toBe(true);
    }
  });

  test("all declared hooks exist", () => {
    const manifest = JSON.parse(
      require("fs").readFileSync(manifestPath, "utf-8")
    );
    if (manifest.hooks) {
      for (const [, relPath] of Object.entries(manifest.hooks)) {
        const hookPath = join(EXT_DIR, relPath as string);
        expect(existsSync(hookPath)).toBe(true);
      }
    }
  });

  test("all declared root_files have symlinks in repo root", () => {
    const manifest = JSON.parse(
      require("fs").readFileSync(manifestPath, "utf-8")
    );
    if (manifest.root_files) {
      for (const file of manifest.root_files) {
        const rootPath = join(FLEET_DIR, file);
        expect(existsSync(rootPath)).toBe(true);
        // Should be a symlink pointing into extensions/review/
        const stat = lstatSync(rootPath);
        if (stat.isSymbolicLink()) {
          const target = readlinkSync(rootPath);
          expect(target).toContain("extensions/review");
        }
      }
    }
  });
});

// ── Symlinks ────────────────────────────────────────────────────────

describe("backward-compat symlinks", () => {
  const symlinks = [
    { path: "REVIEW.md", target: "extensions/review/REVIEW.md" },
    {
      path: "scripts/review.sh",
      target: "../extensions/review/scripts/review.sh",
    },
    {
      path: "scripts/check-docs.sh",
      target: "../extensions/review/scripts/check-docs.sh",
    },
    {
      path: "scripts/verification-hash.sh",
      target: "../extensions/review/scripts/verification-hash.sh",
    },
  ];

  for (const { path, target } of symlinks) {
    test(`${path} is a symlink to ${target}`, () => {
      const fullPath = join(FLEET_DIR, path);
      expect(existsSync(fullPath)).toBe(true);
      const stat = lstatSync(fullPath);
      expect(stat.isSymbolicLink()).toBe(true);
      expect(readlinkSync(fullPath)).toBe(target);
    });
  }
});

// ── check-docs.sh ───────────────────────────────────────────────────

describe("check-docs.sh", () => {
  test("exits 0 when docs are in sync", () => {
    const r = run("scripts/check-docs.sh");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("All documentation in sync");
  });

  test("reports command count", () => {
    const r = run("scripts/check-docs.sh");
    expect(r.stdout).toMatch(/Found \d+ registered commands/);
  });

  test("checks CLAUDE.md, completions, and tests", () => {
    const r = run("scripts/check-docs.sh");
    expect(r.stdout).toContain("Checking CLAUDE.md");
    expect(r.stdout).toContain("Checking completions/fleet.zsh");
    expect(r.stdout).toContain("Checking cli/tests/help-format.test.ts");
  });
});

// ── review.sh ───────────────────────────────────────────────────────

describe("review.sh", () => {
  test("runs all 6 checks (items 17-22)", () => {
    const r = run("scripts/review.sh");
    const output = r.stdout;
    expect(output).toContain("=== 17. Version string drift ===");
    expect(output).toContain("=== 18. Changelog freshness ===");
    expect(output).toContain("=== 19. Secrets in staged diff ===");
    expect(output).toContain("=== 20. Import boundary violation ===");
    expect(output).toContain("=== 21. MCP tool count drift ===");
    expect(output).toContain("=== 22. Idempotency regression");
  });

  test("reports PASS/FAIL/WARN for each check", () => {
    const r = run("scripts/review.sh");
    // Each check should produce at least one PASS, FAIL, or WARN line
    const lines = r.stdout.split("\n");
    const resultLines = lines.filter((l) =>
      /^(PASS|FAIL|WARN):/.test(l.trim())
    );
    expect(resultLines.length).toBeGreaterThanOrEqual(6);
  });

  test("shows summary with error/warning counts", () => {
    const r = run("scripts/review.sh");
    const output = r.stdout;
    expect(output).toMatch(/\d+ error\(s\), \d+ warning\(s\)/);
  });

  test("accepts --staged-only flag without crashing", () => {
    const r = run("scripts/review.sh", "--staged-only");
    expect(r.stdout).toContain("=== 17.");
    // Should still complete all checks
    expect(r.stdout).toContain("items 17-22");
  });

  test("detects import boundary violations", () => {
    // Item 20 should pass — no cross-imports between cli/ and mcp/
    const r = run("scripts/review.sh");
    expect(r.stdout).toContain(
      "PASS:  No cross-boundary imports between cli/ and mcp/"
    );
  });
});

// ── verification-hash.sh ────────────────────────────────────────────

describe("verification-hash.sh", () => {
  test("outputs a path under .git/verification/", () => {
    const r = run("scripts/verification-hash.sh");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toMatch(/\.git\/verification\/[a-f0-9]+\.xml$/);
  });

  test("is deterministic (same hash for same staged state)", () => {
    const r1 = run("scripts/verification-hash.sh");
    const r2 = run("scripts/verification-hash.sh");
    expect(r1.stdout.trim()).toBe(r2.stdout.trim());
  });
});

// ── REVIEW.md structure ─────────────────────────────────────────────

describe("REVIEW.md content", () => {
  const content = require("fs").readFileSync(
    join(EXT_DIR, "REVIEW.md"),
    "utf-8"
  );

  test("has all 22 Always Flag items", () => {
    for (let i = 1; i <= 22; i++) {
      expect(content).toMatch(new RegExp(`^${i}\\.\\s+\\*\\*`, "m"));
    }
  });

  test("has Never Flag section", () => {
    expect(content).toContain("## Never Flag");
  });

  test("has Severity Overrides table", () => {
    expect(content).toContain("## Severity Overrides");
    expect(content).toContain("| Pattern | Override |");
  });

  test("has Pre-commit Verification section with 8 check elements", () => {
    expect(content).toContain("## Pre-commit Verification");
    const checkNames = [
      "cli-claudemd",
      "cli-completions",
      "cli-tests",
      "key-files",
      "cross-refs",
      "version-consistency",
      "secrets-scan",
      "import-boundaries",
    ];
    for (const name of checkNames) {
      expect(content).toContain(`name="${name}"`);
    }
  });

  test("has Evolving This Checklist section", () => {
    expect(content).toContain("## Evolving This Checklist");
  });

  test("has Automated Review Script reference", () => {
    expect(content).toContain("scripts/review.sh");
  });
});

// ── install.sh ──────────────────────────────────────────────────────

describe("install.sh", () => {
  test("is executable", () => {
    const stat = lstatSync(join(EXT_DIR, "install.sh"));
    // Check owner execute bit (0o100)
    expect(stat.mode & 0o100).toBeTruthy();
  });

  test("is idempotent (running twice doesn't error)", () => {
    const r1 = run("install.sh");
    expect(r1.exitCode).toBe(0);
    const r2 = run("install.sh");
    expect(r2.exitCode).toBe(0);
    // Output should be identical both runs
    expect(r1.stdout).toBe(r2.stdout);
  });
});
