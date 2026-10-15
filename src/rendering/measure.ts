/**
 * In-page measurement of one rendering condition.
 *
 * One `page.evaluate` per condition gathers the union of what the checks
 * active under that condition need: the candidate elements with their rects,
 * text, rendered state and exemptions, plus the two optional groups
 * (`clipping`, `stacking`) and the page-level numbers the capture geometry
 * needs. The walk is read-only apart from nothing at all: no scroll, no
 * focus, no mutation.
 *
 * Checks never touch the browser, so everything they decide from has to be
 * in here.
 */

import { MIN_VISIBLE_SIZE_PX } from "../annotate/index.js";
import type { BrowserPage } from "../browser.js";
import type {
  RenderingAncestor,
  RenderingCollect,
  RenderingElement,
  RenderingMeasurement,
} from "./types.js";

/** Upper bound for the measurement round trip, independent of the audit timeout. */
export const MEASURE_TIMEOUT_MS = 10_000;

/** Never report more candidates than this; a huge page would blow up the payload. */
export const MAX_CANDIDATES = 1_200;

/** Bounds for the two strings each candidate carries. */
const TEXT_LIMIT = 120;
const HTML_LIMIT = 200;

/**
 * Most line boxes a wrapped inline element may carry individually. Past it
 * the element is left to its union rect, and the overlap check ignores it.
 */
const MAX_FRAGMENTS = 8;

/** Everything the in-page function needs; it cannot see Node scope. */
interface MeasureArgs {
  collect: RenderingCollect;
  maxCandidates: number;
  textLimit: number;
  htmlLimit: number;
  /** Below this, in CSS px, a box is the screen-reader-only pattern. */
  minVisiblePx: number;
  /** Most line boxes a wrapped element carries individually. */
  maxFragments: number;
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

function isElement(value: unknown): value is RenderingElement {
  if (!value || typeof value !== "object") return false;
  const element = value as Record<string, unknown>;
  if (!Number.isInteger(element.index) || typeof element.selector !== "string") return false;
  if (typeof element.tag !== "string" || typeof element.text !== "string") return false;
  if (!isSize(element.rect) || !isPoint(element.rect)) return false;
  return (
    typeof element.hasText === "boolean" &&
    typeof element.rendered === "boolean" &&
    typeof element.exempt === "boolean"
  );
}

function isAncestor(value: unknown): value is RenderingAncestor {
  if (!value || typeof value !== "object") return false;
  const ancestor = value as Record<string, unknown>;
  if (!Number.isInteger(ancestor.index) || typeof ancestor.selector !== "string") return false;
  return isSize(ancestor.rect) && isPoint(ancestor.rect);
}

/**
 * Validates what came back from the browser. A page object that is not a real
 * browser page (or one that returned something unexpected) must degrade to
 * the failure path instead of producing nonsense findings.
 */
export function isRenderingMeasurement(value: unknown): value is RenderingMeasurement {
  if (!value || typeof value !== "object") return false;
  const measurement = value as Record<string, unknown>;
  if (!Array.isArray(measurement.elements)) return false;
  if (!Number.isFinite(measurement.devicePixelRatio)) return false;
  if (!isSize(measurement.viewport) || !isSize(measurement.document)) return false;
  if (!isSize(measurement.client) || !isPoint(measurement.scroll)) return false;
  if (measurement.ancestors !== undefined) {
    if (!Array.isArray(measurement.ancestors)) return false;
    if (!measurement.ancestors.every(isAncestor)) return false;
  }
  return measurement.elements.every(isElement);
}

/**
 * Measure the page as it is rendered right now. Rejects on a browser error
 * and on the timeout, following the `runAxe` pattern; the caller turns either
 * into a skipped condition.
 */
export async function measureRendering(
  page: BrowserPage,
  collect: RenderingCollect,
  options: { timeout?: number } = {}
): Promise<RenderingMeasurement> {
  const timeout = options.timeout
    ? Math.min(options.timeout, MEASURE_TIMEOUT_MS)
    : MEASURE_TIMEOUT_MS;

  const args: MeasureArgs = {
    collect,
    maxCandidates: MAX_CANDIDATES,
    textLimit: TEXT_LIMIT,
    htmlLimit: HTML_LIMIT,
    minVisiblePx: MIN_VISIBLE_SIZE_PX,
    maxFragments: MAX_FRAGMENTS,
  };

  const run = () =>
    page.evaluate((input: MeasureArgs): RenderingMeasurement => {
      // NOTE: this runs in the browser via page.evaluate — it cannot
      // reference Node-scope constants or helpers, so everything it needs is
      // declared inside this function.

      /**
       * Content that requires two-dimensional layout for usage or meaning,
       * by element type and role: the WCAG 1.4.10 exemption, applied as an
       * explicit list and never as a heuristic on text content.
       */
      const exemptTags = [
        "table",
        "caption",
        "thead",
        "tbody",
        "tfoot",
        "tr",
        "td",
        "th",
        "colgroup",
        "col",
        "svg",
        "math",
        "canvas",
        "video",
        "iframe",
        "object",
        "embed",
        "textarea",
        "map",
        "area",
      ];
      const exemptRoles = [
        "table",
        "grid",
        "treegrid",
        "row",
        "rowgroup",
        "cell",
        "gridcell",
        "columnheader",
        "rowheader",
        "toolbar",
        "menubar",
        "application",
        "textbox",
      ];
      /** Never walked into: they render nothing. */
      const skipTags = ["script", "style", "noscript", "template", "link", "meta", "title"];

      type VisibilityCapable = Element & {
        checkVisibility?: (options?: {
          opacityProperty?: boolean;
          visibilityProperty?: boolean;
          contentVisibilityAuto?: boolean;
        }) => boolean;
      };

      const isVisible = (element: Element, own: CSSStyleDeclaration): boolean => {
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
        if (own.visibility === "hidden" || own.visibility === "collapse") return false;
        let current: Element | null = element;
        while (current) {
          const style = getComputedStyle(current);
          if (style.display === "none" || Number(style.opacity) === 0) return false;
          current = current.parentElement;
        }
        return true;
      };

      const cssEscape = (value: string): string =>
        typeof CSS !== "undefined" && typeof CSS.escape === "function"
          ? CSS.escape(value)
          : value.replace(/[^\w-]/g, "\\$&");

      /** Unique path, shortened at a unique id; also the cross-condition key. */
      const cssPath = (element: Element): string => {
        const parts: string[] = [];
        let node: Element | null = element;
        while (node && parts.length < 20) {
          const id = node.id;
          if (id && document.querySelectorAll(`#${cssEscape(id)}`).length === 1) {
            parts.unshift(`#${cssEscape(id)}`);
            return parts.join(" > ");
          }
          const parent: Element | null = node.parentElement;
          if (!parent) {
            parts.unshift(node.tagName.toLowerCase());
            return parts.join(" > ");
          }
          const position = Array.prototype.indexOf.call(parent.children, node) + 1;
          parts.unshift(`${node.tagName.toLowerCase()}:nth-child(${position})`);
          node = parent;
        }
        return parts.join(" > ");
      };

      /** The opening tag only: serialising a whole subtree is not worth it. */
      const openingTag = (element: Element): string => {
        let out = `<${element.tagName.toLowerCase()}`;
        for (const attribute of Array.from(element.attributes)) {
          out += ` ${attribute.name}="${attribute.value}"`;
          if (out.length > input.htmlLimit) break;
        }
        return `${out.slice(0, input.htmlLimit)}>`;
      };

      const directText = (element: Element): string => {
        let text = "";
        for (const node of Array.from(element.childNodes)) {
          if (node.nodeType === 3) text += node.nodeValue ?? "";
        }
        return text.replace(/\s+/g, " ").trim().slice(0, input.textLimit);
      };

      const clipsOverflow = (value: string): boolean => value === "hidden" || value === "clip";

      const formsStackingContext = (element: Element, style: CSSStyleDeclaration): boolean => {
        if (element === document.documentElement) return true;
        if (style.position === "fixed" || style.position === "sticky") return true;
        if (style.position !== "static" && style.zIndex !== "auto") return true;
        if (Number(style.opacity) < 1) return true;
        if (style.transform !== "none" || style.filter !== "none") return true;
        if (style.perspective !== "none" || style.isolation === "isolate") return true;
        if (style.mixBlendMode !== "normal") return true;
        if (style.willChange.includes("transform") || style.willChange.includes("opacity")) {
          return true;
        }
        return /paint|layout|strict|content/.test(style.contain);
      };

      /** A control the user can see and operate right now. */
      const isControlVisible = (control: Element): boolean => {
        const box = control.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && isVisible(control, getComputedStyle(control));
      };

      /**
       * The elements whose content a control can bring back — the disclosure
       * exemption of `content-hidden-at-viewport`, as the contract spells it
       * out. Three structures qualify, and everything inside them:
       *
       * - a `nav` (element or role), when the page has a visible disclosure
       *   control — an element with `aria-expanded` or `aria-controls` —
       *   anywhere, or the `nav` has a visible control of its own: the
       *   hamburger button and the menu it collapses. The common hamburger
       *   sits in the `header` next to the `nav` rather than inside it and
       *   names no `aria-controls` target, so requiring the control to be
       *   inside the `nav` reported whole main menus as lost content.
       * - the target of a visible control's `aria-controls`: the collapsed
       *   panel a button outside the `nav` opens;
       * - a closed `details` whose `summary` is visible.
       *
       * Only navigation regions get the page-wide rule. A region is never
       * exempt for merely containing some control, and no other region is
       * exempt for a control elsewhere on the page: a `header` with a search
       * button cannot reveal the opening hours next to it, and claiming
       * otherwise exempted every hidden thing in it.
       */
      const disclosureRoots = new Set<Element>();
      if (input.collect.elements) {
        const pageHasDisclosureControl = Array.from(
          document.querySelectorAll("[aria-expanded], [aria-controls]")
        ).some(isControlVisible);

        for (const nav of Array.from(document.querySelectorAll('nav, [role="navigation"]'))) {
          if (pageHasDisclosureControl) {
            disclosureRoots.add(nav);
            continue;
          }
          const controls = nav.querySelectorAll(
            'button, summary, [role="button"], [aria-expanded], input[type="checkbox"], label'
          );
          if (Array.from(controls).some(isControlVisible)) disclosureRoots.add(nav);
        }

        for (const control of Array.from(document.querySelectorAll("[aria-controls]"))) {
          if (!isControlVisible(control)) continue;
          for (const id of (control.getAttribute("aria-controls") ?? "").split(/\s+/)) {
            const target = id === "" ? null : document.getElementById(id);
            if (target) disclosureRoots.add(target);
          }
        }

        for (const details of Array.from(document.querySelectorAll("details:not([open])"))) {
          const summary = details.querySelector("summary");
          if (summary && isControlVisible(summary)) disclosureRoots.add(details);
        }
      }

      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const client = {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
      };
      // The page's own box, which is also the box of the full-page capture:
      // an element outside it is not on the page at all.
      const pageBox = {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      };
      const scrollX = window.scrollX;
      const scrollY = window.scrollY;

      /** The element's box in document space, the origin of the capture. */
      const rectOf = (element: Element) => {
        const box = element.getBoundingClientRect();
        return {
          x: box.left + scrollX,
          y: box.top + scrollY,
          width: box.width,
          height: box.height,
        };
      };

      /**
       * The `rendered` rule, for any element and not only a candidate: the
       * control a hidden label belongs to carries no text of its own and is
       * asked about all the same. Memoised, because a control that is a
       * candidate itself asks twice.
       *
       * It is the rule the annotation map applies: a box thinner or shorter
       * than `minVisiblePx` is the screen-reader-only pattern
       * (`width: 1px; height: 1px; overflow: hidden`), and a box that does
       * not reach the page is the off-canvas one (`left: -1000px` skip
       * links, which `checkVisibility` still calls visible). Neither is
       * clipped text, content a viewport made disappear, or something a
       * marker can point at. The page box is the one `clipRect` intersects
       * against, and it grows with an element that overflows to the right —
       * which is exactly what the reflow check looks for — unless an
       * ancestor clips that overflow away, and then it is not reachable
       * either.
       */
      const renderedMemo = new Map<Element, boolean>();
      const isRenderedBox = (
        element: Element,
        rect: { x: number; y: number; width: number; height: number },
        style: CSSStyleDeclaration
      ): boolean => {
        const cached = renderedMemo.get(element);
        if (cached !== undefined) return cached;
        const value =
          rect.width >= input.minVisiblePx &&
          rect.height >= input.minVisiblePx &&
          rect.x + rect.width > 0 &&
          rect.y + rect.height > 0 &&
          rect.x < pageBox.width &&
          rect.y < pageBox.height &&
          isVisible(element, style);
        renderedMemo.set(element, value);
        return value;
      };

      /**
       * Whether this element is why its content is not rendered: it is
       * `display: none`, `visibility: hidden` or fully transparent, or its
       * own box is gone in both directions.
       *
       * A wrapper that merely collapsed to zero height around children that
       * are gone keeps the width of its container, and is the consequence
       * rather than the cause — naming it as the hidden region would point
       * at a `header` where a menu disappeared.
       */
      const hidesMemo = new Map<Element, boolean>();
      const hidesOwnContent = (element: Element): boolean => {
        const cached = hidesMemo.get(element);
        if (cached !== undefined) return cached;
        const style = getComputedStyle(element);
        let value =
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse" ||
          Number(style.opacity) === 0;
        if (!value) {
          const rect = rectOf(element);
          value = rect.width < input.minVisiblePx && rect.height < input.minVisiblePx;
        }
        hidesMemo.set(element, value);
        return value;
      };

      /**
       * The region a hidden element disappeared with: the topmost ancestor,
       * itself included, that hides its own content. Several hidden text
       * elements share it, and reporting it once is what keeps a collapsed
       * menu one finding instead of one per link.
       */
      const regionMemo = new Map<Element, { selector: string; html: string; tag: string }>();
      const hiddenRegionOf = (element: Element) => {
        let root = element;
        let parent = element.parentElement;
        while (parent && parent !== document.documentElement && hidesOwnContent(parent)) {
          root = parent;
          parent = parent.parentElement;
        }
        const cached = regionMemo.get(root);
        if (cached) return cached;
        const region = {
          selector: cssPath(root),
          html: openingTag(root),
          tag: root.tagName.toLowerCase(),
        };
        regionMemo.set(root, region);
        return region;
      };

      /** A link or button, the controls a hidden label can belong to. */
      const isControl = (element: Element, tag: string, role: string): boolean =>
        tag === "button" ||
        tag === "summary" ||
        (tag === "a" && element.hasAttribute("href")) ||
        role === "button" ||
        role === "link";

      const elements: RenderingElement[] = [];
      /**
       * Boxes of the ancestors of the text candidates, measured in this same
       * walk. The region a narrow layout hides is named by the narrow
       * measurement, and its box lives here: at the wide viewport that
       * ancestor usually carries no text of its own and is no candidate, so
       * without this a finding about it could only borrow a member's
       * geometry and a member's identity.
       */
      const ancestorBoxes: { selector: string; rect: ReturnType<typeof rectOf> }[] = [];
      const ancestorSeen = new Set<Element>();
      const registerAncestors = (element: Element): void => {
        let parent = element.parentElement;
        while (parent && parent !== document.documentElement) {
          // Registered already, and so is everything above it.
          if (ancestorSeen.has(parent)) return;
          if (ancestorBoxes.length >= input.maxCandidates) return;
          ancestorSeen.add(parent);
          ancestorBoxes.push({ selector: cssPath(parent), rect: rectOf(parent) });
          parent = parent.parentElement;
        }
      };
      const candidateIndex = new Map<Element, number>();
      /** Inherited state, filled top-down: querySelectorAll is in document order. */
      const inheritedExempt = new Map<Element, boolean>();
      const inheritedAnchored = new Map<Element, boolean>();
      const inheritedClipped = new Map<Element, boolean>();
      const inheritedRevealable = new Map<Element, boolean>();
      const inheritedControlRendered = new Map<Element, boolean>();
      const childContext = new Map<Element, number>();
      let nextContextId = 0;
      let truncated = false;

      const all =
        input.collect.elements && document.body ? document.body.querySelectorAll("*") : [];

      for (const element of Array.from(all)) {
        const tag = element.tagName.toLowerCase();
        if (skipTags.includes(tag)) continue;

        const parent = element.parentElement;
        const style = getComputedStyle(element);
        const role = (element.getAttribute("role") ?? "").trim().toLowerCase();

        const parentExempt = parent ? inheritedExempt.get(parent) === true : false;
        const exempt =
          parentExempt ||
          exemptTags.includes(tag) ||
          (role !== "" && exemptRoles.includes(role)) ||
          element.getAttribute("contenteditable") === "" ||
          element.getAttribute("contenteditable") === "true";
        inheritedExempt.set(element, exempt);

        const anchored =
          (parent ? inheritedAnchored.get(parent) === true : false) ||
          style.position === "fixed" ||
          style.position === "sticky";
        inheritedAnchored.set(element, anchored);

        // An ancestor that clips horizontal overflow makes the overflow
        // unreachable instead of scrolling the document.
        const clipped = parent ? inheritedClipped.get(parent) === true : false;
        inheritedClipped.set(element, clipped || clipsOverflow(style.overflowX));

        const revealable =
          (parent ? inheritedRevealable.get(parent) === true : false) ||
          disclosureRoots.has(element);
        inheritedRevealable.set(element, revealable);

        const rect = rectOf(element);

        // The nearest link or button the element is part of, itself
        // included, and whether that control is rendered here. A label
        // hidden inside a control that stays is not lost content.
        const inRenderedControl = isControl(element, tag, role)
          ? isRenderedBox(element, rect, style)
          : parent
            ? inheritedControlRendered.get(parent) === true
            : false;
        inheritedControlRendered.set(element, inRenderedControl);

        const ownContext = parent ? (childContext.get(parent) ?? 0) : 0;
        if (input.collect.stacking) {
          childContext.set(
            element,
            formsStackingContext(element, style) ? ++nextContextId : ownContext
          );
        }

        const text = directText(element);
        const hasText = text.length > 0;
        const clips = clipsOverflow(style.overflowX) || clipsOverflow(style.overflowY);
        // Only for a clipping element: reading `textContent` walks the whole
        // subtree, and nothing else needs it.
        const hasContentText = clips ? (element.textContent ?? "").trim().length > 0 : hasText;
        const overflowsViewport = rect.width > 0 && rect.x + rect.width > client.width + 1;

        if (!hasText && !(clips && hasContentText) && !overflowsViewport) continue;

        if (elements.length >= input.maxCandidates) {
          truncated = true;
          break;
        }

        let parentIndex = -1;
        let ancestor = parent;
        while (ancestor) {
          const found = candidateIndex.get(ancestor);
          if (found !== undefined) {
            parentIndex = found;
            break;
          }
          ancestor = ancestor.parentElement;
        }

        const index = elements.length;
        candidateIndex.set(element, index);

        const rendered = isRenderedBox(element, rect, style);

        const measured: RenderingElement = {
          index,
          selector: cssPath(element),
          html: openingTag(element),
          tag,
          role: role === "" ? null : role,
          text,
          rect,
          hasText,
          hasContentText,
          rendered,
          anchored,
          exempt,
          clipped,
          parentIndex,
          revealable,
          inRenderedControl,
          // Only an absence needs a region, and only the check that reports
          // absences reads it.
          ...(rendered ? {} : { hiddenRegion: hiddenRegionOf(element) }),
        };

        if (input.collect.clipping) {
          const lineHeight = Number.parseFloat(style.lineHeight);
          measured.clipping = {
            overflowX: style.overflowX,
            overflowY: style.overflowY,
            textOverflow: style.textOverflow,
            whiteSpace: style.whiteSpace,
            lineHeight: Number.isFinite(lineHeight) ? lineHeight : 0,
            scrollWidth: element.scrollWidth,
            scrollHeight: element.scrollHeight,
            clientWidth: element.clientWidth,
            clientHeight: element.clientHeight,
          };
        }

        if (input.collect.stacking) {
          measured.stackingContext = ownContext;
          const boxes = element.getClientRects();
          measured.fragments = boxes.length;
          if (boxes.length > 1 && boxes.length <= input.maxFragments) {
            measured.boxes = Array.from(boxes, (box) => ({
              x: box.left + scrollX,
              y: box.top + scrollY,
              width: box.width,
              height: box.height,
            }));
          }
        }

        elements.push(measured);

        // Only text elements can be the member of a hidden region, and only
        // their ancestors can be the region itself.
        if (input.collect.ancestors && hasText) registerAncestors(element);
      }

      return {
        elements,
        truncated,
        devicePixelRatio: window.devicePixelRatio,
        viewport,
        // The same numbers the walk judged "on the page" against, so the
        // capture geometry and the rendered state cannot disagree.
        document: pageBox,
        client,
        scroll: { x: scrollX, y: scrollY },
        ...(input.collect.ancestors
          ? {
              // Identities continue the element numbering, so no ancestor
              // can share a mark with a candidate.
              ancestors: ancestorBoxes.map((ancestor, position) => ({
                index: elements.length + position,
                selector: ancestor.selector,
                rect: ancestor.rect,
              })),
            }
          : {}),
      };
    }, args);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`rendering measurement timed out after ${timeout}ms`)),
          timeout
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The union of what a set of checks needs gathered. With no check active the
 * element walk is skipped entirely: the condition still gets its capture, and
 * the page-level numbers come along regardless.
 */
export function unionCollect(collects: RenderingCollect[]): RenderingCollect {
  const union: RenderingCollect = { elements: false };
  for (const collect of collects) {
    if (collect.elements) union.elements = true;
    if (collect.clipping) union.clipping = true;
    if (collect.stacking) union.stacking = true;
    if (collect.ancestors) union.ancestors = true;
  }
  return union;
}
