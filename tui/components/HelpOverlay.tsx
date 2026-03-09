import React from "react";
import { Box, Text } from "ink";
import { colors } from "../theme.js";

const SECTIONS = [
  {
    title: "Navigation",
    keys: [
      ["j / \u2193", "Cursor down"],
      ["k / \u2191", "Cursor up"],
      ["g g", "Jump to top"],
      ["G", "Jump to bottom"],
      ["Ctrl-d", "Page down"],
      ["Ctrl-u", "Page up"],
      ["Enter", "Open item / select worker"],
      ["Esc", "Close detail / cancel"],
    ],
  },
  {
    title: "Panels",
    keys: [
      ["h", "Focus sidebar"],
      ["l", "Focus pane"],
      ["Tab", "Cycle focus"],
      ["1-4", "Switch tab (Inbox/Threads/Fleet/Sent)"],
      ["Ctrl-n", "Next tab"],
      ["Ctrl-p", "Previous tab"],
    ],
  },
  {
    title: "Actions",
    keys: [
      ["r", "Reply to message"],
      ["a", "Archive message"],
      ["s", "Star/unstar"],
      ["d", "Trash message"],
      ["R", "Force refresh"],
    ],
  },
  {
    title: "Commands (:)",
    keys: [
      [":vsplit [worker]", "Vertical split"],
      [":hsplit [worker]", "Horizontal split"],
      [":close", "Close split pane"],
      [":send <to> <subj>", "Send message"],
      [":reply <msg>", "Reply to selected"],
      [":as <worker>", "Switch pane context"],
      [":search <query>", "Search messages"],
      [":q / :quit", "Quit"],
    ],
  },
];

function padRight(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

export function HelpOverlay({ rows, cols }: { rows: number; cols: number }) {
  return (
    <Box
      flexDirection="column"
      width={cols}
      height={rows}
      paddingX={2}
      paddingY={1}
    >
      <Box justifyContent="center">
        <Text bold color={colors.blue}>
          harness-tui v2.0 — Keybindings
        </Text>
      </Box>
      <Box justifyContent="center" marginBottom={1}>
        <Text color={colors.muted}>Press ? or Esc to close</Text>
      </Box>

      {SECTIONS.map((sec) => (
        <Box key={sec.title} flexDirection="column" marginBottom={1}>
          <Box>
            <Text bold color={colors.white}>
              {sec.title}
            </Text>
          </Box>
          {sec.keys.map(([key, desc]) => (
            <Box key={key} paddingLeft={2}>
              <Text color={colors.cyan}>{padRight(key, 22)}</Text>
              <Text color={colors.muted}>{desc}</Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}
