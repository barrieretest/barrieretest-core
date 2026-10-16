import { createRequire } from "node:module";
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { NavigationResponse, PuppeteerBrowserLike, PuppeteerPageLike } from "./browser.js";
import {
  checkNavigationStatus,
  describeUnnavigatedPage,
  isNavigationHttpError,
  launchPuppeteerSession,
  navigateAndInspect,
  NavigationHttpError,
  parseRetryAfterSeconds,
} from "./puppeteer-launch.js";

/**
 * The browser `launchPuppeteerSession` gets for the next call, set by the
 * launch tests at the bottom of this file.
 */
let launchOverride: (() => Promise<PuppeteerBrowserLike>) | null = null;

/**
 * `launchPuppeteerSession` reaches the launcher through `import("puppeteer")`,
 * and bun can only replace a module that nothing has loaded yet — so the stub
 * is installed here, at the top of the file. With no override set it hands
 * the call to the real launcher, so nothing else in the test process loses
 * Puppeteer; `require` reaches it because the mock shadows every import of
 * the specifier, but not the CommonJS build of the same package.
 */
const requirePuppeteer = createRequire(import.meta.url);

mock.module("puppeteer", () => ({
  launch: async (options: { headless: boolean; args: string[] }) => {
    if (launchOverride) {
      return launchOverride();
    }

    const real = requirePuppeteer("puppeteer") as {
      launch: (options: unknown) => Promise<unknown>;
    };
    return real.launch(options);
  },
}));

function makeFakePage(response: NavigationResponse, currentUrl = "about:blank"): PuppeteerPageLike {
  return {
    goto: async () => response,
    evaluate: async () => undefined,
    screenshot: async () => new Uint8Array(),
    url: () => currentUrl,
    title: async () => "Stub",
    browser: () => ({ newPage: async () => makeFakePage(null) }),
  } as unknown as PuppeteerPageLike;
}

/** Run a body with `console.warn` captured. */
async function withWarnSpy<T>(
  body: () => Promise<T> | T
): Promise<{ result: T; messages: string[] }> {
  const originalWarn = console.warn;
  const messages: string[] = [];
  const warn = mock((...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  });
  console.warn = warn;

  try {
    return { result: await body(), messages };
  } finally {
    console.warn = originalWarn;
  }
}

describe("navigateAndInspect", () => {
  test("reports the status, the final URL and that it navigated", async () => {
    const page = makeFakePage({ status: () => 200 }, "https://ok.example/");

    const { navigation, retryAfterSeconds } = await navigateAndInspect(page, "https://ok.example/");

    expect(navigation).toEqual({
      navigated: true,
      requestedUrl: "https://ok.example/",
      finalUrl: "https://ok.example/",
      status: 200,
      redirected: false,
    });
    expect(retryAfterSeconds).toBeUndefined();
  });

  test("reports a null status when the navigation produced no response", async () => {
    const page = makeFakePage(null, "file:///tmp/page.html");

    const { navigation } = await navigateAndInspect(page, "file:///tmp/page.html");

    expect(navigation.status).toBeNull();
    expect(navigation.navigated).toBe(true);
  });

  test("marks a redirect to another path and keeps the final URL", async () => {
    const page = makeFakePage({ status: () => 200 }, "https://example.test/new");

    const { navigation } = await navigateAndInspect(page, "https://example.test/old");

    expect(navigation.redirected).toBe(true);
    expect(navigation.finalUrl).toBe("https://example.test/new");
    expect(navigation.requestedUrl).toBe("https://example.test/old");
  });

  test("ignores a trailing slash and a default port when judging a redirect", async () => {
    const trailingSlash = makeFakePage({ status: () => 200 }, "https://example.test/docs/");
    expect(
      (await navigateAndInspect(trailingSlash, "https://example.test/docs")).navigation.redirected
    ).toBe(false);

    const defaultPort = makeFakePage({ status: () => 200 }, "https://example.test/docs");
    expect(
      (await navigateAndInspect(defaultPort, "https://example.test:443/docs")).navigation.redirected
    ).toBe(false);
  });

  test("a fragment-only difference is not a redirect, and stays in the final URL", async () => {
    // The browser requests no new document for a fragment, so nothing was
    // redirected — but the caller still sees where the page ended up.
    const page = makeFakePage({ status: () => 200 }, "https://example.test/docs#section");

    const { navigation } = await navigateAndInspect(page, "https://example.test/docs#top");

    expect(navigation.redirected).toBe(false);
    expect(navigation.finalUrl).toBe("https://example.test/docs#section");
  });

  test("reads a numeric Retry-After as seconds", async () => {
    const page = makeFakePage({
      status: () => 429,
      headers: () => ({ "retry-after": "30" }),
    });

    expect((await navigateAndInspect(page, "https://busy.example/")).retryAfterSeconds).toBe(30);
  });
});

describe("parseRetryAfterSeconds", () => {
  test("takes numeric seconds", () => {
    expect(parseRetryAfterSeconds("30")).toBe(30);
    expect(parseRetryAfterSeconds(" 0 ")).toBe(0);
  });

  test("converts an HTTP date into seconds from now, never negative", () => {
    // `Date.now` is fixed, so the result is exact and a loaded machine that
    // pauses between the two calls cannot change it.
    const now = Date.parse("Thu, 16 Oct 2026 12:00:00 GMT");
    const realNow = Date.now;
    Date.now = () => now;

    try {
      expect(parseRetryAfterSeconds("Thu, 16 Oct 2026 12:01:00 GMT")).toBe(60);
      expect(parseRetryAfterSeconds("Thu, 16 Oct 2026 11:59:00 GMT")).toBe(0);
    } finally {
      Date.now = realNow;
    }
  });

  test("is undefined for an absent or unparsable value", () => {
    expect(parseRetryAfterSeconds(undefined)).toBeUndefined();
    expect(parseRetryAfterSeconds("soon")).toBeUndefined();
    expect(parseRetryAfterSeconds("-5")).toBeUndefined();
  });
});

describe("checkNavigationStatus", () => {
  test("warns once and does not throw for an error status by default", async () => {
    const { messages } = await withWarnSpy(() =>
      checkNavigationStatus({
        navigation: {
          navigated: true,
          requestedUrl: "https://blocked.example",
          finalUrl: "https://blocked.example",
          status: 403,
          redirected: false,
        },
      })
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("403");
    expect(messages[0]).toContain("https://blocked.example");
    expect(messages[0]).toContain("auditing the served page");
  });

  test("stays silent for a successful status", async () => {
    const { messages } = await withWarnSpy(() =>
      checkNavigationStatus(
        {
          navigation: {
            navigated: true,
            requestedUrl: "https://ok.example",
            finalUrl: "https://ok.example",
            status: 200,
            redirected: false,
          },
        },
        { failOnHttpError: true }
      )
    );

    expect(messages).toEqual([]);
  });

  test("stays silent for a navigation without a response, even with the option", async () => {
    const { messages } = await withWarnSpy(() =>
      checkNavigationStatus(
        {
          navigation: {
            navigated: true,
            requestedUrl: "file:///tmp/page.html",
            finalUrl: "file:///tmp/page.html",
            status: null,
            redirected: false,
          },
        },
        { failOnHttpError: true }
      )
    );

    expect(messages).toEqual([]);
  });

  test("throws a NavigationHttpError with the option set, and does not warn", async () => {
    let caught: unknown;
    const { messages } = await withWarnSpy(() => {
      try {
        checkNavigationStatus(
          {
            navigation: {
              navigated: true,
              requestedUrl: "https://blocked.example/old",
              finalUrl: "https://blocked.example/new",
              status: 403,
              redirected: true,
            },
          },
          { failOnHttpError: true }
        );
      } catch (error) {
        caught = error;
      }
    });

    expect(messages).toEqual([]);
    expect(isNavigationHttpError(caught)).toBe(true);
    const error = caught as NavigationHttpError;
    expect(error.code).toBe("NAVIGATION_HTTP_ERROR");
    expect(error.status).toBe(403);
    expect(error.url).toBe("https://blocked.example/old");
    expect(error.finalUrl).toBe("https://blocked.example/new");
    expect(error.retryable).toBe(false);
    expect(error.retryAfterSeconds).toBeUndefined();
    expect(error.message).toContain("403");
  });

  test("marks 429 and 503 retryable and carries the retry hint", () => {
    const rateLimited = () =>
      checkNavigationStatus(
        {
          navigation: {
            navigated: true,
            requestedUrl: "https://busy.example/",
            finalUrl: "https://busy.example/",
            status: 429,
            redirected: false,
          },
          retryAfterSeconds: 30,
        },
        { failOnHttpError: true }
      );

    expect(rateLimited).toThrow(NavigationHttpError);
    try {
      rateLimited();
    } catch (error) {
      const navigationError = error as NavigationHttpError;
      expect(navigationError.retryable).toBe(true);
      expect(navigationError.retryAfterSeconds).toBe(30);
    }

    try {
      checkNavigationStatus(
        {
          navigation: {
            navigated: true,
            requestedUrl: "https://down.example/",
            finalUrl: "https://down.example/",
            status: 503,
            redirected: false,
          },
        },
        { failOnHttpError: true }
      );
      throw new Error("expected a NavigationHttpError");
    } catch (error) {
      expect((error as NavigationHttpError).retryable).toBe(true);
      expect((error as NavigationHttpError).retryAfterSeconds).toBeUndefined();
    }
  });
});

describe("isNavigationHttpError", () => {
  test("recognises a plain object carrying the code, as a duplicated module copy would throw", () => {
    expect(
      isNavigationHttpError({
        code: "NAVIGATION_HTTP_ERROR",
        status: 403,
        url: "https://blocked.example/",
      })
    ).toBe(true);
  });

  test("rejects other errors", () => {
    expect(isNavigationHttpError(new Error("Target returned HTTP 403"))).toBe(false);
    expect(isNavigationHttpError(undefined)).toBe(false);
    expect(isNavigationHttpError({ code: "NAVIGATION_HTTP_ERROR" })).toBe(false);
  });
});

describe("describeUnnavigatedPage", () => {
  test("reports that nothing was navigated and no status exists", () => {
    expect(describeUnnavigatedPage("https://example.test/", "https://example.test/")).toEqual({
      navigated: false,
      requestedUrl: "https://example.test/",
      finalUrl: "https://example.test/",
      status: null,
      redirected: false,
    });
  });
});

describe("launchPuppeteerSession", () => {
  /**
   * A launcher whose browser records its `close()` and fails in exactly one
   * setup step, so each step can be shown to clean up after itself.
   */
  function stubPuppeteer(failingStep: "newPage" | "setUserAgent" | "setViewport" | null) {
    const failure = new Error(`${failingStep} rejected`);
    const state = { closed: 0, viewports: [] as { width: number; height: number }[] };

    const page = {
      ...makeFakePage(null),
      setUserAgent: async () => {
        if (failingStep === "setUserAgent") throw failure;
      },
      setViewport: async (viewport: { width: number; height: number }) => {
        if (failingStep === "setViewport") throw failure;
        state.viewports.push(viewport);
      },
    };

    const browser = {
      newPage: async () => {
        if (failingStep === "newPage") throw failure;
        return page;
      },
      close: async () => {
        state.closed += 1;
      },
    };

    launchOverride = async () => browser as unknown as PuppeteerBrowserLike;

    return { failure, state };
  }

  afterEach(() => {
    launchOverride = null;
  });

  for (const step of ["newPage", "setUserAgent", "setViewport"] as const) {
    test(`closes the browser and rethrows the original error when ${step} fails`, async () => {
      const { failure, state } = stubPuppeteer(step);

      let caught: unknown;
      try {
        await launchPuppeteerSession();
      } catch (error) {
        caught = error;
      }

      // The caller never sees the browser, so only this helper can close it.
      expect(caught).toBe(failure);
      expect(state.closed).toBe(1);
    });
  }

  test("returns the session and leaves the browser open when setup succeeds", async () => {
    const { state } = stubPuppeteer(null);

    const session = await launchPuppeteerSession({ viewport: { width: 800, height: 600 } });

    expect(session.page).toBeDefined();
    expect(state.viewports).toEqual([{ width: 800, height: 600 }]);
    expect(state.closed).toBe(0);
  });
});
