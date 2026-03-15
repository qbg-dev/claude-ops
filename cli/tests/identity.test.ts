import { describe, test, expect } from "bun:test";
import {
  resolveDirSlug,
  buildMailName,
  parseMailName,
  sanitizeName,
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
