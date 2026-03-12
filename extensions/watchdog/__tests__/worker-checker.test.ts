import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { checkWorker, checkWorkerAsync, parseIsoEpoch } from "../src/worker-checker";
import { makeMockEffects, makeSnapshot, makeConfig } from "./fixtures";

// Override crash dir for tests
process.env.CLAUDE_FLEET_DIR = `/tmp/watchdog-test-ops-${process.pid}`;

describe("parseIsoEpoch", () => {
  test("parses standard ISO string", () => {
    const ts = parseIsoEpoch("2026-03-10T12:00:00Z");
    expect(ts).toBeGreaterThan(0);
  });

  test("handles millisecond-precision ISO strings", () => {
    const ts = parseIsoEpoch("2026-03-11T01:48:02.242Z");
    expect(ts).toBeGreaterThan(0);
  });

  test("returns 0 for null/undefined", () => {
    expect(parseIsoEpoch(null)).toBe(0);
    expect(parseIsoEpoch(undefined)).toBe(0);
  });

  test("returns 0 for invalid strings", () => {
    expect(parseIsoEpoch("not-a-date")).toBe(0);
    expect(parseIsoEpoch("")).toBe(0);
  });
});

describe("checkWorker — skip conditions", () => {
  beforeEach(() => {
    const crashDir = `${process.env.CLAUDE_FLEET_DIR}/state/watchdog-crashes`;
    rmSync(crashDir, { recursive: true, force: true });
    mkdirSync(crashDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(process.env.CLAUDE_FLEET_DIR!, { recursive: true, force: true });
  });

  test("skips standby workers", () => {
    const snap = makeSnapshot({ status: "standby" });
    const action = checkWorker(snap, makeConfig(), makeMockEffects());
    expect(action.type).toBe("skip");
    if (action.type === "skip") expect(action.reason).toContain("standby");
  });

  test("skips workers with invalid pane_id", () => {
    const snap = makeSnapshot({ paneId: "false" });
    const action = checkWorker(snap, makeConfig(), makeMockEffects());
    expect(action.type).toBe("skip");
    if (action.type === "skip") expect(action.reason).toContain("invalid pane_id");
  });

  test("skips workers with 'None' pane_id", () => {
    const snap = makeSnapshot({ paneId: "None" });
    const action = checkWorker(snap, makeConfig(), makeMockEffects());
    expect(action.type).toBe("skip");
  });

  test("skips non-perpetual workers with no pane", () => {
    const snap = makeSnapshot({ paneId: null, perpetual: false, sleepDuration: null });
    const action = checkWorker(snap, makeConfig(), makeMockEffects());
    expect(action.type).toBe("skip");
    if (action.type === "skip") expect(action.reason).toContain("non-perpetual");
  });

  test("skips recently created perpetual workers with no pane", () => {
    const snap = makeSnapshot({
      paneId: null,
      perpetual: true,
      sleepDuration: 300,
      createdAt: new Date().toISOString(), // just now
    });
    const effects = makeMockEffects({
      nowEpoch: () => Math.floor(Date.now() / 1000),
    });
    const action = checkWorker(snap, makeConfig(), effects);
    expect(action.type).toBe("skip");
    if (action.type === "skip") expect(action.reason).toContain("grace period");
  });

  test("skips recently relaunched perpetual workers with no pane", () => {
    const snap = makeSnapshot({
      paneId: null,
      perpetual: true,
      sleepDuration: 300,
      createdAt: new Date(Date.now() - 86400_000).toISOString(),
      lastRelaunchAt: new Date().toISOString(), // just now
    });
    const effects = makeMockEffects({
      nowEpoch: () => Math.floor(Date.now() / 1000),
    });
    const action = checkWorker(snap, makeConfig(), effects);
    expect(action.type).toBe("skip");
    if (action.type === "skip") expect(action.reason).toContain("cooldown");
  });
});

describe("checkWorker — sleeping", () => {
  beforeEach(() => {
    const crashDir = `${process.env.CLAUDE_FLEET_DIR}/state/watchdog-crashes`;
    rmSync(crashDir, { recursive: true, force: true });
    mkdirSync(crashDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(process.env.CLAUDE_FLEET_DIR!, { recursive: true, force: true });
  });

  test("sleeping with future timer → skip", () => {
    const snap = makeSnapshot({
      status: "sleeping",
      sleepUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    const action = checkWorker(snap, makeConfig(), makeMockEffects());
    expect(action.type).toBe("skip");
  });

  test("sleeping with expired timer → fleet-start", () => {
    const snap = makeSnapshot({
      status: "sleeping",
      sleepUntil: new Date(Date.now() - 60_000).toISOString(),
    });
    const action = checkWorker(snap, makeConfig(), makeMockEffects());
    expect(action.type).toBe("fleet-start");
  });

  test("sleeping with no timer and no duration → fleet-start", () => {
    const snap = makeSnapshot({
      status: "sleeping",
      sleepUntil: null,
      sleepDuration: null,
      perpetual: false,
    });
    const action = checkWorker(snap, makeConfig(), makeMockEffects());
    expect(action.type).toBe("fleet-start");
  });

  test("sleeping with no timer but has duration → skip (needs calculation)", () => {
    const snap = makeSnapshot({
      status: "sleeping",
      sleepUntil: null,
      sleepDuration: 300,
      perpetual: true,
    });
    const action = checkWorker(snap, makeConfig(), makeMockEffects());
    expect(action.type).toBe("skip");
  });
});

describe("checkWorker — pane alive", () => {
  beforeEach(() => {
    const crashDir = `${process.env.CLAUDE_FLEET_DIR}/state/watchdog-crashes`;
    rmSync(crashDir, { recursive: true, force: true });
    mkdirSync(crashDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(process.env.CLAUDE_FLEET_DIR!, { recursive: true, force: true });
  });

  test("healthy worker with recent liveness → ok", () => {
    const now = Math.floor(Date.now() / 1000);
    const effects = makeMockEffects({
      isPaneAlive: () => true,
      readLiveness: () => now - 10,
      nowEpoch: () => now,
    });
    const snap = makeSnapshot({ lastRelaunchAt: new Date(Date.now() - 600_000).toISOString() });
    const action = checkWorker(snap, makeConfig(), effects);
    expect(action.type).toBe("ok");
  });

  test("relaunch cooldown → ok", () => {
    const now = Math.floor(Date.now() / 1000);
    const effects = makeMockEffects({
      isPaneAlive: () => true,
      nowEpoch: () => now,
    });
    const snap = makeSnapshot({
      lastRelaunchAt: new Date((now - 30) * 1000).toISOString(), // 30s ago
    });
    const action = checkWorker(snap, makeConfig(), effects);
    expect(action.type).toBe("ok");
  });

  test("memory-leak recycle after maxCycleSec", () => {
    const now = Math.floor(Date.now() / 1000);
    const config = makeConfig({ maxCycleSec: 7200 });
    const effects = makeMockEffects({
      isPaneAlive: () => true,
      nowEpoch: () => now,
    });
    const snap = makeSnapshot({
      perpetual: true,
      sleepDuration: 300,
      lastRelaunchAt: new Date((now - 8000) * 1000).toISOString(), // 8000s ago > 7200
    });
    const action = checkWorker(snap, config, effects);
    expect(action.type).toBe("resume");
    if (action.type === "resume") expect(action.reason).toContain("memory-leak");
  });

  test("no liveness file → seeds it and returns ok", () => {
    const now = Math.floor(Date.now() / 1000);
    const effects = makeMockEffects({
      isPaneAlive: () => true,
      readLiveness: () => null,
      nowEpoch: () => now,
    });
    const snap = makeSnapshot({ lastRelaunchAt: new Date(Date.now() - 600_000).toISOString() });
    const action = checkWorker(snap, makeConfig(), effects);
    expect(action.type).toBe("ok");
    expect(effects.calls.writeLiveness?.length).toBeGreaterThan(0);
  });

  test("non-perpetual idle 3+ hours → move-inactive", () => {
    const now = Math.floor(Date.now() / 1000);
    const effects = makeMockEffects({
      isPaneAlive: () => true,
      readLiveness: () => now - 11000, // ~3 hours
      nowEpoch: () => now,
    });
    const snap = makeSnapshot({
      perpetual: false,
      sleepDuration: null,
      lastRelaunchAt: new Date(Date.now() - 86400_000).toISOString(),
    });
    const action = checkWorker(snap, makeConfig(), effects);
    expect(action.type).toBe("move-inactive");
  });

  test("bare-shell perpetual → bare-shell-restart", () => {
    const now = Math.floor(Date.now() / 1000);
    const effects = makeMockEffects({
      isPaneAlive: () => true,
      readLiveness: () => now - 2000,
      capturePane: () => "$ \nzsh: command not found",
      nowEpoch: () => now,
    });
    const snap = makeSnapshot({
      perpetual: true,
      sleepDuration: 300,
      lastRelaunchAt: new Date(Date.now() - 600_000).toISOString(),
    });
    const action = checkWorker(snap, makeConfig(), effects);
    expect(action.type).toBe("bare-shell-restart");
  });

  test("bare-shell non-perpetual → move-inactive", () => {
    const now = Math.floor(Date.now() / 1000);
    const effects = makeMockEffects({
      isPaneAlive: () => true,
      readLiveness: () => now - 2000,
      capturePane: () => "$ \nzsh: command not found",
      nowEpoch: () => now,
    });
    const snap = makeSnapshot({
      perpetual: false,
      sleepDuration: null,
      lastRelaunchAt: new Date(Date.now() - 600_000).toISOString(),
    });
    const action = checkWorker(snap, makeConfig(), effects);
    expect(action.type).toBe("move-inactive");
  });

  test("sleep_duration does NOT trigger restart while worker is active", () => {
    // sleep_duration is a post-cycle sleep interval, not a max runtime.
    // Active workers should NOT be restarted based on sleep_duration.
    const now = Math.floor(Date.now() / 1000);
    const effects = makeMockEffects({
      isPaneAlive: () => true,
      readLiveness: () => now - 400, // idle 400s
      capturePane: () => "bypass permissions on\n❯ ",
      nowEpoch: () => now,
    });
    const snap = makeSnapshot({
      perpetual: true,
      sleepDuration: 300, // would have triggered sleep-complete before the fix
      lastRelaunchAt: new Date(Date.now() - 600_000).toISOString(),
    });
    const action = checkWorker(snap, makeConfig(), effects);
    // Should NOT be "resume" with "sleep-complete" — sleep_duration is post-cycle only
    // With 400s idle and 1200s perpetual liveness threshold, this should be "ok"
    expect(action.type).toBe("ok");
  });

  test("sleeping worker wakes after sleep_until expires", () => {
    // After round_stop() sets status="sleeping" + sleep_until, the watchdog
    // should wake the worker when the timer expires.
    const now = Math.floor(Date.now() / 1000);
    const expiredWake = new Date((now - 60) * 1000).toISOString(); // expired 60s ago
    const effects = makeMockEffects({ nowEpoch: () => now });
    const snap = makeSnapshot({
      perpetual: true,
      status: "sleeping",
      sleepUntil: expiredWake,
      sleepDuration: 1200,
    });
    const action = checkWorker(snap, makeConfig(), effects);
    expect(action.type).toBe("fleet-start");
    if (action.type === "fleet-start") expect(action.reason).toContain("expired");
  });

  test("stuck non-perpetual → skip (not respawned)", () => {
    const now = Math.floor(Date.now() / 1000);
    // Non-perpetual: livenessThreshold = 300 (base), no sleepDuration boost
    // sinceActive = 400 > 300 → passes liveness gate
    // capturePane shows TUI → passes bare-shell check
    // readScrollbackHash matches → stuck candidate set/read
    // stuckCandidate = now - 700, effectiveThreshold = 600 for non-perpetual
    // 700 > 600 → stuck fires → returns skip (non-perpetual stuck = don't respawn)
    const contentForHash = "idle content\nbypass permissions on";
    const effects = makeMockEffects({
      isPaneAlive: () => true,
      readLiveness: () => now - 400,
      capturePane: () => contentForHash,
      readScrollbackHash: () => {
        const hasher = new Bun.CryptoHasher("md5");
        // Hash must match: filter non-empty lines, join
        const lines = contentForHash.split("\n").filter(l => l.trim().length > 0);
        hasher.update(lines.join("\n"));
        return hasher.digest("hex");
      },
      readStuckCandidate: () => now - 700,
      nowEpoch: () => now,
    });
    const snap = makeSnapshot({
      perpetual: false,
      sleepDuration: null,
      lastRelaunchAt: new Date(Date.now() - 600_000).toISOString(),
    });
    const config = makeConfig({ stuckThresholdSec: 600 });
    const action = checkWorker(snap, config, effects);
    expect(action.type).toBe("skip");
  });
});

describe("checkWorker — pane dead", () => {
  beforeEach(() => {
    const crashDir = `${process.env.CLAUDE_FLEET_DIR}/state/watchdog-crashes`;
    rmSync(crashDir, { recursive: true, force: true });
    mkdirSync(crashDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(process.env.CLAUDE_FLEET_DIR!, { recursive: true, force: true });
  });

  test("non-perpetual dead pane → move-inactive", () => {
    const effects = makeMockEffects({ isPaneAlive: () => false });
    const snap = makeSnapshot({
      perpetual: false,
      sleepDuration: null,
      paneId: "%99",
    });
    const action = checkWorker(snap, makeConfig(), effects);
    expect(action.type).toBe("move-inactive");
  });

  test("perpetual dead pane → relaunch", () => {
    const effects = makeMockEffects({ isPaneAlive: () => false });
    const snap = makeSnapshot({
      perpetual: true,
      sleepDuration: 300,
      paneId: "%99",
    });
    const action = checkWorker(snap, makeConfig(), effects);
    expect(action.type).toBe("relaunch");
  });

  test("perpetual dead pane with too many crashes → crash-loop", () => {
    const now = Math.floor(Date.now() / 1000);
    const effects = makeMockEffects({
      isPaneAlive: () => false,
      nowEpoch: () => now,
    });
    const snap = makeSnapshot({
      perpetual: true,
      sleepDuration: 300,
      paneId: "%99",
    });
    const config = makeConfig({ maxCrashesPerHr: 2 });
    // Increment crashes to meet threshold
    const { incrementCrashCount } = require("../src/crash-tracker");
    incrementCrashCount(snap.name, now - 100);
    incrementCrashCount(snap.name, now - 50);

    const action = checkWorker(snap, config, effects);
    expect(action.type).toBe("crash-loop");
  });
});

describe("checkWorkerAsync — early wake", () => {
  beforeEach(() => {
    const crashDir = `${process.env.CLAUDE_FLEET_DIR}/state/watchdog-crashes`;
    rmSync(crashDir, { recursive: true, force: true });
    mkdirSync(crashDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(process.env.CLAUDE_FLEET_DIR!, { recursive: true, force: true });
  });

  test("sleeping worker with unread mail → fleet-start (early wake)", async () => {
    const effects = makeMockEffects({
      workerHasUnreadMail: async () => true,
    });
    const snap = makeSnapshot({
      status: "sleeping",
      sleepUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    const action = await checkWorkerAsync(snap, makeConfig(), effects);
    expect(action.type).toBe("fleet-start");
    if (action.type === "fleet-start") expect(action.reason).toContain("early-wake");
  });

  test("sleeping worker without mail → skip", async () => {
    const effects = makeMockEffects({
      workerHasUnreadMail: async () => false,
    });
    const snap = makeSnapshot({
      status: "sleeping",
      sleepUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    const action = await checkWorkerAsync(snap, makeConfig(), effects);
    expect(action.type).toBe("skip");
  });
});
