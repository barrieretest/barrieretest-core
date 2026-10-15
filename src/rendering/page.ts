/**
 * The in-page steps of the rendering pass: let a condition settle, and the
 * WCAG 1.4.12 text-spacing override.
 *
 * Both follow the house style of `src/lazy-content.ts`: one bounded
 * `page.evaluate`, a Node-side timeout race on top, and a stylesheet built by
 * script in `document.adoptedStyleSheets` rather than an inserted `<style>`,
 * so a page whose Content-Security-Policy restricts `style-src` is covered
 * and no element is added to the DOM.
 */

import type { BrowserPage } from "../browser.js";

/** Upper bound for the wait on images that are still loading, in ms. */
const SETTLE_NETWORK_CAP_MS = 1_000;

/**
 * Upper bound for the wait on CSS transitions the condition started, in ms.
 *
 * A theme that cross-fades its colours — `transition: background-color .2s`
 * on everything, which is one Tailwind class — is mid-fade for a moment
 * after `prefers-color-scheme` flips, and a colour read then belongs to
 * neither mode. Measured on a live site: 149 transitions running 50 ms
 * after the switch, every one of them settled by 200 ms, and a contrast run
 * in between reported 25 failures that are not on the page.
 */
const SETTLE_TRANSITION_CAP_MS = 1_000;

/**
 * The `window` property the injected sheet is parked on, so the removal step
 * can take out exactly the sheet this pass added.
 */
const TEXT_SPACING_KEY = "__barrieretestTextSpacing";

/**
 * WCAG 1.4.12: line height at least 1.5 times the font size, letter spacing
 * 0.12em, word spacing 0.16em, paragraph spacing 2 times the font size.
 */
const TEXT_SPACING_CSS =
  "*, *::before, *::after { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }";

/**
 * Scroll to the top, wait two animation frames, let the CSS transitions the
 * condition started finish, then give images that are still loading a
 * bounded wait, so a condition's layout and colours have settled before they
 * are measured and captured. Measuring at scroll 0 is what makes the rects
 * document-space coordinates of the full-page capture.
 *
 * Both waits are bounded at one second, so the settlement is as settled as a
 * second allows and not more: a transition that runs longer than that, and an
 * image that never answers, are still in flight when the measurement and the
 * capture are taken. The cap is what keeps one slow condition from spending
 * the whole pass; the transition lengths that caused the false findings this
 * waits for are two orders of magnitude below it.
 */
export async function settleCondition(page: BrowserPage): Promise<void> {
  await page.evaluate(
    async (caps: { networkCapMs: number; transitionCapMs: number }) => {
      // NOTE: this runs in the browser via page.evaluate — it cannot reference
      // Node-scope constants or helpers.
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });

      // Fallback for a single frame wait, so a throttled renderer cannot stall.
      const frameCapMs = 50;
      const nextFrame = () =>
        new Promise<void>((resolve) => {
          let done = false;
          const finish = () => {
            if (!done) {
              done = true;
              resolve();
            }
          };
          requestAnimationFrame(finish);
          setTimeout(finish, frameCapMs);
        });

      await nextFrame();
      await nextFrame();

      // Transitions the condition started, which is every element on a page
      // that cross-fades its theme. Only the running ones, and only until the
      // cap: an infinite animation is not a transition and never finishes,
      // and a transition longer than the cap is left running.
      const transitions = (
        typeof document.getAnimations === "function" ? document.getAnimations() : []
      ).filter(
        (animation) => "transitionProperty" in animation && animation.playState === "running"
      );
      if (transitions.length > 0) {
        await Promise.race([
          Promise.allSettled(transitions.map((transition) => transition.finished)),
          new Promise<void>((resolve) => {
            setTimeout(resolve, caps.transitionCapMs);
          }),
        ]);
        await nextFrame();
      }

      const stillLoading = Array.from(document.images).filter((image) => !image.complete);
      if (stillLoading.length === 0) return;

      // Stands in for network idle: a condition that changes the viewport can
      // pull in a different `srcset` candidate, and that image has to be in the
      // capture. Aborting removes every listener still attached.
      const listeners = new AbortController();
      try {
        await Promise.race([
          Promise.all(
            stillLoading.map(
              (image) =>
                new Promise<void>((resolve) => {
                  const options = { once: true, signal: listeners.signal };
                  image.addEventListener("load", () => resolve(), options);
                  image.addEventListener("error", () => resolve(), options);
                })
            )
          ),
          new Promise<void>((resolve) => {
            setTimeout(resolve, caps.networkCapMs);
          }),
        ]);
      } finally {
        listeners.abort();
      }

      await nextFrame();
    },
    {
      networkCapMs: SETTLE_NETWORK_CAP_MS,
      transitionCapMs: SETTLE_TRANSITION_CAP_MS,
    }
  );
}

/** Add the text-spacing override. Idempotent: at most one sheet per page. */
export async function applyTextSpacing(page: BrowserPage): Promise<void> {
  await page.evaluate(
    (input: { key: string; css: string }) => {
      const flags = window as unknown as Record<string, unknown>;
      if (flags[input.key]) return;

      const sheet = new CSSStyleSheet();
      sheet.replaceSync(input.css);
      if (sheet.cssRules.length === 0) {
        throw new Error("the text-spacing override was not parsed");
      }
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      flags[input.key] = sheet;
    },
    { key: TEXT_SPACING_KEY, css: TEXT_SPACING_CSS }
  );
}

/**
 * Remove the override this pass added, leaving any other adopted sheet (the
 * `content-visibility` override of the lazy-content step) in place.
 */
export async function removeTextSpacing(page: BrowserPage): Promise<void> {
  await page.evaluate((key: string) => {
    const flags = window as unknown as Record<string, unknown>;
    const sheet = flags[key];
    if (!sheet) return;
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((other) => other !== sheet);
    delete flags[key];
  }, TEXT_SPACING_KEY);
}

export { SETTLE_NETWORK_CAP_MS, SETTLE_TRANSITION_CAP_MS, TEXT_SPACING_CSS, TEXT_SPACING_KEY };
