import React, { useState, useEffect } from "react";
import { Text } from "ink";
import { colors } from "../theme.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Spinner({ label }: { label?: string }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, []);

  return (
    <Text color={colors.blue}>
      {FRAMES[frame]}
      {label && <Text color={colors.muted}> {label}</Text>}
    </Text>
  );
}
