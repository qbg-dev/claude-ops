import React from "react";
import { Box, Text } from "ink";
import { colors } from "../theme.js";
import type { Tab } from "../state.js";

const TABS: { key: Tab; label: string; num: string }[] = [
  { key: "inbox", label: "Inbox", num: "1" },
  { key: "threads", label: "Threads", num: "2" },
  { key: "fleet", label: "Fleet", num: "3" },
  { key: "sent", label: "Sent", num: "4" },
];

export function TabBar({
  active,
  workerName,
  msgCount,
}: {
  active: Tab;
  workerName: string;
  msgCount?: number;
}) {
  return (
    <Box paddingX={1}>
      <Text bold color={colors.cyan}>
        {workerName}
      </Text>
      <Text> </Text>
      {TABS.map((t) => (
        <React.Fragment key={t.key}>
          {t.key === active ? (
            <Text bold inverse color={colors.blue}>
              {" "}
              {t.label}{" "}
            </Text>
          ) : (
            <Text color={colors.muted}>
              {" "}
              {t.label}{" "}
            </Text>
          )}
        </React.Fragment>
      ))}
      {msgCount !== undefined && msgCount > 0 && (
        <Text color={colors.muted}>
          {"  "}
          {msgCount} msgs
        </Text>
      )}
    </Box>
  );
}
