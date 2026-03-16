import { describe, test, expect } from "bun:test";
import {
  resolveDirSlug,
  buildMailName,
  parseMailName,
  sanitizeName,
  isValidSessionId,
  sessionDir,
  resolveSessionId,
} from "../../shared/identity";

// ── resolveDirSlug ──────────────────────────────────────────────────

describe("resolveDirSlug", () => {
  test("returns a string", () => {
    const slug = resolveDirSlug();
    expect(typeof slug).toBe("string");
    expect(slug.length).toBeGreaterThan(0);
  });
});

// ── buildMailName ───────────────────────────────────────────────────

describe("buildMailName", () => {
  test("constructs correct format with custom name", () => {
    const result = buildMailName("merger", "proj", "abc-123");
    expect(result).toBe("merger-proj-abc-123");
  });

  test("null custom name defaults to 'session'", () => {
    const result = buildMailName(null, "proj", "abc-123");
    expect(result).toBe("session-proj-abc-123");
  });

  test("handles full UUID session ID", () => {
    const result = buildMailName("merger", "proj", "abc-def-ghi-jkl-mno");
    expect(result).toBe("merger-proj-abc-def-ghi-jkl-mno");
  });
});

// ── parseMailName ───────────────────────────────────────────────────

describe("parseMailName", () => {
  test("round-trips with buildMailName (UUID session ID)", () => {
    const uuid = "a3f1b2c8-9d4e-4b1a-8c2d-1234567890ab";
    const mailName = buildMailName("merger", "proj", uuid);
    const parsed = parseMailName(mailName);
    expect(parsed).not.toBeNull();
    expect(parsed!.customName).toBe("merger");
    expect(parsed!.dirSlug).toBe("proj");
    expect(parsed!.sessionId).toBe(uuid);
  });

  test("returns null for invalid names (no UUID)", () => {
    expect(parseMailName("just-a-plain-name")).toBeNull();
    expect(parseMailName("")).toBeNull();
    expect(parseMailName("abc")).toBeNull();
    expect(parseMailName("no-uuid-here-at-all")).toBeNull();
  });

  test("parses full mail name with UUID correctly", () => {
    const parsed = parseMailName("merger-proj-a3f1b2c8-9d4e-4b1a-8c2d-1234567890ab");
    expect(parsed).not.toBeNull();
    expect(parsed!.customName).toBe("merger");
    expect(parsed!.dirSlug).toBe("proj");
    expect(parsed!.sessionId).toBe("a3f1b2c8-9d4e-4b1a-8c2d-1234567890ab");
  });

  test("handles single-segment prefix (no custom name, just dirSlug)", () => {
    // If prefix is just "proj" (no dashes), customName defaults to "session"
    const parsed = parseMailName("proj-a3f1b2c8-9d4e-4b1a-8c2d-1234567890ab");
    expect(parsed).not.toBeNull();
    expect(parsed!.customName).toBe("session");
    expect(parsed!.dirSlug).toBe("proj");
    expect(parsed!.sessionId).toBe("a3f1b2c8-9d4e-4b1a-8c2d-1234567890ab");
  });
});

// ── sanitizeName ────────────────────────────────────────────────────

describe("sanitizeName", () => {
  test("passes through a valid name", () => {
    expect(sanitizeName("merger")).toBe("merger");
    expect(sanitizeName("my-worker-123")).toBe("my-worker-123");
  });

  test("strips path traversal (..)", () => {
    expect(sanitizeName("../../../etc/passwd")).toBe("etcpasswd");
    expect(sanitizeName("foo/../bar")).toBe("foobar");
  });

  test("strips forward slashes", () => {
    expect(sanitizeName("foo/bar/baz")).toBe("foobarbaz");
  });

  test("strips backslashes", () => {
    expect(sanitizeName("foo\\bar")).toBe("foobar");
  });

  test("strips null bytes", () => {
    expect(sanitizeName("foo\0bar")).toBe("foobar");
  });

  test("strips control characters", () => {
    expect(sanitizeName("foo\x01\x02bar")).toBe("foobar");
    expect(sanitizeName("foo\tbar")).toBe("foobar");
    expect(sanitizeName("foo\nbar")).toBe("foobar");
  });

  test("limits to 128 chars", () => {
    const long = "a".repeat(200);
    expect(sanitizeName(long).length).toBe(128);
  });

  test("defaults to 'session' if empty after sanitization", () => {
    expect(sanitizeName("")).toBe("session");
    expect(sanitizeName("///")).toBe("session");
    expect(sanitizeName("..")).toBe("session");
    expect(sanitizeName("\0\0\0")).toBe("session");
  });

  test("trims leading/trailing dots and whitespace", () => {
    expect(sanitizeName("...merger...")).toBe("merger");
    expect(sanitizeName("  worker  ")).toBe("worker");
  });
});

// ── isValidSessionId ────────────────────────────────────────────────

describe("isValidSessionId", () => {
  test("accepts valid UUIDs", () => {
    expect(isValidSessionId("a3f1b2c8-9d4e-4b1a-8c2d-1234567890ab")).toBe(true);
    expect(isValidSessionId("00000000-0000-0000-0000-000000000000")).toBe(true);
    expect(isValidSessionId("ABCDEF12-3456-7890-ABCD-EF1234567890")).toBe(true);
  });

  test("rejects path traversal attempts", () => {
    expect(isValidSessionId("../../../etc/passwd")).toBe(false);
    expect(isValidSessionId("foo/../bar")).toBe(false);
  });

  test("rejects non-UUID strings", () => {
    expect(isValidSessionId("")).toBe(false);
    expect(isValidSessionId("not-a-uuid")).toBe(false);
    expect(isValidSessionId("abc-def-ghi-jkl-mno")).toBe(false);
    expect(isValidSessionId("a3f1b2c8-9d4e-4b1a-8c2d")).toBe(false); // too short
  });

  test("rejects UUIDs with extra content", () => {
    expect(isValidSessionId("a3f1b2c8-9d4e-4b1a-8c2d-1234567890ab/../../etc")).toBe(false);
    expect(isValidSessionId("prefix-a3f1b2c8-9d4e-4b1a-8c2d-1234567890ab")).toBe(false);
  });
});

// ── sessionDir ──────────────────────────────────────────────────────

describe("sessionDir", () => {
  test("returns path for valid UUID", () => {
    const dir = sessionDir("a3f1b2c8-9d4e-4b1a-8c2d-1234567890ab");
    expect(dir).toContain("a3f1b2c8-9d4e-4b1a-8c2d-1234567890ab");
    expect(dir).toContain(".sessions");
  });

  test("throws on invalid session ID (path traversal)", () => {
    expect(() => sessionDir("../../../etc/passwd")).toThrow("Invalid session ID");
    expect(() => sessionDir("foo/bar")).toThrow("Invalid session ID");
    expect(() => sessionDir("")).toThrow("Invalid session ID");
  });
});

// ── resolveSessionId ────────────────────────────────────────────────

describe("resolveSessionId", () => {
  test("accepts explicit valid UUID", () => {
    const sid = resolveSessionId({ sessionId: "a3f1b2c8-9d4e-4b1a-8c2d-1234567890ab" });
    expect(sid).toBe("a3f1b2c8-9d4e-4b1a-8c2d-1234567890ab");
  });

  test("rejects explicit invalid session ID", () => {
    const sid = resolveSessionId({ sessionId: "../../../etc/passwd" });
    expect(sid).toBeNull();
  });

  test("rejects non-UUID explicit session ID", () => {
    const sid = resolveSessionId({ sessionId: "not-a-uuid" });
    expect(sid).toBeNull();
  });
});
