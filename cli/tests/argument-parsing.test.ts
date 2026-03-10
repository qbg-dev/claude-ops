import { describe, test, expect } from "bun:test";

const CLI = `${process.env.HOME}/.claude-fleet/cli/index.ts`;

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

describe("argument parsing", () => {
  test("fleet create without args → missing required argument 'name'", () => {
    const r = fleet("create");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/missing required argument.*name/i);
  });

  test("fleet create <name> without mission → missing required argument 'mission'", () => {
    const r = fleet("create", "foo");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/missing required argument.*mission/i);
  });

  test("fleet stop without name and without --all → non-zero exit", () => {
    const r = fleet("stop");
    expect(r.exitCode).not.toBe(0);
    // Commander may put the error in stderr, or the command may use fail() which writes to stdout
    const combined = r.stdout + r.stderr;
    expect(combined).toMatch(/usage|missing|name|--all/i);
  });

  test("fleet config without name → missing required argument", () => {
    const r = fleet("config");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/missing required argument/i);
  });

  test("fleet run without name → does NOT fail on missing argument (name is optional)", () => {
    // `fleet run` auto-generates a name (run-N). It will likely fail for other
    // reasons (existing worker, tmux, etc.) but the error should NOT be about
    // a missing argument.
    const r = fleet("run", "--no-launch");
    const combined = r.stdout + r.stderr;
    expect(combined).not.toMatch(/missing required argument/i);
  });

  test("fleet defaults with no args → exit 0, outputs JSON", () => {
    const r = fleet("defaults");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("{");
    // Should be valid JSON
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });

  test("fleet mail-server with no action → defaults to status (exit 0)", () => {
    const r = fleet("mail-server");
    expect(r.exitCode).toBe(0);
    const combined = r.stdout + r.stderr;
    // Status output mentions Fleet Mail in some form
    expect(combined).toMatch(/fleet mail|url|not configured/i);
  });

  test("fleet mcp with no action → defaults to status (exit 0)", () => {
    const r = fleet("mcp");
    expect(r.exitCode).toBe(0);
    const combined = r.stdout + r.stderr;
    // Status prints either "registered" or "not registered"
    expect(combined).toMatch(/registered/i);
  });

  test("fleet log without name → missing required argument", () => {
    const r = fleet("log");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/missing required argument/i);
  });

  test("fleet attach without name → missing required argument", () => {
    const r = fleet("attach");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/missing required argument/i);
  });

  test("fleet fork without enough args → missing required arguments", () => {
    // No args at all
    const r0 = fleet("fork");
    expect(r0.exitCode).not.toBe(0);
    expect(r0.stderr).toMatch(/missing required argument/i);

    // Only parent
    const r1 = fleet("fork", "some-parent");
    expect(r1.exitCode).not.toBe(0);
    expect(r1.stderr).toMatch(/missing required argument/i);

    // Parent + child but no mission
    const r2 = fleet("fork", "some-parent", "some-child");
    expect(r2.exitCode).not.toBe(0);
    expect(r2.stderr).toMatch(/missing required argument/i);
  });
});
