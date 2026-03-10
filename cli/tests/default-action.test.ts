import { describe, test, expect } from "bun:test";

const CLI = new URL("../index.ts", import.meta.url).pathname;

function fleet(...args: string[]) {
  const result = Bun.spawnSync(["bun", "run", CLI, ...args], {
    env: { ...process.env, NO_COLOR: "1" },
  });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  };
}

describe("default action (no subcommand)", () => {
  test("fleet with no args exits 0 and shows status", () => {
    const result = fleet();
    expect(result.exitCode).toBe(0);
    // Default action runs `status`, not help
    expect(result.stdout).not.toContain("Usage:");
    // Status output mentions fleet-related info
    expect(result.stdout).toMatch(/workers|projects|fleet/i);
  });

  test("fleet --json with no subcommand exits 0 and outputs valid JSON", () => {
    const result = fleet("--json");
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toBeDefined();
    expect(typeof parsed).toBe("object");
  });
});

describe("error handling", () => {
  test("fleet foobar (unknown command) exits non-zero with error on stderr", () => {
    const result = fleet("foobar");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/error/i);
  });

  test("fleet --bogus (unknown global option) exits non-zero with error on stderr", () => {
    const result = fleet("--bogus");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/unknown option/i);
  });

  test("fleet list --bogus (unknown subcommand option) exits non-zero with error on stderr", () => {
    const result = fleet("list", "--bogus");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/unknown option/i);
  });
});
