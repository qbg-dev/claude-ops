#!/usr/bin/env bun
/**
 * fleet — Worker fleet management CLI
 *
 * Lightweight, tmux-based Claude Code orchestration platform.
 * Manages persistent worker agents across git worktrees.
 */
import { defineCommand, runMain } from "citty";

const main = defineCommand({
  meta: {
    name: "fleet",
    version: "2.0.0",
    description: "Worker fleet management — persistent Claude Code agents in tmux",
  },
  subCommands: {
    setup:    () => import("./commands/setup").then(m => m.default),
    create:   () => import("./commands/create").then(m => m.default),
    start:    () => import("./commands/start").then(m => m.default),
    restart:  () => import("./commands/start").then(m => m.default),
    stop:     () => import("./commands/stop").then(m => m.default),
    ls:       () => import("./commands/ls").then(m => m.default),
    list:     () => import("./commands/ls").then(m => m.default),
    config:   () => import("./commands/config").then(m => m.default),
    cfg:      () => import("./commands/config").then(m => m.default),
    defaults: () => import("./commands/defaults").then(m => m.default),
    log:      () => import("./commands/log").then(m => m.default),
    logs:     () => import("./commands/log").then(m => m.default),
    mail:     () => import("./commands/mail").then(m => m.default),
    fork:     () => import("./commands/fork").then(m => m.default),
    mcp:      () => import("./commands/mcp").then(m => m.default),
  },
});

runMain(main);
