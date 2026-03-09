import React from "react";
import { Box, Text } from "ink";
import { colors } from "../theme.js";
import { senderName, recipientNames, timeAgo } from "../bms.js";
import { useAppState } from "../state.js";

function truncStr(s: string, max: number): string {
  if (max < 2) return s.slice(0, 1);
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "\u2026";
}

function padRight(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function snippet(body: string, max: number): string {
  if (!body) return "";
  // Strip markdown, collapse whitespace
  const clean = body
    .replace(/^#{1,4}\s+/gm, "")
    .replace(/```[\s\S]*?```/g, "[code]")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\[(.+?)\]\(.+?\)/g, "$1")
    .replace(/^[>\-\*]\s*/gm, "")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return truncStr(clean, max);
}

export function MessageList({
  messages,
  selectedIndex,
  scrollOffset,
  viewportHeight,
  isSent,
}: {
  messages: any[];
  selectedIndex: number;
  scrollOffset: number;
  viewportHeight: number;
  isSent?: boolean;
}) {
  const { state } = useAppState();
  const { directory } = state;

  if (!messages.length) {
    return (
      <Box paddingX={2} paddingY={1}>
        <Text color={colors.muted}>
          {isSent ? "No sent messages." : "No messages in inbox."}
        </Text>
      </Box>
    );
  }

  // 2-line rows: halve viewport
  const rowsPerMsg = 2;
  const visibleCount = Math.floor(viewportHeight / rowsPerMsg);

  // Ensure scroll follows cursor
  let adjOffset = scrollOffset;
  if (selectedIndex < adjOffset) adjOffset = selectedIndex;
  if (selectedIndex >= adjOffset + visibleCount)
    adjOffset = selectedIndex - visibleCount + 1;

  const visible = messages.slice(adjOffset, adjOffset + visibleCount);

  return (
    <Box flexDirection="column" paddingX={1}>
      {visible.map((msg, i) => {
        const globalIndex = adjOffset + i;
        const isSelected = globalIndex === selectedIndex;
        const isUnread = (msg.labelIds || []).includes("UNREAD");
        const isStarred = (msg.labelIds || []).includes("STARRED");
        const isEscalation =
          msg.subject?.toLowerCase().includes("escalation") ||
          msg.subject?.toLowerCase().includes("blocked");

        // Gmail-style indicator
        const indicator = isEscalation
          ? "\u26a0" // ⚠
          : isStarred
            ? "\u2605" // ★
            : isUnread
              ? "\u25cf" // ●
              : " ";
        const indicatorColor = isEscalation
          ? colors.orange
          : isStarred
            ? colors.yellow
            : isUnread
              ? colors.blue
              : colors.muted;

        const from = isSent
          ? "\u2192 " + truncStr(recipientNames(msg, directory) || "?", 16)
          : truncStr(senderName(msg, directory), 18);

        const subj = msg.subject || "(no subject)";
        const time = timeAgo(msg.internalDate);
        const preview = snippet(msg.body || msg.snippet || "", 80);

        // Line 1: cursor + sender — subject — time (bold if unread)
        // Line 2: snippet preview (dimmed)
        const cursor = isSelected ? "\u25b8 " : "  "; // ▸ or space
        return (
          <Box key={msg.id || globalIndex} flexDirection="column">
            <Text wrap="truncate" bold={isUnread}>
              <Text color={isSelected ? colors.blue : colors.muted}>{cursor}</Text>
              <Text color={indicatorColor}>{indicator}</Text>
              <Text> </Text>
              <Text color={isSent ? colors.magenta : colors.cyan} bold={isUnread}>
                {padRight(from, 20)}
              </Text>
              <Text color={isUnread ? colors.white : colors.muted} bold={isUnread}>
                {subj}
              </Text>
              <Text color={colors.gray}>{" "}{padRight(time, 5)}</Text>
            </Text>
            <Text wrap="truncate">
              <Text color={colors.muted}>{"    "}</Text>
              <Text color={isSelected ? colors.lightGray : colors.gray}>
                {preview || " "}
              </Text>
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
