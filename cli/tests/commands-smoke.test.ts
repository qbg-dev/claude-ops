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

// ---------------------------------------------------------------------------
// Read-only commands — should succeed with exit 0
// ---------------------------------------------------------------------------

describe("read-only commands", () => {
  test("fleet list → exit 0", () => {
    const r = fleet("list");
    expect(r.exitCode).toBe(0);
  });

  test("fleet list --json → exit 0, valid JSON array", () => {
    const r = fleet("list", "--json");
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(Array.isArray(parsed)).toBe(true);
  });

  test("fleet status → exit 0", () => {
    const r = fleet("status");
    expect(r.exitCode).toBe(0);
  });

  test("fleet status --json → exit 0, valid JSON object", () => {
    const r = fleet("status", "--json");
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(typeof parsed).toBe("object");
    expect(parsed).not.toBeNull();
    expect(Array.isArray(parsed)).toBe(false);
  });

  test("fleet defaults → exit 0, valid JSON", () => {
    const r = fleet("defaults");
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(typeof parsed).toBe("object");
  });

  test("fleet mcp status → exit 0", () => {
    const r = fleet("mcp", "status");
    expect(r.exitCode).toBe(0);
  });

  test("fleet mail-server status → exit 0", () => {
    const r = fleet("mail-server", "status");
    expect(r.exitCode).toBe(0);
  });

  test("fleet session ls → exit 0", () => {
    const r = fleet("session", "ls");
    expect(r.exitCode).toBe(0);
  });

  test("fleet session clean → exit 0", () => {
    const r = fleet("session", "clean");
    expect(r.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Help for write commands — safe to call with --help
// ---------------------------------------------------------------------------

describe("write command --help", () => {
  test("fleet setup --help → exit 0", () => {
    const r = fleet("setup", "--help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });

  test("fleet create --help → exit 0", () => {
    const r = fleet("create", "--help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });

  test("fleet run --help → exit 0", () => {
    const r = fleet("run", "--help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });

  test("fleet start --help → exit 0", () => {
    const r = fleet("start", "--help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });

  test("fleet stop --help → exit 0", () => {
    const r = fleet("stop", "--help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });

  test("fleet attach --help → exit 0", () => {
    const r = fleet("attach", "--help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });

  test("fleet fork --help → exit 0", () => {
    const r = fleet("fork", "--help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });

  test("fleet mail --help → exit 0", () => {
    const r = fleet("mail", "--help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });

  test("fleet nuke --help → exit 0", () => {
    const r = fleet("nuke", "--help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });

  test("fleet doctor --help → exit 0", () => {
    const r = fleet("doctor", "--help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });

  test("fleet onboard --help → exit 0", () => {
    const r = fleet("onboard", "--help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });

  test("fleet tui --help → exit 0", () => {
    const r = fleet("tui", "--help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });

  test("fleet layout --help → exit 0", () => {
    const r = fleet("layout", "--help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });

  test("fleet deep-review --help → exit 0", () => {
    const r = fleet("deep-review", "--help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });

  test("fleet register --help → exit 0", () => {
    const r = fleet("register", "--help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });

  test("fleet state --help → exit 0", () => {
    const r = fleet("state", "--help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });

  test("fleet checkpoint --help → exit 0", () => {
    const r = fleet("checkpoint", "--help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });

  test("fleet session --help → exit 0", () => {
    const r = fleet("session", "--help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });

  test("fleet mail send --help → exit 0", () => {
    const r = fleet("mail", "send", "--help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });

  test("fleet mail inbox --help → exit 0", () => {
    const r = fleet("mail", "inbox", "--help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });

  test("fleet mail read --help → exit 0", () => {
    const r = fleet("mail", "read", "--help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });

  test("fleet mail help → exit 0", () => {
    const r = fleet("mail", "help");
    expect(r.exitCode).toBe(0);
    const combined = r.stdout + r.stderr;
    expect(combined).toContain("Fleet Mail");
  });
});

// ---------------------------------------------------------------------------
// JSON output validation
// ---------------------------------------------------------------------------

describe("JSON output structure", () => {
  test("fleet list --json returns an array (even if empty)", () => {
    const r = fleet("list", "--json");
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(Array.isArray(parsed)).toBe(true);
  });

  test("fleet status --json has fleet-status keys", () => {
    const r = fleet("status", "--json");
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(typeof parsed).toBe("object");
    // Status should have at least one meaningful key about the fleet
    const keys = Object.keys(parsed);
    expect(keys.length).toBeGreaterThan(0);
  });
});
