export type {
  AIAnalysis,
  AIEnhancedIssue,
  AIEnhanceOptions,
  AIProvider,
  AIProviderConfig,
  AIProviderName,
  JsonSchemaObject,
  ModelCapabilities,
  ModelRequest,
  ModelResponse,
  ProviderKind,
} from "./ai/index.js";
export {
  createMistralProvider,
  createOpenAICompatibleProvider,
  createProvider,
  enhanceWithAI,
  resolveCapabilities,
} from "./ai/index.js";
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
export type { HtmlReportLocale, HtmlReportOptions } from "./html-report/index.js";
export { HTML_REPORT_LOCALES, renderHtmlReport } from "./html-report/index.js";
export type { LazyContentOptions, LazyContentSummary } from "./lazy-content.js";
export { loadLazyContent } from "./lazy-content.js";
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
export type {
  ConditionCancellation,
  CrossConditionCheck,
  MediaFeatures,
  PerConditionCheck,
  RenderingAnimation,
  RenderingAxeNode,
  RenderingAxeResult,
  RenderingAxeRun,
  RenderingCapabilities,
  RenderingCheck,
  RenderingCollect,
  RenderingCondition,
  RenderingElement,
  RenderingFinding,
  RenderingMeasurement,
  RenderingMotion,
  RenderingMotionElement,
  RenderingPaintedElement,
  RenderingRunOptions,
  RenderingRunResult,
  VisionDeficiency,
} from "./rendering/index.js";
export {
  BUILT_IN_RENDERING_CHECK_IDS,
  BUILT_IN_RENDERING_CHECKS,
  contentHiddenAtViewportCheck,
  contrastUnderModeCheck,
  createRenderingCapabilities,
  DEFAULT_RENDERING_CONDITIONS,
  forcedColorsLossCheck,
  motionNotReducedCheck,
  overflowClippedTextCheck,
  overlapTextCheck,
  reflowHorizontalScrollCheck,
  RENDERING_CONDITION_IDS,
  resolveConditions,
  resolveRenderingChecks,
  runRenderingChecks,
  targetSizeCheck,
} from "./rendering/index.js";
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
export {
  altTextQualityCheck,
  ariaMismatchCheck,
  BUILT_IN_CHECK_IDS,
  BUILT_IN_CHECKS,
  buildSemanticResponseSchema,
  formLabelClarityCheck,
  landmarksCheck,
  langAttributeCheck,
  pageTitleCheck,
  parseSemanticObject,
  resolveChecks,
  semanticAudit,
  SEMANTIC_MODEL_TIERS,
  SEMANTIC_RESPONSE_SCHEMA,
  SEMANTIC_SEVERITY_MAP,
} from "./semantic/index.js";
export type {
  RawSemanticFinding,
  SemanticAnalysisInput,
  SemanticAnalysisResponse,
  SemanticAuditResult,
  SemanticCheck,
  SemanticContextLimits,
  SemanticContextSection,
  SemanticIssueMeta,
  SemanticLandmark,
  SemanticMeta,
  SemanticModelTier,
  SemanticOptions,
  SemanticProviderConfig,
  SemanticSeverity,
  SemanticTierMeta,
} from "./semantic/index.js";
export type {
  AnnotationRect,
  AnnotationState,
  AuditEngine,
  AuditOptions,
  AuditResult,
  AuditTarget,
  BrowserPage,
  DetailLevel,
  Issue,
  IssueAnnotation,
  IssueSeverity,
  RenderingCapture,
  RenderingConditionId,
  RenderingIssueMeta,
  RenderingMeta,
  RenderingOptions,
  ScoreInterpretation,
  ScreenshotMeta,
  SeverityLevel,
  TransformedIssue,
} from "./types.js";
