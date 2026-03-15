/**
 * Output formatting: colors, tables, status indicators.
 * Respects NO_COLOR (https://no-color.org/) and FORCE_COLOR env vars.
 *
 * Mode detection: HUMAN=1 env → pretty output (emoji, chalk colors, ASCII tables).
 * No HUMAN env (agent shells) → clean output (plain prefixes, plain tables).
 * CLI flags --human / --json override env detection.
 */
import chalk from "chalk";

// chalk auto-respects NO_COLOR and FORCE_COLOR, no extra wiring needed.

// ── Mode state (set by preAction hook in index.ts) ──────────────

let _humanMode: boolean | null = null;

export function setOutputMode(opts: { human?: boolean }): void {
  if (opts.human !== undefined) _humanMode = opts.human;
}

export function isHumanMode(): boolean {
  if (_humanMode !== null) return _humanMode;
  return !!process.env.HUMAN;
}

// ── Mode-aware output functions ─────────────────────────────────

export const ok = (msg: string) => {
  if (isHumanMode()) {
    console.log(`${chalk.green("\u2713")} ${msg}`);
  } else {
    console.log(`OK: ${stripAnsi(msg)}`);
  }
};

export const info = (msg: string) => {
  if (isHumanMode()) {
    console.log(`${chalk.cyan("\u2192")} ${msg}`);
  } else {
    console.log(`INFO: ${stripAnsi(msg)}`);
  }
};

export const warn = (msg: string) => {
  if (isHumanMode()) {
    console.log(`${chalk.yellow("\u26A0")} ${msg}`);
  } else {
    console.error(`WARN: ${stripAnsi(msg)}`);
  }
};

export const fail = (msg: string): never => {
  if (isHumanMode()) {
    console.error(`${chalk.red("ERROR:")} ${msg}`);
  } else {
    console.error(`ERROR: ${stripAnsi(msg)}`);
  }
  process.exit(1);
};

/** Colorize worker status */
export function statusColor(status: string): string {
  if (!isHumanMode()) return status;
  switch (status) {
    case "active":   return chalk.green(status);
    case "sleeping": return chalk.yellow(status);
    case "idle":     return chalk.dim(status);
    case "dead":     return chalk.red(status);
    default:         return chalk.dim(status);
  }
}

/** Print a table with headers and rows */
export function table(headers: string[], rows: string[][]): void {
  const human = isHumanMode();

  // Calculate column widths (always strip ANSI for measurement)
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => stripAnsi(r[i] || "").length))
  );

  // Print header
  if (human) {
    console.log(headers.map((h, i) => chalk.bold(h.padEnd(widths[i]))).join("  "));
    console.log(widths.map((w) => "\u2500".repeat(w)).join("  "));
  } else {
    console.log(headers.map((h, i) => h.padEnd(widths[i])).join("  "));
    console.log(widths.map((w) => "-".repeat(w)).join("  "));
  }

  // Print rows
  for (const row of rows) {
    const parts = row.map((cell, i) => {
      const raw = human ? (cell || "") : stripAnsi(cell || "");
      const stripped = stripAnsi(cell || "");
      const pad = widths[i] - stripped.length;
      return raw + " ".repeat(Math.max(0, pad));
    });
    console.log(parts.join("  "));
  }
}

/** Strip ANSI escape codes for width calculation */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Suggest running fleet onboard if not yet onboarded */
export function hintOnboard(project: string): void {
  const { existsSync } = require("node:fs");
  const { join } = require("node:path");
  const HOME = process.env.HOME || "/tmp";
  const fleetJsonPath = join(HOME, ".claude/fleet", project, "fleet.json");
  if (!existsSync(fleetJsonPath)) {
    console.log("");
    info(`Tip: Run ${chalk.bold("fleet onboard")} first for guided fleet setup and configuration.`);
  }
}
