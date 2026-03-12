/**
 * Shared types for the deep-review pipeline.
 */

export interface DeepReviewConfig {
  scope: string;
  contentFiles: string[];
  spec: string;
  passesPerFocus: number;
  focusAreas: string[];
  customFocus: string;
  noJudge: boolean;
  noContext: boolean;
  force: boolean;
  verify: boolean;
  verifyRoles: string;
  v1Mode: boolean;
  maxWorkers: number | null;
  noWorktree: boolean;
  noImproveReview: boolean;
  sessionName: string;
  notifyTarget: string;
  workerModel: string;
  coordModel: string;
}

export interface MaterialResult {
  hasDiff: boolean;
  hasContent: boolean;
  materialType: "code_diff" | "code_listing" | "document" | "config" | "mixed";
  materialFile: string;
  materialTypesStr: string;
  diffDesc: string;
  diffLines: number;
  changedFiles: string[];
}

export interface SessionContext {
  sessionId: string;
  sessionDir: string;
  reviewSession: string;
  projectRoot: string;
  workDir: string;
  worktreeDir: string;
  worktreeBranch: string;
  historyFile: string;
  templateDir: string;
  claudeOps: string;
  reviewConfig: string;
  validatorPath: string;
  /** Fleet integration fields (v2 only, empty strings if v1) */
  sessionHash: string;
  coordinatorName: string;
  judgeName: string;
  workerNames: string[];
  verifierNames: string[];
  fleetProject: string;
}

export interface RoleDesignerResult {
  useDynamicRoles: boolean;
  focusAreas: string[];
  numFocus: number;
  totalWorkers: number;
  passesPerFocus: number;
  roleNames: string;
}

/** Serialized pipeline state for async hook-chained phases */
export interface PipelineState {
  config: DeepReviewConfig;
  material: MaterialResult;
  ctx: SessionContext;
  roleResult?: RoleDesignerResult;
}
