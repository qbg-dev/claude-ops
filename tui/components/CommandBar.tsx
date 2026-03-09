import React from "react";
import { Box, Text } from "ink";
import { colors } from "../theme.js";
import { useAppState } from "../state.js";

export function CommandBar() {
  const { state } = useAppState();
  const { commandMode, commandInput, statusMessage } = state;

  if (commandMode) {
    return (
      <Box height={1} paddingX={1}>
        <Text color={colors.blue}>:</Text>
        <Text color={colors.white}>{commandInput}</Text>
        <Text color={colors.muted}>{"\u2588"}</Text>
      </Box>
    );
  }

  if (statusMessage) {
    return (
      <Box height={1} paddingX={1}>
        <Text color={colors.green}>{statusMessage}</Text>
      </Box>
    );
  }

  return (
    <Box height={1} paddingX={1}>
      <Text color={colors.muted}>
        <Text dim>h</Text>/<Text dim>l</Text> panel{"  "}
        <Text dim>j</Text>/<Text dim>k</Text> move{"  "}
        <Text dim>Enter</Text> open{"  "}
        <Text dim>:</Text> cmd{"  "}
        <Text dim>/</Text> search{"  "}
        <Text dim>?</Text> help{"  "}
        <Text dim>q</Text> quit
        {state.panes.length > 1 && (
          <Text color={colors.cyan}>{`  [${state.panes.length} panes]`}</Text>
        )}
      </Text>
    </Box>
  );
}
