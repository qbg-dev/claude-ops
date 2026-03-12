/**
 * fleet completion — output shell completion script
 *
 * Usage:
 *   fleet completion        # prints zsh completion to stdout
 *   fleet completion >> ~/.zshrc  # one-line install
 *   exec zsh               # reload
 */
import { Command } from "commander";
import { readFileSync } from "fs";
import { join, dirname } from "path";

export function register(parent: Command): void {
  parent
    .command("completion")
    .description("Output shell completion (source it or add to ~/.zshrc)")
    .action(() => {
      const fleetDir = process.env.CLAUDE_FLEET_DIR || join(process.env.HOME!, ".claude-fleet");
      const completionFile = join(fleetDir, "completions", "_fleet");
      try {
        readFileSync(completionFile, "utf-8"); // verify file exists
        // Output fpath + source instructions as a shell snippet
        console.log(`# Fleet CLI completions — add to ~/.zshrc or source directly`);
        console.log(`fpath=(${dirname(completionFile)} $fpath)`);
        console.log(`autoload -Uz compinit && compinit`);
      } catch {
        console.error(`Completion file not found: ${completionFile}`);
        console.error(`Run 'fleet setup' first.`);
        process.exit(1);
      }
    });
}
