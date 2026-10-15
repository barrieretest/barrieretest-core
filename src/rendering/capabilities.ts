/**
 * Browser capability adapter for the rendering pass.
 *
 * Viewport, media and vision-deficiency emulation are not on the
 * `BrowserPage` surface the rest of the library uses, and Puppeteer and
 * Playwright spell all three differently. Detection is by method presence,
 * consistent with the `isPuppeteerPage` / `isPlaywrightPage` guards: a page
 * that cannot do an emulation reports it as unsupported, and the runner skips
 * those conditions with a reason instead of failing.
 *
 * Every emulation reverts to "no override", never to a guessed value; the
 * viewport reverts to exactly what the page had before the first condition —
 * device settings included — or to no override at all when it had none.
 */

import { type BrowserPage, isPlaywrightPage, isPuppeteerPage } from "../browser.js";
import type { MediaFeatures, VisionDeficiency } from "./types.js";

export interface ViewportSize {
  width: number;
  height: number;
}

/**
 * A Puppeteer viewport: the dimensions plus the device settings that belong
 * to them. Puppeteer defaults every setting a `setViewport` call leaves out
 * (scale factor 1, no mobile, no touch) and reloads the page when `isMobile`
 * or `hasTouch` change, so a condition that only changes the dimensions has
 * to carry the original settings along — otherwise auditing a mobile or
 * high-DPI page navigates a second time and loses its device emulation.
 */
export interface DeviceViewport extends ViewportSize {
  deviceScaleFactor?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
  isLandscape?: boolean;
}

export interface RenderingCapabilities {
  /** Which emulations this page can do. */
  supports: { viewport: boolean; media: boolean; visionDeficiency: boolean };
  /**
   * The viewport the page reported before the first condition, device
   * settings included. `null` on a page that had no viewport override at
   * all: on Puppeteer `restoreViewport()` then clears the override — the
   * contract's "revert to no override" — instead of installing the measured
   * window size, which would be a guess and a new override; on Playwright,
   * which cannot clear one, `supports.viewport` is false instead.
   */
  originalViewport: DeviceViewport | null;
  setViewport(size: ViewportSize): Promise<void>;
  /** Apply exactly these features; `{}` clears every override this made. */
  emulateMedia(features: MediaFeatures): Promise<void>;
  emulateVisionDeficiency(type: VisionDeficiency): Promise<void>;
  /** Restore the original viewport, if one was read. */
  restoreViewport(): Promise<void>;
  /** Release anything the adapter attached to the page (a CDP session). */
  dispose(): Promise<void>;
}

type CdpSession = {
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  detach?: () => Promise<unknown>;
};

/** Puppeteer's emulation surface, structurally. */
type PuppeteerEmulationPage = {
  viewport?: () => DeviceViewport | null;
  /** `null` clears the override, which is what a page that had none wants back. */
  setViewport?: (size: DeviceViewport | null) => Promise<unknown>;
  emulateMediaFeatures?: (features: { name: string; value: string }[]) => Promise<unknown>;
  emulateVisionDeficiency?: (type: VisionDeficiency) => Promise<unknown>;
  createCDPSession?: () => Promise<CdpSession>;
  target?: () => { createCDPSession?: () => Promise<CdpSession> } | undefined;
};

/** Playwright's emulation surface, structurally. */
type PlaywrightEmulationPage = {
  viewportSize?: () => ViewportSize | null;
  setViewportSize?: (size: ViewportSize) => Promise<unknown>;
  emulateMedia?: (options: Record<string, string | null>) => Promise<unknown>;
  context?: () => { newCDPSession?: (page: unknown) => Promise<CdpSession> } | undefined;
};

/** Media features in CSS spelling, which is what CDP takes as well. */
function mediaFeatureList(features: MediaFeatures): { name: string; value: string }[] {
  const list: { name: string; value: string }[] = [];
  if (features.colorScheme) {
    list.push({ name: "prefers-color-scheme", value: features.colorScheme });
  }
  if (features.forcedColors) list.push({ name: "forced-colors", value: features.forcedColors });
  if (features.prefersContrast) {
    list.push({ name: "prefers-contrast", value: features.prefersContrast });
  }
  if (features.reducedMotion) {
    list.push({ name: "prefers-reduced-motion", value: features.reducedMotion });
  }
  return list;
}

/**
 * Playwright takes every feature in one call and clears an override with
 * `null`, so each key is always sent.
 */
function playwrightMediaOptions(features: MediaFeatures): Record<string, string | null> {
  return {
    colorScheme: features.colorScheme ?? null,
    forcedColors: features.forcedColors ?? null,
    contrast: features.prefersContrast ?? null,
    reducedMotion: features.reducedMotion ?? null,
  };
}

/**
 * A CDP session attached on first use and detached at the end. Emulation
 * overrides belong to the session that set them — clearing them from another
 * session does nothing — so every call of one adapter goes through one
 * session.
 */
function lazyCdpSession(factory: (() => Promise<CdpSession>) | undefined) {
  let session: CdpSession | null = null;

  return {
    available: factory !== undefined,
    async get(): Promise<CdpSession> {
      if (!factory) throw new Error("this page offers no CDP session");
      if (!session) session = await factory();
      return session;
    },
    async dispose(): Promise<void> {
      try {
        await session?.detach?.();
      } catch {
        // The page may already be gone; nothing left to release.
      }
      session = null;
    },
  };
}

/** A viewport the page reported, as opposed to none at all. */
function reportedViewport<T extends ViewportSize>(value: T | null | undefined): T | null {
  return value && value.width > 0 && value.height > 0 ? { ...value } : null;
}

/**
 * The device settings of the original viewport, which every dimension change
 * has to repeat: Puppeteer replaces the whole viewport, so an omitted
 * `deviceScaleFactor`, `isMobile`, `hasTouch` or `isLandscape` is reset to its
 * default — and resetting mobile or touch reloads the page.
 */
function deviceSettings(viewport: DeviceViewport | null): Omit<DeviceViewport, "width" | "height"> {
  if (!viewport) return {};
  const device: Omit<DeviceViewport, "width" | "height"> = {};
  if (viewport.deviceScaleFactor !== undefined) {
    device.deviceScaleFactor = viewport.deviceScaleFactor;
  }
  if (viewport.isMobile !== undefined) device.isMobile = viewport.isMobile;
  if (viewport.hasTouch !== undefined) device.hasTouch = viewport.hasTouch;
  if (viewport.isLandscape !== undefined) device.isLandscape = viewport.isLandscape;
  return device;
}

function unsupported(name: string): never {
  throw new Error(`this page cannot emulate ${name}`);
}

/**
 * Build the adapter for a page, reading its original viewport. Call once, at
 * the start of the pass.
 */
export async function createRenderingCapabilities(
  page: BrowserPage
): Promise<RenderingCapabilities> {
  if (isPuppeteerPage(page)) {
    const puppeteerPage = page as unknown as PuppeteerEmulationPage;
    const setViewport = puppeteerPage.setViewport?.bind(puppeteerPage);
    const emulateMediaFeatures = puppeteerPage.emulateMediaFeatures?.bind(puppeteerPage);
    const emulateVisionDeficiency = puppeteerPage.emulateVisionDeficiency?.bind(puppeteerPage);
    const originalViewport = reportedViewport(puppeteerPage.viewport?.());
    const device = deviceSettings(originalViewport);

    // Puppeteer's own `emulateMediaFeatures` rejects every feature name
    // outside `prefers-color-scheme`, `prefers-reduced-motion` and
    // `color-gamut`, so `forced-colors` and `prefers-contrast` — which
    // Chromium itself emulates — only work over CDP. The whole media path
    // therefore goes through one CDP session where there is one, and falls
    // back to Puppeteer's API where there is not.
    const target = puppeteerPage.target?.();
    const cdp = lazyCdpSession(
      puppeteerPage.createCDPSession?.bind(puppeteerPage) ?? target?.createCDPSession?.bind(target)
    );

    return {
      supports: {
        // A Puppeteer page can always go back: to the viewport it reported,
        // or — when it had none — to no override at all.
        viewport: !!setViewport,
        media: cdp.available || !!emulateMediaFeatures,
        visionDeficiency: !!emulateVisionDeficiency,
      },
      originalViewport,
      setViewport: async (size) => {
        if (!setViewport) unsupported("a viewport change");
        // The dimensions of the condition, the device settings of the page.
        await setViewport({ ...device, width: size.width, height: size.height });
      },
      emulateMedia: async (features) => {
        const list = mediaFeatureList(features);
        if (cdp.available) {
          const session = await cdp.get();
          // An empty media type is "no media type override".
          await session.send("Emulation.setEmulatedMedia", { media: "", features: list });
          return;
        }
        if (!emulateMediaFeatures) unsupported("media features");
        await emulateMediaFeatures(list);
      },
      emulateVisionDeficiency: async (type) => {
        if (!emulateVisionDeficiency) unsupported("a vision deficiency");
        await emulateVisionDeficiency(type);
      },
      restoreViewport: async () => {
        if (!setViewport) return;
        // The whole original object, so the device settings come back exactly
        // as they were; `null` for a page that had no override, which is the
        // only way to give that state back rather than guess at it.
        await setViewport(originalViewport ? { ...originalViewport } : null);
      },
      dispose: () => cdp.dispose(),
    };
  }

  if (isPlaywrightPage(page)) {
    const playwrightPage = page as unknown as PlaywrightEmulationPage;
    const setViewportSize = playwrightPage.setViewportSize?.bind(playwrightPage);
    const emulateMedia = playwrightPage.emulateMedia?.bind(playwrightPage);
    const context = playwrightPage.context?.();
    const newCDPSession = context?.newCDPSession?.bind(context);
    // `viewportSize()` is null for a context without a viewport override —
    // Playwright's `viewport: null` — and `setViewportSize` can only install
    // one, never clear it. Restoring the measured window size would leave
    // behind a fixed override the page never had, so a page in that state
    // reports no viewport capability at all and the viewport conditions are
    // skipped; media, vision deficiency and text spacing still run.
    const originalViewport = reportedViewport(playwrightPage.viewportSize?.());
    const cdp = lazyCdpSession(newCDPSession ? () => newCDPSession(page) : undefined);

    const supports = {
      viewport: !!setViewportSize && !!originalViewport,
      media: !!emulateMedia,
      // Only Chromium answers CDP. The method exists on every Playwright
      // context, so the real answer comes from attaching, which happens on
      // first use; a non-Chromium browser throws there, that condition is
      // skipped with the reason, and the ones after it are skipped before
      // they are applied.
      visionDeficiency: cdp.available,
    };

    return {
      supports,
      originalViewport,
      setViewport: async (size) => {
        if (!setViewportSize) unsupported("a viewport change");
        await setViewportSize(size);
      },
      emulateMedia: async (features) => {
        if (!emulateMedia) unsupported("media features");
        await emulateMedia(playwrightMediaOptions(features));
      },
      emulateVisionDeficiency: async (type) => {
        if (!cdp.available) unsupported("a vision deficiency");
        let session: CdpSession;
        try {
          session = await cdp.get();
        } catch (error) {
          supports.visionDeficiency = false;
          throw new Error(
            `this browser has no CDP session for vision-deficiency emulation (${
              error instanceof Error ? error.message : String(error)
            })`
          );
        }
        await session.send("Emulation.setEmulatedVisionDeficiency", { type });
      },
      restoreViewport: async () => {
        if (setViewportSize && originalViewport) await setViewportSize(originalViewport);
      },
      dispose: () => cdp.dispose(),
    };
  }

  // A plain `BrowserPage` can still take the injected text-spacing override,
  // which needs no capability at all; every emulated condition is skipped.
  // It cannot change its viewport either, so there is nothing to record or
  // restore (and no unbounded browser call before the conditions start).
  return {
    supports: { viewport: false, media: false, visionDeficiency: false },
    originalViewport: null,
    setViewport: async () => unsupported("a viewport change"),
    emulateMedia: async () => unsupported("media features"),
    emulateVisionDeficiency: async () => unsupported("a vision deficiency"),
    restoreViewport: async () => {},
    dispose: async () => {},
  };
}
