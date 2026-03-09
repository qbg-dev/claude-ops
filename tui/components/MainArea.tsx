import React from "react";
import { Box } from "ink";
import { useAppState } from "../state.js";
import { Pane } from "./Pane.js";

export function MainArea({
  height,
  width,
}: {
  height: number;
  width: number;
}) {
  const { state } = useAppState();
  const { panes, activePaneIndex, splitDirection } = state;

  const isVertical = splitDirection === "vertical";

  return (
    <Box
      flexDirection={isVertical ? "row" : "column"}
      width={width}
      height={height}
      overflow="hidden"
    >
      {panes.map((pane, i) => (
        <Pane
          key={pane.id}
          paneIndex={i}
          isActive={i === activePaneIndex && state.focusedPanel === "pane"}
          height={
            isVertical ? height : Math.floor(height / panes.length)
          }
          width={
            isVertical ? Math.floor(width / panes.length) : width
          }
        />
      ))}
    </Box>
  );
}
