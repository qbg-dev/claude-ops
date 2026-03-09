import React from "react";
import { Box, Text } from "ink";
import { colors } from "../theme.js";
import { senderName, recipientNames, timeAgo } from "../bms.js";
import { useAppState } from "../state.js";

function truncStr(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "\u2026";
}

function padRight(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
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

  // Ensure scroll follows cursor
  let adjOffset = scrollOffset;
  if (selectedIndex < adjOffset) adjOffset = selectedIndex;
  if (selectedIndex >= adjOffset + viewportHeight)
    adjOffset = selectedIndex - viewportHeight + 1;

  const visible = messages.slice(adjOffset, adjOffset + viewportHeight);

  return (
    <Box flexDirection="column" paddingX={1}>
      {visible.map((msg, i) => {
        const globalIndex = adjOffset + i;
        const isSelected = globalIndex === selectedIndex;
        const num = String(globalIndex + 1).padStart(2, " ");
        const isUnread = (msg.labelIds || []).includes("UNREAD");
        const isEscalation =
          msg.subject?.toLowerCase().includes("escalation") ||
          msg.subject?.toLowerCase().includes("blocked");

        const indicator = isEscalation ? "!" : isUnread ? "\u2022" : "\u00b7";
        const indicatorColor = isEscalation
          ? colors.orange
          : isUnread
            ? colors.blue
            : colors.muted;

        const from = isSent
          ? "\u2192 " + truncStr(recipientNames(msg, directory) || "?", 12)
          : truncStr(senderName(msg, directory), 14);

        const subj = truncStr(msg.subject || "(no subject)", 40);
        const time = timeAgo(msg.internalDate);

        return (
          <Text key={msg.id || globalIndex} inverse={isSelected} wrap="truncate">
            <Text color={colors.muted}>{num}</Text>
            <Text> </Text>
            <Text color={indicatorColor}>{indicator}</Text>
            <Text> </Text>
            <Text color={isSent ? colors.magenta : colors.cyan}>
              {padRight(from, 15)}
            </Text>
            <Text> </Text>
            <Text color={isSelected ? undefined : colors.white}>{subj}</Text>
            <Text> </Text>
            <Text color={colors.gray}>{padRight(time, 5)}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
