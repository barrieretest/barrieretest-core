// Baseline types

export type { LastRunCache } from "./cache.js";
// Cache
export { CACHE_DIR, clearOldCache, getLastRun, saveLastRun } from "./cache.js";
// Diffing
export { type BaselineDiffResult, diffAgainstBaseline } from "./diff.js";
// Hash generation
export { generateIssueHash } from "./hash.js";
// Integration
export {
  type BaselineInfo,
  type BaselineIntegrationResult,
  type BaselineProcessOptions,
  processAuditWithBaseline,
} from "./integration.js";
export type { BaselineFile, BaselineIssue } from "./types.js";
export { BASELINE_VERSION, isValidBaselineFile } from "./types.js";
// File I/O
export { readBaseline, updateBaseline, writeBaseline } from "./write.js";
