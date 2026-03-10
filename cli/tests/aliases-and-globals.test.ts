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

describe("alias resolution", () => {
  test("ls and list produce the same help", () => {
    const ls = fleet("ls", "--help");
    const list = fleet("list", "--help");
    expect(ls.exitCode).toBe(0);
    expect(list.exitCode).toBe(0);
    expect(ls.stdout).toBe(list.stdout);
  });

  test("cfg and config produce the same help", () => {
    const cfg = fleet("cfg", "--help");
    const config = fleet("config", "--help");
    expect(cfg.exitCode).toBe(0);
    expect(config.exitCode).toBe(0);
    expect(cfg.stdout).toBe(config.stdout);
  });

  test("restart and start produce the same help", () => {
    const restart = fleet("restart", "--help");
    const start = fleet("start", "--help");
    expect(restart.exitCode).toBe(0);
    expect(start.exitCode).toBe(0);
    expect(restart.stdout).toBe(start.stdout);
  });

  test("logs and log produce the same help", () => {
    const logs = fleet("logs", "--help");
    const log = fleet("log", "--help");
    expect(logs.exitCode).toBe(0);
    expect(log.exitCode).toBe(0);
    expect(logs.stdout).toBe(log.stdout);
  });
});

describe("global option propagation", () => {
  test("--json before subcommand is accepted", () => {
    const r = fleet("--json", "list", "--help");
    expect(r.exitCode).toBe(0);
  });

  test("--json after subcommand is accepted", () => {
    const r = fleet("list", "--json", "--help");
    expect(r.exitCode).toBe(0);
  });

  test("-p before subcommand is accepted", () => {
    const r = fleet("-p", "TestProject", "list", "--help");
    expect(r.exitCode).toBe(0);
  });

  test("-p after subcommand is accepted", () => {
    const r = fleet("list", "-p", "TestProject", "--help");
    expect(r.exitCode).toBe(0);
  });
});

describe("global options hidden from subcommand help", () => {
  test("list --help does not show --project or -p", () => {
    const r = fleet("list", "--help");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain("--project");
    expect(r.stdout).not.toContain("-p");
  });
});
