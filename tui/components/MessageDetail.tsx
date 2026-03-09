import React from "react";
import { Box, Text } from "ink";
import { colors } from "../theme.js";
import { senderName, timeAgo } from "../bms.js";
import { useAppState } from "../state.js";

// Simple markdown-to-Ink renderer
function renderMarkdownLines(text: string): React.ReactNode[] {
  const lines = text.split("\n");
  const nodes: React.ReactNode[] = [];
  let inCode = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trimStart().startsWith("```")) {
      inCode = !inCode;
      if (inCode) {
        nodes.push(
          <Text key={`cb-s-${i}`} color={colors.gray}>
            {"\u250c" + "\u2500".repeat(60)}
          </Text>
        );
      } else {
        nodes.push(
          <Text key={`cb-e-${i}`} color={colors.gray}>
            {"\u2514" + "\u2500".repeat(60)}
          </Text>
        );
      }
      continue;
    }

    if (inCode) {
      nodes.push(
        <Text key={`code-${i}`}>
          <Text color={colors.gray}>{"\u2502"}</Text>
          <Text dim> {line}</Text>
        </Text>
      );
      continue;
    }

    // Headings
    if (line.match(/^## /)) {
      nodes.push(
        <Text key={`h2-${i}`} bold color={colors.blue}>
          {line.replace(/^## /, "")}
        </Text>
      );
      continue;
    }
    if (line.match(/^### /)) {
      nodes.push(
        <Text key={`h3-${i}`} color={colors.cyan}>
          {line.replace(/^### /, "")}
        </Text>
      );
      continue;
    }

    // Blockquotes
    if (line.match(/^> /)) {
      nodes.push(
        <Text key={`bq-${i}`}>
          <Text color={colors.gray}>{"\u2502"}</Text>
          <Text italic color={colors.muted}>
            {" "}
            {line.replace(/^> /, "")}
          </Text>
        </Text>
      );
      continue;
    }

    // Inline formatting (simplified — just render as-is for now,
    // stripping markdown syntax)
    let rendered = line
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/`(.+?)`/g, "$1")
      .replace(/\[(.+?)\]\((.+?)\)/g, "$1")
      .replace(/^- /, "  \u00b7 ")
      .replace(/^\* /, "  \u00b7 ");

    nodes.push(
      <Text key={`ln-${i}`} color={colors.lightGray}>
        {rendered}
      </Text>
    );
  }

  return nodes;
}

export function MessageDetail({ message }: { message: any }) {
  const { state } = useAppState();
  const { directory } = state;

  const from = senderName(message, directory);
  const time = timeAgo(message.internalDate);
  const labels = (message.labelIds || []).filter(
    (l: string) => !["INBOX", "SENT", "UNREAD"].includes(l)
  );

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={colors.gray}
      paddingX={1}
      paddingY={0}
    >
      <Box>
        <Text bold color={colors.white}>
          {message.subject || "(no subject)"}
        </Text>
      </Box>
      <Box>
        <Text color={colors.muted}>from </Text>
        <Text color={colors.cyan}>{from}</Text>
        <Text color={colors.gray}> {time}</Text>
        {labels.length > 0 && (
          <Text color={colors.yellow} dim>
            {"  "}
            {labels.join(" ").toLowerCase()}
          </Text>
        )}
      </Box>
      <Box marginTop={1}>
        <Text color={colors.gray}>{"\u2500".repeat(60)}</Text>
      </Box>
      <Box flexDirection="column" paddingY={1}>
        {renderMarkdownLines(message.body || "")}
      </Box>
      <Box>
        <Text color={colors.muted} dim>
          r reply {"  "} a archive {"  "} s star {"  "} d trash {"  "} Esc
          close
        </Text>
      </Box>
    </Box>
  );
}
