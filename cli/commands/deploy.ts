import type { Command } from "commander";
import { info, ok, warn, fail } from "../lib/fmt";
import { addGlobalOpts } from "../index";

function ssh(host: string, cmd: string): { ok: boolean; stdout: string; stderr: string } {
  const result = Bun.spawnSync(
    ["ssh", "-o", "ConnectTimeout=10", "-o", "BatchMode=yes", host, cmd],
    { stderr: "pipe" },
  );
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

async function runDeploy(
  host: string,
  repoUrl: string,
  opts: {
    branch?: string;
    unlockKeychain?: boolean;
    dir?: string;
    dryRun?: boolean;
  },
): Promise<void> {
  const branch = opts.branch || "main";

  info(`Deploying to ${host}`);

  // 1. Check SSH connectivity
  info("Checking SSH connectivity...");
  const ping = ssh(host, "echo ok");
  if (!ping.ok) fail(`Cannot SSH to ${host}: ${ping.stderr}`);
  ok("SSH connected");

  // 2. Check dependencies
  info("Checking remote dependencies...");
  const deps = ssh(host, "which bun && which tmux && which git && which claude");
  if (!deps.ok) {
    const missing: string[] = [];
    for (const tool of ["bun", "tmux", "git", "claude"]) {
      const check = ssh(host, `which ${tool}`);
      if (!check.ok) missing.push(tool);
    }
    fail(`Missing dependencies on ${host}: ${missing.join(", ")}`);
  }
  ok("Dependencies verified");

  // 3. Unlock keychain if requested (macOS)
  if (opts.unlockKeychain) {
    info("Unlocking keychain...");
    // Read password from kevinster credentials if available
    const keychainPw = ssh(host, "security unlock-keychain -p \"$(cat ~/.keychain-password 2>/dev/null)\" 2>/dev/null; echo $?");
    if (keychainPw.stdout.trim() !== "0") {
      warn("Keychain unlock may have failed — Claude auth might not work");
    } else {
      ok("Keychain unlocked");
    }
  }

  // 4. Clone or pull repo
  const repoName = repoUrl.split("/").pop()?.replace(/\.git$/, "") || "repo";
  const remoteDir = opts.dir || `~/${repoName}`;

  info(`Setting up repo at ${remoteDir}...`);
  const repoExists = ssh(host, `test -d ${remoteDir}/.git && echo yes || echo no`);

  if (opts.dryRun) {
    info("[dry-run] Would clone/pull repo");
    info("[dry-run] Would run fleet setup");
    info("[dry-run] Would run fleet launch");
    return;
  }

  if (repoExists.stdout === "yes") {
    info("Repo exists, pulling latest...");
    const pull = ssh(host, `cd ${remoteDir} && git fetch origin && git checkout ${branch} && git pull origin ${branch}`);
    if (!pull.ok) {
      warn(`Pull failed: ${pull.stderr}`);
      warn("Continuing with existing state...");
    } else {
      ok("Repo updated");
    }
  } else {
    info("Cloning repo...");
    const clone = ssh(host, `git clone -b ${branch} ${repoUrl} ${remoteDir}`);
    if (!clone.ok) fail(`Clone failed: ${clone.stderr}`);
    ok("Repo cloned");
  }

  // 5. Run fleet setup
  info("Running fleet setup...");
  const setup = ssh(host, `cd ${remoteDir} && fleet setup`);
  if (!setup.ok) {
    warn(`fleet setup issues: ${setup.stderr}`);
  } else {
    ok("Fleet setup complete");
  }

  // 6. Run fleet launch
  info("Launching fleet from manifest...");
  const launch = ssh(host, `cd ${remoteDir} && fleet launch`);
  if (!launch.ok) {
    warn(`fleet launch issues: ${launch.stderr}`);
    console.log(launch.stdout);
  } else {
    ok("Fleet launched");
    console.log(launch.stdout);
  }

  ok(`Deploy to ${host} complete`);
}

export function register(parent: Command): void {
  const sub = parent
    .command("deploy <host> <repo-url>")
    .description("Deploy fleet to a remote machine via SSH")
    .option("--branch <branch>", "Git branch to checkout (default: main)")
    .option("--unlock-keychain", "Unlock macOS keychain before launching")
    .option("--dir <path>", "Remote directory (default: ~/<repo-name>)")
    .option("--dry-run", "Show what would happen without doing it");
  addGlobalOpts(sub)
    .action(async (host: string, repoUrl: string, opts: {
      branch?: string; unlockKeychain?: boolean; dir?: string; dryRun?: boolean;
    }) => {
      await runDeploy(host, repoUrl, opts);
    });
}
