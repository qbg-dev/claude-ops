#!/usr/bin/env bun
/**
 * scripts/dx-feedback-gate.ts — DX Feedback proof validator.
 *
 * Called from pre-push hook to validate that dx-feedback findings
 * have been addressed with a proof XML file.
 *
 * Usage:
 *   bun run scripts/dx-feedback-gate.ts --sha <SHA> --feedback <path> --proof <path>
 *   bun run scripts/dx-feedback-gate.ts --sha <SHA> --feedback <path> --generate-template
 *   bun run scripts/dx-feedback-gate.ts --validate-proof <path>   # standalone proof validation
 *
 * Exit codes:
 *   0 = clean verdict or proof valid
 *   1 = findings present, proof missing or incomplete
 *   2 = proof XML malformed
 */
import { XMLParser } from "fast-xml-parser";
import { readFileSync, existsSync } from "node:fs";
import { parseArgs } from "node:util";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const { values } = parseArgs({
  options: {
    sha: { type: "string" },
    feedback: { type: "string" },
    proof: { type: "string" },
    "generate-template": { type: "boolean", default: false },
    "validate-proof": { type: "string" },
  },
  strict: true,
});

const VALID_STATUSES = new Set(["addressed", "wontfix", "skip"]);

// ---------------------------------------------------------------------------
// Standalone proof validation mode (for CI)
// ---------------------------------------------------------------------------
if (values["validate-proof"]) {
  const proofPath = values["validate-proof"];
  if (!existsSync(proofPath)) {
    console.error(`Proof file not found: ${proofPath}`);
    process.exit(2);
  }
  const { ok, errors } = validateProofXml(readFileSync(proofPath, "utf-8"), undefined, undefined);
  if (!ok) {
    console.error("Proof validation failed:");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(2);
  }
  console.log("Proof XML is structurally valid.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Main gate mode
// ---------------------------------------------------------------------------
const sha = values.sha;
const feedbackPath = values.feedback;
if (!sha || !feedbackPath) {
  console.error("Usage: dx-feedback-gate.ts --sha <SHA> --feedback <path> [--proof <path>] [--generate-template]");
  process.exit(2);
}

if (!existsSync(feedbackPath)) {
  console.error(`Feedback file not found: ${feedbackPath}`);
  process.exit(2);
}

const feedbackContent = readFileSync(feedbackPath, "utf-8");

// ---------------------------------------------------------------------------
// Parse feedback: extract verdict and finding IDs
// ---------------------------------------------------------------------------
const verdict = extractVerdict(feedbackContent);
const findingIds = extractFindingIds(feedbackContent);

if (verdict === "CLEAN" || findingIds.length === 0) {
  console.log("  DX feedback: CLEAN — no findings, no proof needed.");
  process.exit(0);
}

console.log(`  DX feedback verdict: ${verdict}`);
console.log(`  Findings: ${findingIds.join(", ")}`);

// ---------------------------------------------------------------------------
// Generate template mode
// ---------------------------------------------------------------------------
if (values["generate-template"]) {
  const date = new Date().toISOString().split("T")[0];
  const lines = [`<dx-feedback-proof commit="${sha}" date="${date}">`];
  for (const id of findingIds) {
    lines.push(`  <finding id="${id}" status="" note="" />`);
  }
  lines.push("</dx-feedback-proof>");
  console.log(lines.join("\n"));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Validate proof
// ---------------------------------------------------------------------------
const proofPath = values.proof;
if (!proofPath || !existsSync(proofPath)) {
  console.error("");
  console.error(`  BLOCKED: ${findingIds.length} finding(s) require proof.`);
  console.error(`  No proof file found at: ${proofPath || "(not specified)"}`);
  process.exit(1);
}

const proofContent = readFileSync(proofPath, "utf-8");
const { ok, errors } = validateProofXml(proofContent, sha, findingIds);

if (!ok) {
  console.error("");
  console.error("  BLOCKED: Proof validation failed:");
  for (const e of errors) console.error(`    - ${e}`);
  process.exit(1);
}

console.log(`  DX feedback proof valid (${findingIds.length} finding(s) addressed).`);
process.exit(0);

// ===========================================================================
// Helpers
// ===========================================================================

function extractVerdict(md: string): string {
  const match = md.match(/\*\*Verdict\*\*:\s*(\S+)/);
  return match ? match[1] : "UNKNOWN";
}

function extractFindingIds(md: string): string[] {
  const ids: string[] = [];
  const re = /^###\s+([HML]\d+):/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    ids.push(m[1]);
  }
  return ids;
}

function validateProofXml(
  xml: string,
  expectedSha: string | undefined,
  expectedIds: string[] | undefined,
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    processEntities: false,
    isArray: (_name: string) => _name === "finding",
  });

  let parsed: any;
  try {
    parsed = parser.parse(xml);
  } catch (e: any) {
    return { ok: false, errors: [`XML parse error: ${e.message}`] };
  }

  const root = parsed["dx-feedback-proof"];
  if (!root) {
    errors.push("Missing <dx-feedback-proof> root element.");
    return { ok: false, errors };
  }

  if (expectedSha && root["@_commit"] !== expectedSha) {
    errors.push(`Proof commit="${root["@_commit"]}" doesn't match expected SHA "${expectedSha}".`);
  }

  const findings: any[] = root.finding || [];
  if (!Array.isArray(findings)) {
    errors.push("Unexpected <finding> structure — expected array.");
    return { ok: false, errors };
  }

  const proofIds = new Set<string>();
  for (const f of findings) {
    const id = f["@_id"];
    const status = f["@_status"];
    const note = f["@_note"];

    if (!id) {
      errors.push("Found <finding> without id attribute.");
      continue;
    }

    proofIds.add(id);

    if (!status || status === "") {
      errors.push(`Finding ${id}: missing status (must be addressed|wontfix|skip).`);
    } else if (!VALID_STATUSES.has(status)) {
      errors.push(`Finding ${id}: invalid status="${status}" (must be addressed|wontfix|skip).`);
    }

    if (!note || note.trim() === "") {
      errors.push(`Finding ${id}: missing note (explain what you did).`);
    }
  }

  if (expectedIds) {
    for (const id of expectedIds) {
      if (!proofIds.has(id)) {
        errors.push(`Missing proof for finding ${id}.`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
