/**
 * Data model of the rendering pass.
 *
 * The public types a caller sees (`RenderingCapture`, `RenderingIssueMeta`,
 * `RenderingOptions`, `RenderingMeta`) live in `src/types.ts` next to
 * `Issue`; what is here is the pass's own vocabulary: the conditions, the
 * measurement one `page.evaluate` returns, and the shape of a check.
 */

import type { MeasuredRect } from "../annotate/index.js";
import type { IssueSeverity, RenderingConditionId } from "../types.js";

/** Vision deficiencies Chromium can emulate, in CDP's spelling. */
export type VisionDeficiency =
  | "none"
  | "protanopia"
  | "deuteranopia"
  | "tritanopia"
  | "achromatopsia"
  | "reducedContrast"
  | "blurredVision";

/** Media features a condition can override. Omitted means "no override". */
export interface MediaFeatures {
  colorScheme?: "light" | "dark";
  forcedColors?: "active" | "none";
  prefersContrast?: "more" | "no-preference";
  reducedMotion?: "reduce" | "no-preference";
}

/** Browser capabilities a condition needs to be applied at all. */
export type RenderingCapabilityName = "viewport" | "media" | "visionDeficiency";

/** A named, reversible change to how the page is rendered. */
export interface RenderingCondition {
  id: RenderingConditionId;
  /** The ids this condition is composed of, in application order. */
  parts: RenderingConditionId[];
  viewport?: { width: number; height: number };
  media?: MediaFeatures;
  visionDeficiency?: Exclude<VisionDeficiency, "none">;
  /** Inject the WCAG 1.4.12 text-spacing override. */
  textSpacing?: boolean;
}

/** Scroll vs client box and the styles that decide whether text is clipped. */
export interface ElementClipping {
  overflowX: string;
  overflowY: string;
  textOverflow: string;
  whiteSpace: string;
  /** Used computed `line-height` in px; 0 when the browser reports `normal`. */
  lineHeight: number;
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
}

/** One candidate element, as the in-page measurement reports it. */
export interface RenderingElement {
  /** Identity within this measurement; what the mark numbering groups by. */
  index: number;
  /** Unique CSS path, also the key that matches the element across conditions. */
  selector: string;
  /** The element's opening tag, bounded. */
  html: string;
  /** Lowercase tag name. */
  tag: string;
  /** Explicit `role` attribute, trimmed and lowercased; null when absent. */
  role: string | null;
  /** The element's own text nodes, trimmed and bounded. */
  text: string;
  /** Rect in CSS px in document space, origin at the top-left of the capture. */
  rect: MeasuredRect;
  /** Whether the element has non-whitespace text in a direct child text node. */
  hasText: boolean;
  /** Whether the element's subtree contains non-whitespace text at all. */
  hasContentText: boolean;
  /**
   * Whether the element is visibly rendered with a box of at least two CSS
   * px in both directions that lies on the page — the rule `src/annotate/`
   * uses, so neither the screen-reader-only pattern nor the off-canvas one
   * (`left: -1000px` skip links) counts as rendered text.
   */
  rendered: boolean;
  /** Whether the element or an ancestor is `position: fixed` or `sticky`. */
  anchored: boolean;
  /**
   * Whether the element is part of content that requires two-dimensional
   * layout, by element type and role (WCAG 1.4.10 exemption).
   */
  exempt: boolean;
  /** Whether an ancestor clips horizontal overflow, so overflow is not reachable. */
  clipped: boolean;
  /** Nearest ancestor that is also a candidate, or -1. */
  parentIndex: number;
  /**
   * Whether a control can bring this element's content back: it is inside a
   * `nav` (and the page has a visible disclosure control, or the `nav` has a
   * visible control of its own), is (or is inside) the `aria-controls`
   * target of a visible control, or is inside a closed `details` with a
   * visible `summary` — the disclosure exemption.
   */
  revealable: boolean;
  /**
   * Whether the nearest link or button this element is part of — itself
   * included — is visibly rendered at this condition. A label hidden inside
   * a control that stays is not content the layout lost: the control keeps
   * its function and its accessible name.
   */
  inRenderedControl: boolean;
  /**
   * When the element is not `rendered`: the topmost ancestor (itself
   * included) that is not rendered either — the region it disappeared with.
   * Several hidden text elements in one region share this, which is what
   * makes them one finding instead of one per element.
   */
  hiddenRegion?: { selector: string; html: string; tag: string };
  /** Only when `collect.clipping` asked for it. */
  clipping?: ElementClipping;
  /** Id of the element's stacking context; only when `collect.stacking`. */
  stackingContext?: number;
  /**
   * How many boxes the element is laid out as; only when `collect.stacking`.
   * An inline element that wraps has one box per line, and `rect` is their
   * union — a rectangle the element does not occupy, which two of them can
   * appear to share without anything being drawn on top of anything.
   */
  fragments?: number;
  /**
   * Those boxes, when there is more than one and few enough to carry. An
   * element with more boxes than that has none here and is left out of the
   * overlap check, since its union rect cannot answer the question.
   */
  boxes?: MeasuredRect[];
}

/**
 * The box of one ancestor of a candidate element, measured in the same walk.
 * What a cross-condition check needs to report a region by its own geometry
 * and its own identity: the region a narrow layout hides is named by the
 * narrow measurement, and the box it occupies is only in the wide one, where
 * the region itself is usually not a candidate at all.
 */
export interface RenderingAncestor {
  /**
   * Identity within this measurement, continuing the element numbering, so a
   * finding on the ancestor never shares a mark with one on a member.
   */
  index: number;
  /** Unique CSS path, the key that matches the `hiddenRegion` of a member. */
  selector: string;
  /** Rect in CSS px in document space, like `RenderingElement.rect`. */
  rect: MeasuredRect;
}

/** Everything the single measurement round trip of one condition returns. */
export interface RenderingMeasurement {
  elements: RenderingElement[];
  /** True when the element walk hit its cap, so findings may be incomplete. */
  truncated: boolean;
  devicePixelRatio: number;
  viewport: { width: number; height: number };
  /** `documentElement` scroll size, CSS px. */
  document: { width: number; height: number };
  /** `documentElement` client box, CSS px — the viewport minus scrollbars. */
  client: { width: number; height: number };
  scroll: { x: number; y: number };
  /** Only when `collect.ancestors` asked for it. */
  ancestors?: RenderingAncestor[];
}

/**
 * What a check needs the one `page.evaluate` of its condition to gather. The
 * runner unions the descriptors of the checks active under that condition;
 * every optional group costs a per-element layout or style read, so a
 * condition only pays for what its checks read.
 */
export interface RenderingCollect {
  /**
   * Rect, text, rendered state and exemptions of the candidate elements.
   * Every check needs this; a condition that only produces a capture does
   * not, and then only the page-level numbers are gathered.
   */
  elements: boolean;
  /** Scroll vs client box and the overflow styles. */
  clipping?: boolean;
  /** Stacking-context identity and box count, for pairwise overlap. */
  stacking?: boolean;
  /**
   * Boxes and identities of the ancestors of the text candidates, for a
   * check that reports a region rather than an element.
   */
  ancestors?: boolean;
}

/** One rendering finding, before it becomes an `Issue`. */
export interface RenderingFinding {
  checkId: string;
  impact: IssueSeverity;
  /** Rule-level description, the same for every finding of the check. */
  description: string;
  /** Rule-level remediation summary. */
  help: string;
  helpUrl: string;
  /** What is wrong with this element, with the numbers in words. */
  failureSummary: string;
  selector: string | null;
  html?: string;
  /**
   * The element's own rect from the measurement, in the condition's capture
   * space; omitted when there is none to draw. One rect per element, never a
   * finding-specific one: several findings on one element share a mark, and a
   * mark has one number and one place. Geometry that belongs to the finding
   * rather than to the element — the intersection of an overlap — goes into
   * `evidence`.
   */
  rect?: MeasuredRect;
  /** Element identity, so findings on one element share a mark. */
  elementIndex?: number;
  anchored?: boolean;
  /** The issue is about the page itself, so there is nothing to box. */
  pageLevel?: boolean;
  evidence: Record<string, number | string | boolean>;
}

interface RenderingCheckBase {
  id: string;
  collect: RenderingCollect;
}

/** A check that runs on the measurement of a single condition. */
export interface PerConditionCheck extends RenderingCheckBase {
  kind: "per-condition";
  /** Whether the check runs under this condition. */
  appliesTo(condition: RenderingCondition): boolean;
  evaluate(input: {
    condition: RenderingCondition;
    measurement: RenderingMeasurement;
  }): RenderingFinding[];
}

/**
 * A check that compares two conditions. Its findings are reported under, and
 * drawn on the capture of, `reportsUnder`; `comparesWith` only supplies the
 * second measurement. The check runs only when both conditions ran.
 */
export interface CrossConditionCheck extends RenderingCheckBase {
  kind: "cross-condition";
  reportsUnder: RenderingConditionId;
  comparesWith: RenderingConditionId;
  evaluate(input: {
    condition: RenderingCondition;
    measurement: RenderingMeasurement;
    reference: RenderingMeasurement;
  }): RenderingFinding[];
}

export type RenderingCheck = PerConditionCheck | CrossConditionCheck;
