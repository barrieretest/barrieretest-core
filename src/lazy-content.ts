/**
 * Lazy-content loading before accessibility audits.
 *
 * Nothing else in an audit scrolls, so images with `loading="lazy"`,
 * script-based lazy loaders and reveal-on-scroll effects never trigger below
 * the first viewport: axe sees an unfinished DOM and the full-page screenshot
 * shows blank boxes. This module scrolls the page through once, gives images
 * that are still loading a short bounded wait, and returns to the top, so
 * axe, the semantic context, the screenshot and the annotations all see the
 * same loaded page at scroll position 0.
 *
 * The whole step is best-effort: every failure is swallowed with one warning
 * and the audit continues with whatever loaded.
 */

import type { BrowserPage } from "./browser.js";

/**
 * Caps handed to the in-page function. They have to travel as an argument:
 * the function runs in the browser and cannot see Node-scope constants.
 */
type LazyContentCaps = {
  /** Never scroll further down than this, in CSS px. */
  maxScrollPx: number;
  /** Never take more than this many scroll steps. */
  maxSteps: number;
  /** Pause after the two animation frames of each step, in ms. */
  stepSettleMs: number;
  /** Upper bound for the wait on images that are still loading, in ms. */
  imageWaitMs: number;
  /** Overall budget for scrolling plus the image wait, in ms. */
  budgetMs: number;
};

/** Everything the in-page function needs: the caps plus its cancel handle. */
type LazyContentRunArgs = LazyContentCaps & {
  /**
   * Name of the `window` property the page registers its cancel flag on.
   * Unique per call, and removed when the step finishes. The Node side sets
   * it when its own timeout fires, so a page whose frames or timers were
   * suspended cannot scroll once the audit has moved on.
   */
  cancelKey: string;
  /**
   * Absolute time (epoch ms) after which the page must not scroll any more:
   * the moment the Node side stops waiting. Node and the local browser share
   * the system clock, so this holds even when the cancel evaluate never
   * reaches a stalled renderer.
   */
  expiresAt: number;
};

/** Overrides for the caps; every field keeps its default when omitted. */
export type LazyContentOptions = Partial<LazyContentCaps>;

/** What the step did, for tests and debugging. */
export type LazyContentSummary = {
  /** Number of scroll steps taken. */
  steps: number;
  /** True when the bottom of the document was reached before any cap hit. */
  reachedEnd: boolean;
  /** Images still not `complete` when the wait ended. */
  pendingImages: number;
};

const DEFAULT_CAPS: LazyContentCaps = {
  maxScrollPx: 20_000,
  maxSteps: 40,
  stepSettleMs: 100,
  imageWaitMs: 2_000,
  budgetMs: 6_000,
};

/**
 * Grace on top of the in-page budget before the Node side gives up. The page
 * enforces the budget itself; this only covers a page that stops answering.
 */
const NODE_TIMEOUT_GRACE_MS = 1_000;

/** Upper bound for the recovery scroll and the cancel after a failure. */
const RECOVERY_TIMEOUT_MS = 1_000;

/** Tells the Node-side race apart from an error the page itself raised. */
class LazyContentTimeoutError extends Error {}

/**
 * Race `work` against a timeout. The loser keeps running in the browser; we
 * only stop waiting for it.
 */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new LazyContentTimeoutError(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/** Unique per call, so two runs on one page cannot cancel each other. */
function makeCancelKey(): string {
  return `__barrieretestLazyContentCancel_${Math.random().toString(36).slice(2)}`;
}

/**
 * Tell an in-page step that is still running to stop. Used when the Node-side
 * timeout fired: the evaluate keeps running in the browser, and without this
 * flag a frame or timer that resumes later could scroll the page while the
 * next audit step is already measuring it.
 */
async function cancelInPage(page: BrowserPage, cancelKey: string): Promise<void> {
  try {
    await withTimeout(
      page.evaluate((key: string) => {
        const flags = window as unknown as Record<string, boolean>;
        // Only while the flag is registered: the step may have finished and
        // cleaned up while this call was in flight.
        if (key in flags) {
          flags[key] = true;
        }
      }, cancelKey),
      RECOVERY_TIMEOUT_MS,
      "Lazy content cancel timed out"
    );
  } catch {
    // The page is not answering at all; nothing left to try.
  }
}

/**
 * Best-effort return to the top, used when the main step failed. A stalled
 * renderer may run this evaluate after we stopped waiting, so it carries an
 * expiry and does nothing once that has passed.
 */
async function scrollBackToTop(page: BrowserPage): Promise<void> {
  try {
    await withTimeout(
      page.evaluate((expiresAt: number) => {
        if (Date.now() < expiresAt) {
          window.scrollTo({ top: 0, left: 0, behavior: "instant" });
        }
      }, Date.now() + RECOVERY_TIMEOUT_MS),
      RECOVERY_TIMEOUT_MS,
      "Lazy content recovery scroll timed out"
    );
  } catch {
    // Nothing left to try.
  }
}

/**
 * Scroll the page through once so lazy content loads, wait briefly for
 * pending images, and return to the top.
 *
 * Only call this for a page the audit itself navigated — a caller-supplied
 * page is left at the scroll position its owner chose.
 *
 * Never throws: on error or timeout it warns once, scrolls back to the top
 * and returns a zeroed summary.
 */
export async function loadLazyContent(
  page: BrowserPage,
  options: LazyContentOptions = {}
): Promise<LazyContentSummary> {
  const caps: LazyContentCaps = { ...DEFAULT_CAPS, ...options };
  const cancelKey = makeCancelKey();
  const nodeTimeoutMs = caps.budgetMs + NODE_TIMEOUT_GRACE_MS;
  const runArgs: LazyContentRunArgs = {
    ...caps,
    cancelKey,
    expiresAt: Date.now() + nodeTimeoutMs,
  };

  try {
    // One round trip: the loop, the image wait and the scroll back all run
    // inside this single evaluate.
    return await withTimeout(
      page.evaluate(async (run: LazyContentRunArgs) => {
        const flags = window as unknown as Record<string, boolean>;
        flags[run.cancelKey] = false;

        const deadline = Date.now() + run.budgetMs;
        const remaining = () => deadline - Date.now();
        /** Fallback for a single frame wait, so suspended frames cannot stall. */
        const frameWaitCapMs = 50;

        let settled = false;
        /**
         * Nothing may scroll once we are cancelled or done: every wait below
         * can resolve late, and a late continuation must not move a page the
         * audit has already moved on to.
         */
        const mayScroll = () =>
          !settled && flags[run.cancelKey] !== true && Date.now() < run.expiresAt;

        const sleep = (ms: number) =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, Math.max(0, ms));
          });
        // Resolves on the frame or on its own timeout, whichever comes first:
        // a throttled or backgrounded renderer may never run the callback.
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
            setTimeout(finish, Math.max(0, Math.min(remaining(), frameWaitCapMs)));
          });
        const settleStep = async () => {
          await nextFrame();
          await nextFrame();
          await sleep(Math.min(run.stepSettleMs, remaining()));
        };
        const pending = () => Array.from(document.images).filter((image) => !image.complete);

        let steps = 0;
        let reachedEnd = false;
        let position = 0;

        try {
          while (steps < run.maxSteps && remaining() > 0 && mayScroll()) {
            // Re-read on every step: loading content makes the page grow.
            const viewportHeight = window.innerHeight;
            const bottom = Math.max(0, document.documentElement.scrollHeight - viewportHeight);
            const target = Math.min(position + viewportHeight, bottom, run.maxScrollPx);

            if (target <= position) {
              reachedEnd = position >= bottom;
              break;
            }

            window.scrollTo({ top: target, left: 0, behavior: "instant" });
            position = target;
            steps += 1;

            await settleStep();
          }

          const stillLoading = pending();
          if (stillLoading.length > 0 && remaining() > 0 && mayScroll()) {
            const waitMs = Math.max(0, Math.min(run.imageWaitMs, remaining()));
            // Aborting removes every listener still attached, including the
            // load/error twin of one that already fired.
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
                sleep(waitMs),
              ]);
            } finally {
              listeners.abort();
            }
          }

          const pendingImages = pending().length;

          // Ending at the top is an invariant, so this runs even once the
          // budget is spent — but not when Node cancelled us, because it
          // scrolls back to the top itself in that case.
          if (mayScroll()) {
            window.scrollTo({ top: 0, left: 0, behavior: "instant" });
            await nextFrame();
            await nextFrame();
          }

          return { steps, reachedEnd, pendingImages };
        } finally {
          settled = true;
          delete flags[run.cancelKey];
        }
      }, runArgs),
      nodeTimeoutMs,
      `Lazy content loading timed out after ${nodeTimeoutMs}ms`
    );
  } catch (error) {
    console.warn(
      `Lazy content loading failed: ${error instanceof Error ? error.message : "Unknown error"}`
    );
    if (error instanceof LazyContentTimeoutError) {
      // The step may still be mid-sequence in the page: stop it before the
      // recovery scroll, so no later continuation scrolls after this call.
      await cancelInPage(page, cancelKey);
    }
    await scrollBackToTop(page);
    return { steps: 0, reachedEnd: false, pendingImages: 0 };
  }
}
