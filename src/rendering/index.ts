/**
 * Deterministic rendering checks.
 *
 * `audit(url, { rendering: true })` renders the page under a set of named
 * rendering conditions and runs geometry checks under each. See
 * `docs/plans/rendering-checks.md` for the contract.
 */

export type { DeviceViewport, RenderingCapabilities, ViewportSize } from "./capabilities.js";
export { createRenderingCapabilities } from "./capabilities.js";
export { baselineKey, renderingAxeBaseline, runConditionAxe } from "./axe.js";
export type { Rgb, Rgba, SimulatedDeficiency } from "./color.js";
export {
  compositeOver,
  contrastRatio,
  deltaE,
  isSimulatedDeficiency,
  parseColor,
  relativeLuminance,
  SIMULATED_DEFICIENCIES,
  simulateDeficiency,
} from "./color.js";
export {
  BUILT_IN_RENDERING_CHECK_IDS,
  BUILT_IN_RENDERING_CHECKS,
  contentHiddenAtViewportCheck,
  contrastUnderModeCheck,
  cvdLinkDistinctionCheck,
  cvdStateByColorCheck,
  forcedColorsLossCheck,
  motionNotReducedCheck,
  overflowClippedTextCheck,
  overlapTextCheck,
  reflowHorizontalScrollCheck,
  resolveRenderingChecks,
  targetSizeCheck,
} from "./checks/index.js";
export {
  DEFAULT_RENDERING_CONDITIONS,
  RENDERING_CONDITION_IDS,
  requiredCapabilities,
  resolveCondition,
  resolveConditions,
} from "./conditions.js";
export { renderingIssues } from "./issues.js";
export { isRenderingMeasurement, measureRendering, unionCollect } from "./measure.js";
export type { RenderingRunOptions, RenderingRunResult } from "./runner.js";
export { DEFAULT_CONDITION_TIMEOUT_MS, runRenderingChecks } from "./runner.js";
export type {
  ConditionCancellation,
  CrossConditionCheck,
  ElementClipping,
  MediaFeatures,
  PerConditionCheck,
  RenderingAnimation,
  RenderingAxeNode,
  RenderingAxeResult,
  RenderingAxeRun,
  RenderingCheck,
  RenderingCollect,
  RenderingCondition,
  RenderingElement,
  RenderingFinding,
  RenderingLink,
  RenderingMeasurement,
  RenderingMotion,
  RenderingMotionElement,
  RenderingPaintedElement,
  RenderingStateName,
  RenderingStatePair,
  RenderingStateStyle,
  RenderingTextStyle,
  VisionDeficiency,
} from "./types.js";
