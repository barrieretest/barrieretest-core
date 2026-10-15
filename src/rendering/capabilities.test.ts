/**
 * The adapter against stub pages. Playwright is not a dependency of the test
 * run, so its side is exercised through a page object with Playwright's
 * surface — which is exactly what the detection looks at.
 */

import { describe, expect, it } from "bun:test";
import type { BrowserPage } from "../browser.js";
import { createRenderingCapabilities } from "./capabilities.js";

function puppeteerStub(
  overrides: Record<string, unknown> = {},
  log: string[] = []
): BrowserPage & { log: string[] } {
  const page = {
    evaluate: (async () => ({ width: 800, height: 600 })) as BrowserPage["evaluate"],
    goto: async () => undefined,
    screenshot: async () => new Uint8Array(),
    url: () => "https://example.test/",
    title: async () => "Stub",
    browser: () => ({ newPage: async () => page }),
    viewport: () => ({ width: 1280, height: 720 }),
    setViewport: async (size: Record<string, unknown> | null) => {
      log.push(`setViewport ${JSON.stringify(size)}`);
    },
    emulateMediaFeatures: async (features: { name: string; value: string }[]) => {
      log.push(`media ${JSON.stringify(features)}`);
    },
    createCDPSession: async () => ({
      send: async (method: string, params?: Record<string, unknown>) => {
        log.push(`cdp ${method} ${JSON.stringify(params)}`);
        return undefined;
      },
      detach: async () => {
        log.push("cdp detach");
      },
    }),
    emulateVisionDeficiency: async (type: string) => {
      log.push(`cvd ${type}`);
    },
    log,
    ...overrides,
  };
  return page as unknown as BrowserPage & { log: string[] };
}

function playwrightStub(
  options: { cdp?: "ok" | "throws" | "missing"; log?: string[]; viewport?: null } = {}
): BrowserPage & { log: string[] } {
  const log = options.log ?? [];
  const cdp = options.cdp ?? "ok";
  const session = {
    send: async (method: string, params?: Record<string, unknown>) => {
      log.push(`cdp ${method} ${JSON.stringify(params)}`);
      return undefined;
    },
    detach: async () => {
      log.push("cdp detach");
    },
  };

  const page = {
    _guid: "page@1",
    evaluate: (async () => ({ width: 800, height: 600 })) as BrowserPage["evaluate"],
    goto: async () => undefined,
    screenshot: async () => new Uint8Array(),
    url: () => "https://example.test/",
    title: async () => "Stub",
    context: () =>
      cdp === "missing"
        ? {}
        : {
            newCDPSession: async () => {
              if (cdp === "throws") throw new Error("CDP is only available in Chromium");
              return session;
            },
          },
    viewportSize: () => (options.viewport === null ? null : { width: 1280, height: 720 }),
    setViewportSize: async (size: { width: number; height: number }) => {
      log.push(`setViewportSize ${size.width}x${size.height}`);
    },
    emulateMedia: async (featureOptions: Record<string, string | null>) => {
      log.push(`media ${JSON.stringify(featureOptions)}`);
    },
    log,
  };
  return page as unknown as BrowserPage & { log: string[] };
}

describe("createRenderingCapabilities (Puppeteer)", () => {
  it("reads the original viewport and reports every capability", async () => {
    const capabilities = await createRenderingCapabilities(puppeteerStub());

    expect(capabilities.originalViewport).toEqual({ width: 1280, height: 720 });
    expect(capabilities.supports).toEqual({
      viewport: true,
      media: true,
      visionDeficiency: true,
    });
  });

  it("reverts to no override when the page reported no viewport", async () => {
    const page = puppeteerStub({ viewport: () => null });
    const capabilities = await createRenderingCapabilities(page);

    // The measured window size is not the same state: it would install an
    // override the page never had. Puppeteer takes `null` for "no override",
    // which is what the contract asks the pass to revert to.
    expect(capabilities.originalViewport).toBeNull();
    expect(capabilities.supports.viewport).toBe(true);

    await capabilities.setViewport({ width: 320, height: 720 });
    await capabilities.restoreViewport();

    expect(page.log).toEqual(['setViewport {"width":320,"height":720}', "setViewport null"]);
  });

  it("carries the original device settings through every viewport change", async () => {
    // A caller's mobile, high-DPI page: Puppeteer replaces the whole
    // viewport, defaults what a call leaves out, and reloads when mobile or
    // touch change — so the settings have to travel with the dimensions.
    const original = {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      isLandscape: false,
    };
    const page = puppeteerStub({ viewport: () => ({ ...original }) });
    const capabilities = await createRenderingCapabilities(page);

    expect(capabilities.originalViewport).toEqual(original);

    await capabilities.setViewport({ width: 320, height: 720 });
    await capabilities.setViewport({ width: 1280, height: 720 });
    await capabilities.restoreViewport();

    expect(page.log).toEqual([
      'setViewport {"deviceScaleFactor":2,"isMobile":true,"hasTouch":true,"isLandscape":false,"width":320,"height":720}',
      'setViewport {"deviceScaleFactor":2,"isMobile":true,"hasTouch":true,"isLandscape":false,"width":1280,"height":720}',
      `setViewport ${JSON.stringify(original)}`,
    ]);
  });

  it("sets media features over one CDP session and clears them with an empty set", async () => {
    const page = puppeteerStub();
    const capabilities = await createRenderingCapabilities(page);

    await capabilities.emulateMedia({ colorScheme: "dark", forcedColors: "active" });
    await capabilities.emulateMedia({});
    await capabilities.dispose();

    // Puppeteer's own `emulateMediaFeatures` rejects `forced-colors`, and an
    // override set over one session cannot be cleared from another, so the
    // whole media path is one CDP session.
    expect(page.log).toEqual([
      'cdp Emulation.setEmulatedMedia {"media":"","features":[{"name":"prefers-color-scheme","value":"dark"},{"name":"forced-colors","value":"active"}]}',
      'cdp Emulation.setEmulatedMedia {"media":"","features":[]}',
      "cdp detach",
    ]);
  });

  it("falls back to Puppeteer's own media API when the page offers no CDP session", async () => {
    const page = puppeteerStub({ createCDPSession: undefined });
    const capabilities = await createRenderingCapabilities(page);

    expect(capabilities.supports.media).toBe(true);
    await capabilities.emulateMedia({ colorScheme: "dark" });
    await capabilities.emulateMedia({});

    expect(page.log).toEqual([
      'media [{"name":"prefers-color-scheme","value":"dark"}]',
      "media []",
    ]);
  });

  it("uses the target's CDP session on older Puppeteer versions", async () => {
    const log: string[] = [];
    const page = puppeteerStub(
      {
        createCDPSession: undefined,
        target: () => ({
          createCDPSession: async () => ({
            send: async (method: string) => {
              log.push(`target cdp ${method}`);
              return undefined;
            },
          }),
        }),
      },
      log
    );
    const capabilities = await createRenderingCapabilities(page);

    await capabilities.emulateMedia({ colorScheme: "dark" });
    expect(log).toEqual(["target cdp Emulation.setEmulatedMedia"]);
  });

  it("restores the viewport it read at the start", async () => {
    const page = puppeteerStub();
    const capabilities = await createRenderingCapabilities(page);

    await capabilities.setViewport({ width: 320, height: 720 });
    await capabilities.restoreViewport();

    expect(page.log).toEqual([
      'setViewport {"width":320,"height":720}',
      'setViewport {"width":1280,"height":720}',
    ]);
  });

  it("reports a missing emulation instead of failing on it", async () => {
    const capabilities = await createRenderingCapabilities(
      puppeteerStub({ emulateVisionDeficiency: undefined })
    );

    expect(capabilities.supports.visionDeficiency).toBe(false);
    await expect(capabilities.emulateVisionDeficiency("protanopia")).rejects.toThrow(
      /cannot emulate a vision deficiency/
    );
  });
});

describe("createRenderingCapabilities (Playwright)", () => {
  it("uses Playwright's own methods and clears overrides with null", async () => {
    const page = playwrightStub();
    const capabilities = await createRenderingCapabilities(page);

    expect(capabilities.supports).toEqual({
      viewport: true,
      media: true,
      visionDeficiency: true,
    });

    await capabilities.setViewport({ width: 360, height: 800 });
    await capabilities.emulateMedia({ prefersContrast: "more" });
    await capabilities.emulateMedia({});

    expect(page.log).toEqual([
      "setViewportSize 360x800",
      'media {"colorScheme":null,"forcedColors":null,"contrast":"more","reducedMotion":null}',
      'media {"colorScheme":null,"forcedColors":null,"contrast":null,"reducedMotion":null}',
    ]);
  });

  it("emulates a vision deficiency over a CDP session and detaches it", async () => {
    const page = playwrightStub();
    const capabilities = await createRenderingCapabilities(page);

    await capabilities.emulateVisionDeficiency("deuteranopia");
    await capabilities.emulateVisionDeficiency("none");
    await capabilities.dispose();

    expect(page.log).toEqual([
      'cdp Emulation.setEmulatedVisionDeficiency {"type":"deuteranopia"}',
      'cdp Emulation.setEmulatedVisionDeficiency {"type":"none"}',
      "cdp detach",
    ]);
  });

  it("turns a browser without CDP into an unsupported capability", async () => {
    const capabilities = await createRenderingCapabilities(playwrightStub({ cdp: "throws" }));

    await expect(capabilities.emulateVisionDeficiency("protanopia")).rejects.toThrow(
      /no CDP session for vision-deficiency emulation/
    );
    // So the next CVD condition is skipped before it is applied.
    expect(capabilities.supports.visionDeficiency).toBe(false);
  });

  it("reports no viewport capability when the context has no viewport override", async () => {
    // `setViewportSize` can only install an override, never clear one, so
    // "restoring" a measured window size would leave the caller's page with
    // a fixed viewport it never had. The viewport conditions are skipped
    // instead; everything else still runs.
    const page = playwrightStub({ viewport: null });
    const capabilities = await createRenderingCapabilities(page);

    expect(capabilities.originalViewport).toBeNull();
    expect(capabilities.supports).toEqual({
      viewport: false,
      media: true,
      visionDeficiency: true,
    });

    await capabilities.restoreViewport();
    expect(page.log).toEqual([]);
  });

  it("reports no vision deficiency when the context cannot open a CDP session at all", async () => {
    const capabilities = await createRenderingCapabilities(playwrightStub({ cdp: "missing" }));
    expect(capabilities.supports.visionDeficiency).toBe(false);
  });
});

describe("createRenderingCapabilities (plain page)", () => {
  it("supports nothing but still answers, so text-spacing can run", async () => {
    const page = {
      evaluate: (async () => ({ width: 500, height: 400 })) as BrowserPage["evaluate"],
      goto: async () => undefined,
      screenshot: async () => new Uint8Array(),
      url: () => "https://example.test/",
      title: async () => "Stub",
    } as BrowserPage;

    const capabilities = await createRenderingCapabilities(page);

    expect(capabilities.supports).toEqual({
      viewport: false,
      media: false,
      visionDeficiency: false,
    });
    // It cannot change its viewport, so there is nothing to record.
    expect(capabilities.originalViewport).toBeNull();
    await expect(capabilities.restoreViewport()).resolves.toBeUndefined();
  });

  it("does not call into a page that never answers", async () => {
    // A plain page whose evaluate hangs must not keep the pass from starting
    // its bounded conditions.
    const page = {
      evaluate: (() => new Promise(() => {})) as BrowserPage["evaluate"],
      goto: async () => undefined,
      screenshot: async () => new Uint8Array(),
      url: () => "https://example.test/",
      title: async () => "Stub",
    } as BrowserPage;

    const created = await Promise.race([
      createRenderingCapabilities(page).then(() => "created"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 500)),
    ]);

    expect(created).toBe("created");
  });
});
