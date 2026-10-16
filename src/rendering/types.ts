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

/**
 * One element whose paint the forced-colors check judges, as the in-page
 * measurement reports it under `forced-colors: active`. Not a text
 * candidate: an icon button carries no text at all, which is the whole
 * point, so these are gathered beside `elements` rather than in it.
 */
export interface RenderingPaintedElement {
  /** Identity within this measurement; what the mark numbering groups by. */
  index: number;
  selector: string;
  html: string;
  tag: string;
  role: string | null;
  /** Rect in CSS px in document space, like `RenderingElement.rect`. */
  rect: MeasuredRect;
  anchored: boolean;
  /** Computed `background-image`, bounded; `"none"` when there is none. */
  backgroundImage: string;
  /** A border side that paints: width above 0 and a style other than none. */
  border: boolean;
  /** Computed `forced-color-adjust`, which is an inherited property. */
  forcedColorAdjust: string;
  /**
   * Whether this element is where `forced-color-adjust: none` starts, rather
   * than a descendant that inherited it. The opt-out is one decision, made
   * at one element, and reported there: every element under it would
   * otherwise carry the same finding.
   */
  setsForcedColorAdjust: boolean;
  /** Whether the subtree holds any non-whitespace text. */
  hasContentText: boolean;
  /**
   * Whether the element itself is, or holds, replaced or vector content —
   * `img`, `svg`, `canvas`, `video`, `object`, an image input — which keeps
   * rendering under forced colours and is therefore not lost. The element
   * itself counts: a bordered, named `img` is not rendering the forced
   * palette takes away.
   */
  hasGraphic: boolean;
  /** `aria-hidden="true"` on the element or an ancestor: decorative. */
  ariaHidden: boolean;
  /** Whether the element is itself focusable or an interactive element. */
  interactive: boolean;
  /** Whether it carries `aria-label`, `aria-labelledby` or `title`. */
  named: boolean;
  /** Whether it is, or sits inside, a rendered link or button. */
  inControl: boolean;
}

/**
 * Everything that distinguishes one piece of text from another, as the
 * measurement computes it: the colours, and the cues that are not colour.
 *
 * Colours arrive normalised to `rgba(r, g, b, a)` — the measurement paints
 * the computed value on a canvas, so the browser resolves `oklch()`,
 * `lab()` and `color(srgb …)` itself and the pure check only ever parses
 * one syntax.
 */
export interface RenderingTextStyle {
  /** Painted text colour (`-webkit-text-fill-color`, else `color`). */
  color: string;
  /** The opaque colour painted behind the text, `rgb(r, g, b)`. */
  background: string;
  /**
   * Whether an image or gradient is painted behind the text, in which case
   * `background` is not what is on the screen and no colour judgement is
   * possible — the same case axe reports as `incomplete`.
   */
  backgroundImage: boolean;
  /** Computed `text-decoration-line`, e.g. `"none"` or `"underline"`. */
  decoration: string;
  /** A border side that paints: width above 0 and a style that draws. */
  border: boolean;
  /** `box-shadow` other than `none` — the box-shadow underline. */
  boxShadow: boolean;
  /** Computed `font-weight` as a number. */
  fontWeight: number;
  /** Computed `font-style`. */
  fontStyle: string;
}

/**
 * One link inside a text block, with the surrounding text it has to be
 * distinguishable from (WCAG 1.4.1, the link-in-text-block technique).
 * `surrounding` is the block the link sits in: the element whose own text
 * runs alongside the link, which is the colour a reader compares against.
 */
export interface RenderingLink {
  /** Identity within this measurement; what the mark numbering groups by. */
  index: number;
  selector: string;
  html: string;
  tag: string;
  /** Rect in CSS px in document space, like `RenderingElement.rect`. */
  rect: MeasuredRect;
  anchored: boolean;
  /** The link's own text, trimmed and bounded. */
  text: string;
  /** The block whose other text surrounds the link. */
  blockSelector: string;
  link: RenderingTextStyle;
  surrounding: RenderingTextStyle;
}

/** The states whose visual cue the colour check judges. */
export type RenderingStateName = "aria-invalid" | "aria-selected" | "aria-current" | "required";

/**
 * What the state check compares between a stateful element and a sibling of
 * the same kind without the state. Colours are normalised like
 * `RenderingTextStyle`; everything else is a cue that is not colour, and one
 * of them differing is enough for the state not to be conveyed by colour
 * alone.
 */
export interface RenderingStateStyle {
  /** Unique CSS path of the element these values were read from. */
  selector: string;
  /** Rect in CSS px in document space. */
  rect: MeasuredRect;
  /**
   * The colour the foreground paints, `rgba(r, g, b, a)`, and `""` when it
   * paints nothing a reader sees: an empty box's `color`, or one whose icon
   * carries a fill of its own, is a value nobody is shown and no cue. Read
   * from the element the visible text sits in, so a label in a `span` with
   * its own colour is that colour.
   */
  color: string;
  /**
   * The opaque colour the element's box paints, `rgb(r, g, b)`: its own
   * `background-color` composited over what is behind it, so a transparent
   * background is the colour that shows through it — which is what a reader
   * compares the other side's background with.
   */
  background: string;
  /**
   * Whether an image or gradient is painted on or behind the element, in
   * which case its colours are not what is on the screen.
   */
  backgroundImage: boolean;
  /** Colour of the widest painted border side; `""` when none paints. */
  borderColor: string;
  /** The four border widths — a shape cue, not a colour one. */
  borderWidths: string;
  /** Whether an outline paints. */
  outline: boolean;
  /** Computed `text-decoration-line`. */
  decoration: string;
  fontWeight: number;
  fontStyle: string;
  fontFamily: string;
  fontSize: number;
  /**
   * The text a reader can see, trimmed and bounded: text inside a child the
   * page hides (`display: none`, the screen-reader-only 1 px box) is not a
   * visual cue and is left out. A marker word like "(selected)" is in here,
   * which is why the two sides' texts have to match for the state to be
   * carried by colour alone.
   */
  text: string;
  /** Whether `text` hit its bound, so the two sides cannot be compared. */
  textTruncated: boolean;
  /** Element children; an icon or a marker span changes the count. */
  childElements: number;
  /**
   * A signature of the replaced and vector content it holds, in document
   * order: the tag plus the `src` of an image or a short hash of an SVG's
   * markup, so a tick and a cross are two different graphics rather than
   * two graphics. `""` when it holds none.
   */
  graphics: string;
  /**
   * Whether every graphic in `graphics` could be identified. A `canvas`
   * paints what no attribute says, so two of them cannot be told apart and
   * the pair is not judged at all.
   */
  graphicsReadable: boolean;
  /** `::before` and `::after` `content`, joined — the pseudo-element cue. */
  pseudoContent: string;
}

/**
 * One element carrying a state, paired with the sibling of the same kind
 * that does not carry it: the only comparison that can say whether the state
 * is visible at all, and whether anything but colour carries it.
 */
export interface RenderingStatePair {
  /** Identity within this measurement; what the mark numbering groups by. */
  index: number;
  html: string;
  tag: string;
  role: string | null;
  anchored: boolean;
  state: RenderingStateName;
  /** The attribute's value, e.g. `"true"` or `"page"`; `""` for `required`. */
  stateValue: string;
  element: RenderingStateStyle;
  sibling: RenderingStateStyle;
}

/**
 * One entry of `document.getAnimations()` under the condition, resolved to
 * the element it animates.
 */
export interface RenderingAnimation {
  /** Identity within this measurement; what the mark numbering groups by. */
  index: number;
  /** The animated element, when the effect has one. */
  selector: string | null;
  html?: string;
  tag?: string;
  rect?: MeasuredRect;
  anchored?: boolean;
  /** `animation-name`, transition property, or the animation's id. */
  name: string;
  /** `"running"`, `"paused"`, `"finished"` or `"idle"`. */
  playState: string;
  /** -1 stands for an infinite count: JSON cannot carry `Infinity`. */
  iterations: number;
  /** Iteration duration in ms; 0 when the effect reports `"auto"`. */
  durationMs: number;
  /**
   * Identity of the nearest element above this one that is animated too, or
   * -1. An SVG spinner animates the `svg` and the `circle` in it; that is
   * one thing moving, and the check reports the outermost of them.
   */
  parentIndex: number;
}

/** Markup that moves by itself, which no media query can stop. */
export interface RenderingMotionElement {
  index: number;
  kind: "video-autoplay" | "marquee";
  selector: string;
  html: string;
  tag: string;
  rect: MeasuredRect;
  anchored: boolean;
}

/** What the motion check reads: the animations and the self-moving markup. */
export interface RenderingMotion {
  animations: RenderingAnimation[];
  elements: RenderingMotionElement[];
  /**
   * Whether the collection dropped running animations or self-moving
   * elements it was eligible to carry, so the group is partial.
   */
  truncated?: boolean;
}

/** One node of one axe rule, as the condition's axe run reported it. */
export interface RenderingAxeNode {
  /**
   * The axe target, flattened the way the engine pass flattens it, so the
   * baseline lookup compares like with like.
   */
  selector: string;
  html: string;
  failureSummary?: string;
  impact: IssueSeverity;
  /** Identity within this measurement; what the mark numbering groups by. */
  index: number;
  /** Rect in CSS px in document space; absent when the node had no element. */
  rect?: MeasuredRect;
  anchored?: boolean;
  /**
   * Whether the engine pass already reported this rule on this element. A
   * mode-specific check reports what the mode added, and this is how it
   * knows; set by the collection, so the check stays a pure function of the
   * data it is handed.
   */
  inBaseline: boolean;
  /**
   * Whether axe measured a text colour the browser does not paint: the
   * element's computed `color` and `-webkit-text-fill-color` disagree *and*
   * the element is subject to forced-colour adjustment. Axe reads the fill
   * colour in preference to `color`, and under `forced-colors: active`
   * Chromium forces `color` and paints with it but leaves the fill colour at
   * the author's value — so axe's contrast numbers are about a colour that
   * is nowhere on the screen. An element that opted out of the forced
   * palette (`forced-color-adjust: none`, its own or inherited) keeps both
   * author values, so its mismatch is the author's and axe's numbers are
   * about what is painted: it is never flagged here.
   */
  textFillMismatch?: boolean;
}

/** One rule's results under the condition, violations and incomplete apart. */
export interface RenderingAxeResult {
  /** The axe rule id, e.g. `"target-size"`. */
  id: string;
  /** Whether axe failed the nodes or could not decide about them. */
  outcome: "violation" | "incomplete";
  description: string;
  help: string;
  helpUrl: string;
  impact: IssueSeverity;
  nodes: RenderingAxeNode[];
  /**
   * Whether the rule had more nodes a check could report than the run
   * carries. The baseline's own nodes are dropped before the cap applies, so
   * this is about findings the condition introduced and nothing else.
   */
  truncated?: boolean;
}

/** Everything the condition's axe run returned. */
export interface RenderingAxeRun {
  /** The rules it was restricted to. */
  rules: string[];
  results: RenderingAxeResult[];
  /** Whether any rule hit the node cap, so its findings are partial. */
  truncated?: boolean;
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
  /** Only when `collect.forcedColors` asked for it. */
  painted?: RenderingPaintedElement[];
  /**
   * Whether the forced-colours collection dropped elements it was eligible
   * to carry, so that group is partial. Apart from `truncated`, which is
   * the element walk: a check that reads one group must not be told the
   * other one stopped early.
   */
  paintedTruncated?: boolean;
  /**
   * Whether the ancestor-box collection hit its cap, so some hidden regions
   * fall back to their members' union box and an identity of their own.
   */
  ancestorsTruncated?: boolean;
  /** Only when `collect.motion` asked for it. */
  motion?: RenderingMotion;
  /** Only when `collect.links` asked for it. */
  links?: RenderingLink[];
  /** Whether the link collection hit its cap, so that group is partial. */
  linksTruncated?: boolean;
  /** Only when `collect.states` asked for it. */
  states?: RenderingStatePair[];
  /** Whether the state collection hit its cap, so that group is partial. */
  statesTruncated?: boolean;
  /** Only when `collect.axeRules` asked for rules. */
  axe?: RenderingAxeRun;
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
  /** Paint, text and naming of the elements the forced-colours check judges. */
  forcedColors?: boolean;
  /** Running animations, autoplaying video and `<marquee>`. */
  motion?: boolean;
  /** Links inside a text block, with the colours and cues of both. */
  links?: boolean;
  /** Stateful elements paired with a sibling of the same kind without the state. */
  states?: boolean;
  /**
   * Axe rules to run under this condition, on top of the measurement. Axe is
   * already on the page from the engine pass and is re-injected only when it
   * is not; the run is restricted to these rules, and its cost counts
   * against the condition's own budget like every other step.
   */
  axeRules?: string[];
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

/**
 * The runner's cancellation token, as a step that takes one sees it. The
 * runner owns the clock: a step that spans several browser operations asks
 * before each of them, so a condition the runner has abandoned cannot reach
 * the page again.
 */
export interface ConditionCancellation {
  /** Throws when the condition has been abandoned. */
  check(): void;
}

interface RenderingCheckBase {
  id: string;
  collect: RenderingCollect;
}

/**
 * How a check says its own finding cap dropped results it was eligible to
 * report. The runner rolls this into `truncatedConditions` and its warning,
 * so a partial result is never presented as the whole picture.
 *
 * A side channel rather than part of the return value: the findings stay a
 * pure function of the measurement, and a check that reports everything it
 * found says nothing at all.
 */
export type RenderingTruncationReport = () => void;

/** A check that runs on the measurement of a single condition. */
export interface PerConditionCheck extends RenderingCheckBase {
  kind: "per-condition";
  /** Whether the check runs under this condition. */
  appliesTo(condition: RenderingCondition): boolean;
  evaluate(input: {
    condition: RenderingCondition;
    measurement: RenderingMeasurement;
    /** Called when the check's finding cap dropped an eligible result. */
    onTruncated?: RenderingTruncationReport;
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
    /** Called when the check's finding cap dropped an eligible result. */
    onTruncated?: RenderingTruncationReport;
  }): RenderingFinding[];
}

export type RenderingCheck = PerConditionCheck | CrossConditionCheck;
