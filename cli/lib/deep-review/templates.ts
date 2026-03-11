/**
 * Template loading and substitution for seed prompts.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getAttackVectors } from "./args";
import { buildMailEnvExport } from "./fleet-provisioning";
import type { DeepReviewConfig, MaterialResult, SessionContext, RoleDesignerResult } from "./types";

/** Replace all occurrences of a literal string */
function replaceAll(str: string, search: string, replacement: string): string {
  return str.split(search).join(replacement);
}

/** Replace all {{PLACEHOLDER}} occurrences in template content */
function substitute(content: string, vars: Record<string, string>): string {
  let result = content;
  for (const [k, v] of Object.entries(vars)) {
    result = replaceAll(result, k, v);
  }
  return result;
}

/** Generate all worker seed files */
export function generateWorkerSeeds(
  config: DeepReviewConfig,
  _material: MaterialResult,
  ctx: SessionContext,
  roleResult: RoleDesignerResult,
): void {
  const templatePath = join(ctx.templateDir, "worker-seed.md");
  const template = readFileSync(templatePath, "utf-8");

  // Build worker roster
  let workerRoster = "";
  for (let i = 0; i < roleResult.totalWorkers; i++) {
    const focus = roleResult.focusAreas[i];
    workerRoster += `- Worker ${i + 1}: ${focus}\n`;
  }
  writeFileSync(join(ctx.sessionDir, "worker-roster.txt"), workerRoster);

  for (let i = 1; i <= roleResult.totalWorkers; i++) {
    let focus: string;
    let passInFocus: number;
    let focusTotal: number;

    if (roleResult.useDynamicRoles) {
      focus = roleResult.focusAreas[i - 1];
      // Count occurrences of this focus before position i
      passInFocus = 0;
      for (let j = 0; j < i; j++) {
        if (roleResult.focusAreas[j] === focus) passInFocus++;
      }
      // Count total passes for this focus
      focusTotal = roleResult.focusAreas.filter((fa) => fa === focus).length;
    } else {
      const focusIdx = Math.floor((i - 1) / config.passesPerFocus);
      passInFocus = ((i - 1) % config.passesPerFocus) + 1;
      focus = roleResult.focusAreas[focusIdx];
      focusTotal = config.passesPerFocus;
    }

    // Resolve attack vectors: custom (from roles.json) or built-in
    const avFile = join(ctx.sessionDir, `av-${focus}.txt`);
    const av = existsSync(avFile) ? readFileSync(avFile, "utf-8") : getAttackVectors(focus);

    let seed = substitute(template, {
      "{{PASS_NUMBER}}": String(i),
      "{{PASS_IN_FOCUS}}": String(passInFocus),
      "{{PASSES_PER_FOCUS}}": String(focusTotal),
      "{{NUM_PASSES}}": String(roleResult.totalWorkers),
      "{{MATERIAL_FILE}}": join(ctx.sessionDir, `material-pass-${i}.txt`),
      "{{OUTPUT_FILE}}": join(ctx.sessionDir, `findings-pass-${i}.json`),
      "{{DONE_FILE}}": join(ctx.sessionDir, `pass-${i}.done`),
      "{{PROJECT_ROOT}}": ctx.workDir,
      "{{SESSION_DIR}}": ctx.sessionDir,
      "{{SPECIALIZATION}}": focus,
      "{{SPEC}}": config.spec,
      "{{VALIDATOR}}": ctx.validatorPath,
      "{{ROLE_ID}}": focus,
      "{{COORDINATOR_NAME}}": ctx.coordinatorName || "",
    });

    // Substitute fields that may contain special chars
    seed = replaceAll(seed, "{{ATTACK_VECTORS}}", av);
    seed = replaceAll(seed, "{{REVIEW_CONFIG}}", ctx.reviewConfig);
    seed = replaceAll(seed, "{{WORKER_ROSTER}}", workerRoster);

    writeFileSync(join(ctx.sessionDir, `worker-${i}-seed.md`), seed);
  }
}

/** Generate the coordinator seed file */
export function generateCoordinatorSeed(
  config: DeepReviewConfig,
  material: MaterialResult,
  ctx: SessionContext,
  roleResult: RoleDesignerResult,
): void {
  const templatePath = join(ctx.templateDir, "coordinator-seed.md");
  const template = readFileSync(templatePath, "utf-8");
  const focusListCsv = roleResult.focusAreas
    .filter((v, i, a) => a.indexOf(v) === i) // unique
    .join(",");

  const seed = substitute(template, {
    "{{SESSION_DIR}}": ctx.sessionDir,
    "{{SESSION_ID}}": ctx.sessionId,
    "{{PROJECT_ROOT}}": ctx.workDir,
    "{{NUM_PASSES}}": String(roleResult.totalWorkers),
    "{{PASSES_PER_FOCUS}}": String(roleResult.passesPerFocus),
    "{{NUM_FOCUS}}": String(roleResult.numFocus),
    "{{FOCUS_LIST}}": focusListCsv,
    "{{REPORT_FILE}}": join(ctx.sessionDir, "report.md"),
    "{{HISTORY_FILE}}": ctx.historyFile,
    "{{NOTIFY_TARGET}}": config.notifyTarget,
    "{{REVIEW_SESSION}}": ctx.reviewSession,
    "{{DIFF_DESC}}": material.diffDesc,
    "{{MATERIAL_TYPES}}": material.materialTypesStr,
    "{{REVIEW_CONFIG}}": ctx.reviewConfig,
    "{{WORKTREE_DIR}}": ctx.worktreeDir,
    "{{VALIDATOR}}": ctx.validatorPath,
    "{{COORDINATOR_NAME}}": ctx.coordinatorName || "",
    "{{JUDGE_NAME}}": ctx.judgeName || "",
  });

  writeFileSync(join(ctx.sessionDir, "coordinator-seed.md"), seed);
}

/** Generate the judge seed file */
export function generateJudgeSeed(ctx: SessionContext, roleResult: RoleDesignerResult): boolean {
  const templatePath = join(ctx.templateDir, "judge-seed.md");
  if (!existsSync(templatePath)) return false;

  let seed = substitute(readFileSync(templatePath, "utf-8"), {
    "{{SESSION_DIR}}": ctx.sessionDir,
    "{{PROJECT_ROOT}}": ctx.workDir,
    "{{NUM_PASSES}}": String(roleResult.totalWorkers),
    "{{VALIDATOR}}": ctx.validatorPath,
    "{{COORDINATOR_NAME}}": ctx.coordinatorName || "",
  });

  seed = replaceAll(seed, "{{REVIEW_CONFIG}}", ctx.reviewConfig);
  seed = replaceAll(seed, "{{COMMS_LOG}}", `(check ${ctx.sessionDir}/comms/ for inter-worker messages)`);

  writeFileSync(join(ctx.sessionDir, "judge-seed.md"), seed);
  return true;
}

/** Generate verifier seed files */
export function generateVerifierSeeds(
  config: DeepReviewConfig,
  ctx: SessionContext,
): void {
  const templatePath = join(ctx.templateDir, "verifier-seed.md");
  if (!existsSync(templatePath)) return;

  const template = readFileSync(templatePath, "utf-8");
  const verifierRolesArg = config.verifyRoles ? `Test as these user roles: ${config.verifyRoles}` : "";

  const verifierConfigs: Record<string, { setup: string; protocol: string }> = {
    chrome: {
      setup: `Deploy to a test slot:\n\`\`\`bash\ncd ${ctx.workDir}\nbash .claude/scripts/worker/deploy-to-slot.sh --service static\n\`\`\`\nNote the slot URL from the deploy output. Open it in Chrome MCP.\nLogin as each relevant user role. ${verifierRolesArg}`,
      protocol: `For each Chrome path:\n- Open the slot URL in Chrome MCP\n- Walk through each UI path, verify expected behavior\n- Check browser console for errors (zero errors acceptable, warnings OK)\n- Test both desktop and mobile viewports\n- Capture evidence (console output, page text)`,
    },
    curl: {
      setup: `Get auth tokens:\n\`\`\`bash\nbash .claude/scripts/autologin.sh staff --env test\n\`\`\``,
      protocol: `For each API endpoint:\n- Execute the curl command against the test server\n- Verify response status codes and body structure\n- Check error branches (invalid input, missing auth, wrong role)\n- Record exact responses as evidence`,
    },
    test: {
      setup: `Ensure test environment is ready:\n\`\`\`bash\ncd ${ctx.workDir}\nbun test --help > /dev/null 2>&1\n\`\`\``,
      protocol: `For each test path:\n- Write test cases in \`src/tests/unit/\` or \`src/tests/isolated/\`\n- Run with \`bun test <file>\` and verify they pass\n- Focus on boundary conditions and error paths\n- Include the test file path in evidence`,
    },
    script: {
      setup: `No special setup needed. Write scripts to \`.claude/scripts/verify/\` directory.`,
      protocol: `For each script path:\n- Write a verification script that exercises the scenario end-to-end\n- Run it and capture output\n- Scripts should be idempotent and self-contained\n- Include the script path and output in evidence`,
    },
  };

  const types = ["chrome", "curl", "test", "script"] as const;

  for (const vtype of types) {
    const voutput = join(ctx.sessionDir, `verification-${vtype}-results.json`);
    const vdone = join(ctx.sessionDir, `verify-${vtype}.done`);

    let seed = substitute(template, {
      "{{VERIFY_TYPE}}": vtype,
      "{{SESSION_DIR}}": ctx.sessionDir,
      "{{PROJECT_ROOT}}": ctx.workDir,
      "{{OUTPUT_FILE}}": voutput,
      "{{DONE_FILE}}": vdone,
      "{{VALIDATOR}}": ctx.validatorPath,
      "{{COORDINATOR_NAME}}": ctx.coordinatorName || "",
    });

    const vc = verifierConfigs[vtype];
    seed = replaceAll(seed, "{{VERIFY_SETUP}}", vc.setup);
    seed = replaceAll(seed, "{{VERIFY_PROTOCOL}}", vc.protocol);

    writeFileSync(join(ctx.sessionDir, `verifier-${vtype}-seed.md`), seed);
  }
}

/** Generate launch wrapper scripts */
export function generateLaunchWrappers(
  config: DeepReviewConfig,
  ctx: SessionContext,
  roleResult: RoleDesignerResult,
): void {
  const useFleet = !config.v1Mode && !!ctx.coordinatorName;
  const project = ctx.fleetProject || "";

  // Worker wrappers
  for (let i = 1; i <= roleResult.totalWorkers; i++) {
    const workerName = ctx.workerNames?.[i - 1] || "";
    const fleetEnv = useFleet && workerName
      ? buildMailEnvExport(workerName, project)
      : "";

    const projectRootExport = fleetEnv ? `\nexport PROJECT_ROOT="${ctx.workDir}"` : "";
    const script = `#!/usr/bin/env bash
cd "${ctx.workDir}"
${fleetEnv ? fleetEnv + projectRootExport : ""}

# Run the review worker
claude --model ${config.workerModel} --dangerously-skip-permissions "$(cat '${ctx.sessionDir}/worker-${i}-seed.md')"

# Post-exit validation: ensure findings JSON is structurally valid
OUTPUT_FILE="${ctx.sessionDir}/findings-pass-${i}.json"
DONE_FILE="${ctx.sessionDir}/pass-${i}.done"
VALIDATOR="${ctx.validatorPath}"

if [ -f "$OUTPUT_FILE" ]; then
  if bash "$VALIDATOR" "$OUTPUT_FILE" worker > /dev/null 2>&1; then
    [ ! -f "$DONE_FILE" ] && echo "done" > "$DONE_FILE"
    echo "[pass-${i}] Findings validated successfully"
  else
    echo "[pass-${i}] WARNING: Findings validation failed:"
    bash "$VALIDATOR" "$OUTPUT_FILE" worker 2>&1 || true
    echo "invalid" > "$DONE_FILE"
  fi
else
  echo "[pass-${i}] WARNING: No findings file produced"
  echo "no-output" > "$DONE_FILE"
fi
`;
    const path = join(ctx.sessionDir, `run-pass-${i}.sh`);
    writeFileSync(path, script, { mode: 0o755 });
  }

  // Coordinator wrapper
  const coordFleetEnv = useFleet && ctx.coordinatorName
    ? buildMailEnvExport(ctx.coordinatorName, project)
    : "";

  const coordPrExport = coordFleetEnv ? `\nexport PROJECT_ROOT="${ctx.workDir}"` : "";
  const coordScript = `#!/usr/bin/env bash
cd "${ctx.workDir}"
${coordFleetEnv ? coordFleetEnv + coordPrExport : ""}
exec claude --model ${config.coordModel} --dangerously-skip-permissions "$(cat '${ctx.sessionDir}/coordinator-seed.md')"
`;
  writeFileSync(join(ctx.sessionDir, "run-coordinator.sh"), coordScript, { mode: 0o755 });

  // Judge wrapper
  if (!config.noJudge && existsSync(join(ctx.sessionDir, "judge-seed.md"))) {
    const judgeName = ctx.judgeName || "";
    const judgeFleetEnv = useFleet && judgeName
      ? buildMailEnvExport(judgeName, project)
      : "";

    const judgePrExport = judgeFleetEnv ? `\nexport PROJECT_ROOT="${ctx.workDir}"` : "";
    const judgeScript = `#!/usr/bin/env bash
cd "${ctx.workDir}"
${judgeFleetEnv ? judgeFleetEnv + judgePrExport : ""}
exec claude --model ${config.workerModel} --dangerously-skip-permissions "$(cat '${ctx.sessionDir}/judge-seed.md')"
`;
    writeFileSync(join(ctx.sessionDir, "run-judge.sh"), judgeScript, { mode: 0o755 });
  }

  // Verifier wrappers
  if (config.verify) {
    const types = ["chrome", "curl", "test", "script"];
    for (let vi = 0; vi < types.length; vi++) {
      const vtype = types[vi];
      const voutput = join(ctx.sessionDir, `verification-${vtype}-results.json`);
      const vdone = join(ctx.sessionDir, `verify-${vtype}.done`);
      const verifierName = ctx.verifierNames?.[vi] || "";
      const vFleetEnv = useFleet && verifierName
        ? buildMailEnvExport(verifierName, project)
        : "";

      const vPrExport = vFleetEnv ? `\nexport PROJECT_ROOT="${ctx.workDir}"` : "";
      const script = `#!/usr/bin/env bash
cd "${ctx.workDir}"
${vFleetEnv ? vFleetEnv + vPrExport : ""}

# Wait for coordinator to finish
echo "Verifier (${vtype}) waiting for coordinator to complete..."
while [ ! -f "${ctx.sessionDir}/review.done" ]; do
  sleep 15
  echo "  ... still waiting ($(date +%H:%M:%S))"
done
echo "Coordinator done. Starting ${vtype} verification."

claude --model ${config.workerModel} --dangerously-skip-permissions "$(cat '${ctx.sessionDir}/verifier-${vtype}-seed.md')"

# Post-exit validation
if [ -f "${voutput}" ]; then
  if bash "${ctx.validatorPath}" "${voutput}" verifier > /dev/null 2>&1; then
    [ ! -f "${vdone}" ] && echo "done" > "${vdone}"
    echo "[verifier-${vtype}] Results validated"
  else
    echo "[verifier-${vtype}] WARNING: Validation failed"
    bash "${ctx.validatorPath}" "${voutput}" verifier 2>&1 || true
    echo "invalid" > "${vdone}"
  fi
else
  echo "[verifier-${vtype}] No results produced"
  echo "no-output" > "${vdone}"
fi
`;
      writeFileSync(join(ctx.sessionDir, `run-verifier-${vtype}.sh`), script, { mode: 0o755 });
    }
  }
}
