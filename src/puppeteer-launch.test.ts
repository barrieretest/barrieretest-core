import { createRequire } from "node:module";
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { NavigationResponse, PuppeteerBrowserLike, PuppeteerPageLike } from "./browser.js";
import {
  buildLaunchArgs,
  checkNavigationStatus,
  describeUnnavigatedPage,
  isNavigationHttpError,
  isNavigationNetworkError,
  launchPuppeteerSession,
  navigateAndInspect,
  NavigationHttpError,
  type NavigationNetworkError,
  parseRetryAfterSeconds,
} from "./puppeteer-launch.js";

/**
 * The browser `launchPuppeteerSession` gets for the next call, set by the
 * launch tests at the bottom of this file.
 */
let launchOverride:
  | ((options: { headless: boolean; args: string[] }) => Promise<PuppeteerBrowserLike>)
  | null = null;

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
      return launchOverride(options);
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
    const state = {
      closed: 0,
      viewports: [] as { width: number; height: number }[],
      args: [] as string[],
    };

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

    launchOverride = async (options) => {
      state.args = options.args;
      return browser as unknown as PuppeteerBrowserLike;
    };

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

  test("launches with the shared defaults, and with the proxy arguments when asked", async () => {
    const { state } = stubPuppeteer(null);

    await launchPuppeteerSession();
    expect(state.args).toEqual(DEFAULT_ARGS);

    await launchPuppeteerSession({ browser: { proxyServer: "http://127.0.0.1:4750" } });
    expect(state.args).toEqual([
      ...DEFAULT_ARGS,
      "--proxy-server=http://127.0.0.1:4750",
      "--proxy-bypass-list=<-loopback>",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    ]);
  });

  test("rejects a contradicting extra argument before it starts a browser", async () => {
    const { state } = stubPuppeteer(null);

    await expect(
      launchPuppeteerSession({
        browser: { proxyServer: "http://127.0.0.1:4750", extraArgs: ["--no-proxy-server"] },
      })
    ).rejects.toThrow("--no-proxy-server");

    expect(state.args).toEqual([]);
  });

  test("rejects a proxy that was supplied but empty before it starts a browser", async () => {
    const { state } = stubPuppeteer(null);

    await expect(launchPuppeteerSession({ browser: { proxyServer: "" } })).rejects.toThrow(
      "supplied but empty"
    );

    expect(state.args).toEqual([]);
  });
});

/**
 * The argument list every launch path starts from. Spelled out rather than
 * imported, so a change to the module's own list has to be made here too
 * (invariant 2: without the option, launching is what it was).
 */
const DEFAULT_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
];

describe("buildLaunchArgs", () => {
  test("without options it is exactly the defaults, and the pa11y base is left alone", () => {
    expect(buildLaunchArgs(undefined)).toEqual(DEFAULT_ARGS);
    expect(buildLaunchArgs({})).toEqual(DEFAULT_ARGS);
    // The pa11y engine passes its own base list, which `chromeArgs` replaces.
    expect(buildLaunchArgs(undefined, ["--window-size=800,600"])).toEqual([
      "--window-size=800,600",
    ]);
  });

  test("appends extra arguments after the base list, with no proxy involved", () => {
    expect(buildLaunchArgs({ extraArgs: ["--lang=de", "--mute-audio"] })).toEqual([
      ...DEFAULT_ARGS,
      "--lang=de",
      "--mute-audio",
    ]);
  });

  test("adds the proxy, the removed loopback bypass and the WebRTC policy, extras last", () => {
    expect(
      buildLaunchArgs({ proxyServer: "http://127.0.0.1:4750", extraArgs: ["--lang=de"] }, [
        "--window-size=800,600",
      ])
    ).toEqual([
      "--window-size=800,600",
      "--proxy-server=http://127.0.0.1:4750",
      "--proxy-bypass-list=<-loopback>",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--lang=de",
    ]);
  });

  test("accepts http, https and socks proxies", () => {
    for (const proxyServer of [
      "http://proxy.internal:3128",
      "https://proxy.internal:3128",
      "socks5://127.0.0.1:1080",
    ]) {
      expect(buildLaunchArgs({ proxyServer })).toContain(`--proxy-server=${proxyServer}`);
    }
  });

  test("rejects a proxy that is not a URL with a supported scheme", () => {
    expect(() => buildLaunchArgs({ proxyServer: "127.0.0.1:4750" })).toThrow(
      "must be a URL with an explicit scheme"
    );
    expect(() => buildLaunchArgs({ proxyServer: "ftp://proxy.internal:21" })).toThrow(
      "is not supported"
    );
    expect(() => buildLaunchArgs({ proxyServer: "socks5://" })).toThrow("names no host");
  });

  test("rejects a proxy value that is a rule list rather than one endpoint", () => {
    // Chromium splits the switch value on commas and semicolons and reads
    // `direct://` as a direct route, so either of these would reopen the hole
    // the option closes.
    for (const proxyServer of [
      "http://proxy/,direct://",
      "http://a:1;https=direct://",
      "http://proxy:1 ,direct://",
      "http://proxy:1,\tdirect://",
      // `URL` percent-decodes a host, so this would reach Chromium as
      // `http://proxy,:1` — two rules again.
      "http://proxy%2C:1",
      // `=` starts a per-scheme rule; the schemes it does not name go direct.
      "http://http=proxy:4750",
      "http://http%3Dproxy:4750",
    ]) {
      expect(() => buildLaunchArgs({ proxyServer })).toThrow("must be a single proxy URL");
    }
  });

  test("rejects a proxy URL that carries anything but a scheme, host and port", () => {
    expect(() => buildLaunchArgs({ proxyServer: "http://user:pw@proxy:1" })).toThrow(
      "without credentials"
    );

    for (const proxyServer of ["http://proxy:1/path", "http://proxy:1/?a=b", "http://proxy:1#x"]) {
      expect(() => buildLaunchArgs({ proxyServer })).toThrow("without a path, query or fragment");
    }
  });

  test("hands Chromium the parsed endpoint, not the caller's string", () => {
    // An IPv6 literal keeps its brackets, and the trailing slash `URL` gives
    // an http(s) URL is dropped: the value is rebuilt from scheme and host.
    expect(buildLaunchArgs({ proxyServer: "http://[::1]:4750" })).toContain(
      "--proxy-server=http://[::1]:4750"
    );
    expect(buildLaunchArgs({ proxyServer: "http://127.0.0.1:4750/" })).toContain(
      "--proxy-server=http://127.0.0.1:4750"
    );
  });

  test("rejects every extra argument that would undo the proxy, with or without a value", () => {
    const contradicting = [
      "--proxy-server=http://elsewhere:3128",
      "--proxy-bypass-list=<local>",
      "--no-proxy-server",
      "--proxy-pac-url=http://elsewhere/pac",
      "--proxy-auto-detect",
      "--host-resolver-rules=MAP * 127.0.0.1",
      "--host-rules=MAP * 127.0.0.1",
    ];

    for (const argument of contradicting) {
      expect(() =>
        buildLaunchArgs({ proxyServer: "http://127.0.0.1:4750", extraArgs: [argument] })
      ).toThrow(argument);
    }

    // Without a proxy there is nothing to contradict: the caller owns the
    // browser's networking either way.
    expect(buildLaunchArgs({ extraArgs: ["--no-proxy-server"] })).toEqual([
      ...DEFAULT_ARGS,
      "--no-proxy-server",
    ]);
  });

  test("rejects a contradicting argument however Chromium would still read it", async () => {
    // One dash, three dashes and a different case are all the same switch to
    // Chromium, and the WebRTC policy must not be overridden either.
    const spellings = [
      "-proxy-bypass-list=*",
      "---no-proxy-server",
      "--Proxy-Server=http://elsewhere:3128",
      "--force-webrtc-ip-handling-policy=default",
    ];

    for (const argument of spellings) {
      expect(() =>
        buildLaunchArgs({ proxyServer: "http://127.0.0.1:4750", extraArgs: [argument] })
      ).toThrow(argument);
    }
  });

  test("rejects the argument terminator, which would make core's switches positional", () => {
    expect(() =>
      buildLaunchArgs({
        proxyServer: "http://127.0.0.1:4750",
        extraArgs: ["--", "--no-proxy-server"],
      })
    ).toThrow("argument terminator");

    // Without a proxy the caller's argument list is their own business.
    expect(buildLaunchArgs({ extraArgs: ["--"] })).toEqual([...DEFAULT_ARGS, "--"]);
  });

  test("rejects a contradicting base argument, which pa11y's chromeArgs supplies", () => {
    expect(() =>
      buildLaunchArgs({ proxyServer: "http://127.0.0.1:4750" }, [
        "--no-sandbox",
        "--no-proxy-server",
      ])
    ).toThrow("--no-proxy-server");

    expect(() =>
      buildLaunchArgs({ proxyServer: "http://127.0.0.1:4750" }, ["--", "--no-sandbox"])
    ).toThrow("argument terminator");
  });

  test("rejects a proxy that was supplied but empty, instead of launching without one", () => {
    for (const proxyServer of ["", "   ", "\t"]) {
      expect(() => buildLaunchArgs({ proxyServer })).toThrow("supplied but empty");
    }

    // Leaving the option out is the only way to launch without a proxy.
    expect(buildLaunchArgs({ proxyServer: undefined })).toEqual(DEFAULT_ARGS);
  });
});

describe("navigateAndInspect network failures", () => {
  /** A page whose `goto` fails the way the drivers report a net error. */
  function failingPage(message: string, name = "Error"): PuppeteerPageLike {
    const error = new Error(message);
    error.name = name;
    return {
      goto: async () => {
        throw error;
      },
      url: () => "about:blank",
      browser: () => ({ newPage: async () => makeFakePage(null) }),
    } as unknown as PuppeteerPageLike;
  }

  /** Catch the error of a navigation that must fail with a network error. */
  async function expectNetworkError(promise: Promise<unknown>): Promise<NavigationNetworkError> {
    let caught: unknown;
    try {
      await promise;
    } catch (error) {
      caught = error;
    }

    expect(isNavigationNetworkError(caught)).toBe(true);
    return caught as NavigationNetworkError;
  }

  test("maps a DNS failure without a proxy, keeping the driver error as the cause", async () => {
    const page = failingPage("net::ERR_NAME_NOT_RESOLVED at http://nope.invalid/");

    const error = await expectNetworkError(navigateAndInspect(page, "http://nope.invalid/"));

    expect(error.code).toBe("NAVIGATION_NETWORK_ERROR");
    expect(error.netError).toBe("ERR_NAME_NOT_RESOLVED");
    expect(error.url).toBe("http://nope.invalid/");
    expect(error.retryable).toBe(false);
    // No proxy was configured, so nothing is claimed about one.
    expect(error.refusedByProxy).toBeUndefined();
    expect(error.proxyStatus).toBeUndefined();
    expect((error.cause as Error)?.message).toContain("ERR_NAME_NOT_RESOLVED");
  });

  test("tells a proxy refusal apart from a tunnel that says nothing", async () => {
    const browser = { proxyServer: "http://127.0.0.1:4750" };

    const refused = await expectNetworkError(
      navigateAndInspect(
        failingPage("net::ERR_PROXY_AUTH_UNSUPPORTED at https://blocked.example/"),
        "https://blocked.example/",
        { browser }
      )
    );
    expect(refused.netError).toBe("ERR_PROXY_AUTH_UNSUPPORTED");
    expect(refused.refusedByProxy).toBe(true);
    expect(refused.retryable).toBe(false);
    expect(refused.message).toContain("refused the destination");

    const tunnel = await expectNetworkError(
      navigateAndInspect(
        failingPage("net::ERR_TUNNEL_CONNECTION_FAILED at https://typo.exmaple/"),
        "https://typo.exmaple/",
        { browser }
      )
    );
    expect(tunnel.netError).toBe("ERR_TUNNEL_CONNECTION_FAILED");
    // A tunnel failure is a typo'd domain, a destination that refused the
    // connection, a timeout — or a proxy refusing with a status Chromium does
    // not expose (A2): neither "refused" nor "not refused" is claimed.
    expect(tunnel.refusedByProxy).toBeUndefined();
    expect(tunnel.retryable).toBe(false);
    expect(tunnel.message).toContain("cannot see why");
  });

  test("a failure behind the proxy that is not the tunnel is not a refusal", async () => {
    const browser = { proxyServer: "http://127.0.0.1:4750" };

    // The tunnel was open, so the failure is the destination's own.
    for (const netError of [
      "ERR_CERT_AUTHORITY_INVALID",
      "ERR_TIMED_OUT",
      "ERR_CONNECTION_RESET",
    ]) {
      const error = await expectNetworkError(
        navigateAndInspect(
          failingPage(`net::${netError} at https://example.test/`),
          "https://example.test/",
          { browser }
        )
      );
      expect(error.netError).toBe(netError);
      expect(error.refusedByProxy).toBe(false);
    }
  });

  test("an unreachable proxy is retryable and not a refusal", async () => {
    const error = await expectNetworkError(
      navigateAndInspect(
        failingPage("net::ERR_PROXY_CONNECTION_FAILED at https://example.test/"),
        "https://example.test/",
        { browser: { proxyServer: "http://127.0.0.1:1" } }
      )
    );

    expect(error.netError).toBe("ERR_PROXY_CONNECTION_FAILED");
    expect(error.retryable).toBe(true);
    expect(error.refusedByProxy).toBe(false);
  });

  test("a timeout or a reset is retryable, an unknown name is not", async () => {
    const reset = await expectNetworkError(
      navigateAndInspect(
        failingPage("net::ERR_CONNECTION_RESET at https://example.test/"),
        "https://example.test/"
      )
    );
    expect(reset.retryable).toBe(true);

    const unknown = await expectNetworkError(
      navigateAndInspect(
        failingPage("net::ERR_SOMETHING_NEW at https://example.test/"),
        "https://example.test/"
      )
    );
    expect(unknown.netError).toBe("ERR_SOMETHING_NEW");
    expect(unknown.retryable).toBe(false);
  });

  test("keeps the failing URL when the browser blamed another one", async () => {
    const error = await expectNetworkError(
      navigateAndInspect(
        failingPage("net::ERR_CONNECTION_REFUSED at http://elsewhere.test/moved"),
        "http://example.test/old"
      )
    );

    expect(error.url).toBe("http://example.test/old");
    expect(error.failedUrl).toBe("http://elsewhere.test/moved");
    expect(error.message).toContain("http://elsewhere.test/moved");
  });

  test("leaves a navigation timeout exactly as it was", async () => {
    const page = failingPage("Navigation timeout of 30000 ms exceeded", "TimeoutError");

    let caught: unknown;
    try {
      await navigateAndInspect(page, "https://slow.example/", {
        browser: { proxyServer: "http://127.0.0.1:4750" },
      });
    } catch (error) {
      caught = error;
    }

    // The page may well have loaded: this is not a network failure (A3).
    expect(isNavigationNetworkError(caught)).toBe(false);
    expect((caught as Error).name).toBe("TimeoutError");
  });
});

describe("navigateAndInspect and the proxy's own answer", () => {
  const PROXY_HEADER = "X-Smokescreen-Error";

  function pageAnswering(status: number, headers: Record<string, string>): PuppeteerPageLike {
    return makeFakePage(
      { status: () => status, headers: () => headers },
      "http://blocked.example/"
    );
  }

  async function expectProxyError(promise: Promise<unknown>): Promise<NavigationNetworkError> {
    let caught: unknown;
    try {
      await promise;
    } catch (error) {
      caught = error;
    }
    expect(isNavigationNetworkError(caught)).toBe(true);
    return caught as NavigationNetworkError;
  }

  test("a 407 carrying the header is a refusal, not the site's status", async () => {
    const error = await expectProxyError(
      navigateAndInspect(
        pageAnswering(407, { "x-smokescreen-error": "  Request rejected by proxy  " }),
        "http://blocked.example/",
        { browser: { proxyServer: "http://127.0.0.1:4750", proxyErrorHeader: PROXY_HEADER } }
      )
    );

    expect(error.netError).toBeNull();
    expect(error.proxyStatus).toBe(407);
    expect(error.refusedByProxy).toBe(true);
    expect(error.retryable).toBe(false);
    // The proxy's message is for the reader, not a field to parse.
    expect(error.message).toContain("Request rejected by proxy");
    expect(error.message).not.toContain("  Request");
  });

  test("a 502 is the proxy failing to reach the destination, a 429 and a 504 are retryable", async () => {
    const browser = { proxyServer: "http://127.0.0.1:4750", proxyErrorHeader: PROXY_HEADER };

    const failed = await expectProxyError(
      navigateAndInspect(
        pageAnswering(502, { "x-smokescreen-error": "no such host" }),
        "http://typo.exmaple/",
        { browser }
      )
    );
    expect(failed.proxyStatus).toBe(502);
    expect(failed.refusedByProxy).toBe(false);
    expect(failed.retryable).toBe(false);

    for (const status of [429, 504]) {
      const transient = await expectProxyError(
        navigateAndInspect(
          pageAnswering(status, { "x-smokescreen-error": "busy" }),
          "http://busy.example/",
          { browser }
        )
      );
      expect(transient.retryable).toBe(true);
      expect(transient.refusedByProxy).toBe(false);
    }
  });

  test("claims nothing about a proxy when only the header is configured", async () => {
    const error = await expectProxyError(
      navigateAndInspect(
        pageAnswering(407, { "x-smokescreen-error": "Request rejected by proxy" }),
        "http://blocked.example/",
        { browser: { proxyErrorHeader: PROXY_HEADER } }
      )
    );

    // The answer is still the proxy's, so it throws with its status — but
    // `refusedByProxy` is documented as absent without a configured proxy.
    expect(error.netError).toBeNull();
    expect(error.proxyStatus).toBe(407);
    expect(error.refusedByProxy).toBeUndefined();
    expect(error.message).toContain("refused the destination");
  });

  test("a response without the header, and a run without the option, are audited as usual", async () => {
    const siteOwn403 = await navigateAndInspect(
      pageAnswering(403, { "content-type": "text/html" }),
      "http://blocked.example/",
      { browser: { proxyServer: "http://127.0.0.1:4750", proxyErrorHeader: PROXY_HEADER } }
    );
    expect(siteOwn403.navigation.status).toBe(403);

    // Without the option the header means nothing to core.
    const unconfigured = await navigateAndInspect(
      pageAnswering(407, { "x-smokescreen-error": "Request rejected by proxy" }),
      "http://blocked.example/"
    );
    expect(unconfigured.navigation.status).toBe(407);
  });
});

describe("isNavigationNetworkError", () => {
  test("recognises a plain object carrying the code, as a duplicated module copy would throw", () => {
    expect(
      isNavigationNetworkError({
        code: "NAVIGATION_NETWORK_ERROR",
        netError: "ERR_TUNNEL_CONNECTION_FAILED",
        url: "https://blocked.example/",
      })
    ).toBe(true);
    // `netError` is null for a proxy's own HTTP answer.
    expect(
      isNavigationNetworkError({
        code: "NAVIGATION_NETWORK_ERROR",
        netError: null,
        url: "http://blocked.example/",
      })
    ).toBe(true);
  });

  test("rejects other errors", () => {
    expect(isNavigationNetworkError(new Error("net::ERR_TUNNEL_CONNECTION_FAILED"))).toBe(false);
    expect(isNavigationNetworkError(undefined)).toBe(false);
    expect(isNavigationNetworkError({ code: "NAVIGATION_NETWORK_ERROR" })).toBe(false);
    expect(isNavigationNetworkError({ code: "NAVIGATION_HTTP_ERROR", status: 403, url: "x" })).toBe(
      false
    );
  });
});
