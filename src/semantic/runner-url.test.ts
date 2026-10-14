import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AIProvider } from "../ai/types.js";
import type { PuppeteerPageLike } from "../browser.js";

/**
 * `runSemanticAuditOnUrl` is the one semantic path that navigates itself, so
 * it is the one that loads lazy content. Both the browser session and the AI
 * provider are stubbed: the test only observes what the page was asked to do.
 */

/** Sources of every `page.evaluate` of the current run. */
let evaluateSources: string[] = [];

const stubPage = {
  url: () => "https://stub.test/page",
  title: async () => "Stub",
  goto: async () => null,
  browser: () => ({ newPage: async () => stubPage }),
  setViewport: async () => undefined,
  screenshot: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  // biome-ignore lint/suspicious/noExplicitAny: test stub mirrors the overloaded evaluate signature
  evaluate: async (fn: any) => {
    const source = String(fn);
    evaluateSources.push(source);
    if (source.includes("requestAnimationFrame")) {
      return { steps: 2, reachedEnd: true, pendingImages: 0 };
    }
    // Everything else is context extraction or cookie-banner probing; the
    // extracted-context shape satisfies both.
    return {
      pageTitle: "Stub",
      langAttr: "en",
      headSnippet: "",
      bodySnippet: "<body></body>",
      ariaElements: [],
      formElements: [],
      images: [],
      landmarks: [],
    };
  },
  // biome-ignore lint/suspicious/noExplicitAny: the stub only needs the members the runner uses
} as any as PuppeteerPageLike;

const stubProvider: AIProvider = {
  name: "stub",
  model: "stub-model",
  async analyze() {
    return { contextualAnalysis: "n/a", suggestedFix: "n/a", confidence: 1 };
  },
  async analyzeSemantic() {
    return {
      content: JSON.stringify({ issues: [], detectedLanguage: "en" }),
      model: "stub-model",
    };
  },
};

// Captured by value: `mock.module` replaces the bindings of the live module
// namespace, so a namespace object kept around would come back carrying the
// stubs and leak them into the test files that run after this one.
const realAi = await import("../ai/index.js");
const realCreateProvider = realAi.createProvider;
const realPuppeteerLaunchModule = await import("../puppeteer-launch.js");
const realPuppeteerLaunch = {
  launchPuppeteerSession: realPuppeteerLaunchModule.launchPuppeteerSession,
  navigateTo: realPuppeteerLaunchModule.navigateTo,
  closeSession: realPuppeteerLaunchModule.closeSession,
};

mock.module("../ai/index.js", () => ({
  ...realAi,
  createProvider: () => stubProvider,
}));

mock.module("../puppeteer-launch.js", () => ({
  ...realPuppeteerLaunch,
  launchPuppeteerSession: async () => ({
    browser: { close: async () => undefined },
    page: stubPage,
  }),
  navigateTo: async () => undefined,
  closeSession: async () => undefined,
}));

const { runSemanticAuditOnUrl } = await import("./runner.js");

afterAll(() => {
  mock.module("../ai/index.js", () => ({ ...realAi, createProvider: realCreateProvider }));
  mock.module("../puppeteer-launch.js", () => realPuppeteerLaunch);
});

beforeEach(() => {
  evaluateSources = [];
});

const lazyCalls = () =>
  evaluateSources.filter((source) => source.includes("requestAnimationFrame")).length;

describe("runSemanticAuditOnUrl lazy-content step", () => {
  test("loads lazy content once on the page it launched", async () => {
    const result = await runSemanticAuditOnUrl("https://stub.test/page", {
      provider: { name: "nebius", apiKey: "stub" },
      checks: ["aria-mismatch"],
    });

    expect(result.url).toBe("https://stub.test/page");
    expect(lazyCalls()).toBe(1);
  });

  test("skips the step when loadLazyContent is false", async () => {
    await runSemanticAuditOnUrl("https://stub.test/page", {
      provider: { name: "nebius", apiKey: "stub" },
      checks: ["aria-mismatch"],
      loadLazyContent: false,
    });

    expect(lazyCalls()).toBe(0);
  });
});
