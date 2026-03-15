#!/usr/bin/env bun
/**
 * fleet — Worker fleet management CLI
 *
 * Lightweight, tmux-based Claude Code orchestration platform.
 * Manages persistent worker agents across git worktrees.
 */
import { Command, Option } from "commander";
import { setOutputMode } from "./lib/fmt";

const program = new Command()
  .name("fleet")
  .description("Fleet — persistent Claude Code agents in tmux")
  .version("2.0.0", "-v, --version")
  .option("-p, --project <name>", "Override project detection")
  .option("--json", "JSON output for supported commands")
  .option("--human", "Human-friendly output (default when HUMAN=1)");

// Set output mode before any command runs
program.hook("preAction", (thisCommand) => {
  const opts = thisCommand.optsWithGlobals();
  setOutputMode({ human: opts.human });
});

/**
 * Add hidden copies of global options to a subcommand so they're
 * recognized after the subcommand name (e.g. `fleet ls --json`).
 * They don't show in subcommand --help since they're already on root.
 */
export function addGlobalOpts(cmd: Command): Command {
  return cmd
    .addOption(new Option("-p, --project <name>").hideHelp())
    .addOption(new Option("--json").hideHelp())
    .addOption(new Option("--human").hideHelp());
}

// Default action (no subcommand) → show status dashboard
program.action(async (_opts: Record<string, unknown>, cmd: Command) => {
  const { runStatus } = await import("./commands/status");
  await runStatus(cmd.optsWithGlobals());
});

// Register all subcommands
import { register as registerSetup } from "./commands/setup";
import { register as registerCreate } from "./commands/create";
import { register as registerStart } from "./commands/start";
import { register as registerStop } from "./commands/stop";
import { register as registerLs } from "./commands/ls";
import { register as registerStatus } from "./commands/status";
import { register as registerAttach } from "./commands/attach";
import { register as registerConfig } from "./commands/config";
import { register as registerDefaults } from "./commands/defaults";
import { register as registerLog } from "./commands/log";
import { register as registerMail } from "./commands/mail";
import { register as registerMailServer } from "./commands/mail-server";
import { register as registerFork } from "./commands/fork";
import { register as registerMcp } from "./commands/mcp";
import { register as registerRun } from "./commands/run";
import { register as registerNuke } from "./commands/nuke";
import { register as registerDoctor } from "./commands/doctor";
import { register as registerOnboard } from "./commands/onboard";
import { register as registerTui } from "./commands/tui";
import { register as registerLayout } from "./commands/layout";
import { register as registerDeepReview } from "./commands/deep-review";
import { register as registerHook } from "./commands/hook";
import { register as registerRecycle } from "./commands/recycle";
import { register as registerPipeline } from "./commands/pipeline";
import { register as registerCompletion } from "./commands/completion";
import { register as registerUpdate } from "./commands/update";
import { register as registerLaunch } from "./commands/launch";
import { register as registerDeploy } from "./commands/deploy";
import { register as registerGet } from "./commands/get";

registerSetup(program);
registerCreate(program);
registerRun(program);
registerStart(program);
registerStop(program);
registerLs(program);
registerStatus(program);
registerAttach(program);
registerConfig(program);
registerDefaults(program);
registerLog(program);
registerMail(program);
registerMailServer(program);
registerFork(program);
registerMcp(program);
registerNuke(program);
registerDoctor(program);
registerOnboard(program);
registerTui(program);
registerLayout(program);
registerDeepReview(program);
registerHook(program);
registerRecycle(program);
registerPipeline(program);
registerCompletion(program);
registerUpdate(program);
registerLaunch(program);
registerDeploy(program);
registerGet(program);

program.parse();
