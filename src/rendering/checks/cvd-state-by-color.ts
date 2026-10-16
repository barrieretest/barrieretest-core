/**
 * States that only colour shows, and whose colour a deficiency takes.
 *
 * WCAG 1.4.1 Use of Color: the state of an element — invalid, selected,
 * current, required — must not be conveyed by colour alone. `aria-invalid`,
 * `aria-selected`, `aria-current` and `required` are programmatically
 * determinable, so what is in question here is only the *visual* cue, and a
 * cue nobody with the deficiency can see is no cue.
 *
 * The comparison is the element against a sibling of the same kind without
 * the state, which the measurement pairs up: a single `aria-current` link
 * says nothing about how the others look. A pair is a finding when
 *
 * 1. nothing but colour differs — the same visible text, the same graphics
 *    (an `img` by its source, an `svg` by a hash of its markup, so a tick
 *    and a cross are two cues and not one), the same pseudo-element
 *    content, the same child count, no font, decoration, outline or
 *    border-width difference, and the same box height;
 * 2. at least one colour (text, background or the widest border side) does
 *    differ enough to see, so the state is conveyed at all — and only a
 *    colour that paints something counts: a foreground that paints no
 *    visible text and no icon of its own is not compared at all; and
 * 3. *every* colour that differs enough to see collapses below that same
 *    distance once the deficiency is simulated. One cue that survives is
 *    enough, so a pair where the border collapses and the text colour does
 *    not is not reported.
 *
 * The distance is CIE76 ΔE and not a contrast ratio on purpose: two colours
 * of the same luminance and different hue — the red and green of a status
 * indicator — have a contrast ratio of 1 and are plainly different to see,
 * and the ratio cannot tell whether a deficiency changed anything.
 *
 * `cvd:reduced-contrast` and `cvd:blurred-vision` are not colour
 * transformations, so they have no matrix and this check does not run under
 * them.
 */

import {
  compositeOver,
  deltaE,
  isSimulatedDeficiency,
  parseColor,
  type Rgb,
  simulateDeficiency,
  type SimulatedDeficiency,
} from "../color.js";
import type {
  PerConditionCheck,
  RenderingFinding,
  RenderingStateName,
  RenderingStatePair,
  RenderingStateStyle,
} from "../types.js";

/**
 * How far apart (CIE76 ΔE) two colours have to be to count as a cue someone
 * can see, here and after the simulation. The just-noticeable difference is
 * about 2.3; this is a difference nobody has to look twice at, and it is the
 * line between the cases measured on 2026-10-15: a red error border against
 * a neutral one is 82 normally and 55 under deuteranopia (visible, no
 * finding), a green tick colour against a red cross colour is 118 normally
 * and 5 under deuteranopia (gone, a finding), a selected green against a
 * grey is 52 normally and 3 under achromatopsia (gone), and a `#fdeaea`
 * invalid tint against white is 9 either way — too faint to be the cue in
 * the first place, so never a finding.
 */
export const MIN_STATE_DELTA_E = 10;

/**
 * Box heights within this many CSS px count as the same size. Height only:
 * two siblings carry different labels, so their widths differ for reasons
 * that have nothing to do with the state, while padding, scale and border
 * cues all show up in the height.
 */
const SIZE_TOLERANCE_PX = 2;

const HELP_URL = "https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html";

const HELP =
  "Add a cue that is not colour: an icon or text marker, an underline, a heavier weight, a border or an outline. Colour alone is invisible to a reader with a colour-vision deficiency even when the contrast is high.";

/** Never report more than this many elements per condition. */
const MAX_FINDINGS = 25;

/** The deficiency in the words a report shows. */
const DEFICIENCY_NAMES: Record<SimulatedDeficiency, string> = {
  protanopia: "protanopia",
  deuteranopia: "deuteranopia",
  tritanopia: "tritanopia",
  achromatopsia: "achromatopsia",
};

/** The state in the words a report shows. */
const STATE_NAMES: Record<RenderingStateName, string> = {
  "aria-invalid": "invalid",
  "aria-selected": "selected",
  "aria-current": "current",
  required: "required",
};

/** One colour the state could be carried by, and its two values. */
interface ColorCue {
  property: string;
  state: Rgb;
  sibling: Rgb;
}

/**
 * What is painted where a colour sits on the background behind it. The
 * background the measurement reports is already composited down to an
 * opaque colour, so this composites exactly once: the foreground over it.
 */
function painted(color: string, background: string): Rgb | null {
  const parsed = parseColor(color);
  const behind = parseColor(background);
  if (!parsed || !behind) return null;
  if (parsed.a === 0) return null;
  return compositeOver(parsed, behind);
}

/** An already-composited background as a colour, for comparing two of them. */
function backgroundColor(background: string): Rgb | null {
  const parsed = parseColor(background);
  if (!parsed) return null;
  return { r: parsed.r, g: parsed.g, b: parsed.b };
}

/**
 * Whether the two sides carry evidence that can be compared at all. A text
 * that hit its bound could differ past the cut, and a `canvas` paints what
 * no attribute names: either way nothing here can say the state is conveyed
 * by colour alone, and a missed finding beats a made-up one.
 */
function evidenceUnreadable(state: RenderingStateStyle, sibling: RenderingStateStyle): boolean {
  if (state.textTruncated || sibling.textTruncated) return true;
  return !state.graphicsReadable || !sibling.graphicsReadable;
}

/** Whether anything that is not a colour differs between the two. */
function differsBeyondColor(state: RenderingStateStyle, sibling: RenderingStateStyle): boolean {
  if (state.pseudoContent !== sibling.pseudoContent) return true;
  // The visible text and *which* graphics each side holds, not only that it
  // holds one: a "(selected)" marker and a tick against a cross are both
  // cues a reader without the colour still sees. Two labels that merely
  // differ as labels do are indistinguishable from a marker from here, so
  // they count as a cue too and the pair is left alone.
  if (state.text !== sibling.text) return true;
  if (state.graphics !== sibling.graphics) return true;
  if (state.childElements !== sibling.childElements) return true;
  if (state.fontWeight !== sibling.fontWeight) return true;
  if (state.fontStyle !== sibling.fontStyle) return true;
  if (state.fontFamily !== sibling.fontFamily) return true;
  if (state.fontSize !== sibling.fontSize) return true;
  if (state.decoration !== sibling.decoration) return true;
  if (state.outline !== sibling.outline) return true;
  // Border widths cover presence and shape: a 2 px bottom border where the
  // sibling has none is a cue, and so is a thicker one.
  if (state.borderWidths !== sibling.borderWidths) return true;
  return Math.abs(state.rect.height - sibling.rect.height) > SIZE_TOLERANCE_PX;
}

/** The colours that could carry the state, as they are painted. */
function colorCues(pair: RenderingStatePair): ColorCue[] {
  const cues: ColorCue[] = [];

  const add = (property: string, state: Rgb | null, sibling: Rgb | null): void => {
    if (state && sibling) cues.push({ property, state, sibling });
  };

  // Only when both sides paint their foreground somewhere a reader sees it:
  // the `color` of an empty box is a value nobody is shown, and the
  // measurement reports `""` for it. Comparing it anyway made a cue out of
  // two carousel dots that differ in nothing but an unused colour, and let
  // such a difference stand in for a background cue that is gone.
  if (pair.element.color !== "" && pair.sibling.color !== "") {
    add(
      "text colour",
      painted(pair.element.color, pair.element.background),
      painted(pair.sibling.color, pair.sibling.background)
    );
  }
  // The two backgrounds as they are painted, compared directly: each one
  // already has the element's own `background-color` composited into what
  // is behind it, and a transparent background is the colour behind it,
  // which is just as much what a reader sees.
  add(
    "background colour",
    backgroundColor(pair.element.background),
    backgroundColor(pair.sibling.background)
  );
  // Only when both sides paint a border: a border on one side alone is a
  // shape difference, which `differsBeyondColor` has already ruled out.
  if (pair.element.borderColor !== "" && pair.sibling.borderColor !== "") {
    add(
      "border colour",
      painted(pair.element.borderColor, pair.element.background),
      painted(pair.sibling.borderColor, pair.sibling.background)
    );
  }

  return cues;
}

export const cvdStateByColorCheck: PerConditionCheck = {
  id: "cvd-state-by-color",
  kind: "per-condition",
  // No element walk: the state group carries the pair, their colours and
  // their boxes.
  collect: { elements: false, states: true },

  appliesTo: (condition) => isSimulatedDeficiency(condition.visionDeficiency),

  evaluate({ condition, measurement, onTruncated }) {
    const deficiency = condition.visionDeficiency;
    if (!isSimulatedDeficiency(deficiency)) return [];

    const findings: RenderingFinding[] = [];

    for (const pair of measurement.states ?? []) {
      // An image or gradient on either side: the colours are not what is on
      // the screen, so no colour judgement is possible.
      if (pair.element.backgroundImage || pair.sibling.backgroundImage) continue;
      if (evidenceUnreadable(pair.element, pair.sibling)) continue;
      if (differsBeyondColor(pair.element, pair.sibling)) continue;

      const visible = colorCues(pair).filter(
        (cue) => deltaE(cue.state, cue.sibling) >= MIN_STATE_DELTA_E
      );
      // Nothing visible sets the state apart at all; that is a state with no
      // visual cue, not a state carried by a colour that collapses.
      if (visible.length === 0) continue;

      const simulated = visible.map((cue) => ({
        cue,
        distance: deltaE(cue.state, cue.sibling),
        simulatedDistance: deltaE(
          simulateDeficiency(cue.state, deficiency),
          simulateDeficiency(cue.sibling, deficiency)
        ),
      }));
      // One cue that survives is enough.
      if (simulated.some((entry) => entry.simulatedDistance >= MIN_STATE_DELTA_E)) continue;

      // Asked after the filters, so it is only truncation when what the cap
      // drops is a finding.
      if (findings.length >= MAX_FINDINGS) {
        onTruncated?.();
        break;
      }

      // The strongest cue is the one the summary names: it is what a reader
      // without the deficiency goes by.
      const dominant = simulated.reduce((worst, entry) =>
        entry.distance > worst.distance ? entry : worst
      );
      const state = STATE_NAMES[pair.state];
      const name = DEFICIENCY_NAMES[deficiency];
      const colorText = (color: Rgb) => `rgb(${color.r}, ${color.g}, ${color.b})`;

      findings.push({
        checkId: "cvd-state-by-color",
        impact: "moderate",
        description: `The "${state}" state of this element is conveyed by colour alone, and that colour difference disappears for a reader with this colour-vision deficiency.`,
        help: HELP,
        helpUrl: HELP_URL,
        failureSummary: `The <${pair.tag}> is marked ${state} (${pair.state}${pair.stateValue ? `="${pair.stateValue}"` : ""}), and against \`${pair.sibling.selector}\` — the same kind of element without the state — nothing but its ${dominant.cue.property} differs: the same visible text, the same icons and pseudo-element content, no font, decoration, outline or border difference, and the same height. That colour difference is ${dominant.distance.toFixed(0)} (CIE76) normally and ${dominant.simulatedDistance.toFixed(0)} under ${name}, so the state is no longer visible.`,
        selector: pair.element.selector,
        html: pair.html,
        rect: pair.element.rect,
        elementIndex: pair.index,
        ...(pair.anchored ? { anchored: true } : {}),
        evidence: {
          deficiency: name,
          state: pair.state,
          ...(pair.stateValue ? { stateValue: pair.stateValue } : {}),
          property: dominant.cue.property,
          distance: Number(dominant.distance.toFixed(1)),
          simulatedDistance: Number(dominant.simulatedDistance.toFixed(1)),
          required: MIN_STATE_DELTA_E,
          stateColor: colorText(dominant.cue.state),
          siblingColor: colorText(dominant.cue.sibling),
          comparedWith: pair.sibling.selector,
        },
      });
    }

    return findings;
  },
};
