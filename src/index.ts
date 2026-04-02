export type {
  AIAnalysis,
  AIEnhancedIssue,
  AIEnhanceOptions,
  AIProvider,
  AIProviderConfig,
  AIProviderName,
} from "./ai/index.js";
export { createProvider, enhanceWithAI } from "./ai/index.js";
export { audit } from "./audit.js";
export { type BaselineDiffResult, diffAgainstBaseline } from "./baseline/diff.js";
export type { BaselineInfo } from "./baseline/integration.js";
export type { BaselineFile, BaselineIssue } from "./baseline/types.js";
export { readBaseline, updateBaseline, writeBaseline } from "./baseline/write.js";
export { isBrowserPage, isPlaywrightPage, isPuppeteerPage, isUrl } from "./browser.js";
export { dismissCookieBanner } from "./cookie-banner.js";
export type { AxeRunnerOptions, AxeRunResult, AxeViolation } from "./engines/axe.js";
export { runAxeCore, transformAxeViolation } from "./engines/axe.js";
export type {
  Pa11yIssue,
  Pa11yOptions,
  Pa11yResults,
  Pa11yRunnerOptions,
  Pa11yRunResult,
} from "./engines/pa11y.js";
export { runPa11y } from "./engines/pa11y.js";
export type {
  LocalizationConfidence,
  LocalizationOptions,
  LocalizationResult,
  LocalizedIssue,
} from "./localization/index.js";
export { localizeIssues } from "./localization/index.js";
export type {
  ActionableIssue,
  FixReadyIssue,
  MinimalIssue,
} from "./report.js";
export {
  formatActionable,
  formatFixReady,
  formatIssues,
  formatMinimal,
} from "./report.js";
export {
  calculateScore,
  getScoreInterpretation,
  getSeverityLevel,
  SEVERITY_THRESHOLDS,
} from "./scoring.js";
export type {
  AuditEngine,
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
