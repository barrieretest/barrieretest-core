// Public API - keep minimal and stable

export type {
  AIAnalysis,
  AIEnhancedIssue,
  AIEnhanceOptions,
  AIProvider,
  AIProviderConfig,
  AIProviderName,
} from "./ai/index.js";
// AI enhancement system
export { createProvider, enhanceWithAI } from "./ai/index.js";
// Main audit function
export { audit } from "./audit.js";
// Baseline system
export { type BaselineDiffResult, diffAgainstBaseline } from "./baseline/diff.js";
// NOTE: BaselineInfo is used by packages/playwright/src/format.ts — keep until playwright is refactored
export type { BaselineInfo } from "./baseline/integration.js";
export type { BaselineFile, BaselineIssue } from "./baseline/types.js";
export { readBaseline, updateBaseline, writeBaseline } from "./baseline/write.js";
// Browser detection utilities
export { isPlaywrightPage, isPuppeteerPage, isUrl } from "./browser.js";
// Cookie banner dismissal
export { dismissCookieBanner } from "./cookie-banner.js";
export type {
  Pa11yIssue,
  Pa11yOptions,
  Pa11yResults,
  Pa11yRunnerOptions,
  Pa11yRunResult,
} from "./engines/pa11y.js";
// Engine access (for advanced usage)
export { runPa11y } from "./engines/pa11y.js";
export type {
  LocalizationConfidence,
  LocalizationOptions,
  LocalizationResult,
  LocalizedIssue,
} from "./localization/index.js";
// Localization system
export { localizeIssues } from "./localization/index.js";
export type {
  ActionableIssue,
  FixReadyIssue,
  MinimalIssue,
} from "./report.js";
// Report formatting
export {
  formatActionable,
  formatFixReady,
  formatIssues,
  formatMinimal,
} from "./report.js";
// Scoring utilities
export {
  calculateScore,
  getScoreInterpretation,
  getSeverityLevel,
  SEVERITY_THRESHOLDS,
} from "./scoring.js";
// Types
export type {
  AuditOptions,
  AuditResult,
  AuditTarget,
  BrowserPage,
  DetailLevel,
  Issue,
  IssueSeverity,
  ScoreInterpretation,
  SeverityLevel,
  TransformedIssue,
} from "./types.js";
