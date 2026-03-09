import React from "react";
import { Box, Text } from "ink";
import { colors } from "../theme.js";
import { useAppState } from "../state.js";
import { TabBar } from "./TabBar.js";
import { MessageList } from "./MessageList.js";
import { MessageDetail } from "./MessageDetail.js";
import { ThreadList, ThreadDetail } from "./ThreadView.js";
import { FleetPanel } from "./FleetPanel.js";

export function Pane({
  paneIndex,
  isActive,
  height,
  width,
}: {
  paneIndex: number;
  isActive: boolean;
  height: number;
  width: number;
}) {
  const { state } = useAppState();
  const pane = state.panes[paneIndex];
  if (!pane) return null;

  const { tab, messages, threads, selectedIndex, scrollOffset, openMessage, openThread, loading, worker } = pane;

  // Calculate content height: total - tab bar (1) - borders (2)
  const contentHeight = Math.max(1, height - 3);

  // If detail is open, split view: list takes ~40%, detail takes ~60%
  const hasDetail = !!openMessage || !!openThread;
  const listHeight = hasDetail
    ? Math.max(3, Math.floor(contentHeight * 0.35))
    : contentHeight;
  const detailHeight = hasDetail ? contentHeight - listHeight : 0;

  const msgCount = tab === "inbox" || tab === "sent" ? messages.length : threads.length;

  return (
    <Box
      flexDirection="column"
      flexGrow={0}
      flexShrink={0}
      borderStyle={isActive ? "double" : "single"}
      borderColor={isActive ? colors.blue : colors.gray}
      height={height}
      width={width}
    >
      <TabBar active={tab} workerName={worker} msgCount={msgCount} />

      {loading && (
        <Box paddingX={2} paddingY={1}>
          <Text color={colors.muted}>Loading...</Text>
        </Box>
      )}

      {!loading && (tab === "inbox" || tab === "sent") && (
        <Box flexDirection="column" height={listHeight}>
          <MessageList
            messages={messages}
            selectedIndex={selectedIndex}
            scrollOffset={scrollOffset}
            viewportHeight={listHeight}
            isSent={tab === "sent"}
          />
        </Box>
      )}

      {!loading && tab === "threads" && !openThread && (
        <Box flexDirection="column" height={listHeight}>
          <ThreadList
            threads={threads}
            selectedIndex={selectedIndex}
            scrollOffset={scrollOffset}
            viewportHeight={listHeight}
          />
        </Box>
      )}

      {!loading && tab === "fleet" && <FleetPanel />}

      {openMessage && (
        <Box flexDirection="column" height={detailHeight}>
          <MessageDetail message={openMessage} />
        </Box>
      )}

      {openThread && (
        <Box flexDirection="column" height={detailHeight}>
          <ThreadDetail thread={openThread} />
        </Box>
      )}
    </Box>
  );
}
