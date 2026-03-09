import React from "react";
import { Box, Text } from "ink";
import { colors } from "../theme.js";
import { senderName, timeAgo } from "../bms.js";
import { useAppState } from "../state.js";

function truncStr(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "\u2026";
}

function padRight(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

// ── Thread List ──

export function ThreadList({
  threads,
  selectedIndex,
  scrollOffset,
  viewportHeight,
}: {
  threads: any[];
  selectedIndex: number;
  scrollOffset: number;
  viewportHeight: number;
}) {
  const { state } = useAppState();
  const { directory } = state;

  if (!threads.length) {
    return (
      <Box paddingX={2} paddingY={1}>
        <Text color={colors.muted}>No threads.</Text>
      </Box>
    );
  }

  let adjOffset = scrollOffset;
  if (selectedIndex < adjOffset) adjOffset = selectedIndex;
  if (selectedIndex >= adjOffset + viewportHeight)
    adjOffset = selectedIndex - viewportHeight + 1;

  const visible = threads.slice(adjOffset, adjOffset + viewportHeight);

  return (
    <Box flexDirection="column" paddingX={1}>
      {visible.map((t, i) => {
        const globalIndex = adjOffset + i;
        const isSelected = globalIndex === selectedIndex;
        const num = String(globalIndex + 1).padStart(2, " ");
        const msgCount = t.messageCount || t.messages?.length || "?";
        const subj = truncStr(
          t.subject || t.snippet || "(no subject)",
          36
        );
        const time = timeAgo(t.internalDate || t.lastMessageDate);

        const participants = (t.participants || [])
          .map((p: any) => {
            if (typeof p === "string")
              return directory[p] || p.slice(0, 8);
            return p.displayName || p.name || p.id?.slice(0, 8) || "?";
          })
          .slice(0, 3)
          .join(", ");

        return (
          <Text key={t.id || globalIndex} inverse={isSelected} wrap="truncate">
            <Text color={colors.muted}>{num}</Text>
            <Text> </Text>
            <Text color={colors.blue}>{"\u00b7"}</Text>
            <Text> </Text>
            <Text color={colors.cyan}>{padRight(truncStr(participants || "?", 20), 20)}</Text>
            <Text> </Text>
            <Text color={isSelected ? undefined : colors.white}>{subj}</Text>
            <Text> </Text>
            <Text color={colors.muted}>{msgCount} msg{msgCount !== 1 ? "s" : ""}</Text>
            <Text> </Text>
            <Text color={colors.gray}>{time}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

// ── Thread Detail ──

export function ThreadDetail({ thread }: { thread: any }) {
  const { state } = useAppState();
  const { directory } = state;

  const msgs = thread.messages || [];
  const subject = thread.subject || msgs[0]?.subject || "(no subject)";

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={colors.gray}
      paddingX={1}
    >
      <Box>
        <Text bold color={colors.white}>
          {subject}
        </Text>
      </Box>
      <Box>
        <Text color={colors.muted}>
          {msgs.length} message{msgs.length !== 1 ? "s" : ""} in thread
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={colors.gray}>{"\u2500".repeat(60)}</Text>
      </Box>

      <Box flexDirection="column">
        {msgs.map((m: any, i: number) => {
          const from = senderName(m, directory);
          const time = timeAgo(m.internalDate);
          return (
            <Box key={m.id || i} flexDirection="column" marginTop={i > 0 ? 1 : 0}>
              {i > 0 && (
                <Text color={colors.gray} dim>
                  {"\u254c".repeat(60)}
                </Text>
              )}
              <Box>
                <Text bold color={colors.cyan}>
                  {from}
                </Text>
                <Text color={colors.gray}> {time}</Text>
              </Box>
              <Box marginTop={0} paddingLeft={1}>
                <Text color={colors.lightGray}>
                  {(m.body || m.snippet || "").slice(0, 500)}
                </Text>
              </Box>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text color={colors.muted} dim>
          Esc close
        </Text>
      </Box>
    </Box>
  );
}
