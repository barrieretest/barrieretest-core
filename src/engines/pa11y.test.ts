import { describe, expect, mock, test } from "bun:test";
import type { PuppeteerPageLike } from "../browser.js";

// The engine imports pa11y dynamically; the stub keeps the run offline and
// lets the test observe what the engine did to the page before pa11y ran.
// `mock.module` is process-wide and this one is never restored, because
// restoring would mean importing the real pa11y — no other unit test runs it.
mock.module("pa11y", () => ({
  default: async (url: string) => ({
    issues: [],
    documentTitle: "Stub",
    pageUrl: url,
  }),
}));

const { runPa11y } = await import("./pa11y.js");

/**
 * Puppeteer-shaped stub page that records the source of every `evaluate`.
 * The lazy-content step is the only call that waits for animation frames, so
 * its source identifies it among the cookie-banner calls.
 */
function makeStubPage(): { page: PuppeteerPageLike; evaluateSources: string[] } {
  const evaluateSources: string[] = [];
  const page = {
    url: () => "https://example.test/",
    title: async () => "Stub",
    goto: async () => null,
    browser: () => ({ newPage: async () => page }),
    screenshot: async () => new Uint8Array(),
    setViewport: async () => undefined,
    // biome-ignore lint/suspicious/noExplicitAny: test stub mirrors the overloaded evaluate signature
    evaluate: async (fn: any) => {
      const source = String(fn);
      evaluateSources.push(source);
      if (source.includes("requestAnimationFrame")) {
        return { steps: 1, reachedEnd: true, pendingImages: 0 };
      }
      return undefined;
    },
    // biome-ignore lint/suspicious/noExplicitAny: the stub only needs the members the engine uses
  } as any;

  return { page, evaluateSources };
}

const lazyCalls = (sources: string[]) =>
  sources.filter((source) => source.includes("requestAnimationFrame")).length;

describe("runPa11y lazy-content step", () => {
  test("loads lazy content once, because this engine always navigates", async () => {
    const { page, evaluateSources } = makeStubPage();

    const messages: string[] = [];
    // The page is already at the target URL, and pa11y navigates to it
    // regardless — so the step runs even for a caller-supplied page.
    await runPa11y("https://example.test/", {
      page,
      onProgress: ({ message }) => {
        messages.push(message);
      },
    });

    expect(lazyCalls(evaluateSources)).toBe(1);
    expect(messages).toContain("Loading lazy content");
  });

  test("skips the step when loadLazyContent is false", async () => {
    const { page, evaluateSources } = makeStubPage();

    await runPa11y("https://example.test/", { page, loadLazyContent: false });

    expect(lazyCalls(evaluateSources)).toBe(0);
  });
});
