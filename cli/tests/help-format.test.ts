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

const ALL_COMMANDS = [
  "setup",
  "create",
  "start",
  "stop",
  "list",
  "status",
  "attach",
  "config",
  "defaults",
  "log",
  "mail",
  "mail-server",
  "fork",
  "mcp",
  "run",
  "setup-agent",
] as const;

describe("fleet --help", () => {
  const help = fleet("--help");

  test("exits 0", () => {
    expect(help.exitCode).toBe(0);
  });

  test("description mentions Fleet and persistent Claude Code agents", () => {
    expect(help.stdout).toContain("Fleet");
    expect(help.stdout).toContain("persistent Claude Code agents");
  });

  test("contains all 16 commands", () => {
    for (const cmd of ALL_COMMANDS) {
      expect(help.stdout).toContain(cmd);
    }
  });

  test("shows global option -p / --project", () => {
    expect(help.stdout).toMatch(/-p, --project/);
  });

  test("shows global option --json", () => {
    expect(help.stdout).toContain("--json");
  });

  test("shows global option -v / --version", () => {
    expect(help.stdout).toMatch(/-v, --version/);
  });

  test("shows global option -h / --help", () => {
    expect(help.stdout).toMatch(/-h, --help/);
  });

  test("aliases appear: list|ls", () => {
    expect(help.stdout).toContain("list|ls");
  });

  test("aliases appear: start|restart", () => {
    expect(help.stdout).toContain("start|restart");
  });

  test("aliases appear: config|cfg", () => {
    expect(help.stdout).toContain("config|cfg");
  });

  test("aliases appear: log|logs", () => {
    expect(help.stdout).toContain("log|logs");
  });
});

describe("fleet --version", () => {
  test("--version outputs 2.0.0", () => {
    const result = fleet("--version");
    expect(result.stdout.trim()).toBe("2.0.0");
    expect(result.exitCode).toBe(0);
  });

  test("-v outputs 2.0.0", () => {
    const result = fleet("-v");
    expect(result.stdout.trim()).toBe("2.0.0");
    expect(result.exitCode).toBe(0);
  });
});

describe("subcommand --help", () => {
  for (const cmd of ALL_COMMANDS) {
    test(`${cmd} --help exits 0`, () => {
      const result = fleet(cmd, "--help");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage:");
    });
  }
});
