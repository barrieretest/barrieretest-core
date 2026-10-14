import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BrowserPage } from "./browser.js";
import { loadLazyContent } from "./lazy-content.js";

// biome-ignore lint/suspicious/noExplicitAny: the recorded function mirrors the overloaded evaluate signature
type EvaluateCall = { source: string; arg: unknown; fn: any };

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
      calls.push({ source, arg, fn });

      if (source.includes("requestAnimationFrame")) {
        if (options.hangOnStep) {
          return new Promise(() => {
            // Never settles — stands in for a page that stopped answering.
          });
        }
        return options.onStep?.({ source, arg, fn });
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
    const summary = {
      steps: 3,
      reachedEnd: true,
      pendingImages: 1,
      renderAll: true,
      keptHidden: 2,
    };
    const { page, calls } = makeStubPage({ onStep: () => summary });

    const result = await loadLazyContent(page);

    expect(result).toEqual(summary);
    expect(calls).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  test("passes the caps to the page as an argument, defaults merged with overrides", async () => {
    const { page, calls } = makeStubPage({
      onStep: () => ({
        steps: 0,
        reachedEnd: true,
        pendingImages: 0,
        renderAll: true,
        keptHidden: 0,
      }),
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

    expect(result).toEqual({
      steps: 0,
      reachedEnd: false,
      pendingImages: 0,
      renderAll: false,
      keptHidden: 0,
    });
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

    expect(result).toEqual({
      steps: 0,
      reachedEnd: false,
      pendingImages: 0,
      renderAll: false,
      keptHidden: 0,
    });
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

/**
 * The `content-visibility` override, by running the captured in-page function
 * against a minimal DOM: the stylesheet it adopts and the guard that keeps a
 * late continuation from mutating a page the audit has moved on to.
 */
describe("the step's render-all override", () => {
  const SELECTOR = ":not([hidden]):not([data-barrieretest-keep-hidden])";

  /** Stands in for a constructed `CSSStyleSheet`. */
  type FakeSheet = { text: string; cssRules: unknown[] };
  /** An element the override walk can read a computed value off and mark. */
  type FakeElement = {
    contentVisibility: string;
    marked: boolean;
    setAttribute: (name: string, value: string) => void;
  };

  function makeElement(contentVisibility: string): FakeElement {
    const element: FakeElement = {
      contentVisibility,
      marked: false,
      setAttribute: (name: string) => {
        if (name === "data-barrieretest-keep-hidden") {
          element.marked = true;
        }
      },
    };
    return element;
  }

  /**
   * Just enough `window` and `document` for the step to run under Bun.
   * `onComputedStyle` is called with the number of reads taken so far, so a
   * test can change the world while the scan is walking the document.
   */
  function installFakeDom(
    options: {
      elements?: FakeElement[];
      onComputedStyle?: (reads: number) => void;
      /** Make `replaceSync` throw, as a browser without constructable sheets would. */
      sheetFails?: boolean;
    } = {}
  ) {
    const adopted: FakeSheet[] = [];
    const scrolls: unknown[] = [];
    // One of each case the walk has to tell apart.
    const elements = options.elements ?? [
      makeElement("hidden"),
      makeElement("auto"),
      makeElement("visible"),
    ];
    const globals = globalThis as unknown as Record<string, unknown>;
    const previous = {
      window: globals.window,
      document: globals.document,
      requestAnimationFrame: globals.requestAnimationFrame,
      getComputedStyle: globals.getComputedStyle,
      CSSStyleSheet: globals.CSSStyleSheet,
    };

    globals.window = {
      innerHeight: 720,
      scrollTo: (options?: unknown) => scrolls.push(options),
    };
    globals.document = {
      images: [],
      // Same height as the viewport, so the scroll loop ends immediately and
      // the test is about the override, not about scrolling.
      // The `style` object stands in for a browser that knows the property.
      documentElement: { scrollHeight: 720, style: { contentVisibility: "" } },
      querySelectorAll: () => elements,
    };
    // `adoptedStyleSheets` is assigned a new array by the step; keep the
    // latest one visible to the test through `adopted`.
    Object.defineProperty(globals.document, "adoptedStyleSheets", {
      get: () => adopted,
      set: (sheets: FakeSheet[]) => {
        adopted.splice(0, adopted.length, ...sheets);
      },
    });
    globals.CSSStyleSheet = class {
      text = "";
      cssRules: unknown[] = [];
      replaceSync(text: string) {
        if (options.sheetFails) {
          throw new Error("constructable stylesheets are not supported");
        }
        this.text = text;
        this.cssRules = [text];
      }
    };
    globals.requestAnimationFrame = (callback: (time: number) => void) => {
      callback(0);
      return 0;
    };
    let reads = 0;
    globals.getComputedStyle = (element: FakeElement) => {
      options.onComputedStyle?.(reads);
      reads += 1;
      return { contentVisibility: element.contentVisibility };
    };

    return {
      adopted,
      scrolls,
      elements,
      restore: () => {
        Object.assign(globals, previous);
      },
    };
  }

  /** The in-page step function and the argument it was called with. */
  async function captureStep() {
    const { page, calls } = makeStubPage({
      onStep: () => ({
        steps: 0,
        reachedEnd: true,
        pendingImages: 0,
        renderAll: true,
        keptHidden: 0,
      }),
    });
    await loadLazyContent(page);
    return calls[0];
  }

  test("adopts the stylesheet at most once and reports it as renderAll", async () => {
    const step = await captureStep();
    const dom = installFakeDom();

    try {
      const first = await step.fn({ ...(step.arg as object), expiresAt: Date.now() + 5_000 });

      expect(first.renderAll).toBe(true);
      expect(dom.adopted).toHaveLength(1);
      expect(dom.adopted[0].text).toBe(`${SELECTOR} { content-visibility: visible !important; }`);
      // The override is in place before the step returns to the top, so the
      // layout the screenshot and the annotations see has settled.
      expect(dom.scrolls).toHaveLength(1);

      // A second run on the same page finds its own stylesheet and leaves it.
      const second = await step.fn({ ...(step.arg as object), expiresAt: Date.now() + 5_000 });

      expect(second.renderAll).toBe(true);
      expect(dom.adopted).toHaveLength(1);
      // Nothing left to mark: the elements still hidden were marked before
      // the override that is already in place went in.
      expect(second.keptHidden).toBe(0);
    } finally {
      dom.restore();
    }
  });

  test("marks elements whose computed content-visibility is hidden", async () => {
    const step = await captureStep();
    const dom = installFakeDom();

    try {
      const summary = await step.fn({ ...(step.arg as object), expiresAt: Date.now() + 5_000 });

      // Only the deliberately unrendered element is excluded; `auto` is the
      // case the override exists for.
      expect(dom.elements.map((element) => element.marked)).toEqual([true, false, false]);
      expect(summary.keptHidden).toBe(1);
    } finally {
      dom.restore();
    }
  });

  test("skips the walk when the browser does not know content-visibility", async () => {
    const step = await captureStep();
    const dom = installFakeDom();
    const globals = globalThis as unknown as { document: { documentElement: { style: object } } };
    globals.document.documentElement.style = {};

    try {
      const summary = await step.fn({ ...(step.arg as object), expiresAt: Date.now() + 5_000 });

      expect(summary.keptHidden).toBe(0);
      expect(dom.elements.map((element) => element.marked)).toEqual([false, false, false]);
      // The stylesheet still goes in: its selector needs no support check.
      expect(dom.adopted).toHaveLength(1);
    } finally {
      dom.restore();
    }
  });

  test("abandons the override when the step expires during the hidden-element scan", async () => {
    const step = await captureStep();
    // Enough elements that the scan's periodic check runs several times, so
    // the expiry is caught inside the walk rather than only after it.
    const elements = Array.from({ length: 500 }, () => makeElement("hidden"));
    const realNow = Date.now;
    let now = realNow();
    const expiresAt = now + 5_000;
    let reads = 0;
    const dom = installFakeDom({
      elements,
      // The Node side stops waiting while the scan is reading computed
      // styles: from here on the step may not touch the page at all.
      onComputedStyle: (taken) => {
        reads = taken + 1;
        if (taken === 250) {
          now = expiresAt + 1;
        }
      },
    });
    Date.now = () => now;

    try {
      const summary = await step.fn({ ...(step.arg as object), expiresAt });

      expect(summary.renderAll).toBe(false);
      expect(summary.keptHidden).toBe(0);
      expect(dom.adopted).toEqual([]);
      expect(elements.some((element) => element.marked)).toBe(false);
      expect(dom.scrolls).toEqual([]);
      // The walk gave up at its next check instead of reading every element.
      expect(reads).toBeLessThan(elements.length);
    } finally {
      Date.now = realNow;
      dom.restore();
    }
  });

  test("inserts nothing once the step may no longer touch the page", async () => {
    const step = await captureStep();
    const dom = installFakeDom();

    try {
      // Expired: the Node side has stopped waiting, so this continuation must
      // neither scroll nor mutate the page.
      const summary = await step.fn({ ...(step.arg as object), expiresAt: Date.now() - 1 });

      expect(summary).toEqual({
        steps: 0,
        reachedEnd: false,
        pendingImages: 0,
        renderAll: false,
        keptHidden: 0,
      });
      expect(dom.adopted).toEqual([]);
      expect(dom.scrolls).toEqual([]);
    } finally {
      dom.restore();
    }
  });

  test("reports a stylesheet it cannot build instead of claiming renderAll", async () => {
    const step = await captureStep();
    const dom = installFakeDom({ sheetFails: true });

    try {
      const summary = await step.fn({ ...(step.arg as object), expiresAt: Date.now() + 5_000 });

      expect(summary.renderAll).toBe(false);
      expect(summary.keptHidden).toBe(0);
      expect(String(summary.renderAllError)).toContain("not supported");
      // No marker is left behind when the override never went in.
      expect(dom.elements.some((element) => element.marked)).toBe(false);
      expect(dom.adopted).toEqual([]);
      // The page still returns to the top.
      expect(dom.scrolls).toHaveLength(1);
    } finally {
      dom.restore();
    }
  });
});

describe("loadLazyContent override failure", () => {
  test("warns once and keeps renderAllError out of the summary", async () => {
    const { page } = makeStubPage({
      onStep: () => ({
        steps: 2,
        reachedEnd: true,
        pendingImages: 0,
        renderAll: false,
        keptHidden: 0,
        renderAllError: "constructable stylesheets are not supported",
      }),
    });

    const summary = await loadLazyContent(page);

    expect(summary).toEqual({
      steps: 2,
      reachedEnd: true,
      pendingImages: 0,
      renderAll: false,
      keptHidden: 0,
    });
    expect("renderAllError" in summary).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0][0])).toStartWith("Lazy content could not force rendering");
  });
});
