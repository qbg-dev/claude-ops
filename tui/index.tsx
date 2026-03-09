#!/usr/bin/env bun
/**
 * harness-tui — aerc-inspired multi-pane terminal dashboard for the worker fleet.
 * v2.0
 */

import React from "react";
import { render } from "ink";
import { App } from "./app.js";
import {
  loadRegistry,
  loadTokenMap,
  resolveUserToken,
  autoProvisionUser,
} from "./bms.js";

async function main() {
  // Load registry and tokens
  const registry = loadRegistry();
  const tokenMap = loadTokenMap(registry);

  // Resolve user token
  let userToken = resolveUserToken();
  if (!userToken) {
    try {
      userToken = await autoProvisionUser();
    } catch (e: any) {
      process.stderr.write(`Failed to provision BMS account: ${e.message}\n`);
      process.exit(1);
    }
  }

  // Enter alternate screen buffer
  process.stdout.write("\x1b[?1049h"); // alternate screen
  process.stdout.write("\x1b[?25l"); // hide cursor

  const { waitUntilExit } = render(
    <App
      initialTokenMap={tokenMap}
      initialRegistry={registry}
      userToken={userToken}
    />,
    {
      exitOnCtrlC: false,
    }
  );

  await waitUntilExit();

  // Restore terminal
  process.stdout.write("\x1b[?25h"); // show cursor
  process.stdout.write("\x1b[?1049l"); // exit alternate screen
}

main().catch((e) => {
  // Ensure we restore terminal on error
  process.stdout.write("\x1b[?25h");
  process.stdout.write("\x1b[?1049l");
  process.stderr.write(e.message + "\n");
  process.exit(1);
});
