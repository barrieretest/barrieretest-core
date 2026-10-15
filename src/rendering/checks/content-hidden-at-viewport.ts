/**
 * Text that exists on the desktop layout and is simply gone on the phone
 * layout, with no control to reveal it.
 *
 * The one check that compares two conditions. It is reported under
 * `viewport:1280` and drawn on that capture, because that is where the
 * content still is: a box on the narrow capture would point at nothing. The
 * `viewport:360` measurement only says what disappeared.
 *
 * One finding per hidden region, not per hidden element: when several text
 * elements go with one hidden ancestor — the four links of a collapsed menu,
 * the captions of a row of thumbnails — the region is named once, with the
 * number of text elements it took with it in the evidence. The narrow
 * measurement names that region; its rect and its identity come from the
 * wide one, where the walk measured the ancestor's box alongside the
 * candidates. A member can carry a finding of its own — clipped text, an
 * overlap — and the region's mark must be its own box and its own number,
 * not that member's.
 *
 * Three exemptions. The structural one: content a control at 360 px can
 * bring back is not reported — content inside a `nav` the page has a visible
 * disclosure control for, the `aria-controls` target of a visible control,
 * or a closed `details` with a visible `summary`. The one for controls that
 * stay: a label hidden inside a link or button that is still rendered at
 * 360 px is not lost content, the control keeps its function and its
 * accessible name (a control without a visible label is a different
 * criterion). And the one that catches the rest: when the same text is
 * rendered somewhere else at 360 px, nothing disappeared — a site that ships
 * a separate mobile menu with the same labels, which is the common pattern,
 * swaps the content instead of dropping it. Sites with non-standard menus
 * and unique labels can still slip through, which is why this is `moderate`
 * and never `critical`.
 *
 * The whole check is a claim about content that is *not* there, so it needs a
 * complete narrow measurement: when the element walk hit its cap, the check
 * reports nothing rather than call capped-off content missing.
 */

import type { MeasuredRect } from "../../annotate/index.js";
import type {
  CrossConditionCheck,
  RenderingAncestor,
  RenderingElement,
  RenderingFinding,
  RenderingMeasurement,
} from "../types.js";

const HELP_URL = "https://www.w3.org/WAI/WCAG22/Understanding/reflow.html";

const DESCRIPTION =
  "Content that is shown on the wide layout is missing from the narrow one, with no control to reveal it.";

const HELP =
  "Keep the same content available at every viewport. Where space is tight, move it behind a control the user can operate, and give that control an accessible name and state.";

/** Shorter text than this is a label fragment, not content worth reporting. */
const MIN_TEXT_LENGTH = 2;

/** Never report more than this many regions. */
const MAX_FINDINGS = 25;

/** The hidden region one finding is about, as its members are walked. */
interface HiddenRegion {
  selector: string;
  html: string;
  tag: string;
  /**
   * The region's own box at the wide viewport, from the ancestor the wide
   * walk measured. Falls back to the union of its members' boxes when the
   * wide measurement has no box for it.
   */
  rect: MeasuredRect;
  /** Whether `rect` is the region's own box and not its members' union. */
  ownBox: boolean;
  /** How many text elements disappeared with the region. */
  textElements: number;
  /**
   * The region's own identity in the wide measurement, never a member's: a
   * member can carry a finding of its own — an overlap, clipped text — and
   * two findings that share an identity share one mark and one rect, which
   * would put the region's number on a paragraph's box.
   */
  elementIndex: number;
  anchored: boolean;
  /** The first member's own text, for the summary. */
  text: string;
  /** Whether the first member exists in the narrow measurement at all. */
  presentAtNarrowViewport: boolean;
}

/** The ancestor boxes of the wide measurement, by selector. */
function ancestorsBySelector(measurement: RenderingMeasurement): Map<string, RenderingAncestor> {
  const index = new Map<string, RenderingAncestor>();
  for (const ancestor of measurement.ancestors ?? []) {
    if (!index.has(ancestor.selector)) index.set(ancestor.selector, ancestor);
  }
  return index;
}

function bySelector(measurement: RenderingMeasurement): Map<string, RenderingElement> {
  const index = new Map<string, RenderingElement>();
  for (const element of measurement.elements) {
    if (!index.has(element.selector)) index.set(element.selector, element);
  }
  return index;
}

/** Comparable form of an element's own text. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Every text that is rendered somewhere in this measurement. */
function renderedTexts(measurement: RenderingMeasurement): Set<string> {
  const texts = new Set<string>();
  for (const element of measurement.elements) {
    if (element.rendered && element.hasText) texts.add(normalize(element.text));
  }
  return texts;
}

function union(first: MeasuredRect, second: MeasuredRect): MeasuredRect {
  const x = Math.min(first.x, second.x);
  const y = Math.min(first.y, second.y);
  return {
    x,
    y,
    width: Math.max(first.x + first.width, second.x + second.width) - x,
    height: Math.max(first.y + first.height, second.y + second.height) - y,
  };
}

/**
 * The region an already grouped ancestor put this element in. The narrow
 * measurement names the region of everything it still has; this is for an
 * element the narrow layout dropped from the DOM altogether, where the only
 * thing that relates it to its neighbours is the wide tree.
 */
function regionOfAncestor(
  element: RenderingElement,
  elements: RenderingElement[],
  keys: Map<number, string>
): string | undefined {
  let index = element.parentIndex;
  while (index >= 0 && index < elements.length) {
    const key = keys.get(index);
    if (key !== undefined) return key;
    index = elements[index].parentIndex;
  }
  return undefined;
}

export const contentHiddenAtViewportCheck: CrossConditionCheck = {
  id: "content-hidden-at-viewport",
  kind: "cross-condition",
  // The ancestor boxes are what gives a region finding its own geometry and
  // its own identity instead of its first member's.
  collect: { elements: true, ancestors: true },
  reportsUnder: "viewport:1280",
  comparesWith: "viewport:360",

  evaluate({ measurement, reference }) {
    // An absence in a measurement that stopped early is not an absence.
    if (reference.truncated) return [];

    const narrow = bySelector(reference);
    const narrowTexts = renderedTexts(reference);
    const wide = bySelector(measurement);
    const wideAncestors = ancestorsBySelector(measurement);
    const regions = new Map<string, HiddenRegion>();
    /** Wide element index to the key of the region it was counted into. */
    const keys = new Map<number, string>();
    /**
     * Identity for a region the wide measurement has neither a candidate nor
     * an ancestor box for, which is a walk that hit its cap. Past every real
     * index, so the region still gets a mark of its own and not a member's.
     */
    let nextRegionIndex = measurement.elements.length + (measurement.ancestors?.length ?? 0);

    for (const element of measurement.elements) {
      if (!element.rendered || !element.hasText) continue;
      if (element.text.length < MIN_TEXT_LENGTH) continue;

      const counterpart = narrow.get(element.selector);
      if (counterpart?.rendered) continue;
      if (counterpart?.revealable ?? element.revealable) continue;
      if (counterpart?.inRenderedControl) continue;
      if (narrowTexts.has(normalize(element.text))) continue;

      const key =
        counterpart?.hiddenRegion?.selector ??
        regionOfAncestor(element, measurement.elements, keys) ??
        element.selector;
      keys.set(element.index, key);

      const region = regions.get(key);
      if (region) {
        region.textElements += 1;
        // Only a region without a box of its own is described by its
        // members; one that has it keeps the ancestor's rectangle.
        if (!region.ownBox) region.rect = union(region.rect, element.rect);
        continue;
      }

      // The region as the wide measurement has it: a candidate of its own
      // when it carries text, otherwise the ancestor box the same walk
      // measured. Either way its own geometry and its own identity.
      const own = wide.get(key) ?? wideAncestors.get(key);

      regions.set(key, {
        selector: key,
        html: counterpart?.hiddenRegion?.html ?? element.html,
        tag: counterpart?.hiddenRegion?.tag ?? element.tag,
        rect: own?.rect ?? element.rect,
        ownBox: own !== undefined,
        textElements: 1,
        elementIndex: own?.index ?? nextRegionIndex++,
        anchored: element.anchored,
        text: element.text,
        presentAtNarrowViewport: counterpart !== undefined,
      });
    }

    const wideWidth = Math.round(measurement.viewport.width);
    const narrowWidth = Math.round(reference.viewport.width);

    return [...regions.values()].slice(0, MAX_FINDINGS).map((region): RenderingFinding => {
      const state = region.presentAtNarrowViewport ? "not rendered" : "absent";
      const content =
        region.textElements === 1
          ? `Text: "${region.text}".`
          : `It takes ${region.textElements} text elements with it, starting with "${region.text}".`;

      return {
        checkId: "content-hidden-at-viewport",
        impact: "moderate",
        description: DESCRIPTION,
        help: HELP,
        helpUrl: HELP_URL,
        failureSummary: `The <${region.tag}> is rendered at ${wideWidth} px but ${state} at ${narrowWidth} px, and no visible control can reveal it. ${content}`,
        selector: region.selector,
        html: region.html,
        rect: region.rect,
        elementIndex: region.elementIndex,
        ...(region.anchored ? { anchored: true } : {}),
        evidence: {
          wideViewport: wideWidth,
          narrowViewport: narrowWidth,
          textElements: region.textElements,
          presentAtNarrowViewport: region.presentAtNarrowViewport,
        },
      };
    });
  },
};
