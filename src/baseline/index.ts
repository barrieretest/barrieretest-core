// Baseline types

export type { LastRunCache } from "./cache";
// Cache
export { CACHE_DIR, clearOldCache, getLastRun, saveLastRun } from "./cache";
// Diffing
export { type BaselineDiffResult, diffAgainstBaseline } from "./diff";
// Hash generation
export { generateIssueHash } from "./hash";
// Integration
export {
  type BaselineInfo,
  type BaselineIntegrationResult,
  type BaselineProcessOptions,
  processAuditWithBaseline,
} from "./integration";
export type { BaselineFile, BaselineIssue } from "./types";
export { BASELINE_VERSION, isValidBaselineFile } from "./types";
// File I/O
export { readBaseline, updateBaseline, writeBaseline } from "./write";
