import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BrowserPage } from "./browser.js";
import { loadLazyContent } from "./lazy-content.js";

type EvaluateCall = { source: string; arg: unknown };

/**
 * Stub page that records every `page.evaluate` and routes by the source of
 * the passed function, the way the real browser distinguishes the calls this
 * module can make: the scroll-and-wait step (the only one that uses
 * `requestAnimationFrame`), the cancel flag and the recovery scroll after a
 * failure.
 */
function makeStubPage(options: {
  onStep?: (call: EvaluateCall) => unknown;
  hangOnStep?: boolean;
}): { page: BrowserPage; calls: EvaluateCall[] } {
  const calls: EvaluateCall[] = [];
  const page = {
    url: () => "https://example.test/",
    title: async () => "Stub",
    goto: async () => undefined,
    screenshot: async () => new Uint8Array(),
    // biome-ignore lint/suspicious/noExplicitAny: test stub mirrors the overloaded evaluate signature
    evaluate: async (fn: any, arg: unknown) => {
      const source = String(fn);
      calls.push({ source, arg });

      if (source.includes("requestAnimationFrame")) {
        if (options.hangOnStep) {
          return new Promise(() => {
            // Never settles — stands in for a page that stopped answering.
          });
        }
        return options.onStep?.({ source, arg });
      }

      return undefined;
    },
  } as unknown as BrowserPage;

  return { page, calls };
}

let warnings: unknown[][];
let restoreWarn: () => void;

beforeEach(() => {
  const original = console.warn;
  warnings = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  restoreWarn = () => {
    console.warn = original;
  };
});

afterEach(() => {
  restoreWarn();
});

describe("loadLazyContent", () => {
  test("runs the whole step in a single evaluate and returns the page summary", async () => {
    const summary = { steps: 3, reachedEnd: true, pendingImages: 1 };
    const { page, calls } = makeStubPage({ onStep: () => summary });

    const result = await loadLazyContent(page);

    expect(result).toEqual(summary);
    expect(calls).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  test("passes the caps to the page as an argument, defaults merged with overrides", async () => {
    const { page, calls } = makeStubPage({
      onStep: () => ({ steps: 0, reachedEnd: true, pendingImages: 0 }),
    });

    await loadLazyContent(page, { maxSteps: 2, budgetMs: 500 });

    const before = Date.now();
    const { cancelKey, expiresAt, ...caps } = calls[0].arg as Record<string, unknown>;
    expect(caps).toEqual({
      maxScrollPx: 20_000,
      maxSteps: 2,
      stepSettleMs: 100,
      imageWaitMs: 2_000,
      budgetMs: 500,
    });
    // The page registers its cancel flag under this name, so the Node side
    // can stop a step that outlived the timeout.
    expect(String(cancelKey)).toStartWith("__barrieretestLazyContentCancel_");
    // The page stops scrolling on its own once Node stops waiting (budget
    // plus grace), even if the cancel evaluate never reaches it.
    expect(typeof expiresAt).toBe("number");
    expect(expiresAt as number).toBeGreaterThan(before);
    expect(expiresAt as number).toBeLessThanOrEqual(before + 500 + 1_000);
    // The in-page function reads its caps from that argument only, so no
    // Node-scope value can leak into the browser.
    expect(calls[0].source).toContain("run.maxSteps");
  });

  test("warns once and scrolls back to the top when the page throws", async () => {
    const { page, calls } = makeStubPage({
      onStep: () => {
        throw new Error("Execution context was destroyed");
      },
    });

    const result = await loadLazyContent(page);

    expect(result).toEqual({ steps: 0, reachedEnd: false, pendingImages: 0 });
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0][0])).toStartWith("Lazy content");
    expect(String(warnings[0][0])).toContain("Execution context was destroyed");

    // Second and last evaluate is the recovery scroll, without the step's
    // frame waits: a step that failed is no longer running, so there is
    // nothing to cancel in the page.
    expect(calls).toHaveLength(2);
    expect(calls[1].source).toContain("scrollTo");
    expect(calls[1].source).not.toContain("requestAnimationFrame");
  });

  test("gives up on a page that never answers, with one warning", async () => {
    const { page, calls } = makeStubPage({ hangOnStep: true });

    const started = Date.now();
    const result = await loadLazyContent(page, { budgetMs: 10 });
    const elapsed = Date.now() - started;

    expect(result).toEqual({ steps: 0, reachedEnd: false, pendingImages: 0 });
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0][0])).toStartWith("Lazy content");
    expect(String(warnings[0][0])).toContain("timed out");
    // The Node-side race, not the in-page budget, ended the wait.
    expect(elapsed).toBeLessThan(5_000);

    // On a timeout the step may still be running in the page, so the cancel
    // flag is set before the recovery scroll: a continuation that wakes up
    // later must not scroll a page the audit has moved on to.
    expect(calls).toHaveLength(3);
    const cancelKey = (calls[0].arg as { cancelKey: string }).cancelKey;
    expect(calls[1].arg).toBe(cancelKey);
    expect(calls[1].source).not.toContain("scrollTo");
    expect(calls[2].source).toContain("scrollTo");
  }, 10_000);

  test("a recovery scroll the renderer runs after we gave up does not scroll", async () => {
    const scrolls: unknown[] = [];
    const globals = globalThis as unknown as { window?: unknown };
    const previousWindow = globals.window;
    globals.window = { scrollTo: (...args: unknown[]) => scrolls.push(args) };

    try {
      const page = {
        url: () => "https://example.test/",
        title: async () => "Stub",
        goto: async () => undefined,
        screenshot: async () => new Uint8Array(),
        // biome-ignore lint/suspicious/noExplicitAny: test stub mirrors the overloaded evaluate signature
        evaluate: (fn: any, arg: unknown) => {
          const source = String(fn);
          if (source.includes("requestAnimationFrame")) {
            return Promise.reject(new Error("Execution context was destroyed"));
          }
          // A stalled renderer: the recovery evaluate runs only after the
          // Node side has stopped waiting for it.
          return new Promise((resolve) => {
            setTimeout(() => resolve(fn(arg)), 1_300);
          });
        },
      } as unknown as BrowserPage;

      await loadLazyContent(page);
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(scrolls).toEqual([]);
    } finally {
      globals.window = previousWindow;
    }
  }, 10_000);
});
