/**
 * The rendering condition registry.
 *
 * Every condition is a named, reversible change to how the page is rendered.
 * Two or more ids joined with `+` compose into one condition that applies all
 * their parts, e.g. `viewport:320+text-spacing`.
 */

import type { RenderingConditionId } from "../types.js";
import type { RenderingCapabilityName, RenderingCondition } from "./types.js";

/** What one id contributes to a condition. */
type ConditionPart = Omit<RenderingCondition, "id" | "parts">;

const PARTS: Record<string, ConditionPart> = {
  // The WCAG 1.4.10 equivalent of 1280 px at 400% zoom.
  "viewport:320": { viewport: { width: 320, height: 720 } },
  "viewport:360": { viewport: { width: 360, height: 800 } },
  "viewport:768": { viewport: { width: 768, height: 1024 } },
  // Baseline: no layout change, but findings and captures get a uniform id.
  "viewport:1280": { viewport: { width: 1280, height: 720 } },
  "cvd:protanopia": { visionDeficiency: "protanopia" },
  "cvd:deuteranopia": { visionDeficiency: "deuteranopia" },
  "cvd:tritanopia": { visionDeficiency: "tritanopia" },
  "cvd:achromatopsia": { visionDeficiency: "achromatopsia" },
  "cvd:reduced-contrast": { visionDeficiency: "reducedContrast" },
  "cvd:blurred-vision": { visionDeficiency: "blurredVision" },
  "media:dark": { media: { colorScheme: "dark" } },
  "media:forced-colors": { media: { forcedColors: "active" } },
  "media:more-contrast": { media: { prefersContrast: "more" } },
  "media:reduced-motion": { media: { reducedMotion: "reduce" } },
  "text-spacing": { textSpacing: true },
};

/** Every single condition id, in the order the table documents them. */
export const RENDERING_CONDITION_IDS: readonly RenderingConditionId[] = Object.keys(PARTS);

/**
 * What `rendering: true` means (decision 1 of the contract): the lean set.
 * Every other condition is available through `rendering.conditions`.
 */
export const DEFAULT_RENDERING_CONDITIONS: readonly RenderingConditionId[] = [
  // The wide baseline content-hidden-at-viewport compares viewport:360 with;
  // first, because at the default 1280 px viewport it changes nothing.
  "viewport:1280",
  "viewport:320",
  "viewport:360",
  "media:dark",
  "cvd:protanopia",
  "cvd:deuteranopia",
  "text-spacing",
];

/**
 * Run order: viewports first (cheapest and most valuable), then media, then
 * CVD, then text-spacing, then the composites.
 */
function runOrder(parts: RenderingConditionId[]): number {
  if (parts.length > 1) return 4;
  const [part] = parts;
  if (part.startsWith("viewport:")) return 0;
  if (part.startsWith("media:")) return 1;
  if (part.startsWith("cvd:")) return 2;
  return 3;
}

/** The media features a composite could claim twice with different values. */
const MEDIA_FEATURES = ["colorScheme", "forcedColors", "prefersContrast", "reducedMotion"] as const;

/**
 * Two parts of one composite that set the same thing to different values.
 * Letting the last one win would run something other than what was asked
 * for, and the capture would carry the wrong condition id.
 */
function conflict(
  id: RenderingConditionId,
  parts: [RenderingConditionId, RenderingConditionId],
  what: string
): Error {
  return new Error(
    `Conflicting rendering condition id: '${id}' composes '${parts[0]}' and '${parts[1]}', which both set ${what}. Use one of them, or two conditions.`
  );
}

/**
 * Resolve one condition id, including a `+`-composed one. Throws on an
 * unknown part, naming what is known — a typo must not silently run less than
 * was asked for — and on a composite whose parts contradict each other.
 */
export function resolveCondition(id: RenderingConditionId): RenderingCondition {
  const parts = [
    ...new Set(
      id
        .split("+")
        .map((part) => part.trim())
        .filter(Boolean)
    ),
  ];

  if (parts.length === 0) {
    throw new Error(
      `Unknown rendering condition id: '${id}'. Known: ${RENDERING_CONDITION_IDS.join(", ")}`
    );
  }

  const condition: RenderingCondition = { id: parts.join("+"), parts };
  /** Which part set each aspect, so a conflict can name both. */
  const setBy = new Map<string, RenderingConditionId>();

  for (const part of parts) {
    const definition = PARTS[part];
    if (!definition) {
      throw new Error(
        `Unknown rendering condition id: '${part}'. Known: ${RENDERING_CONDITION_IDS.join(", ")}`
      );
    }

    if (definition.viewport) {
      const previous = setBy.get("viewport");
      if (previous) throw conflict(id, [previous, part], "the viewport");
      setBy.set("viewport", part);
      condition.viewport = definition.viewport;
    }

    if (definition.media) {
      for (const feature of MEDIA_FEATURES) {
        if (definition.media[feature] === undefined) continue;
        const previous = setBy.get(feature);
        if (previous) throw conflict(id, [previous, part], `the ${feature} media feature`);
        setBy.set(feature, part);
      }
      condition.media = { ...condition.media, ...definition.media };
    }

    if (definition.visionDeficiency) {
      const previous = setBy.get("visionDeficiency");
      if (previous) throw conflict(id, [previous, part], "the vision deficiency");
      setBy.set("visionDeficiency", part);
      condition.visionDeficiency = definition.visionDeficiency;
    }

    if (definition.textSpacing) condition.textSpacing = true;
  }

  return condition;
}

/**
 * Resolve the requested ids (or the default set) into conditions in run
 * order, de-duplicated by resolved id.
 */
export function resolveConditions(ids?: RenderingConditionId[]): RenderingCondition[] {
  const requested = ids && ids.length > 0 ? ids : [...DEFAULT_RENDERING_CONDITIONS];
  const resolved = new Map<RenderingConditionId, RenderingCondition>();

  for (const id of requested) {
    const condition = resolveCondition(id);
    if (!resolved.has(condition.id)) resolved.set(condition.id, condition);
  }

  return [...resolved.values()]
    .map((condition, index) => ({ condition, index }))
    .sort((a, b) => runOrder(a.condition.parts) - runOrder(b.condition.parts) || a.index - b.index)
    .map(({ condition }) => condition);
}

/** The browser capabilities a condition cannot be applied without. */
export function requiredCapabilities(condition: RenderingCondition): RenderingCapabilityName[] {
  const required: RenderingCapabilityName[] = [];
  if (condition.viewport) required.push("viewport");
  if (condition.media) required.push("media");
  if (condition.visionDeficiency) required.push("visionDeficiency");
  return required;
}
