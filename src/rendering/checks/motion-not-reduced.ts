/**
 * Motion that keeps going when the user asked for less of it.
 *
 * Under `prefers-reduced-motion: reduce` three things are reported, each as
 * `moderate`:
 *
 * - an animation that is still running and either repeats forever or lasts
 *   longer than five seconds per iteration — the threshold the contract
 *   sets, which leaves the short transitions a page runs all the time
 *   alone;
 * - a `<video autoplay>` without `controls`, which starts by itself and
 *   cannot be stopped;
 * - a `<marquee>`, which no media query stops.
 *
 * One finding per element: an element with four keyframe animations is one
 * thing that moves, and the count is in the evidence. An element inside
 * another reported element is left out for the same reason — an SVG spinner
 * animates the `svg` and the `circle` in it, and that is one spinner,
 * reported on the outermost of them, with every animation of the movement
 * counted there.
 *
 * The nesting is read from every animation the measurement collected, not
 * only from the ones that qualify: a 300 ms fade between an infinite
 * ancestor and an infinite descendant is still the nesting, and following
 * the chain only through qualifying animations stopped at it and reported
 * the pair twice. The cap on the findings is the last thing applied, so 25
 * animated children listed before their animated parent fold into the
 * parent rather than using up the cap.
 */

import type { PerConditionCheck, RenderingFinding } from "../types.js";

const HELP_URL = "https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html";

const DESCRIPTION =
  "Content keeps moving although the user asked for reduced motion (`prefers-reduced-motion: reduce`).";

const HELP =
  "Honour `@media (prefers-reduced-motion: reduce)`: stop looping and long animations there, and give autoplaying video controls or do not start it by itself.";

/** Longer than this per iteration counts as a long animation, in ms. */
export const LONG_ANIMATION_MS = 5_000;

/** Never report more than this many elements per condition. */
const MAX_FINDINGS = 25;

export const motionNotReducedCheck: PerConditionCheck = {
  id: "motion-not-reduced",
  kind: "per-condition",
  collect: { elements: false, motion: true },

  appliesTo: (condition) => condition.media?.reducedMotion === "reduce",

  evaluate({ measurement, onTruncated }) {
    const motion = measurement.motion;
    if (!motion) return [];

    /**
     * The animated element each animated element sits in, from every entry
     * the measurement carries: an animation that does not qualify is still
     * a link in the chain between two that do.
     */
    const parentOf = new Map<number, number>();
    for (const animation of motion.animations) {
      if (!parentOf.has(animation.index)) parentOf.set(animation.index, animation.parentIndex);
    }

    // Only what is still moving under the condition and either repeats
    // forever or runs long: an animation the page paused or finished is not
    // what the user is asking about, and a short transition is not motion
    // the criterion is about.
    const qualifying = motion.animations.filter((animation) => {
      if (animation.playState !== "running") return false;
      // -1 is the infinite count; JSON cannot carry Infinity.
      return animation.iterations === -1 || animation.durationMs > LONG_ANIMATION_MS;
    });
    const qualifies = new Set(qualifying.map((animation) => animation.index));

    /**
     * The outermost qualifying element this one is part of, itself included:
     * the element that carries the finding for the whole movement.
     */
    const ownerOf = (index: number): number => {
      let owner = index;
      const seen = new Set<number>([index]);
      let parent = parentOf.get(index);
      while (parent !== undefined && parent >= 0 && !seen.has(parent)) {
        seen.add(parent);
        if (qualifies.has(parent)) owner = parent;
        parent = parentOf.get(parent);
      }
      return owner;
    };

    /** One finding per element that owns a movement, animations counted. */
    const byElement = new Map<number, RenderingFinding>();

    // The owners first, so every finding is built from the element that
    // carries it and never from a descendant that folded into it.
    for (const animation of qualifying) {
      if (ownerOf(animation.index) !== animation.index) continue;
      if (byElement.has(animation.index)) continue;

      const infinite = animation.iterations === -1;
      const seconds = Math.round(animation.durationMs / 100) / 10;
      byElement.set(animation.index, {
        checkId: "motion-not-reduced",
        impact: "moderate",
        description: DESCRIPTION,
        help: HELP,
        helpUrl: HELP_URL,
        failureSummary: infinite
          ? `The animation${animation.name ? ` \`${animation.name}\`` : ""} on this <${animation.tag ?? "element"}> repeats forever and is still running under reduced motion.`
          : `The animation${animation.name ? ` \`${animation.name}\`` : ""} on this <${animation.tag ?? "element"}> lasts ${seconds} s per iteration and is still running under reduced motion.`,
        selector: animation.selector,
        ...(animation.html ? { html: animation.html } : {}),
        ...(animation.rect ? { rect: animation.rect } : {}),
        elementIndex: animation.index,
        ...(animation.anchored ? { anchored: true } : {}),
        evidence: {
          kind: infinite ? "infinite-animation" : "long-animation",
          animations: 0,
          iterations: animation.iterations,
          durationMs: Math.round(animation.durationMs),
          ...(animation.name ? { animation: animation.name } : {}),
        },
      });
    }

    // Every qualifying animation counts towards the movement it is part of,
    // including the ones on descendants that are not reported themselves.
    for (const animation of qualifying) {
      const finding = byElement.get(ownerOf(animation.index));
      if (!finding) continue;
      finding.evidence.animations = Number(finding.evidence.animations ?? 0) + 1;
    }

    for (const element of motion.elements) {
      if (byElement.has(element.index)) continue;

      byElement.set(element.index, {
        checkId: "motion-not-reduced",
        impact: "moderate",
        description: DESCRIPTION,
        help: HELP,
        helpUrl: HELP_URL,
        failureSummary:
          element.kind === "video-autoplay"
            ? "This video plays by itself and has no controls, so a user who asked for reduced motion cannot stop it."
            : "This `<marquee>` scrolls by itself; no media query stops it, and the element is obsolete.",
        selector: element.selector,
        html: element.html,
        rect: element.rect,
        elementIndex: element.index,
        ...(element.anchored ? { anchored: true } : {}),
        evidence: { kind: element.kind },
      });
    }

    // The cap is the last thing applied: what it drops is a movement of its
    // own, not a descendant another finding already covers.
    const findings: RenderingFinding[] = [];
    for (const finding of byElement.values()) {
      if (findings.length >= MAX_FINDINGS) {
        onTruncated?.();
        break;
      }
      findings.push(finding);
    }
    return findings;
  },
};
