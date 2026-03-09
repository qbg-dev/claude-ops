import React from "react";
import { Box, Text } from "ink";
import { colors, statusColors } from "../theme.js";
import { useAppState } from "../state.js";

function padRight(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

export function FleetPanel() {
  const { state } = useAppState();
  const { registry } = state;

  const workers = Object.entries(registry)
    .filter(([k]) => k !== "_config" && k !== "user")
    .map(([name, w]: [string, any]) => ({
      name,
      status: w.status || "?",
      perpetual: !!w.perpetual,
      pane: w.pane_id || "",
      runtime: w.custom?.runtime || "claude",
      hasBms: !!w.bms_token,
      sleepUntil: w.custom?.sleep_until,
    }))
    .sort((a, b) => {
      const order: Record<string, number> = {
        active: 0,
        sleeping: 1,
        standby: 2,
      };
      return (
        (order[a.status] ?? 3) - (order[b.status] ?? 3) ||
        a.name.localeCompare(b.name)
      );
    });

  const active = workers.filter((w) => w.status === "active").length;
  const sleeping = workers.filter((w) => w.status === "sleeping").length;
  const idle = workers.filter(
    (w) => !["active", "sleeping", "standby"].includes(w.status)
  ).length;

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box>
        <Text bold color={colors.blue}>
          Fleet
        </Text>
        <Text color={colors.muted}>
          {"  "}
          {active} active
          {sleeping ? ` \u00b7 ${sleeping} sleeping` : ""}
          {idle ? ` \u00b7 ${idle} idle` : ""}
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {/* Header */}
        <Box>
          <Text color={colors.muted} dim>
            {padRight(" ", 2)}
            {padRight("Name", 24)}
            {padRight("Status", 16)}
            {padRight("\u2709", 3)}
            {"Pane"}
          </Text>
        </Box>

        {workers.map((w) => {
          const sc = statusColors[w.status] || colors.gray;
          let statusStr = w.status;

          if (w.status === "sleeping" && w.sleepUntil) {
            const d = new Date(w.sleepUntil);
            const hm = `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
            statusStr = `sleep \u2192${hm}`;
          }

          return (
            <Box key={w.name}>
              <Text color={colors.muted}>
                {w.perpetual ? "\u267b" : " "}{" "}
              </Text>
              <Text color={colors.white}>{padRight(w.name, 24)}</Text>
              <Text color={sc}>{padRight(statusStr, 16)}</Text>
              <Text color={colors.blue} dim>
                {w.hasBms ? "\u2709" : " "}
              </Text>
              <Text> </Text>
              <Text color={colors.gray}>{w.pane}</Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
