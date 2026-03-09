import React from "react";
import { Box, Text } from "ink";
import { colors } from "../theme.js";
import { useAppState } from "../state.js";

const COMMANDS = ["vsplit", "hsplit", "close", "as", "send", "search", "reply", "quit"];

export function CommandBar() {
  const { state } = useAppState();
  const { commandMode, commandInput, statusMessage, workerList } = state;

  if (commandMode) {
    // Ghost text: show best completion match (only when not already cycling)
    const txt = state.tabCompletionBase || commandInput;
    const parts = txt.split(/\s+/);
    let ghost = "";
    if (state.tabCompletionIndex < 0) {
      if (parts.length <= 1) {
        const prefix = parts[0] || "";
        const match = COMMANDS.find((c) => c.startsWith(prefix) && c !== prefix);
        if (match) ghost = match.slice(prefix.length);
      } else {
        const argPrefix = parts.slice(1).join(" ");
        if (argPrefix) {
          const match = workerList.find((w) => w.name.startsWith(argPrefix) && w.name !== argPrefix);
          if (match) ghost = match.name.slice(argPrefix.length);
        }
      }
    }

    return (
      <Box height={1} paddingX={1}>
        <Text color={colors.blue} bold>:</Text>
        <Text color={colors.white}>{commandInput}</Text>
        {ghost && <Text color={colors.gray} dim>{ghost}</Text>}
        <Text color={colors.muted}>{"\u2588"}</Text>
        <Text color={colors.gray} dim>{"  Tab"}</Text>
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

  // Show the current pane's tab for context
  const pane = state.panes[state.activePaneIndex];
  const tabHint = pane ? `[${pane.tab}]` : "";

  return (
    <Box height={1} paddingX={1}>
      <Text color={colors.muted}>
        <Text dim>j</Text>/<Text dim>k</Text> move{"  "}
        <Text dim>Enter</Text> open{"  "}
        <Text dim>1-4</Text> tab{"  "}
        <Text dim>e</Text> archive{"  "}
        <Text dim>r</Text> reply{"  "}
        <Text dim>:</Text> cmd{"  "}
        <Text dim>?</Text> help
        {state.panes.length > 1 && (
          <Text color={colors.cyan}>{`  [${state.panes.length} panes]`}</Text>
        )}
        <Text color={colors.gray}>{`  ${tabHint}`}</Text>
      </Text>
    </Box>
  );
}
