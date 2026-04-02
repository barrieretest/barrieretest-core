// Public API - keep minimal and stable

export type {
  AIAnalysis,
  AIEnhancedIssue,
  AIEnhanceOptions,
  AIProvider,
  AIProviderConfig,
  AIProviderName,
} from "./ai";
// AI enhancement system
export { createProvider, enhanceWithAI } from "./ai";
// Main audit function
export { audit } from "./audit";
// Baseline system
export { type BaselineDiffResult, diffAgainstBaseline } from "./baseline/diff";
// NOTE: BaselineInfo is used by packages/playwright/src/format.ts — keep until playwright is refactored
export type { BaselineInfo } from "./baseline/integration";
export type { BaselineFile, BaselineIssue } from "./baseline/types";
export { readBaseline, updateBaseline, writeBaseline } from "./baseline/write";
// Browser detection utilities
export { isPlaywrightPage, isPuppeteerPage, isUrl } from "./browser";
// Cookie banner dismissal
export { dismissCookieBanner } from "./cookie-banner";
export type {
  Pa11yIssue,
  Pa11yOptions,
  Pa11yResults,
  Pa11yRunnerOptions,
  Pa11yRunResult,
} from "./engines/pa11y";
// Engine access (for advanced usage)
export { runPa11y } from "./engines/pa11y";
export type {
  LocalizationConfidence,
  LocalizationOptions,
  LocalizationResult,
  LocalizedIssue,
} from "./localization";
// Localization system
export { localizeIssues } from "./localization";
export type {
  ActionableIssue,
  FixReadyIssue,
  MinimalIssue,
} from "./report";
// Report formatting
export {
  formatActionable,
  formatFixReady,
  formatIssues,
  formatMinimal,
} from "./report";
// Scoring utilities
export {
  calculateScore,
  getScoreInterpretation,
  getSeverityLevel,
  SEVERITY_THRESHOLDS,
} from "./scoring";
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
} from "./types";
