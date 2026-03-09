import React from "react";
import { Box, Text } from "ink";
import { colors, statusColors } from "../theme.js";
import { useAppState, type WorkerInfo } from "../state.js";

function statusDot(w: WorkerInfo): string {
  if (w.status === "active") return "\u25cf"; // ●
  if (w.status === "sleeping") return "\u25cb"; // ○
  if (w.status === "standby") return "\u25cb";
  return "\u25cb";
}

function truncate(s: string, max: number): string {
  if (max < 2) return s.slice(0, 1);
  return s.length > max ? s.slice(0, max - 1) + "\u2026" : s;
}

function padRight(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

export function Sidebar({ width }: { width: number }) {
  const { state } = useAppState();
  const { workerList, sidebarIndex, focusedPanel, panes, activePaneIndex } =
    state;

  const focused = focusedPanel === "sidebar";
  const currentWorker = panes[activePaneIndex]?.worker || "user";

  const fleetWorkers = workerList.filter((w) => w.name !== "user");
  const userWorker = workerList.find((w) => w.name === "user");

  // Only show active/sleeping/standby workers
  const activeWorkers = fleetWorkers.filter((w) =>
    ["active", "sleeping", "standby"].includes(w.status)
  );

  // Sort: active first, then sleeping, then standby
  const sortOrder: Record<string, number> = {
    active: 0,
    sleeping: 1,
    standby: 2,
  };
  const sorted = [...activeWorkers].sort(
    (a, b) =>
      (sortOrder[a.status] ?? 3) - (sortOrder[b.status] ?? 3) ||
      a.name.localeCompare(b.name)
  );

  // Layout: "● name    N" — inner width = width - 4 (borders + padding)
  const innerW = width - 4;
  // "● " = 2 chars, then name, then " N" = count area
  const countAreaW = 4; // space + up to 3 digits
  const nameW = Math.max(3, innerW - 2 - countAreaW); // 2 for "● "

  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle={focused ? "double" : "single"}
      borderColor={focused ? colors.blue : colors.gray}
    >
      <Box paddingX={1}>
        <Text bold color={colors.blue}>
          Workers
        </Text>
      </Box>

      {sorted.map((w, i) => {
        const isSelected = i === sidebarIndex && focused;
        const isCurrent = w.name === currentWorker;
        const sc = statusColors[w.status] || colors.gray;

        const name = truncate(w.name, nameW);
        const badge = isCurrent ? "\u25c9" : "";
        const count = w.unread > 0 ? String(w.unread) : "";
        const suffix = (badge + " " + count).trim();

        // Build the full line, pad to innerW
        const lineContent = `${statusDot(w)} ${name}`;
        const padded = padRight(lineContent, innerW - suffix.length) + suffix;

        return (
          <Box key={w.name} paddingX={1}>
            <Text inverse={isSelected} wrap="truncate">
              <Text color={sc}>{padded.slice(0, 2)}</Text>
              <Text color={isSelected ? undefined : colors.white}>
                {padded.slice(2, 2 + nameW + 1)}
              </Text>
              {suffix && (
                <Text bold color={w.unread > 0 ? colors.orange : colors.muted}>
                  {padded.slice(2 + nameW + 1)}
                </Text>
              )}
            </Text>
          </Box>
        );
      })}

      {sorted.length > 0 && (
        <Box paddingX={1} marginTop={1}>
          <Text color={colors.gray}>
            {"\u2500\u2500\u2500 you \u2500\u2500\u2500"}
          </Text>
        </Box>
      )}

      <Box paddingX={1}>
        <Text
          inverse={sidebarIndex === sorted.length && focused}
          wrap="truncate"
        >
          <Text color={colors.cyan}>{"  "}</Text>
          <Text
            color={
              sidebarIndex === sorted.length && focused
                ? undefined
                : colors.white
            }
          >
            user
          </Text>
          {(userWorker?.unread ?? 0) > 0 ? (
            <Text bold color={colors.orange}>
              {currentWorker === "user" ? " \u25c9" : ""}{" "}
              {userWorker?.unread}
            </Text>
          ) : currentWorker === "user" ? (
            <Text color={colors.orange}> {"\u25c9"}</Text>
          ) : null}
        </Text>
      </Box>
    </Box>
  );
}
