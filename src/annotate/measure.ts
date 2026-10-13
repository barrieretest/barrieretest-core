/**
 * In-page measurement for issue annotations.
 *
 * One `page.evaluate` resolves the whole de-duplicated selector batch and
 * reports geometry, visibility and anchoring per selector plus the page-level
 * numbers the capture geometry needs. The measurement is read-only: nothing
 * scrolls, focuses or mutates, so the page the semantic pass saw is the page
 * that is measured.
 */

import type { BrowserPage } from "../browser.js";

/** Unrounded rect of an element, CSS px in document space. */
export interface MeasuredRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the measurement found for one requested selector. */
export interface SelectorMeasurement {
  /** How many elements the selector matched; 0 for no match and for an invalid selector. */
  matchCount: number;
  /** True when `querySelectorAll` threw — an invalid selector, including model-written prose. */
  invalid: boolean;
  /**
   * Identity of the first match within this measurement. Two selectors that
   * hit the same node report the same index, which is what lets their issues
   * share one mark.
   */
  elementIndex?: number;
  /** Geometry of the first match. */
  rect?: MeasuredRect;
  /** Whether the first match is rendered at all (display, visibility, opacity). */
  rendered?: boolean;
  /** Whether the first match or an ancestor is `position: fixed` or `sticky`. */
  anchored?: boolean;
  /**
   * Whether the first match is the document element or the body — the target
   * of page-level rules such as `page-has-heading-one` or `html-has-lang`,
   * which describe the page and not a box on it.
   */
  page?: boolean;
}

/** Everything the single measurement round trip returns. */
export interface PageMeasurement {
  /** One entry per requested selector, in request order. */
  selectors: SelectorMeasurement[];
  devicePixelRatio: number;
  viewport: { width: number; height: number };
  document: { width: number; height: number };
  scroll: { x: number; y: number };
}

/** Upper bound for the measurement round trip, independent of the audit timeout. */
export const MEASURE_TIMEOUT_MS = 10_000;

function isMeasuredRect(value: unknown): value is MeasuredRect {
  if (!value || typeof value !== "object") return false;
  const rect = value as Record<string, unknown>;
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height)
  );
}

function isSize(value: unknown): value is { width: number; height: number } {
  if (!value || typeof value !== "object") return false;
  const size = value as Record<string, unknown>;
  return Number.isFinite(size.width) && Number.isFinite(size.height);
}

function isPoint(value: unknown): value is { x: number; y: number } {
  if (!value || typeof value !== "object") return false;
  const point = value as Record<string, unknown>;
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

/**
 * Validates what came back from the browser. A page object that is not a real
 * browser page (or a page that returned something unexpected) must degrade to
 * the failure path instead of producing nonsense rects.
 */
export function isPageMeasurement(value: unknown): value is PageMeasurement {
  if (!value || typeof value !== "object") return false;
  const measurement = value as Record<string, unknown>;

  if (!Array.isArray(measurement.selectors)) return false;
  if (!Number.isFinite(measurement.devicePixelRatio)) return false;
  if (!isSize(measurement.viewport) || !isSize(measurement.document)) return false;
  if (!isPoint(measurement.scroll)) return false;

  return measurement.selectors.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const selector = entry as Record<string, unknown>;
    if (
      !Number.isInteger(selector.matchCount) ||
      (selector.matchCount as number) < 0 ||
      typeof selector.invalid !== "boolean"
    ) {
      return false;
    }
    if (
      !isOptionalBoolean(selector.rendered) ||
      !isOptionalBoolean(selector.anchored) ||
      !isOptionalBoolean(selector.page)
    ) {
      return false;
    }
    if (selector.rect === undefined) return true;
    if (!isMeasuredRect(selector.rect)) return false;
    // A rect without a usable element identity could not share a mark.
    return Number.isInteger(selector.elementIndex) && (selector.elementIndex as number) >= 0;
  });
}

/**
 * Measure the given selectors on the page. Rejects on a browser error and on
 * the timeout, following the `runAxe` pattern; the caller turns either into
 * all-unresolved annotations.
 */
export async function measureSelectors(
  page: BrowserPage,
  selectors: string[],
  options: { timeout?: number } = {}
): Promise<PageMeasurement> {
  const timeout = options.timeout
    ? Math.min(options.timeout, MEASURE_TIMEOUT_MS)
    : MEASURE_TIMEOUT_MS;

  const run = () =>
    page.evaluate((requested: string[]): PageMeasurement => {
      // NOTE: this runs in the browser via page.evaluate — it cannot
      // reference Node-scope constants or helpers, so everything it needs
      // is declared inside this function.

      /** Elements seen so far, so the same node keeps the same index. */
      const nodes: Element[] = [];

      type VisibilityCapable = Element & {
        checkVisibility?: (options?: {
          opacityProperty?: boolean;
          visibilityProperty?: boolean;
        }) => boolean;
      };

      const isRendered = (element: Element): boolean => {
        const candidate = element as VisibilityCapable;
        if (typeof candidate.checkVisibility === "function") {
          try {
            return candidate.checkVisibility({
              opacityProperty: true,
              visibilityProperty: true,
            });
          } catch {
            // Older engines reject the options bag; fall through to the walk.
          }
        }

        // visibility is inherited and a descendant can override it, so only
        // the element's own computed value counts; display and opacity hide
        // the whole subtree, so those are checked up the ancestor chain.
        const ownVisibility = getComputedStyle(element).visibility;
        if (ownVisibility === "hidden" || ownVisibility === "collapse") {
          return false;
        }

        let current: Element | null = element;
        while (current) {
          const style = getComputedStyle(current);
          if (style.display === "none" || Number(style.opacity) === 0) {
            return false;
          }
          current = current.parentElement;
        }
        return true;
      };

      const isAnchored = (element: Element): boolean => {
        let current: Element | null = element;
        while (current) {
          const position = getComputedStyle(current).position;
          if (position === "fixed" || position === "sticky") {
            return true;
          }
          current = current.parentElement;
        }
        return false;
      };

      const selectors = requested.map((selector) => {
        let matches: NodeListOf<Element>;
        try {
          matches = document.querySelectorAll(selector);
        } catch {
          return { matchCount: 0, invalid: true };
        }

        const first = matches[0];
        if (!first) {
          return { matchCount: 0, invalid: false };
        }

        let elementIndex = nodes.indexOf(first);
        if (elementIndex === -1) {
          elementIndex = nodes.length;
          nodes.push(first);
        }

        const box = first.getBoundingClientRect();

        return {
          matchCount: matches.length,
          invalid: false,
          elementIndex,
          rect: {
            x: box.left + window.scrollX,
            y: box.top + window.scrollY,
            width: box.width,
            height: box.height,
          },
          rendered: isRendered(first),
          anchored: isAnchored(first),
          page: first === document.documentElement || first === document.body,
        };
      });

      return {
        selectors,
        devicePixelRatio: window.devicePixelRatio,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        document: {
          width: document.documentElement.scrollWidth,
          height: document.documentElement.scrollHeight,
        },
        scroll: { x: window.scrollX, y: window.scrollY },
      };
    }, selectors);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`measurement timed out after ${timeout}ms`)),
          timeout
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
