export type { LastRunCache } from "./cache.js";
export { CACHE_DIR, clearOldCache, getLastRun, saveLastRun } from "./cache.js";
export { type BaselineDiffResult, diffAgainstBaseline } from "./diff.js";
export { generateIssueHash } from "./hash.js";
export {
  type BaselineInfo,
  type BaselineIntegrationResult,
  type BaselineProcessOptions,
  processAuditWithBaseline,
} from "./integration.js";
export type { BaselineFile, BaselineIssue } from "./types.js";
export { BASELINE_VERSION, isValidBaselineFile } from "./types.js";
export { readBaseline, updateBaseline, writeBaseline } from "./write.js";
