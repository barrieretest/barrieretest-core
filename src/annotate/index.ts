/**
 * Screenshot coordinate map for issues.
 *
 * `annotateIssues()` resolves every `Issue.selector` against the live page in
 * a single round trip and returns copies of the issues carrying where their
 * element sits on the full-page screenshot, plus the geometry of that capture.
 * Engine findings and semantic findings go through the same path, since both
 * arrive as an `Issue.selector`.
 *
 * It never fails an audit: a screenshot whose size cannot be read means no
 * annotations, a failed or timed-out measurement means all-unresolved
 * annotations, and either way one `console.warn`.
 *
 * `audit()` is the only caller.
 */

import type { BrowserPage } from "../browser.js";
import type { Issue, ScreenshotMeta } from "../types.js";
import {
  annotatedElsewhere,
  applyAnnotations,
  captureSizeFrom,
  resolveSelectorAnnotations,
  screenshotMetaFrom,
  unresolvedAnnotations,
} from "./map.js";
import { isPageMeasurement, measureSelectors } from "./measure.js";
import { readPngSize } from "./png.js";

export interface AnnotateOptions {
  /** Audit timeout; the measurement uses the smaller of it and its own bound. */
  timeout?: number;
}

export interface AnnotateResult {
  /** The issues, annotated where annotation was possible. New objects. */
  issues: Issue[];
  /** Geometry of the capture; omitted when nothing could be measured. */
  screenshotMeta?: ScreenshotMeta;
}

/** The selectors worth sending to the browser, de-duplicated, in issue order. */
function uniqueSelectors(issues: Issue[]): string[] {
  const selectors: string[] = [];
  for (const issue of issues) {
    // A rendering finding is already annotated in its own capture's space.
    if (annotatedElsewhere(issue)) continue;
    const selector = issue.selector;
    if (selector === null || selector.trim() === "") continue;
    if (!selectors.includes(selector)) selectors.push(selector);
  }
  return selectors;
}

export async function annotateIssues(
  page: BrowserPage,
  issues: Issue[],
  screenshot: Uint8Array,
  options: AnnotateOptions = {}
): Promise<AnnotateResult> {
  const png = readPngSize(screenshot);
  if (!png) {
    console.warn("Annotation skipped: the screenshot is not a PNG whose size could be read.");
    return { issues };
  }

  const selectors = uniqueSelectors(issues);

  let measurement: unknown;
  try {
    measurement = await measureSelectors(page, selectors, { timeout: options.timeout });
  } catch (error) {
    console.warn(
      `Annotation measurement failed: ${error instanceof Error ? error.message : "Unknown error"}`
    );
    return { issues: unresolvedAnnotations(issues) };
  }

  if (!isPageMeasurement(measurement)) {
    console.warn("Annotation measurement returned unexpected data; issues left unresolved.");
    return { issues: unresolvedAnnotations(issues) };
  }

  const capture = captureSizeFrom(png, measurement.devicePixelRatio);
  const resolved = resolveSelectorAnnotations(selectors, measurement, capture);

  return {
    issues: applyAnnotations(issues, resolved),
    screenshotMeta: screenshotMetaFrom(png, measurement),
  };
}

export { readImageSize, readJpegSize } from "./jpeg.js";
export type { CaptureMeasurement, CaptureSize, MarkCandidate, SelectorAnnotation } from "./map.js";
export {
  annotatedElsewhere,
  applyAnnotations,
  captureSizeFrom,
  clipRect,
  markNumbersInReadingOrder,
  MIN_VISIBLE_SIZE_PX,
  resolveSelectorAnnotations,
  screenshotMetaFrom,
  unresolvedAnnotations,
} from "./map.js";
export type { MeasuredRect, PageMeasurement, SelectorMeasurement } from "./measure.js";
export { isPageMeasurement, MEASURE_TIMEOUT_MS, measureSelectors } from "./measure.js";
export type { PngSize } from "./png.js";
export { readPngSize } from "./png.js";
