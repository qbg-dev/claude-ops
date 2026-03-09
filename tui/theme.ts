/**
 * Theme — 256-color palette matching the harness REPL.
 * Ink 5 expects string color values (named, hex, ansi256(), or rgb()).
 */

function a(n: number): string {
  return `ansi256(${n})`;
}

export const colors = {
  blue: a(75),
  cyan: a(116),
  green: a(114),
  yellow: a(222),
  red: a(203),
  gray: a(241),
  lightGray: a(248),
  white: a(255),
  muted: a(244),
  orange: a(215),
  magenta: a(176),
} as const;

export const statusColors: Record<string, string> = {
  active: colors.green,
  sleeping: colors.yellow,
  standby: colors.muted,
  exited: colors.gray,
  idle: colors.gray,
};
