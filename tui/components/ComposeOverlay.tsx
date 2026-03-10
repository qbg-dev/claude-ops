import React from "react";
import { Box, Text } from "ink";
import { colors } from "../theme.js";
import { useAppState } from "../state.js";

const FIELD_ORDER = ["to", "cc", "subject", "body"] as const;
const FIELD_LABELS: Record<string, string> = {
  to: "To",
  cc: "Cc",
  subject: "Subject",
  body: "Body",
};

export function ComposeOverlay({ rows, cols }: { rows: number; cols: number }) {
  const { state } = useAppState();
  const { composeFields } = state;

  return (
    <Box flexDirection="column" height={rows} width={cols} paddingX={2} paddingY={1}>
      <Text bold color={colors.blue}>
        Compose New Message
      </Text>
      <Text color={colors.gray}>{"─".repeat(Math.min(60, cols - 4))}</Text>

      {FIELD_ORDER.map((field) => {
        const isActive = composeFields.activeField === field;
        const value = composeFields[field];

        if (field === "body") {
          return (
            <Box key={field} flexDirection="column" marginTop={1} flexGrow={1}>
              <Text color={isActive ? colors.blue : colors.muted} bold={isActive}>
                {FIELD_LABELS[field]}:
              </Text>
              <Box
                borderStyle="single"
                borderColor={isActive ? colors.blue : colors.gray}
                flexGrow={1}
                paddingX={1}
              >
                <Text color={colors.white}>{value}</Text>
                {isActive && <Text color={colors.muted}>█</Text>}
              </Box>
            </Box>
          );
        }

        return (
          <Box key={field}>
            <Text color={isActive ? colors.blue : colors.muted} bold={isActive}>
              {FIELD_LABELS[field].padEnd(8)}
            </Text>
            <Text color={colors.white}>{value}</Text>
            {isActive && <Text color={colors.muted}>█</Text>}
          </Box>
        );
      })}

      <Text color={colors.gray}>{"─".repeat(Math.min(60, cols - 4))}</Text>
      <Text color={colors.gray} dim>
        <Text bold>Tab</Text> next field{"  "}
        <Text bold>Ctrl+Enter</Text> send{"  "}
        <Text bold>Esc</Text> cancel
      </Text>
    </Box>
  );
}
