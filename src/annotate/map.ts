/**
 * Pure mapping from a page measurement to issue annotations.
 *
 * Nothing here touches a browser: the states, the rounding, the clipping, the
 * mark numbering and the capture geometry are decided from the measurement
 * alone, so they can be tested directly.
 */

import type { AnnotationRect, Issue, IssueAnnotation, ScreenshotMeta } from "../types.js";
import type { MeasuredRect, PageMeasurement } from "./measure.js";
import type { PngSize } from "./png.js";

/** CSS px size of the captured image. */
export interface CaptureSize {
  width: number;
  height: number;
}

/**
 * An element thinner or shorter than this is treated as not visibly rendered:
 * it is the screen-reader-only clipping pattern (`width: 1px; height: 1px`),
 * not something a marker can point at.
 */
const MIN_VISIBLE_SIZE_PX = 2;

/** Per-selector outcome, before reading order turns element identity into marks. */
export interface SelectorAnnotation {
  state: IssueAnnotation["state"];
  rect?: AnnotationRect;
  anchored?: true;
  /** Identity of the measured element; issues sharing it share a mark. */
  elementIndex?: number;
}

/** CSS px size of the capture: image pixels divided by the page's pixel ratio. */
export function captureSizeFrom(png: PngSize, devicePixelRatio: number): CaptureSize {
  const ratio = devicePixelRatio > 0 ? devicePixelRatio : 1;
  return { width: png.width / ratio, height: png.height / ratio };
}

/** Capture geometry for the result, so a consumer can place rects on the image. */
export function screenshotMetaFrom(png: PngSize, measurement: PageMeasurement): ScreenshotMeta {
  const deviceScaleFactor = measurement.devicePixelRatio > 0 ? measurement.devicePixelRatio : 1;
  const capture = captureSizeFrom(png, deviceScaleFactor);

  return {
    width: capture.width,
    height: capture.height,
    deviceScaleFactor,
    viewport: measurement.viewport,
    fullPage: true,
    document: measurement.document,
    scroll: measurement.scroll,
  };
}

/**
 * Whole-pixel rect, rounded outward from the measured box and clamped to the
 * capture's whole-pixel box, so a rect never reaches past the image. `null`
 * when the box does not intersect the capture — off-canvas, below a capture
 * the browser truncated, or left with no pixels by the clamping.
 *
 * Intersection is decided against the unrounded capture size: an element that
 * starts at or past the capture's edge is outside it, however the fractional
 * size rounds.
 */
function clipRect(rect: MeasuredRect, capture: CaptureSize): AnnotationRect | null {
  if (
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height)
  ) {
    return null;
  }

  if (rect.x >= capture.width || rect.y >= capture.height) {
    return null;
  }
  if (rect.x + rect.width <= 0 || rect.y + rect.height <= 0) {
    return null;
  }

  const captureRight = Math.floor(capture.width);
  const captureBottom = Math.floor(capture.height);

  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const right = Math.min(captureRight, Math.ceil(rect.x + rect.width));
  const bottom = Math.min(captureBottom, Math.ceil(rect.y + rect.height));

  if (right <= x || bottom <= y) {
    return null;
  }

  return { x, y, width: right - x, height: bottom - y };
}

/**
 * Resolve every measured selector into a state and, where there is something
 * to draw, a rect. `page` wins over everything: a rule that targets `html` or
 * `body` describes the page, so a box around the whole capture would be noise
 * and would consume a mark. `hidden` then wins over `ambiguous`: a consumer
 * cannot draw a marker either way, and the first match is what both describe.
 */
export function resolveSelectorAnnotations(
  selectors: string[],
  measurement: PageMeasurement,
  capture: CaptureSize
): Map<string, SelectorAnnotation> {
  const resolved = new Map<string, SelectorAnnotation>();

  selectors.forEach((selector, index) => {
    const measured = measurement.selectors[index];

    if (!measured || measured.invalid || measured.matchCount === 0 || !measured.rect) {
      resolved.set(selector, { state: "unresolved" });
      return;
    }

    if (measured.page) {
      resolved.set(selector, { state: "page" });
      return;
    }

    const anchored = measured.anchored ? ({ anchored: true } as const) : {};
    const rect = clipRect(measured.rect, capture);

    if (
      measured.rendered === false ||
      measured.rect.width < MIN_VISIBLE_SIZE_PX ||
      measured.rect.height < MIN_VISIBLE_SIZE_PX ||
      !rect
    ) {
      resolved.set(selector, { state: "hidden", ...anchored });
      return;
    }

    resolved.set(selector, {
      state: measured.matchCount > 1 ? "ambiguous" : "resolved",
      rect,
      elementIndex: measured.elementIndex,
      ...anchored,
    });
  });

  return resolved;
}

/**
 * Number the marked elements in the page's reading order: top edge ascending,
 * then left edge, then first appearance in the issue list for the rare pair
 * that shares a corner. The rect is the clipped, rounded one the annotation
 * carries, so the numbers follow what a consumer draws. Returns a mark per
 * element index.
 */
function numberMarks(
  issues: Issue[],
  resolved: Map<string, SelectorAnnotation>
): Map<number, number> {
  const marked = new Map<number, { rect: AnnotationRect; first: number }>();

  issues.forEach((issue, index) => {
    const match = issue.selector === null ? undefined : resolved.get(issue.selector);
    if (!match?.rect || match.elementIndex === undefined || marked.has(match.elementIndex)) {
      return;
    }
    marked.set(match.elementIndex, { rect: match.rect, first: index });
  });

  const ordered = [...marked.entries()].sort(
    ([, a], [, b]) => a.rect.y - b.rect.y || a.rect.x - b.rect.x || a.first - b.first
  );

  return new Map(ordered.map(([elementIndex], position) => [elementIndex, position + 1]));
}

/**
 * Attach annotations to copies of the issues, numbering marks in the page's
 * reading order: one number per distinct element, shared by every issue on
 * it, contiguous from 1. The order of `issues` itself is unchanged. Issues
 * the measurement never saw (no selector) come out unresolved.
 */
export function applyAnnotations(
  issues: Issue[],
  resolved: Map<string, SelectorAnnotation>
): Issue[] {
  const marks = numberMarks(issues, resolved);

  return issues.map((issue) => {
    const selector = issue.selector;
    const match = selector === null ? undefined : resolved.get(selector);

    if (!match) {
      return { ...issue, annotation: { selector, state: "unresolved" as const } };
    }

    const annotation: IssueAnnotation = { selector, state: match.state };

    if (match.anchored) {
      annotation.anchored = true;
    }

    const mark = match.elementIndex === undefined ? undefined : marks.get(match.elementIndex);

    if (match.rect && mark !== undefined) {
      annotation.rect = match.rect;
      annotation.mark = mark;
    }

    return { ...issue, annotation };
  });
}

/** Failure path: every issue unresolved, on copies, with no geometry claimed. */
export function unresolvedAnnotations(issues: Issue[]): Issue[] {
  return issues.map((issue) => ({
    ...issue,
    annotation: { selector: issue.selector, state: "unresolved" as const },
  }));
}
