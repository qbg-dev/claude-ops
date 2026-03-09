import React from "react";
import { Box, Text } from "ink";
import { colors } from "../theme.js";
import { senderName, recipientNames, timeAgo } from "../bms.js";
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

    // Inline formatting
    let rendered = line
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/`(.+?)`/g, "$1")
      .replace(/\[(.+?)\]\((.+?)\)/g, "$1")
      .replace(/^- /, "  \u2022 ")
      .replace(/^\* /, "  \u2022 ");

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
  const to = recipientNames(message, directory);
  const time = timeAgo(message.internalDate);
  const isUnread = (message.labelIds || []).includes("UNREAD");
  const isStarred = (message.labelIds || []).includes("STARRED");
  const labels = (message.labelIds || []).filter(
    (l: string) => !["INBOX", "SENT", "UNREAD", "STARRED"].includes(l)
  );

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={colors.gray}
      paddingX={1}
      paddingY={0}
      overflow="hidden"
    >
      {/* Subject line */}
      <Box>
        {isStarred && <Text color={colors.yellow}>{"\u2605 "}</Text>}
        {isUnread && <Text color={colors.blue} bold>{"\u25cf "}</Text>}
        <Text bold color={colors.white}>
          {message.subject || "(no subject)"}
        </Text>
        {labels.length > 0 &&
          labels.map((l: string) => (
            <Text key={l} color={colors.yellow} dim>
              {" [" + l.toLowerCase() + "]"}
            </Text>
          ))}
      </Box>

      {/* From/To/Time header */}
      <Box>
        <Text color={colors.cyan} bold>{from}</Text>
        {to && (
          <>
            <Text color={colors.muted}>{" \u2192 "}</Text>
            <Text color={colors.magenta}>{to}</Text>
          </>
        )}
        <Text color={colors.gray}>{"  \u00b7  "}{time}</Text>
      </Box>

      {/* Divider */}
      <Box marginTop={0}>
        <Text color={colors.gray}>{"\u2500".repeat(70)}</Text>
      </Box>

      {/* Body */}
      <Box flexDirection="column" paddingY={0} overflow="hidden">
        {renderMarkdownLines(message.body || "")}
      </Box>

      {/* Action hints */}
      <Box marginTop={0}>
        <Text color={colors.gray} dim>
          {"  "}
          <Text bold>r</Text> reply{"  "}
          <Text bold>a</Text> archive{"  "}
          <Text bold>s</Text> star{"  "}
          <Text bold>d</Text> trash{"  "}
          <Text bold>Esc</Text> close
        </Text>
      </Box>
    </Box>
  );
}
