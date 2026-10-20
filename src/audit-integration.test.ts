/**
 * Integration tests for `audit()` orchestration.
 *
 * These mock the engine and semantic-runner modules so we can exercise
 * audit()'s merge / filter / baseline / warn-and-continue logic without
 * launching a real browser or hitting an AI provider.
 *
 * The context-extraction block at the bottom is the exception: its whole
 * point is that the extraction code runs inside a real browser, so it drives
 * Puppeteer against an inline page.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Browser, LaunchOptions } from "puppeteer";
import { measureSelectors, readPngSize } from "./annotate/index.js";
import type { BrowserPage } from "./browser.js";
import { dismissCookieBanner } from "./cookie-banner.js";
import { renderHtmlReport } from "./html-report/index.js";
import { loadLazyContent } from "./lazy-content.js";
import {
  isNavigationHttpError,
  isNavigationNetworkError,
  type NavigationHttpError,
  type NavigationNetworkError,
} from "./puppeteer-launch.js";
import { SIMULATED_DEFICIENCIES, simulateDeficiency } from "./rendering/color.js";
import { MAX_ANIMATIONS, MAX_PAINTED } from "./rendering/measure.js";
import { settleCondition } from "./rendering/page.js";
import { extractHtmlContext } from "./semantic/context.js";
import type { Issue } from "./types.js";

// ----- the instrumented Chromium launcher -----

/**
 * What one watched call opened for itself: the browsers, so their closure
 * can be asserted, and the work every page they created was asked to do.
 * Each post-navigation step (cookie banner, lazy scroll, axe, the rendering
 * pass, the screenshot) goes through `evaluate` or `screenshot`, so two
 * counters cover "nothing happened after the navigation failed".
 */
interface WatchedRun {
  browsers: Browser[];
  counts: { evaluate: number; screenshot: number }[];
  /** The Chromium argument list of every browser the call launched. */
  args: string[][];
}

/** Set while a watched call runs; the launcher below reads it. */
let watchedLaunches: WatchedRun | null = null;

/** Count what a real page is asked to do, through its real methods. */
function countPageWork(page: unknown) {
  const counts = { evaluate: 0, screenshot: 0 };
  const target = page as {
    evaluate: (...args: unknown[]) => unknown;
    screenshot: (...args: unknown[]) => unknown;
  };
  const realEvaluate = target.evaluate.bind(target);
  const realScreenshot = target.screenshot.bind(target);

  target.evaluate = (...args: unknown[]) => {
    counts.evaluate += 1;
    return realEvaluate(...args);
  };
  target.screenshot = (...args: unknown[]) => {
    counts.screenshot += 1;
    return realScreenshot(...args);
  };

  return counts;
}

/**
 * Every path that launches a browser for itself reaches
 * `import("puppeteer")` — `launchPuppeteerSession` for `audit()` and the
 * semantic entry point, the pa11y engine for its own launch — so this is the
 * one place that sees all three. Outside a watched call it is the real
 * launcher and nothing is instrumented.
 *
 * The mock has to be installed before anything imports Puppeteer, because
 * bun cannot replace an ES module that is already loaded — hence no
 * `import puppeteer from "puppeteer"` in this file, and hence `require` for
 * the real launcher: the mock shadows every import of the specifier, the
 * CommonJS build of the same package it does not.
 */
const requirePuppeteer = createRequire(import.meta.url);

async function launchInstrumentedChromium(options?: LaunchOptions): Promise<Browser> {
  const real = requirePuppeteer("puppeteer") as {
    launch: (options?: LaunchOptions) => Promise<Browser>;
  };
  const browser = await real.launch(options);

  const run = watchedLaunches;
  if (run) {
    run.browsers.push(browser);
    run.args.push([...(options?.args ?? [])]);
    const realNewPage = browser.newPage.bind(browser);
    browser.newPage = async () => {
      const page = await realNewPage();
      run.counts.push(countPageWork(page));
      return page;
    };
  }

  return browser;
}

mock.module("puppeteer", () => ({ launch: launchInstrumentedChromium }));

/** Stands in for the default export for this file's own browser launches. */
const puppeteer = { launch: launchInstrumentedChromium };

/** Run `body` with the browsers it launches for itself under observation. */
async function watchOwnBrowsers<T>(
  body: () => Promise<T>
): Promise<{ result: T; run: WatchedRun }> {
  const run: WatchedRun = { browsers: [], counts: [], args: [] };
  watchedLaunches = run;
  try {
    return { result: await body(), run };
  } finally {
    watchedLaunches = null;
  }
}

/** The call opened a browser, did nothing to its pages, and closed it. */
function expectNoWorkAndClosed(run: WatchedRun) {
  expect(run.counts.length).toBeGreaterThan(0);
  expect(run.counts).toEqual(run.counts.map(() => ({ evaluate: 0, screenshot: 0 })));
  expect(run.browsers.length).toBeGreaterThan(0);
  expect(run.browsers.map((candidate) => candidate.connected)).toEqual(
    run.browsers.map(() => false)
  );
}

// ----- shared mock state -----

interface EngineCall {
  url: string;
  hadPage: boolean;
}

interface SemanticCall {
  url: string;
  pagePrepared: boolean | undefined;
}

let engineCalls: EngineCall[];
let semanticCalls: SemanticCall[];
let nextEngineIssues: Issue[];
let nextSemanticIssues: Issue[];
let nextSemanticThrows: Error | null;
/** Screenshot the engine mock hands back; the annotation tests set a real one. */
let nextEngineScreenshot: Uint8Array | undefined;
/** One entry per `localizeIssues` call, so the eligibility tests can count them. */
let localizeCalls: { issueIds: string[] }[];
let consoleWarnSpy: { calls: unknown[][]; restore: () => void };

const ENGINE_URL = "https://example.test/page";

/**
 * The real engine, captured as values before the stub replaces the module —
 * mocking rebinds the module's own exports, including the transform
 * `runAxeCore` calls internally. The report's end-to-end test puts both back
 * for its own run, so one test in this file drives the whole pipeline
 * without a mocked engine.
 */
const realAxeModule = await import("./engines/axe.js");
const realAxe = {
  runAxeCore: realAxeModule.runAxeCore,
  transformAxeViolation: realAxeModule.transformAxeViolation,
};

const axeStubModule = {
  runAxeCore: async (
    url: string,
    options: { page?: unknown }
  ): Promise<{
    issues: Issue[];
    documentTitle: string;
    pageUrl: string;
    screenshot?: Uint8Array;
  }> => {
    engineCalls.push({ url, hadPage: !!options.page });
    return {
      issues: [...nextEngineIssues],
      documentTitle: "Stub Doc",
      pageUrl: url,
      screenshot: nextEngineScreenshot ?? new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    };
  },
  transformAxeViolation: () => [],
};

mock.module("./engines/axe.js", () => axeStubModule);

/**
 * The real semantic runner, captured by value before the stub replaces the
 * module: the navigation-status tests drive `runSemanticAuditOnUrl` itself
 * (with a stub AI provider) to cover the standalone entry point.
 */
const realSemanticRunnerModule = await import("./semantic/runner.js");
const realSemanticRunner = {
  runSemanticAudit: realSemanticRunnerModule.runSemanticAudit,
  runSemanticAuditOnUrl: realSemanticRunnerModule.runSemanticAuditOnUrl,
  validateFindingsAgainstChecks: realSemanticRunnerModule.validateFindingsAgainstChecks,
};

/** The real AI module, captured the same way, so only `createProvider` is stubbed. */
const realAiModule = await import("./ai/index.js");
const realAi = { ...realAiModule };

const semanticRunnerStubModule = {
  runSemanticAudit: async (runContext: { url: string; pagePrepared?: boolean }) => {
    semanticCalls.push({
      url: runContext.url,
      pagePrepared: runContext.pagePrepared,
    });
    if (nextSemanticThrows) throw nextSemanticThrows;
    return {
      url: runContext.url,
      issues: [...nextSemanticIssues],
      meta: {
        checksRun: ["aria-mismatch"],
        provider: "stub",
        model: "stub-model",
      },
      screenshot: undefined,
      timestamp: new Date().toISOString(),
    };
  },
  // Re-export the helper used by other call sites that import it from runner.
  validateFindingsAgainstChecks: () => ({ valid: [], dropped: [] }),
};

mock.module("./semantic/runner.js", () => semanticRunnerStubModule);

// Stub localization: it scrolls elements into view and reads the filesystem,
// so the eligibility tests only need to know whether audit() called it.
mock.module("./localization/index.js", () => ({
  localizeIssues: async (_page: unknown, issues: Issue[]) => {
    localizeCalls.push({ issueIds: issues.map((issue) => issue.id) });
    return issues;
  },
}));

/** The real launcher, captured before the stub replaces the module. */
const realPuppeteerLaunchModule = await import("./puppeteer-launch.js");
const realPuppeteerLaunch = {
  launchPuppeteerSession: realPuppeteerLaunchModule.launchPuppeteerSession,
  closeSession: realPuppeteerLaunchModule.closeSession,
  navigateAndInspect: realPuppeteerLaunchModule.navigateAndInspect,
  checkNavigationStatus: realPuppeteerLaunchModule.checkNavigationStatus,
  describeUnnavigatedPage: realPuppeteerLaunchModule.describeUnnavigatedPage,
  // Pure helpers with nothing to stub, but they have to stay bound while the
  // module is mocked, because this file imports the guard.
  isNavigationHttpError: realPuppeteerLaunchModule.isNavigationHttpError,
  NavigationHttpError: realPuppeteerLaunchModule.NavigationHttpError,
  isNavigationNetworkError: realPuppeteerLaunchModule.isNavigationNetworkError,
  NavigationNetworkError: realPuppeteerLaunchModule.NavigationNetworkError,
  buildLaunchArgs: realPuppeteerLaunchModule.buildLaunchArgs,
};

// Stub puppeteer-launch so audit() doesn't try to launch a real browser
// when handed a URL with `semantic` set.
const puppeteerLaunchStubModule = {
  launchPuppeteerSession: async () => ({
    browser: { close: async () => undefined },
    page: {
      url: () => "about:blank",
      title: async () => "Stub",
      goto: async () => undefined,
      evaluate: async () => ({}),
      screenshot: async () => new Uint8Array(),
      close: async () => undefined,
    },
  }),
  closeSession: async () => undefined,
  navigateAndInspect: realPuppeteerLaunchModule.navigateAndInspect,
  checkNavigationStatus: realPuppeteerLaunchModule.checkNavigationStatus,
  describeUnnavigatedPage: realPuppeteerLaunchModule.describeUnnavigatedPage,
  // Pure helpers with nothing to stub, but they have to stay bound while the
  // module is mocked, because this file imports the guard.
  isNavigationHttpError: realPuppeteerLaunchModule.isNavigationHttpError,
  NavigationHttpError: realPuppeteerLaunchModule.NavigationHttpError,
  isNavigationNetworkError: realPuppeteerLaunchModule.isNavigationNetworkError,
  NavigationNetworkError: realPuppeteerLaunchModule.NavigationNetworkError,
  buildLaunchArgs: realPuppeteerLaunchModule.buildLaunchArgs,
};

mock.module("./puppeteer-launch.js", () => puppeteerLaunchStubModule);

const { audit } = await import("./audit.js");

// ----- helpers -----

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "engine-rule",
    impact: "moderate",
    description: "stub",
    help: "stub help",
    selector: ".x",
    nodes: [{ html: "<div></div>" }],
    ...overrides,
  };
}

function makeSemanticIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "semantic:aria-mismatch",
    impact: "serious",
    description: "label mismatch",
    help: "fix it",
    selector: "button",
    nodes: [{ html: "<button></button>" }],
    semantic: { checkType: "aria-mismatch", confidence: 0.8 },
    ...overrides,
  };
}

beforeEach(() => {
  engineCalls = [];
  semanticCalls = [];
  nextEngineIssues = [];
  nextSemanticIssues = [];
  nextSemanticThrows = null;
  nextEngineScreenshot = undefined;
  localizeCalls = [];

  const original = console.warn;
  const calls: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    calls.push(args);
  };
  consoleWarnSpy = {
    calls,
    restore: () => {
      console.warn = original;
    },
  };
});

afterEach(() => {
  consoleWarnSpy.restore();
});

// ----- the actual integration tests -----

describe("audit() merge ordering", () => {
  it("returns engine + semantic issues merged in result.issues", async () => {
    nextEngineIssues = [makeIssue({ id: "engine-a" }), makeIssue({ id: "engine-b" })];
    nextSemanticIssues = [makeSemanticIssue()];

    const result = await audit(ENGINE_URL, {
      semantic: { provider: { name: "nebius", apiKey: "stub" } },
    });

    expect(result.issues.map((i) => i.id)).toEqual([
      "engine-a",
      "engine-b",
      "semantic:aria-mismatch",
    ]);
    expect(result.semanticMeta?.provider).toBe("stub");
  });

  it("passes pagePrepared:true to the semantic runner", async () => {
    nextEngineIssues = [];
    nextSemanticIssues = [];

    await audit(ENGINE_URL, {
      semantic: { provider: { name: "nebius", apiKey: "stub" } },
    });

    expect(semanticCalls).toHaveLength(1);
    expect(semanticCalls[0].pagePrepared).toBe(true);
  });
});

describe("audit() minSeverity + ignore on merged set", () => {
  it("minSeverity drops low-severity semantic issues", async () => {
    nextEngineIssues = [makeIssue({ id: "engine-critical", impact: "critical" })];
    nextSemanticIssues = [
      makeSemanticIssue({ id: "semantic:aria-mismatch", impact: "minor" }),
      makeSemanticIssue({ id: "semantic:page-title", impact: "serious" }),
    ];

    const result = await audit(ENGINE_URL, {
      minSeverity: "serious",
      semantic: { provider: { name: "nebius", apiKey: "stub" } },
    });

    const ids = result.issues.map((i) => i.id);
    expect(ids).toContain("engine-critical");
    expect(ids).toContain("semantic:page-title");
    expect(ids).not.toContain("semantic:aria-mismatch");
  });

  it("ignore drops semantic issues by id", async () => {
    nextEngineIssues = [makeIssue({ id: "engine-x" })];
    nextSemanticIssues = [
      makeSemanticIssue({ id: "semantic:aria-mismatch" }),
      makeSemanticIssue({ id: "semantic:page-title" }),
    ];

    const result = await audit(ENGINE_URL, {
      ignore: ["semantic:aria-mismatch"],
      semantic: { provider: { name: "nebius", apiKey: "stub" } },
    });

    const ids = result.issues.map((i) => i.id);
    expect(ids).toContain("engine-x");
    expect(ids).toContain("semantic:page-title");
    expect(ids).not.toContain("semantic:aria-mismatch");
  });

  it("minSeverity also drops low-severity engine issues before semantic runs", async () => {
    nextEngineIssues = [
      makeIssue({ id: "engine-minor", impact: "minor" }),
      makeIssue({ id: "engine-critical", impact: "critical" }),
    ];
    nextSemanticIssues = [];

    const result = await audit(ENGINE_URL, {
      minSeverity: "serious",
      semantic: { provider: { name: "nebius", apiKey: "stub" } },
    });

    const ids = result.issues.map((i) => i.id);
    expect(ids).toContain("engine-critical");
    expect(ids).not.toContain("engine-minor");
  });
});

describe("audit() warn-and-continue on semantic failure", () => {
  it("returns engine results, no semanticMeta, and logs a warning when semantic throws", async () => {
    nextEngineIssues = [makeIssue({ id: "engine-only" })];
    nextSemanticThrows = new Error("nebius down");

    const result = await audit(ENGINE_URL, {
      semantic: { provider: { name: "nebius", apiKey: "stub" } },
    });

    expect(result.issues.map((i) => i.id)).toEqual(["engine-only"]);
    expect(result.semanticMeta).toBeUndefined();
    expect(
      consoleWarnSpy.calls.some((args) => String(args[0] ?? "").includes("Semantic audit failed"))
    ).toBe(true);
  });
});

/**
 * The rendering pass is opt-in and recoverable, but two of its outcomes
 * reach the rest of `audit()`: a configuration error, which is the caller's
 * and is thrown, and a page it could not establish the state of, after which
 * nothing may measure that page any more.
 */
describe("audit() and the rendering pass", () => {
  /**
   * A Puppeteer-shaped page whose viewport change lands only when the test
   * opens the gate, so the pass gives up waiting on work that is still its
   * own — with the order of the two decided by the test and not by a margin.
   */
  function gatedViewportPage(gate: Promise<unknown>): { page: BrowserPage; log: string[] } {
    const log: string[] = [];
    const viewport = { width: 1280, height: 720 };

    const page = {
      evaluate: (async () => undefined) as BrowserPage["evaluate"],
      goto: async () => undefined,
      url: () => ENGINE_URL,
      title: async () => "Stub Doc",
      screenshot: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      browser: () => ({ newPage: async () => page }),
      viewport: () => ({ ...viewport }),
      setViewport: async (size: { width: number; height: number }) => {
        const restore = size.width === 1280 && size.height === 720;
        if (!restore) await gate;
        Object.assign(viewport, size);
        log.push(`viewport:${size.width}x${size.height}`);
      },
    } as unknown as BrowserPage;

    return { page, log };
  }

  const warned = (needle: string): boolean =>
    consoleWarnSpy.calls.some((args) => String(args[0] ?? "").includes(needle));

  it("rejects an invalid rendering configuration instead of warning about it", async () => {
    await expect(
      audit(ENGINE_URL, { rendering: { conditions: ["viewport:999"] } })
    ).rejects.toThrow(/Unknown rendering condition id/);

    await expect(
      audit(ENGINE_URL, { rendering: { conditions: ["viewport:320+viewport:1280"] } })
    ).rejects.toThrow(/Conflicting rendering condition id/);

    await expect(audit(ENGINE_URL, { rendering: { checks: ["nope"] } })).rejects.toThrow(
      /Unknown rendering check id/
    );

    expect(engineCalls).toHaveLength(0);
  });

  it("skips localization, the semantic pass and the annotation step when the page may still change", async () => {
    nextEngineIssues = [makeIssue({ id: "engine-only" })];
    let openGate = (): void => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const { page, log } = gatedViewportPage(gate);

    const result = await audit(page, {
      // `fix-ready` is what makes localization eligible on a caller's page.
      detail: "fix-ready",
      rendering: { conditions: ["viewport:320"], conditionTimeout: 10 },
      semantic: { provider: { name: "nebius", apiKey: "stub" } },
    });

    expect(result.renderingMeta?.pageUnsafe).toBe(true);
    expect(result.renderingMeta?.restorationFailed).toEqual(["viewport:320"]);
    expect(warned("Rendering pass could not establish the page's state")).toBe(true);

    // Taken before the pass, so they stand.
    expect(result.issues.map((issue) => issue.id)).toEqual(["engine-only"]);
    expect(result.score).toBeGreaterThan(0);
    expect(result.screenshot).toBeDefined();

    // Measured on the page as it is now, so they do not run at all.
    expect(localizeCalls).toEqual([]);
    expect(semanticCalls).toEqual([]);
    expect(result.semanticMeta).toBeUndefined();
    expect(result.screenshotMeta).toBeUndefined();
    expect(result.issues.every((issue) => issue.annotation === undefined)).toBe(true);

    // Nothing of the abandoned apply reached the page while the audit ran.
    expect(log).not.toContain("viewport:320x720");

    // The pass still owns that work and puts the page back when it lands.
    openGate();
    const deadline = Date.now() + 5_000;
    while (!warned("after the abandoned work settled")) {
      if (Date.now() > deadline) throw new Error("the late restore never happened");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(log.lastIndexOf("viewport:1280x720")).toBeGreaterThan(
      log.lastIndexOf("viewport:320x720")
    );
  }, 20_000);
});

// ----- browser-side context extraction -----

/**
 * Inline page covering the cases that a truncated raw-HTML snippet used to
 * hide: a `for=` label, a wrapping label, an unlabeled field, a data-URI
 * image, the three variants that are hidden from assistive technology, an
 * image without an alt attribute, an image inside a text link, the two
 * selector shapes an id and a `/_next/image` proxy produce, and two images
 * this viewport does not render.
 */
const CONTEXT_PAGE = `<!doctype html>
<html lang="de">
<head><title>Kontakt – Beispiel</title></head>
<body>
  <main>
    <form>
      <label for="url">Website-Adresse</label>
      <input type="url" id="url" name="url" placeholder="https://example.at" />
      <label>Ihre E-Mail <input type="email" name="mail" /></label>
      <input type="text" name="suche" placeholder="Suchen" />
      <input type="hidden" name="csrf" value="token" />
      <button type="submit">Prüfung starten</button>
    </form>
    <img src="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3C%2Fsvg%3E" alt="Logo von Beispiel GmbH" width="40" height="40" />
    <img src="/assets/deko.png?v=2" alt="" role="presentation" width="8" height="8" />
    <img src="/assets/spacer.gif" alt="" aria-hidden="true" width="1" height="1" />
    <img src="/photos/team.jpg" width="200" height="100" />
    <a href="/start"><img src="/icons/home.svg" alt="" /> Zur Startseite</a>
    <a href="/"><img src="/brand/logo.svg" alt="Beispiel Logo" aria-hidden="true" width="24" height="24" /> Beispiel GmbH</a>
    <img id="hero-photo" src="/photos/hero.jpg" alt="Blick auf den Schlossberg" width="1200" height="600" />
    <img src="/_next/image?url=%2F_next%2Fstatic%2Fmedia%2Fchdv.DIqY6M1l_ZfrtzR.webp&amp;w=2048&amp;q=75" alt="Mitglieds-Logo der Charta der Vielfalt" width="2063" height="1411" />
    <picture><img src="/photos/team-wide.jpg" alt="Team beim Workshop" style="display:none" width="300" height="200" /></picture>
    <img src="/photos/team-tall.jpg" alt="Team beim Workshop" style="visibility:hidden" width="300" height="200" />
    <nav class="site-nav is-sticky" style="display:flex" aria-label="Hauptnavigation"><a href="/a">A</a></nav>
  </main>
</body></html>`;

describe("dismissCookieBanner (real browser)", () => {
  let browser: Awaited<ReturnType<typeof puppeteer.launch>>;

  beforeAll(async () => {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
  });

  /**
   * A banner whose buttons record which one was clicked and then remove the
   * banner, as a consent tool would. Buttons appear in the given order; on
   * graz.at the "only necessary" button comes first, so a loose text match
   * would click it.
   */
  const banner = (windowClass: string, buttons: { id: string; cls: string; text: string }[]) =>
    `<!doctype html>
<html lang="de"><head><title>Cookie fixture</title></head><body>
  <main><h1>Seite</h1></main>
  <div class="${windowClass}" role="dialog">
    ${buttons.map((b) => `<a role="button" id="${b.id}" class="${b.cls}">${b.text}</a>`).join("\n    ")}
  </div>
  <script>
    for (const button of document.querySelectorAll("[role=dialog] a")) {
      button.addEventListener("click", () => {
        window.clicked = button.id;
        document.querySelector("[role=dialog]").remove();
      });
    }
  </script>
</body></html>`;

  async function dismissOn(html: string) {
    const page = await browser.newPage();
    try {
      await page.setContent(html);
      const dismissed = await dismissCookieBanner(page as unknown as BrowserPage);
      const clicked = await page.evaluate(
        () => (window as unknown as { clicked?: string }).clicked ?? null
      );
      return { dismissed, clicked };
    } finally {
      await page.close();
    }
  }

  // Texts no accept pattern knows, so only the cookieconsent selectors can
  // find these buttons.
  const deny = { id: "deny", cls: "cc-btn cc-deny", text: "Ablehnen" };

  it("accepts an Osano cookieconsent banner by its allow button", async () => {
    // Classes as on graz.at (Datareporter on top of cookieconsent).
    const result = await dismissOn(
      banner("cc-window cc-banner", [
        deny,
        { id: "allow", cls: "cc-btn cc-allow", text: "Zustimmung erteilen" },
      ])
    );

    expect(result).toEqual({ dismissed: true, clicked: "allow" });
  }, 30_000);

  it("closes an informational cookieconsent banner by its dismiss button", async () => {
    const result = await dismissOn(
      banner("cc-window cc-banner", [
        { id: "dismiss", cls: "cc-btn cc-dismiss", text: "Verstanden, weiter" },
      ])
    );

    expect(result).toEqual({ dismissed: true, clicked: "dismiss" });
  }, 30_000);

  it("prefers allow over dismiss when a cookieconsent banner has both", async () => {
    const result = await dismissOn(
      banner("cc-window cc-banner", [
        { id: "dismiss", cls: "cc-btn cc-dismiss", text: "Später" },
        { id: "allow", cls: "cc-btn cc-allow", text: "Zustimmung erteilen" },
      ])
    );

    expect(result).toEqual({ dismissed: true, clicked: "allow" });
  }, 30_000);

  it("matches German 'Alle Cookies erlauben' and not the necessary-only button", async () => {
    // No known consent-tool classes: only the text strategy can find it.
    const result = await dismissOn(
      banner("consent", [
        { id: "deny", cls: "", text: "Nur erforderliche Cookies erlauben" },
        { id: "allow", cls: "", text: "Alle Cookies erlauben" },
      ])
    );

    expect(result).toEqual({ dismissed: true, clicked: "allow" });
  }, 30_000);

  it("matches German 'Alle erlauben'", async () => {
    const result = await dismissOn(
      banner("consent", [
        { id: "deny", cls: "", text: "Nur notwendige" },
        { id: "allow", cls: "", text: "Alle erlauben" },
      ])
    );

    expect(result).toEqual({ dismissed: true, clicked: "allow" });
  }, 30_000);
});

describe("extractHtmlContext (real browser)", () => {
  let browser: Awaited<ReturnType<typeof puppeteer.launch>>;
  let formElements: string[];
  let images: string[];
  let cappedImages: string[];
  let ariaElements: string[];

  beforeAll(async () => {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    await page.setContent(CONTEXT_PAGE);

    const context = await extractHtmlContext(page as unknown as BrowserPage, [
      "aria",
      "forms",
      "images",
    ]);
    formElements = context.formElements;
    images = context.images;
    ariaElements = context.ariaElements;

    const capped = await extractHtmlContext(page as unknown as BrowserPage, ["images"], {
      maxImages: 1,
    });
    cappedImages = capped.images;
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it("resolves a label referenced by for=", () => {
    expect(formElements).toContain(
      '<input> type=url id=url name=url | name: "Website-Adresse" (via label) | placeholder: "https://example.at"'
    );
  });

  it("resolves a wrapping label", () => {
    expect(formElements).toContain(
      '<input> type=email name=mail | name: "Ihre E-Mail" (via label)'
    );
  });

  it("states the absence of a label explicitly", () => {
    expect(formElements).toContain(
      '<input> type=text name=suche | label: (none) | placeholder: "Suchen"'
    );
  });

  it("names a submit button by its text instead of reporting no label", () => {
    expect(formElements).toContain('<button> type=submit | name: "Prüfung starten" (via text)');
    expect(formElements.join("\n")).not.toContain("type=submit | label: (none)");
  });

  it("skips hidden inputs", () => {
    expect(formElements.some((line) => line.includes("name=csrf"))).toBe(false);
  });

  it("puts the labelled alt text first and the selector last", () => {
    expect(images).toContain(
      'Image 1: alt text = "Logo von Beispiel GmbH" | selector = img[src^="data:image/svg+xml"] | 40x40'
    );
  });

  it("distinguishes an empty alt from a missing one", () => {
    expect(images).toContain(
      'Image 3: alt text = (empty) | inside link with text "Zur Startseite" | selector = img[src$="home.svg"]'
    );
    expect(images).toContain(
      'Image 2: alt text = (missing) | selector = img[src$="team.jpg"] | 200x100'
    );
  });

  it("selects by id when the image has one", () => {
    expect(images).toContain(
      'Image 4: alt text = "Blick auf den Schlossberg" | selector = img#hero-photo | 1200x600'
    );
  });

  it("selects a proxied image by the file name its url parameter wraps", () => {
    expect(images).toContain(
      'Image 5: alt text = "Mitglieds-Logo der Charta der Vielfalt" | selector = img[src*="chdv.DIqY6M1l_ZfrtzR.webp"] | 2063x1411'
    );
  });

  it("leaves images this viewport does not render out of the list and counts them", () => {
    expect(images.some((line) => line.includes("team-wide.jpg"))).toBe(false);
    expect(images.some((line) => line.includes("team-tall.jpg"))).toBe(false);
    expect(images).toContain("(2 images not rendered at this viewport are not listed)");
  });

  it("leaves images hidden from assistive technology out of the list and counts them", () => {
    expect(images.some((line) => line.includes("deko.png"))).toBe(false);
    expect(images.some((line) => line.includes("spacer.gif"))).toBe(false);
    // Hidden wins over a non-empty alt: the image has no accessible name.
    expect(images.some((line) => line.includes("logo.svg"))).toBe(false);
    expect(images).toContain(
      "(3 images hidden from assistive technology via aria-hidden or role=presentation are not listed)"
    );
  });

  it("states how many images the cap left out", () => {
    expect(cappedImages).toHaveLength(4);
    expect(cappedImages).toContain("(4 more images not listed)");
    // Nothing is left out below the cap, so the uncapped list carries no note.
    expect(images.some((line) => line.includes("more images not listed"))).toBe(false);
  });

  it("reports the text of an enclosing link", () => {
    expect(images).toContain(
      'Image 3: alt text = (empty) | inside link with text "Zur Startseite" | selector = img[src$="home.svg"]'
    );
  });

  it("drops class and style from ARIA snippets", () => {
    const nav = ariaElements.find((snippet) => snippet.startsWith("<nav"));
    expect(nav).toBe('<nav aria-label="Hauptnavigation"><a href="/a">A</a></nav>');
  });
});

// ----- browser-side selectors and accessible names -----

/** Past the former 200-character alt cap, well inside the current one. */
const LONG_ALT = `Luftbild des Schlossbergs: ${"Uhrturm, Kasematten und Stadtpark, ".repeat(8)}Ende.`;
/** Past the 1000-character alt cap, so the line ends in an ellipsis. */
const OVERLONG_ALT = `Sehr lange Beschreibung: ${"Detail um Detail, ".repeat(70)}Ende.`;
const LONG_ID = "a".repeat(70);
const LONG_NAME = "b".repeat(70);

/**
 * Second inline page for the cases a selector or a name resolution gets
 * wrong: an id that needs escaping, a `src` whose fragment breaks a `$=`
 * match, two images sharing a data URL, a `src` carrying a quote and a
 * backslash, two ancestors sharing an id, graphics hidden through an
 * ancestor, an unnamed `role="img"`, an image named by ARIA next to its
 * alt, controls named by an image or by a native default, a button whose
 * contents are partly hidden from assistive technology, over-long
 * `id`/`name` attributes, and alt texts past the former and current caps.
 */
const SELECTOR_PAGE = `<!doctype html>
<html lang="de">
<head><title>Selektoren – Beispiel</title></head>
<body>
  <main id="content">
    <img id="hero:main" src="/photos/a.jpg" alt="Blick über die Mur" width="100" height="50" />
    <img src="/photos/karte.svg#ansicht" alt="Lageplan des Geländes" width="100" height="50" />
    <img src="data:image/png;base64,iVBORw0KGgo=" alt="Erstes Symbol" width="10" height="10" />
    <img src="data:image/png;base64,iVBORw0KGgo=" alt="Zweites Symbol" width="10" height="10" />
    <div aria-hidden="true"><img src="/photos/deko.jpg" alt="Dekoration" width="10" height="10" /></div>
    <svg role="img" aria-hidden="true" width="10" height="10"><title>Verstecktes Symbol</title></svg>
    <span role="img">🎉</span>
    <img src="/photos/lang.jpg" alt="${LONG_ALT}" width="100" height="50" />
    <img src="/photos/zu-lang.jpg" alt="${OVERLONG_ALT}" width="100" height="50" />
    <img src="/charts/umsatz.svg" alt="" aria-label="Quartalsumsatz nach Region" width="100" height="50" />
    <img src="/charts/trend.svg" alt="Trend" aria-labelledby="trend-caption" width="100" height="50" />
    <span id="trend-caption">Umsatzentwicklung 2025</span>
    <img src="/photos/titel.jpg" alt="" title="Eingang des Rathauses" width="100" height="50" />
    <img src='/photos/an"d\\back.jpg' alt="Zitat und Backslash" width="100" height="50" />
    <div id="zwilling"><img src="/photos/zwilling.jpg" alt="Erster Zwilling" width="10" height="10" /></div>
    <div id="zwilling"><img src="/photos/zwilling.jpg" alt="Zweiter Zwilling" width="10" height="10" /></div>
    <form>
      <input type="image" src="/icons/suche.png" alt="Suche starten" />
      <button type="button"><img src="/icons/schliessen.svg" alt="Dialog schließen" width="10" height="10" /></button>
      <input type="submit" />
      <input type="reset" />
      <input type="button" value="Formular leeren" />
      <input type="text" id="${LONG_ID}" name="${LONG_NAME}" />
      <input type="text" aria-labelledby="hint-label" />
      <span id="hint-label">Suchbegriff</span>
      <input type="text" title="Nur ein Titel" />
      <label for="aria-wins">Nativer Text</label>
      <input type="text" id="aria-wins" aria-label="ARIA gewinnt" />
      <button type="button"><span aria-hidden="true">✕</span>Fenster schließen</button>
      <button type="button"><span style="display:none">Versteckt</span>Jetzt senden</button>
      <button type="button"><span hidden>Unsichtbar</span>Menü öffnen</button>
      <button type="button">
        <img src="/icons/zahnrad.svg" alt="Verstecktes Symbol" aria-hidden="true" width="10" height="10" />
        <img src="/icons/korb.svg" alt="Warenkorb öffnen" width="10" height="10" />
      </button>
      <button type="button"><span aria-hidden="true" aria-label="Verstecktes Label"></span><span aria-label="Suche öffnen"></span></button>
      <button type="button" aria-labelledby="sr-label"></button>
      <span id="sr-label" hidden>Barrierefreiheit prüfen</span>
    </form>
  </main>
</body></html>`;

describe("extractHtmlContext selectors and names (real browser)", () => {
  let browser: Awaited<ReturnType<typeof puppeteer.launch>>;
  let page: Awaited<ReturnType<typeof browser.newPage>>;
  let formElements: string[];
  let images: string[];

  /** The `selector = …` part of an image line. */
  const selectorIn = (line: string): string => line.match(/selector = ([^|]+)/)?.[1].trim() ?? "";

  const lineFor = (needle: string): string => {
    const line = images.find((entry) => entry.includes(needle));
    if (!line) throw new Error(`no image line containing ${needle}`);
    return line;
  };

  /** How many elements the extracted selector addresses on the live page. */
  const matchCount = (selector: string): Promise<number> =>
    page.evaluate((value) => document.querySelectorAll(value).length, selector);

  beforeAll(async () => {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    page = await browser.newPage();
    await page.setContent(SELECTOR_PAGE);

    const context = await extractHtmlContext(page as unknown as BrowserPage, ["forms", "images"]);
    formElements = context.formElements;
    images = context.images;
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it("escapes an id that contains a colon", async () => {
    expect(images).toContain(
      'Image 1: alt text = "Blick über die Mur" | selector = img#hero\\:main | 100x50'
    );
    expect(await matchCount("img#hero\\:main")).toBe(1);
  });

  it("falls back to a unique selector when a src fragment breaks the match", async () => {
    const line = lineFor("Lageplan des Geländes");
    expect(line).not.toContain('img[src$="karte.svg"]');
    expect(selectorIn(line)).toBe("#content > img:nth-of-type(2)");
    expect(await matchCount(selectorIn(line))).toBe(1);
  });

  it("gives two images sharing a data URL distinct, unique selectors", async () => {
    const first = selectorIn(lineFor("Erstes Symbol"));
    const second = selectorIn(lineFor("Zweites Symbol"));

    expect(first).not.toBe(second);
    expect(await matchCount(first)).toBe(1);
    expect(await matchCount(second)).toBe(1);
  });

  it("keeps an alt text longer than 200 characters", () => {
    expect(LONG_ALT.length).toBeGreaterThan(200);
    expect(lineFor("Luftbild des Schlossbergs")).toContain(`alt text = "${LONG_ALT}"`);
  });

  it("truncates an alt text past 1000 characters with an ellipsis", () => {
    expect(OVERLONG_ALT.length).toBeGreaterThan(1000);
    const line = lineFor("Sehr lange Beschreibung");
    expect(line).toContain(`alt text = "${OVERLONG_ALT.substring(0, 1000)}…"`);
    expect(line).not.toContain("Ende.");
  });

  it("escapes a src that contains a quote and a backslash", async () => {
    const selector = selectorIn(lineFor("Zitat und Backslash"));
    expect(selector).toBe('img[src$="an\\"d\\\\back.jpg"]');
    expect(await matchCount(selector)).toBe(1);
  });

  it("gives two images under ancestors sharing an id unique selectors", async () => {
    const first = selectorIn(lineFor("Erster Zwilling"));
    const second = selectorIn(lineFor("Zweiter Zwilling"));

    expect(first).not.toBe(second);
    expect(await matchCount(first)).toBe(1);
    expect(await matchCount(second)).toBe(1);
  });

  it("reports the accessible name an aria-label gives an image with an empty alt", () => {
    expect(lineFor("Quartalsumsatz")).toContain(
      'alt text = (empty) | accessible name = "Quartalsumsatz nach Region" (via aria-label)'
    );
  });

  it("reports an aria-labelledby name next to the alt it overrides", () => {
    expect(lineFor("Umsatzentwicklung")).toContain(
      'alt text = "Trend" | accessible name = "Umsatzentwicklung 2025" (via aria-labelledby)'
    );
  });

  it("falls back to title for the accessible name, after alt", () => {
    expect(lineFor("Rathauses")).toContain(
      'alt text = (empty) | accessible name = "Eingang des Rathauses" (via title)'
    );
    // An alt that is the accessible name is not repeated as one.
    expect(lineFor("Blick über die Mur")).not.toContain("accessible name");
  });

  it("omits graphics hidden through an ancestor or their own role and counts them", () => {
    expect(images.some((line) => line.includes("deko.jpg"))).toBe(false);
    expect(images.some((line) => line.includes("Verstecktes Symbol"))).toBe(false);
    // The hidden svg title, the image under the aria-hidden div, and the
    // aria-hidden icon inside the cart button.
    expect(images).toContain(
      "(3 images hidden from assistive technology via aria-hidden or role=presentation are not listed)"
    );
  });

  it("lists an unnamed role=img that is not hidden as a missing name", () => {
    expect(images).toContain(
      'Image 5: alt text = (missing) | role=img | selector = span[role="img"]'
    );
  });

  it("names an input[type=image] by its alt", () => {
    expect(formElements).toContain('<input> type=image | name: "Suche starten" (via alt)');
  });

  it("names an icon button by the alt of the image it wraps", () => {
    expect(formElements).toContain('<button> type=button | name: "Dialog schließen" (via alt)');
  });

  it("uses the native names of submit and reset buttons, and a value when there is one", () => {
    expect(formElements).toContain('<input> type=submit | name: "Submit" (via default)');
    expect(formElements).toContain('<input> type=reset | name: "Reset" (via default)');
    expect(formElements).toContain('<input> type=button | name: "Formular leeren" (via value)');
  });

  it("resolves aria-labelledby and title without repeating them as evidence", () => {
    expect(formElements).toContain('<input> type=text | name: "Suchbegriff" (via aria-labelledby)');
    expect(formElements).toContain('<input> type=text | name: "Nur ein Titel" (via title)');
  });

  it("prefers an aria-label over a native label, as the name computation does", () => {
    expect(formElements).toContain(
      '<input> type=text id=aria-wins | name: "ARIA gewinnt" (via aria-label) | label: "Nativer Text" (for=aria-wins)'
    );
  });

  it("leaves descendants hidden from assistive technology out of a button name", () => {
    expect(formElements).toContain('<button> type=button | name: "Fenster schließen" (via text)');
    expect(formElements).toContain('<button> type=button | name: "Jetzt senden" (via text)');
    expect(formElements).toContain('<button> type=button | name: "Menü öffnen" (via text)');
    expect(formElements).toContain('<button> type=button | name: "Warenkorb öffnen" (via alt)');
    expect(formElements).toContain('<button> type=button | name: "Suche öffnen" (via aria-label)');
    expect(formElements.join("\n")).not.toContain("Versteckt");
    expect(formElements.join("\n")).not.toContain("Unsichtbar");
    expect(formElements.join("\n")).not.toContain("Verstecktes Label");
  });

  it("resolves an aria-labelledby target that is itself hidden", () => {
    expect(formElements).toContain(
      '<button> type=button | name: "Barrierefreiheit prüfen" (via aria-labelledby)'
    );
  });

  it("caps the id and name attributes that sit in the never-truncated head", () => {
    expect(formElements).toContain(
      `<input> type=text id=${"a".repeat(60)}… name=${"b".repeat(60)}… | label: (none)`
    );
  });
});

// ----- localization eligibility -----

describe("audit() localization eligibility", () => {
  /** A page object target: the caller's page, which localization may use. */
  const callerPage = (): BrowserPage => ({
    url: () => ENGINE_URL,
    title: async () => "Stub Doc",
    goto: async () => undefined,
    screenshot: async () => new Uint8Array(),
    evaluate: (async () => ({})) as unknown as BrowserPage["evaluate"],
  });

  it("does not localize a URL target when only annotation keeps the page open", async () => {
    nextEngineIssues = [makeIssue({ id: "engine-a" })];

    // Annotation is on by default, so audit() owns a page here — but that
    // must not start localization, which scrolls elements into view.
    const result = await audit(ENGINE_URL, { detail: "fix-ready" });

    expect(localizeCalls).toHaveLength(0);
    expect(result.issues.map((issue) => issue.id)).toEqual(["engine-a"]);
  });

  it("still localizes a URL target when the semantic pass owns the page", async () => {
    nextEngineIssues = [makeIssue({ id: "engine-a" })];

    await audit(ENGINE_URL, {
      detail: "fix-ready",
      semantic: { provider: { name: "nebius", apiKey: "stub" } },
    });

    expect(localizeCalls).toHaveLength(1);
    expect(localizeCalls[0].issueIds).toEqual(["engine-a"]);
  });

  it("still localizes a page-object target", async () => {
    nextEngineIssues = [makeIssue({ id: "engine-a" })];

    await audit(callerPage(), { detail: "fix-ready" });

    expect(localizeCalls).toHaveLength(1);
  });

  it("does not localize below detail fix-ready", async () => {
    nextEngineIssues = [makeIssue({ id: "engine-a" })];

    await audit(callerPage(), { detail: "actionable" });

    expect(localizeCalls).toHaveLength(0);
  });
});

// ----- issue annotations -----

/**
 * Fixture whose layout covers every annotation state: a visible image with
 * two issues on it, a sticky header, a `display: none` block, a
 * screen-reader-only paragraph clipped to a pixel, a block pushed off the
 * canvas, a selector that matches three list items, and enough height to make
 * the full-page capture taller than the viewport.
 */
const ANNOTATION_PAGE = `<!doctype html>
<html lang="de">
<head>
  <title>Annotationen – Beispiel</title>
  <style>
    body { margin: 0; font: 16px/1.4 system-ui, sans-serif; }
    #bar { position: sticky; top: 0; height: 60px; background: #123456; color: #fff; }
    #hero { display: block; margin: 40px; width: 400px; height: 200px; background: #cde; }
    #cta { display: block; margin: 20px 40px; width: 240px; height: 48px; }
    #sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
    #gone { display: none; width: 300px; height: 100px; }
    #offcanvas { position: absolute; left: -4000px; top: 300px; width: 300px; height: 50px; }
    #tall { height: 1600px; }
    nav li { width: 200px; height: 32px; }
  </style>
</head>
<body>
  <header id="bar">Kopfzeile</header>
  <main>
    <img id="hero" src="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3C%2Fsvg%3E" />
    <button id="cta" type="button">Jetzt prüfen</button>
    <p id="sr">Nur für Screenreader</p>
    <div id="gone">Ausgeblendet</div>
    <div id="offcanvas">Außerhalb des Bildbereichs</div>
    <nav><ul><li><a href="/a">A</a></li><li><a href="/b">B</a></li><li><a href="/c">C</a></li></ul></nav>
    <div id="tall">Langer Inhalt</div>
  </main>
</body></html>`;

describe("audit() annotations (real browser)", () => {
  let browser: Awaited<ReturnType<typeof puppeteer.launch>>;
  let realPage: Awaited<ReturnType<typeof browser.newPage>>;
  let fixtureShot: Uint8Array;
  let metrics: {
    devicePixelRatio: number;
    documentHeight: number;
    hero: { x: number; y: number; width: number; height: number };
    bar: { x: number; y: number; width: number; height: number };
  };
  let result: Awaited<ReturnType<typeof audit>>;

  /**
   * The real page behind the generic `BrowserPage` surface `audit()` uses.
   * `overrides` let a test break one method (a failing `evaluate`) or count
   * the calls annotation makes.
   */
  const asBrowserPage = (overrides: Partial<BrowserPage> = {}): BrowserPage => ({
    url: () => realPage.url(),
    title: () => realPage.title(),
    goto: (url: string) => realPage.goto(url),
    screenshot: (options) =>
      realPage.screenshot(
        options as Parameters<typeof realPage.screenshot>[0]
      ) as Promise<Uint8Array>,
    evaluate: ((fn: never, arg: never) => realPage.evaluate(fn, arg)) as BrowserPage["evaluate"],
    ...overrides,
  });

  /**
   * Engine findings covering the states: shared element, hidden, ambiguous,
   * page-level (the `html` and `body` targets of rules such as
   * `page-has-heading-one`), no selector.
   */
  const engineIssues = (): Issue[] => [
    makeIssue({ id: "page-has-heading-one", selector: "html" }),
    makeIssue({ id: "landmark-one-main", selector: "body" }),
    makeIssue({ id: "image-alt", selector: "#hero" }),
    makeIssue({ id: "image-redundant-alt", selector: "main #hero" }),
    makeIssue({ id: "hidden-block", selector: "#gone" }),
    makeIssue({ id: "sr-only-text", selector: "#sr" }),
    makeIssue({ id: "off-canvas", selector: "#offcanvas" }),
    makeIssue({ id: "sticky-header", selector: "#bar" }),
    makeIssue({ id: "list-items", selector: "nav li" }),
    makeIssue({ id: "page-level", selector: null }),
  ];

  /** One prose location the model invented, one selector that resolves. */
  const semanticIssues = (): Issue[] => [
    makeSemanticIssue({
      id: "semantic:page-title",
      selector: "the button below the hero image",
    }),
    makeSemanticIssue({ id: "semantic:form-label-clarity", selector: "#cta" }),
  ];

  const annotationFor = (id: string) => result.issues.find((issue) => issue.id === id)?.annotation;

  beforeAll(async () => {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    realPage = await browser.newPage();
    await realPage.setViewport({ width: 1280, height: 720 });
    await realPage.setContent(ANNOTATION_PAGE);

    fixtureShot = await realPage.screenshot({ type: "png", fullPage: true });
    metrics = await realPage.evaluate(() => {
      const box = (selector: string) => {
        const rect = (document.querySelector(selector) as Element).getBoundingClientRect();
        return {
          x: rect.left + window.scrollX,
          y: rect.top + window.scrollY,
          width: rect.width,
          height: rect.height,
        };
      };
      return {
        devicePixelRatio: window.devicePixelRatio,
        documentHeight: document.documentElement.scrollHeight,
        hero: box("#hero"),
        bar: box("#bar"),
      };
    });

    nextEngineIssues = engineIssues();
    nextSemanticIssues = semanticIssues();
    nextEngineScreenshot = fixtureShot;

    result = await audit(asBrowserPage(), {
      semantic: { provider: { name: "nebius", apiKey: "stub" } },
    });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it("resolves a visible element to a mark and the measured rect", () => {
    const annotation = annotationFor("image-alt");

    expect(annotation?.state).toBe("resolved");
    expect(annotation?.selector).toBe("#hero");
    // Second from the top: the sticky header is above the hero image.
    expect(annotation?.mark).toBe(2);
    expect(annotation?.rect?.x).toBeCloseTo(metrics.hero.x, 0);
    expect(annotation?.rect?.y).toBeCloseTo(metrics.hero.y, 0);
    expect(annotation?.rect?.width).toBeCloseTo(metrics.hero.width, 0);
    expect(annotation?.rect?.height).toBeCloseTo(metrics.hero.height, 0);
  });

  it("leaves an issue without a selector unresolved", () => {
    const annotation = annotationFor("page-level");

    expect(annotation).toEqual({ selector: null, state: "unresolved" });
  });

  it("keeps a semantic finding whose location is prose, unresolved", () => {
    const annotation = annotationFor("semantic:page-title");

    expect(annotation?.state).toBe("unresolved");
    expect(annotation?.rect).toBeUndefined();
    expect(result.issues.map((issue) => issue.id)).toContain("semantic:page-title");
  });

  it("annotates a semantic finding whose location is a real selector", () => {
    expect(annotationFor("semantic:form-label-clarity")?.state).toBe("resolved");
    expect(annotationFor("semantic:form-label-clarity")?.mark).toBeDefined();
  });

  it("calls a display:none, a screen-reader-only and an off-canvas element hidden", () => {
    for (const id of ["hidden-block", "sr-only-text", "off-canvas"]) {
      expect(annotationFor(id)?.state).toBe("hidden");
      expect(annotationFor(id)?.rect).toBeUndefined();
      expect(annotationFor(id)?.mark).toBeUndefined();
    }
  });

  it("calls an html- or body-targeted issue page-level, with no rect and no mark", () => {
    for (const id of ["page-has-heading-one", "landmark-one-main"]) {
      const annotation = annotationFor(id);

      expect(annotation?.state).toBe("page");
      expect(annotation?.rect).toBeUndefined();
      expect(annotation?.mark).toBeUndefined();
      expect(annotation?.anchored).toBeUndefined();
    }
  });

  it("marks a selector with several matches ambiguous, on its first match", () => {
    const annotation = annotationFor("list-items");

    expect(annotation?.state).toBe("ambiguous");
    expect(annotation?.rect?.height).toBe(32);
    expect(annotation?.mark).toBeDefined();
  });

  it("gives two issues on one element a shared mark, contiguous from 1", () => {
    expect(annotationFor("image-alt")?.mark).toBe(2);
    expect(annotationFor("image-redundant-alt")?.mark).toBe(2);

    const marks = result.issues
      .map((issue) => issue.annotation?.mark)
      .filter((mark): mark is number => mark !== undefined);
    const distinct = [...new Set(marks)].sort((a, b) => a - b);

    expect(distinct).toEqual([1, 2, 3, 4]);
  });

  it("numbers the marks down the page, not in issue order", () => {
    // Fixture layout: sticky header, hero image, button, nav list.
    expect(annotationFor("sticky-header")?.mark).toBe(1);
    expect(annotationFor("image-alt")?.mark).toBe(2);
    expect(annotationFor("semantic:form-label-clarity")?.mark).toBe(3);
    expect(annotationFor("list-items")?.mark).toBe(4);

    const marked = result.issues
      .filter((issue) => issue.annotation?.mark !== undefined)
      .map((issue) => ({
        mark: issue.annotation?.mark as number,
        y: issue.annotation?.rect?.y as number,
      }))
      .sort((a, b) => a.mark - b.mark);

    for (let index = 1; index < marked.length; index += 1) {
      expect(marked[index].y).toBeGreaterThanOrEqual(marked[index - 1].y);
    }
  });

  it("reports the capture geometry in CSS pixels", () => {
    const png = readPngSize(result.screenshot as Uint8Array);

    expect(result.screenshotMeta?.deviceScaleFactor).toBe(metrics.devicePixelRatio);
    expect(result.screenshotMeta?.width).toBe(
      (png as { width: number }).width / metrics.devicePixelRatio
    );
    expect(result.screenshotMeta?.height).toBe(
      (png as { height: number }).height / metrics.devicePixelRatio
    );
    expect(result.screenshotMeta?.width).toBe(1280);
    expect(result.screenshotMeta?.height).toBe(metrics.documentHeight);
    expect(result.screenshotMeta?.viewport).toEqual({ width: 1280, height: 720 });
    expect(result.screenshotMeta?.fullPage).toBe(true);
    expect(result.screenshotMeta?.document.height).toBe(metrics.documentHeight);
    expect(result.screenshotMeta?.scroll).toEqual({ x: 0, y: 0 });
    // The fixture is taller than the viewport, so the capture is too.
    expect(metrics.documentHeight).toBeGreaterThan(720);
  });

  it("flags a sticky header as anchored at its scroll-0 position", () => {
    const annotation = annotationFor("sticky-header");

    expect(annotation?.anchored).toBe(true);
    expect(annotation?.rect).toEqual({
      x: metrics.bar.x,
      y: metrics.bar.y,
      width: metrics.bar.width,
      height: metrics.bar.height,
    });
    expect(annotation?.rect?.y).toBe(0);
  });

  it("adds no annotation, no geometry and no round trip with annotate: false", async () => {
    nextEngineIssues = engineIssues();
    nextEngineScreenshot = fixtureShot;
    let evaluateCalls = 0;

    const plain = await audit(
      asBrowserPage({
        evaluate: ((fn: never, arg: never) => {
          evaluateCalls += 1;
          return realPage.evaluate(fn, arg);
        }) as BrowserPage["evaluate"],
      }),
      { annotate: false }
    );

    expect(evaluateCalls).toBe(0);
    expect(plain.screenshotMeta).toBeUndefined();
    expect(plain.issues.every((issue) => issue.annotation === undefined)).toBe(true);
  });

  it("keeps annotations out of the baseline file and the last-run cache", async () => {
    const dir = mkdtempSync(join(tmpdir(), "barrieretest-annotate-"));
    const baselinePath = join(dir, "baseline.json");

    try {
      nextEngineIssues = engineIssues();
      nextEngineScreenshot = fixtureShot;

      const annotated = await audit(asBrowserPage(), {
        baseline: baselinePath,
        updateBaseline: true,
      });

      expect(annotated.issues.some((issue) => issue.annotation?.state === "resolved")).toBe(true);
      expect(readFileSync(baselinePath, "utf-8")).not.toContain("annotation");
      expect(
        readFileSync(join(process.cwd(), ".barrieretest", "cache", "last-run.json"), "utf-8")
      ).not.toContain("annotation");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("degrades to all-unresolved with a warning when the measurement fails", async () => {
    nextEngineIssues = engineIssues();
    nextEngineScreenshot = fixtureShot;

    const failed = await audit(
      asBrowserPage({
        evaluate: (() => {
          throw new Error("Execution context was destroyed");
        }) as unknown as BrowserPage["evaluate"],
      })
    );

    expect(failed.issues).toHaveLength(engineIssues().length);
    expect(failed.issues.every((issue) => issue.annotation?.state === "unresolved")).toBe(true);
    expect(failed.screenshotMeta).toBeUndefined();
    // Otherwise a normal result: the score comes from the issues, not from
    // whether they could be placed on the screenshot.
    expect(failed.documentTitle).toBe("Stub Doc");
    expect(failed.score).toBeGreaterThan(0);
    expect(
      consoleWarnSpy.calls.some((args) => String(args[0] ?? "").startsWith("Annotation"))
    ).toBe(true);
  });

  it("does not annotate when the screenshot is not captured", async () => {
    nextEngineIssues = engineIssues();
    nextEngineScreenshot = fixtureShot;
    let evaluateCalls = 0;

    const plain = await audit(
      asBrowserPage({
        evaluate: ((fn: never, arg: never) => {
          evaluateCalls += 1;
          return realPage.evaluate(fn, arg);
        }) as BrowserPage["evaluate"],
      }),
      { captureScreenshot: false }
    );

    expect(evaluateCalls).toBe(0);
    expect(plain.screenshotMeta).toBeUndefined();
    expect(plain.issues.every((issue) => issue.annotation === undefined)).toBe(true);
  });

  it("lets an element override an inherited visibility: hidden without checkVisibility", async () => {
    const fallbackPage = await browser.newPage();
    try {
      await fallbackPage.setContent(`<!doctype html><html><body>
        <div style="visibility: hidden"><span id="shown" style="visibility: visible">sichtbar</span></div>
        <div style="visibility: hidden"><span id="inherited">unsichtbar</span></div>
        <div style="opacity: 0"><span id="faded" style="visibility: visible">transparent</span></div>
      </body></html>`);
      await fallbackPage.evaluate(() => {
        // Force the computed-style fallback used by engines without checkVisibility.
        delete (Element.prototype as { checkVisibility?: unknown }).checkVisibility;
      });

      const measurement = await measureSelectors(fallbackPage as unknown as BrowserPage, [
        "#shown",
        "#inherited",
        "#faded",
      ]);

      expect(measurement.selectors.map((entry) => entry.rendered)).toEqual([true, false, false]);
    } finally {
      await fallbackPage.close();
    }
  });
});

/**
 * The HTML report is the reference consumer of the coordinate map: if it can
 * place every marker from `Issue.annotation` and `screenshotMeta` alone, any
 * viewer can. These tests render a report from a real annotated audit, load
 * it in the browser and measure what the markers actually cover.
 *
 * The report's own Content-Security-Policy (`default-src 'none'`) blocks
 * script injection, which is exactly the point of it — so the axe pass over
 * the report runs on a page with `setBypassCSP(true)`.
 */
describe("renderHtmlReport (real browser)", () => {
  let browser: Awaited<ReturnType<typeof puppeteer.launch>>;
  let fixturePage: Awaited<ReturnType<typeof browser.newPage>>;
  let reportPage: Awaited<ReturnType<typeof browser.newPage>>;
  let result: Awaited<ReturnType<typeof audit>>;
  let reportDir: string;
  let reportPath: string;

  beforeAll(async () => {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    fixturePage = await browser.newPage();
    await fixturePage.setViewport({ width: 1280, height: 720 });
    await fixturePage.setContent(ANNOTATION_PAGE);

    nextEngineIssues = [
      makeIssue({ id: "page-has-heading-one", selector: "html" }),
      makeIssue({ id: "image-alt", impact: "critical", selector: "#hero" }),
      makeIssue({ id: "image-redundant-alt", selector: "main #hero" }),
      makeIssue({ id: "button-name", impact: "serious", selector: "#cta" }),
      makeIssue({ id: "list-items", selector: "nav li" }),
      makeIssue({ id: "hidden-block", impact: "minor", selector: "#gone" }),
      makeIssue({ id: "no-selector", selector: null }),
      makeSemanticIssue({
        id: "semantic:alt-text-quality",
        selector: "#bar",
        semantic: { checkType: "alt-text-quality", confidence: 0.74, suggestion: "Benenne es." },
      }),
    ];
    nextEngineScreenshot = await fixturePage.screenshot({ type: "png", fullPage: true });

    result = await audit({
      url: () => fixturePage.url(),
      title: () => fixturePage.title(),
      goto: (url: string) => fixturePage.goto(url),
      screenshot: (options) =>
        fixturePage.screenshot(
          options as Parameters<typeof fixturePage.screenshot>[0]
        ) as Promise<Uint8Array>,
      evaluate: ((fn: never, arg: never) =>
        fixturePage.evaluate(fn, arg)) as BrowserPage["evaluate"],
    });

    reportDir = mkdtempSync(join(tmpdir(), "barrieretest-html-report-"));
    reportPath = join(reportDir, "report.html");
    writeFileSync(reportPath, renderHtmlReport(result));

    reportPage = await browser.newPage();
    await reportPage.setBypassCSP(true);
    await reportPage.goto(`file://${reportPath}`);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    if (reportDir) rmSync(reportDir, { recursive: true, force: true });
  });

  /**
   * A report document in its own page, so a test can render from a crafted
   * result without disturbing the shared one.
   */
  const openReport = async (html: string, viewport: { width: number; height: number }) => {
    const page = await browser.newPage();
    await page.setViewport(viewport);
    await page.setContent(html, { waitUntil: "load" });
    return page;
  };

  /** The real audit's result with the issues a single test needs. */
  const resultWith = (issues: Issue[]) => ({ ...result, issues });

  /** Every marker's rendered box against its rect scaled to the rendered image. */
  const measureGeometry = (page: Awaited<ReturnType<typeof browser.newPage>>) =>
    page.evaluate(() => {
      const image = document.querySelector(".shot__frame img") as HTMLImageElement;
      const imageRect = image.getBoundingClientRect();
      return {
        image: {
          left: imageRect.left + window.scrollX,
          top: imageRect.top + window.scrollY,
          width: imageRect.width,
          height: imageRect.height,
        },
        markers: [...document.querySelectorAll(".marker")].map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            id: element.id,
            left: rect.left + window.scrollX,
            top: rect.top + window.scrollY,
            width: rect.width,
            height: rect.height,
          };
        }),
      };
    });

  const measureMarkers = async (containerWidth: number) => {
    await reportPage.setViewport({ width: containerWidth, height: 900 });
    return measureGeometry(reportPage);
  };

  for (const containerWidth of [1280, 640]) {
    it(`places every marker on its element at ${containerWidth} CSS px`, async () => {
      const meta = result.screenshotMeta;
      if (!meta) throw new Error("expected screenshotMeta");
      const { image, markers } = await measureMarkers(containerWidth);
      const scale = image.width / meta.width;

      expect(markers.length).toBeGreaterThan(0);
      for (const marker of markers) {
        const mark = Number(marker.id.replace("marker-", ""));
        const rect = result.issues.find((issue) => issue.annotation?.mark === mark)?.annotation
          ?.rect;
        if (!rect) throw new Error(`no rect for ${marker.id}`);

        expect(Math.abs(marker.left - image.left - rect.x * scale)).toBeLessThanOrEqual(1);
        expect(Math.abs(marker.top - image.top - rect.y * scale)).toBeLessThanOrEqual(1);
        expect(Math.abs(marker.width - rect.width * scale)).toBeLessThanOrEqual(1);
        expect(Math.abs(marker.height - rect.height * scale)).toBeLessThanOrEqual(1);
      }
    });
  }

  it("moves focus to the group when a marker is followed, and back again", async () => {
    await reportPage.setViewport({ width: 1280, height: 900 });

    await reportPage.click("#marker-1");
    expect(await reportPage.evaluate(() => document.activeElement?.id)).toBe("group-1");

    await reportPage.click('a[href="#marker-1"]');
    expect(await reportPage.evaluate(() => document.activeElement?.id)).toBe("marker-1");
  });

  it("has a group for every marker and a marker link for every group", async () => {
    const pairs = await reportPage.evaluate(() => ({
      markers: [...document.querySelectorAll(".marker")].map((element) => element.id),
      groups: [...document.querySelectorAll(".group__title[id]")].map((element) => element.id),
      backLinks: [...document.querySelectorAll(".group__link")].map((element) =>
        element.getAttribute("href")
      ),
    }));

    expect(pairs.markers.length).toBe(pairs.groups.length);
    for (const marker of pairs.markers) {
      expect(pairs.groups).toContain(marker.replace("marker-", "group-"));
      expect(pairs.backLinks).toContain(`#${marker}`);
    }
  });

  it("passes its own axe audit with zero violations", async () => {
    await reportPage.setViewport({ width: 1280, height: 900 });
    const axeModule = (await import("axe-core")) as unknown as {
      source?: string;
      default?: { source: string };
    };
    const axeSource = axeModule.source ?? axeModule.default?.source;
    if (!axeSource) throw new Error("Unable to load axe-core source.");

    await reportPage.evaluate((source: string) => {
      const script = document.createElement("script");
      script.textContent = source;
      (document.head ?? document.documentElement).appendChild(script);
    }, axeSource);

    const violations = await reportPage.evaluate(async () => {
      const runtime = globalThis as unknown as {
        axe: { run: (context: Document) => Promise<{ violations: { id: string }[] }> };
      };
      const results = await runtime.axe.run(document);
      return results.violations.map((violation) => violation.id);
    });

    expect(violations).toEqual([]);
  });

  it("reflows at 320 CSS px without horizontal scrolling", async () => {
    await reportPage.setViewport({ width: 320, height: 800 });
    const overflow = await reportPage.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );

    expect(overflow).toBeLessThanOrEqual(1);
  });

  /**
   * A 4 by 4 px element: the marker box is exactly the rect, with no minimum
   * size that would make the outline lie about where the element is. The hit
   * area comes from the marker's pseudo-element instead.
   */
  for (const containerWidth of [1280, 640]) {
    it(`matches a tiny rect exactly at ${containerWidth} CSS px`, async () => {
      const meta = result.screenshotMeta;
      if (!meta) throw new Error("expected screenshotMeta");
      const rect = { x: 300, y: 400, width: 4, height: 4 };
      const page = await openReport(
        renderHtmlReport(
          resultWith([
            {
              ...result.issues[0],
              annotation: { selector: "#dot", state: "resolved", mark: 1, rect },
            },
          ])
        ),
        { width: containerWidth, height: 900 }
      );

      try {
        const { image, markers } = await measureGeometry(page);
        const scale = image.width / meta.width;

        expect(markers).toHaveLength(1);
        expect(Math.abs(markers[0].left - image.left - rect.x * scale)).toBeLessThanOrEqual(1);
        expect(Math.abs(markers[0].top - image.top - rect.y * scale)).toBeLessThanOrEqual(1);
        expect(Math.abs(markers[0].width - rect.width * scale)).toBeLessThanOrEqual(1);
        expect(Math.abs(markers[0].height - rect.height * scale)).toBeLessThanOrEqual(1);

        // The hit area is on the pseudo-element, not on the outlined box.
        const hitArea = await page.evaluate(() => {
          const style = getComputedStyle(
            document.querySelector(".marker") as HTMLElement,
            "::before"
          );
          return { width: Number.parseFloat(style.width), height: Number.parseFloat(style.height) };
        });
        expect(hitArea.width).toBeGreaterThanOrEqual(24);
        expect(hitArea.height).toBeGreaterThanOrEqual(24);
      } finally {
        await page.close();
      }
    });
  }

  /**
   * Side by side the screenshot panel is sticky, at most one viewport tall
   * and scrolls on its own; following "Show marker N" has to bring a marker
   * near the bottom of a tall capture into the panel's visible box, with no
   * script involved.
   */
  it("scrolls the sticky panel to a marker far down the capture", async () => {
    const meta = result.screenshotMeta;
    if (!meta) throw new Error("expected screenshotMeta");
    const rect = { x: 40, y: meta.height - 140, width: 200, height: 40 };
    const page = await openReport(
      renderHtmlReport(
        resultWith([
          {
            ...result.issues[0],
            annotation: { selector: "#footer-note", state: "resolved", mark: 1, rect },
          },
        ])
      ),
      { width: 1440, height: 900 }
    );

    try {
      const panel = await page.evaluate(() => {
        const shot = document.querySelector(".shot") as HTMLElement;
        const style = getComputedStyle(shot);
        return {
          position: style.position,
          overflowY: style.overflowY,
          tabIndex: shot.tabIndex,
          labelled: !!document.getElementById(shot.getAttribute("aria-labelledby") ?? ""),
          scrollable: shot.scrollHeight > shot.clientHeight,
          height: shot.clientHeight,
        };
      });

      expect(panel.position).toBe("sticky");
      expect(panel.overflowY).toBe("auto");
      expect(panel.tabIndex).toBe(0);
      expect(panel.labelled).toBe(true);
      expect(panel.scrollable).toBe(true);
      expect(panel.height).toBeLessThanOrEqual(900);

      await page.click('a[href="#marker-1"]');

      const scrolled = await page.evaluate(
        () => (document.querySelector(".shot") as HTMLElement).scrollTop
      );
      expect(scrolled).toBeGreaterThan(0);

      const seen = await page.evaluate(() => {
        const box = (element: Element) => {
          const rect = element.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
        };
        return {
          marker: box(document.querySelector(".marker") as HTMLElement),
          panel: box(document.querySelector(".shot") as HTMLElement),
          viewport: { width: window.innerWidth, height: window.innerHeight },
        };
      });

      // Inside the panel's visible box …
      expect(seen.marker.top).toBeGreaterThanOrEqual(seen.panel.top - 1);
      expect(seen.marker.bottom).toBeLessThanOrEqual(seen.panel.bottom + 1);
      // … and inside the viewport.
      expect(seen.marker.top).toBeGreaterThanOrEqual(-1);
      expect(seen.marker.bottom).toBeLessThanOrEqual(seen.viewport.height + 1);
      expect(seen.marker.left).toBeGreaterThanOrEqual(-1);
      expect(seen.marker.right).toBeLessThanOrEqual(seen.viewport.width + 1);
    } finally {
      await page.close();
    }
  });

  it("makes the screenshot panel a normal block below 1024 CSS px", async () => {
    const page = await openReport(renderHtmlReport(result), { width: 900, height: 800 });

    try {
      const style = await page.evaluate(() => {
        const shot = document.querySelector(".shot") as HTMLElement;
        const computed = getComputedStyle(shot);
        return { position: computed.position, maxHeight: computed.maxHeight };
      });

      expect(style.position).toBe("static");
      expect(style.maxHeight).toBe("none");
    } finally {
      await page.close();
    }
  });

  /**
   * Result text can be one unbroken token — a minified selector, a long URL,
   * a data URI in a snippet. All of it has to wrap, in either locale.
   */
  const LONG = "x".repeat(200);

  for (const locale of ["en", "de"] as const) {
    it(`wraps unbroken result text at 320 CSS px (${locale})`, async () => {
      const page = await openReport(
        renderHtmlReport(
          {
            ...resultWith([
              {
                ...result.issues[0],
                id: LONG,
                description: LONG,
                help: LONG,
                helpUrl: `https://example.com/${LONG}`,
                failureSummary: LONG,
                selector: LONG,
                nodes: [{ html: `<div class="${LONG}"></div>` }],
                semantic: { checkType: LONG, confidence: 0.5, suggestion: LONG },
                annotation: {
                  selector: LONG,
                  state: "resolved",
                  mark: 1,
                  rect: { x: 10, y: 20, width: 300, height: 100 },
                },
              },
            ]),
            url: `https://example.com/${LONG}`,
            documentTitle: LONG,
          },
          { locale }
        ),
        { width: 320, height: 800 }
      );

      try {
        const overflow = await page.evaluate(() => {
          const limit = document.documentElement.clientWidth;
          const wide = [
            ...document.querySelectorAll(
              ".facts dd, .score__title, .score__desc, .summary, .rules th, .rules td, .issue__headline, .issue__desc, .fields dd, .code, pre, .group__meta code"
            ),
          ]
            .filter((element) => element.getBoundingClientRect().right > limit + 1)
            .map((element) => element.className || element.tagName);
          return {
            page: document.documentElement.scrollWidth - limit,
            wide,
          };
        });

        expect(overflow.wide).toEqual([]);
        expect(overflow.page).toBeLessThanOrEqual(1);
      } finally {
        await page.close();
      }
    });
  }

  /**
   * Criterion 4 in a parsed DOM rather than in the string: load a report
   * rendered from hostile text and ask the browser what elements exist.
   */
  it("renders hostile result text as inert nodes in the parsed DOM", async () => {
    const payload =
      '<script>alert(1)</script>"><img src=x onerror=alert(1)><iframe src=x></iframe>';
    const page = await openReport(
      renderHtmlReport({
        ...resultWith(
          result.issues.map((issue) => ({
            ...issue,
            description: payload,
            help: payload,
            helpUrl: "javascript:alert(1)",
            failureSummary: payload,
            selector: payload,
            nodes: [{ html: payload }],
            semantic: { checkType: payload, confidence: 0.5, suggestion: payload },
          }))
        ),
        url: payload,
        documentTitle: payload,
      }),
      { width: 1280, height: 900 }
    );

    try {
      const dom = await page.evaluate(() => ({
        scripts: document.querySelectorAll("script").length,
        iframes: document.querySelectorAll("iframe").length,
        strayImages: [...document.querySelectorAll("img")].filter(
          (image) => !image.closest(".shot__frame")
        ).length,
        images: document.querySelectorAll("img").length,
        eventHandlers: [...document.querySelectorAll("*")]
          .flatMap((element) => [...element.attributes].map((attribute) => attribute.name))
          .filter((name) => name.startsWith("on")),
        badHrefs: [...document.querySelectorAll("a[href]")]
          .map((anchor) => anchor.getAttribute("href") ?? "")
          .filter((href) => !/^(#|https?:\/\/)/.test(href)),
        alerted: typeof (window as unknown as { __alerted?: boolean }).__alerted,
        text: document.body.textContent ?? "",
      }));

      expect(dom.scripts).toBe(0);
      expect(dom.iframes).toBe(0);
      expect(dom.strayImages).toBe(0);
      expect(dom.images).toBe(1);
      expect(dom.eventHandlers).toEqual([]);
      expect(dom.badHrefs).toEqual([]);
      // The payload is there — as text.
      expect(dom.text).toContain("<script>alert(1)</script>");
      expect(dom.text).toContain("javascript:alert(1)");
    } finally {
      await page.close();
    }
  });

  it("writes the report from the CLI, in the requested locale", async () => {
    const { parseArgs, runCli } = await import("./cli/index.js");
    const target = join(reportDir, "nested", "cli-report.html");

    nextEngineIssues = [makeIssue({ id: "image-alt", selector: "#hero" })];
    nextEngineScreenshot = await fixturePage.screenshot({ type: "png", fullPage: true });

    const cli = await runCli(
      parseArgs(["https://example.test/page", "--html", target, "--html-locale", "de"])
    );

    const written = readFileSync(target, "utf8");
    expect(written.startsWith("<!doctype html>")).toBe(true);
    expect(written).toContain('<html lang="de">');
    expect(written).toContain("Bericht zur Barrierefreiheit");
    expect(cli.message).toContain(`HTML report: ${target}`);
  }, 30_000);
});

/**
 * The whole pipeline once, with no engine mock: real axe-core on a local
 * `file://` fixture, real annotation, real report. Isolated in its own
 * describe, which swaps the stub module for the real engine while it runs and
 * puts the stub back afterwards, so the mocked describes above are untouched.
 */
describe("renderHtmlReport end to end (real audit, real browser)", () => {
  const FIXTURE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Report pipeline fixture</title>
  <style>
    body { margin: 0; font: 16px/1.5 system-ui, sans-serif; }
    #hero { display: block; margin: 24px; width: 320px; height: 180px; background: #cde; }
    #cta { display: block; margin: 24px; width: 220px; height: 44px; }
    #tall { height: 1400px; }
  </style>
</head>
<body>
  <main>
    <h1>Report pipeline fixture</h1>
    <img id="hero" src="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3C%2Fsvg%3E" />
    <button id="cta" type="button"></button>
    <div id="tall">Langer Inhalt</div>
  </main>
</body></html>`;

  let browser: Awaited<ReturnType<typeof puppeteer.launch>>;
  let fixtureDir: string;
  let auditResult: Awaited<ReturnType<typeof audit>>;
  let reportPage: Awaited<ReturnType<typeof browser.newPage>>;

  beforeAll(async () => {
    mock.module("./engines/axe.js", () => realAxe);

    fixtureDir = mkdtempSync(join(tmpdir(), "barrieretest-report-e2e-"));
    const fixturePath = join(fixtureDir, "fixture.html");
    writeFileSync(fixturePath, FIXTURE);

    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const fixturePage = await browser.newPage();
    await fixturePage.setViewport({ width: 1280, height: 720 });
    await fixturePage.goto(`file://${fixturePath}`);

    auditResult = await audit(fixturePage);

    reportPage = await browser.newPage();
    await reportPage.setViewport({ width: 1280, height: 900 });
    await reportPage.setBypassCSP(true);
    await reportPage.setContent(renderHtmlReport(auditResult), { waitUntil: "load" });
  }, 120_000);

  afterAll(async () => {
    try {
      await browser?.close();
      if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
    } finally {
      // A browser that refuses to close must not leave the real modules
      // mocked in for whatever runs next in this process.
      mock.module("./engines/axe.js", () => axeStubModule);
    }
  });

  it("finds real issues and places a marker for every located one", async () => {
    expect(auditResult.issues.length).toBeGreaterThan(0);
    expect(auditResult.screenshotMeta).toBeDefined();
    // Real axe rule ids, so this cannot pass on the stub's findings.
    expect(auditResult.issues.map((issue) => issue.id).sort()).toEqual([
      "button-name",
      "image-alt",
    ]);
    expect(auditResult.documentTitle).toBe("Report pipeline fixture");

    const located = new Set(
      auditResult.issues
        .map((issue) => issue.annotation)
        .filter((annotation) => annotation?.mark !== undefined && annotation?.rect)
        .map((annotation) => `marker-${annotation?.mark}`)
    );
    expect(located.size).toBeGreaterThan(0);

    const markers = await reportPage.evaluate(() =>
      [...document.querySelectorAll(".marker")].map((element) => element.id)
    );
    expect(new Set(markers)).toEqual(located);
  });

  it("passes its own axe audit with zero violations", async () => {
    const axeModule = (await import("axe-core")) as unknown as {
      source?: string;
      default?: { source: string };
    };
    const axeSource = axeModule.source ?? axeModule.default?.source;
    if (!axeSource) throw new Error("Unable to load axe-core source.");

    await reportPage.evaluate((source: string) => {
      const script = document.createElement("script");
      script.textContent = source;
      (document.head ?? document.documentElement).appendChild(script);
    }, axeSource);

    const violations = await reportPage.evaluate(async () => {
      const runtime = globalThis as unknown as {
        axe: { run: (context: Document) => Promise<{ violations: { id: string }[] }> };
      };
      const results = await runtime.axe.run(document);
      return results.violations.map((violation) => violation.id);
    });

    expect(violations).toEqual([]);
  });
});

/**
 * The lazy-content step against a local fixture, with the real engine and a
 * real browser: a `loading="lazy"` image and an IntersectionObserver reveal,
 * both several viewports below the fold. Served from a temp directory over
 * `file://` — a `data:` URL loads eagerly and would not exercise any of this.
 */
describe("lazy content (real audit, real browser)", () => {
  const PICTURE = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">
  <rect width="400" height="300" fill="#36c" />
</svg>`;

  const FIXTURE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Lazy content fixture</title>
  <style>
    body { margin: 0; font: 16px/1.5 system-ui, sans-serif; }
    .spacer { height: 3000px; }
    /* Chrome loads lazy images up to about 2500 px ahead of the viewport on
       slow connection estimates; the image sits well beyond that even after
       a test scrolls to 400 px, so only a scroll-through loads it. */
    .spacer--far { height: 6000px; }
    #lazy { display: block; width: 400px; height: 300px; }
    #reveal { height: 200px; background: #eee; opacity: 0; }
    #reveal.shown { opacity: 1; }
  </style>
</head>
<body>
  <main>
    <h1>Lazy content fixture</h1>
    <div class="spacer spacer--far"></div>
    <img id="lazy" src="picture.svg" loading="lazy" alt="A blue rectangle" />
    <div class="spacer"></div>
    <div id="reveal">Revealed when it intersects</div>
  </main>
  <script>
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) entry.target.classList.add("shown");
      }
    });
    observer.observe(document.getElementById("reveal"));
  </script>
</body></html>`;

  /**
   * A second fixture for the `content-visibility: auto` case: the image loads
   * eagerly but Chrome skips rendering the subtree outside the viewport, so
   * without the override it paints blank in the full-page capture. The
   * `contain-intrinsic-size` matches the image box, so the placeholder and
   * the rendered content have the same height.
   *
   * Next to it, the two ways content is deliberately unrendered, each with a
   * coloured block the capture would show if the override reached it: the
   * browser's own `hidden="until-found"` and an author style. Their intrinsic
   * size matches their content too, so every position below them is the same
   * whether they render or not.
   */
  const CV_FIXTURE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Content-visibility fixture</title>
  <style>
    body { margin: 0; background: #fff; font: 16px/1.5 system-ui, sans-serif; }
    .spacer { height: 3000px; }
    #skipped { content-visibility: auto; contain-intrinsic-size: 400px 300px; }
    #picture { display: block; width: 400px; height: 300px; }
    #author-hidden { content-visibility: hidden; contain-intrinsic-size: 400px 300px; }
    #until-found { contain-intrinsic-size: 400px 300px; }
    /* Full width, so the box centre is inside the coloured area. */
    .panel { height: 300px; color: #fff; }
  </style>
</head>
<body>
  <main>
    <h1>Content-visibility fixture</h1>
    <div class="spacer"></div>
    <div id="skipped">
      <img id="picture" src="picture.svg" alt="A blue rectangle" />
    </div>
    <div id="author-hidden">
      <div class="panel" style="background: #cc3333">Collapsed by an author style</div>
    </div>
    <div id="until-found" hidden="until-found">
      <div class="panel" style="background: #33cc33">Collapsed until found</div>
    </div>
  </main>
</body></html>`;

  /**
   * A third fixture for the layout the override leaves behind: a
   * `content-visibility: auto` section whose `contain-intrinsic-size`
   * placeholder is 500 px shorter than its content, so everything below it
   * sits in a different place depending on whether the subtree renders.
   * Below it, an image without `alt` — a real axe finding on an element with
   * a distinctive colour, so its annotation rect can be checked against the
   * capture.
   */
  const LAYOUT_FIXTURE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Layout fixture</title>
  <style>
    body { margin: 0; background: #fff; font: 16px/1.5 system-ui, sans-serif; }
    /* Measured with this viewport: an \`auto\` subtree 1200 px below the fold
       still renders, one 3000 px down is skipped — so this far it is. */
    .spacer { height: 3000px; }
    #grows { content-visibility: auto; contain-intrinsic-size: 400px 100px; }
    #grows .inner { height: 600px; background: #eee; }
    #target { display: block; width: 400px; height: 300px; }
  </style>
</head>
<body>
  <main>
    <h1>Layout fixture</h1>
    <div class="spacer"></div>
    <div id="grows"><div class="inner">Tall content behind a short placeholder</div></div>
    <div class="spacer"></div>
    <img id="target" src="picture.svg" />
  </main>
</body></html>`;

  /** What the fixture looks like right now, read from the live page. */
  const readState = (page: Awaited<ReturnType<typeof browser.newPage>>) =>
    page.evaluate(() => {
      const image = document.getElementById("lazy") as HTMLImageElement;
      const reveal = document.getElementById("reveal") as HTMLElement;
      return {
        imageComplete: image.complete,
        imageWidth: image.naturalWidth,
        revealOpacity: getComputedStyle(reveal).opacity,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      };
    });

  let browser: Awaited<ReturnType<typeof puppeteer.launch>>;
  let fixtureDir: string;
  let fixtureUrl: string;
  let cvFixtureUrl: string;
  let cspFixtureUrl: string;
  let layoutFixtureUrl: string;

  beforeAll(async () => {
    mock.module("./engines/axe.js", () => realAxe);
    mock.module("./puppeteer-launch.js", () => realPuppeteerLaunch);

    fixtureDir = mkdtempSync(join(tmpdir(), "barrieretest-lazy-"));
    writeFileSync(join(fixtureDir, "picture.svg"), PICTURE);
    const fixturePath = join(fixtureDir, "fixture.html");
    writeFileSync(fixturePath, FIXTURE);
    fixtureUrl = `file://${fixturePath}`;
    const cvFixturePath = join(fixtureDir, "cv-fixture.html");
    writeFileSync(cvFixturePath, CV_FIXTURE);
    cvFixtureUrl = `file://${cvFixturePath}`;
    // The same page behind a policy that blocks every stylesheet inserted
    // after it. A meta policy does not apply to the fixture's own <style>,
    // which comes first, so only the audit's override is at stake.
    const cspFixturePath = join(fixtureDir, "csp-fixture.html");
    writeFileSync(
      cspFixturePath,
      CV_FIXTURE.replace(
        "</style>",
        `</style>\n  <meta http-equiv="Content-Security-Policy" content="style-src 'none'" />`
      )
    );
    cspFixtureUrl = `file://${cspFixturePath}`;
    const layoutFixturePath = join(fixtureDir, "layout-fixture.html");
    writeFileSync(layoutFixturePath, LAYOUT_FIXTURE);
    layoutFixtureUrl = `file://${layoutFixturePath}`;

    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }, 120_000);

  afterAll(async () => {
    try {
      await browser?.close();
      if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
    } finally {
      // A browser that refuses to close must not leave the real modules
      // mocked in for whatever runs next in this process.
      mock.module("./engines/axe.js", () => axeStubModule);
      mock.module("./puppeteer-launch.js", () => puppeteerLaunchStubModule);
    }
  });

  it("loads the lazy image and the revealed element, and ends at the top", async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });

    try {
      // The engine navigates itself here, which is what arms the step.
      const result = await realAxe.runAxeCore(fixtureUrl, { page });
      expect(result.documentTitle).toBe("Lazy content fixture");

      const state = await readState(page);
      expect(state.imageComplete).toBe(true);
      expect(state.imageWidth).toBeGreaterThan(0);
      expect(state.revealOpacity).toBe("1");
      expect(state.scrollX).toBe(0);
      expect(state.scrollY).toBe(0);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("leaves the page unloaded when loadLazyContent is false", async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });

    try {
      await realAxe.runAxeCore(fixtureUrl, { page, loadLazyContent: false });

      const state = await readState(page);
      expect(state.imageComplete).toBe(false);
      expect(state.imageWidth).toBe(0);
      expect(state.revealOpacity).toBe("0");
      expect(state.scrollY).toBe(0);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("does not scroll a caller-supplied page that is already at the target URL", async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });

    try {
      await page.goto(fixtureUrl, { waitUntil: "networkidle2" });
      // A non-zero start proves the page is left where its owner put it, not
      // merely that nothing scrolled past the fold.
      await page.evaluate(() => {
        window.scrollTo({ top: 400, left: 0, behavior: "instant" });
      });

      const result = await audit(page);
      expect(result.documentTitle).toBe("Lazy content fixture");

      const state = await readState(page);
      expect(state.scrollY).toBe(400);
      expect(state.imageComplete).toBe(false);
      expect(state.revealOpacity).toBe("0");
      // A page we did not navigate is not mutated either: no render-all
      // override, so it keeps the `content-visibility` limitation.
      const overrides = await page.evaluate(() => ({
        flag: (window as unknown as Record<string, unknown>).__barrieretestRenderAll,
        sheets: document.adoptedStyleSheets.length,
      }));
      expect(overrides).toEqual({ flag: undefined, sheets: 0 });
    } finally {
      await page.close();
    }
  }, 60_000);

  it("reports scroll 0 in screenshotMeta for a URL audit", async () => {
    const result = await audit(fixtureUrl);

    expect(result.documentTitle).toBe("Lazy content fixture");
    expect(result.screenshotMeta?.scroll).toEqual({ x: 0, y: 0 });
  }, 60_000);

  /**
   * Decodes a PNG the audit returned, in the browser we already have, and
   * reads one pixel: the most direct evidence that the lazy image really is
   * in the capture rather than only in the DOM afterwards.
   */
  async function samplePixel(
    png: Uint8Array,
    x: number,
    y: number
  ): Promise<{ r: number; g: number; b: number }> {
    const dataUrl = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
    const sampler = await browser.newPage();

    try {
      return await sampler.evaluate(
        async (input: { dataUrl: string; x: number; y: number }) => {
          const image = new Image();
          await new Promise((resolve, reject) => {
            image.onload = () => resolve(undefined);
            image.onerror = () => reject(new Error("Screenshot did not decode"));
            image.src = input.dataUrl;
          });

          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const context = canvas.getContext("2d");
          if (!context) {
            throw new Error("No 2d context");
          }
          context.drawImage(image, 0, 0);

          const [r, g, b] = context.getImageData(input.x, input.y, 1, 1).data;
          return { r, g, b };
        },
        { dataUrl, x, y }
      );
    } finally {
      await sampler.close();
    }
  }

  it("renders the lazy image in the screenshot audit() returns", async () => {
    // The image has a fixed CSS size, so its document position is the same
    // whether or not the file ever loaded; measure it on a separate page,
    // since audit() owns and closes its own.
    const probe = await browser.newPage();
    let center: { x: number; y: number };
    try {
      await probe.setViewport({ width: 1280, height: 720 });
      await probe.goto(fixtureUrl, { waitUntil: "networkidle2" });
      center = await probe.evaluate(() => {
        const rect = (document.getElementById("lazy") as HTMLImageElement).getBoundingClientRect();
        return {
          x: rect.x + window.scrollX + rect.width / 2,
          y: rect.y + window.scrollY + rect.height / 2,
        };
      });
    } finally {
      await probe.close();
    }

    const loaded = await audit(fixtureUrl);
    const unloaded = await audit(fixtureUrl, { loadLazyContent: false });

    const scale = loaded.screenshotMeta?.deviceScaleFactor ?? 1;
    const atCenter = (png: Uint8Array | undefined) => {
      if (!png) throw new Error("Audit returned no screenshot");
      return samplePixel(png, Math.round(center.x * scale), Math.round(center.y * scale));
    };

    // #36c is the fixture image; anything else means a blank box.
    expect(await atCenter(loaded.screenshot)).toEqual({ r: 0x33, g: 0x66, b: 0xcc });
    expect(await atCenter(unloaded.screenshot)).not.toEqual({ r: 0x33, g: 0x66, b: 0xcc });
  }, 120_000);

  it("renders content-visibility: auto content in the screenshot audit() returns", async () => {
    // Measured with the subtree forced to render, which is the layout the
    // audit captures; the placeholder has the same height, so the position
    // holds for the unloaded capture too.
    const probe = await browser.newPage();
    let center: { x: number; y: number };
    try {
      await probe.setViewport({ width: 1280, height: 720 });
      await probe.goto(cvFixtureUrl, { waitUntil: "networkidle2" });
      center = await probe.evaluate(() => {
        (document.getElementById("skipped") as HTMLElement).style.contentVisibility = "visible";
        const rect = (
          document.getElementById("picture") as HTMLImageElement
        ).getBoundingClientRect();
        return {
          x: rect.x + window.scrollX + rect.width / 2,
          y: rect.y + window.scrollY + rect.height / 2,
        };
      });
    } finally {
      await probe.close();
    }

    const rendered = await audit(cvFixtureUrl);
    const skipped = await audit(cvFixtureUrl, { loadLazyContent: false });

    const scale = rendered.screenshotMeta?.deviceScaleFactor ?? 1;
    const atCenter = (png: Uint8Array | undefined) => {
      if (!png) throw new Error("Audit returned no screenshot");
      return samplePixel(png, Math.round(center.x * scale), Math.round(center.y * scale));
    };

    // #36c is the fixture image; anything else means skipped rendering.
    expect(await atCenter(rendered.screenshot)).toEqual({ r: 0x33, g: 0x66, b: 0xcc });
    expect(await atCenter(skipped.screenshot)).not.toEqual({ r: 0x33, g: 0x66, b: 0xcc });
  }, 120_000);

  it("renders content-visibility: auto content behind a style-src policy", async () => {
    // An inserted <style> would be dropped silently here (its sheet stays
    // null); the override is a constructed sheet, which the policy does not
    // govern.
    const probe = await browser.newPage();
    let center: { x: number; y: number };
    try {
      await probe.setViewport({ width: 1280, height: 720 });
      await probe.goto(cspFixtureUrl, { waitUntil: "networkidle2" });
      center = await probe.evaluate(() => {
        const rect = (
          document.getElementById("picture") as HTMLImageElement
        ).getBoundingClientRect();
        return {
          x: rect.x + window.scrollX + rect.width / 2,
          y: rect.y + window.scrollY + rect.height / 2,
        };
      });
    } finally {
      await probe.close();
    }

    const rendered = await audit(cspFixtureUrl);
    const scale = rendered.screenshotMeta?.deviceScaleFactor ?? 1;
    if (!rendered.screenshot) throw new Error("Audit returned no screenshot");
    const pixel = await samplePixel(
      rendered.screenshot,
      Math.round(center.x * scale),
      Math.round(center.y * scale)
    );

    expect(pixel).toEqual({ r: 0x33, g: 0x66, b: 0xcc });
  }, 120_000);

  it("leaves content-visibility: hidden content unrendered", async () => {
    // The boxes keep their intrinsic size whether or not their content
    // renders, so one measurement describes both captures.
    const probe = await browser.newPage();
    let centers: { author: { x: number; y: number }; untilFound: { x: number; y: number } };
    try {
      await probe.setViewport({ width: 1280, height: 720 });
      await probe.goto(cvFixtureUrl, { waitUntil: "networkidle2" });
      centers = await probe.evaluate(() => {
        const centerOf = (id: string) => {
          const rect = (document.getElementById(id) as HTMLElement).getBoundingClientRect();
          return {
            x: rect.x + window.scrollX + rect.width / 2,
            y: rect.y + window.scrollY + rect.height / 2,
          };
        };
        return { author: centerOf("author-hidden"), untilFound: centerOf("until-found") };
      });
    } finally {
      await probe.close();
    }

    const rendered = await audit(cvFixtureUrl);
    const scale = rendered.screenshotMeta?.deviceScaleFactor ?? 1;
    const at = (point: { x: number; y: number }) => {
      if (!rendered.screenshot) throw new Error("Audit returned no screenshot");
      return samplePixel(
        rendered.screenshot,
        Math.round(point.x * scale),
        Math.round(point.y * scale)
      );
    };

    // Only the boxes themselves paint, so their area shows the page
    // background; the coloured panel inside each of them would mean the
    // override reached it (verified: a `*` selector paints both).
    expect(await at(centers.author)).toEqual({ r: 0xff, g: 0xff, b: 0xff });
    expect(await at(centers.untilFound)).toEqual({ r: 0xff, g: 0xff, b: 0xff });

    // The DOM state the rest of the audit sees, on a page of our own: the
    // audit closes the page it navigated itself.
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: 1280, height: 720 });
      await page.goto(cvFixtureUrl, { waitUntil: "networkidle2" });
      const summary = await loadLazyContent(page);
      expect(summary.renderAll).toBe(true);
      // Both boxes: the walk reads computed values, so it marks the
      // `hidden="until-found"` box too, which the selector excludes anyway.
      expect(summary.keptHidden).toBe(2);

      const state = await page.evaluate(() => {
        const cv = (id: string) =>
          getComputedStyle(document.getElementById(id) as HTMLElement).contentVisibility;
        const panelShown = (id: string) =>
          (
            (document.getElementById(id) as HTMLElement).firstElementChild as HTMLElement
          ).checkVisibility();
        return {
          skipped: cv("skipped"),
          author: cv("author-hidden"),
          untilFound: cv("until-found"),
          authorPanelShown: panelShown("author-hidden"),
          untilFoundPanelShown: panelShown("until-found"),
        };
      });

      expect(state.skipped).toBe("visible");
      expect(state.author).toBe("hidden");
      expect(state.untilFound).toBe("hidden");
      expect(state.authorPanelShown).toBe(false);
      expect(state.untilFoundPanelShown).toBe(false);
    } finally {
      await page.close();
    }
  }, 120_000);

  it("annotates on the same layout the screenshot shows", async () => {
    // Where the image sits once the skipped subtree renders, which is the
    // layout the whole audit works on with the override in place.
    const probe = await browser.newPage();
    let expected: { x: number; y: number; width: number; height: number };
    try {
      await probe.setViewport({ width: 1280, height: 720 });
      await probe.goto(layoutFixtureUrl, { waitUntil: "networkidle2" });
      expected = await probe.evaluate(() => {
        (document.getElementById("grows") as HTMLElement).style.contentVisibility = "visible";
        const rect = (document.getElementById("target") as HTMLElement).getBoundingClientRect();
        return {
          x: rect.x + window.scrollX,
          y: rect.y + window.scrollY,
          width: rect.width,
          height: rect.height,
        };
      });
    } finally {
      await probe.close();
    }

    const result = await audit(layoutFixtureUrl);

    const issue = result.issues.find((candidate) => candidate.selector?.includes("#target"));
    const rect = issue?.annotation?.rect;
    if (!rect) throw new Error("The image without alt was not annotated");
    expect(issue?.annotation?.state).toBe("resolved");

    // The rect describes the grown layout, not the 100 px placeholder: the
    // override went in before anything measured. Annotation rounds rects
    // outward to whole pixels, hence the floor/ceil.
    expect(rect.x).toBe(Math.floor(expected.x));
    expect(rect.y).toBe(Math.floor(expected.y));
    expect(rect.x + rect.width).toBe(Math.ceil(expected.x + expected.width));
    expect(rect.y + rect.height).toBe(Math.ceil(expected.y + expected.height));

    // And the capture agrees: #36c is the image, white would mean the
    // screenshot was taken on a layout 500 px shorter than the measured one.
    const scale = result.screenshotMeta?.deviceScaleFactor ?? 1;
    if (!result.screenshot) throw new Error("Audit returned no screenshot");
    const center = await samplePixel(
      result.screenshot,
      Math.round((rect.x + rect.width / 2) * scale),
      Math.round((rect.y + rect.height / 2) * scale)
    );
    expect(center).toEqual({ r: 0x33, g: 0x66, b: 0xcc });

    // Nothing grew between the capture and the measurement either.
    expect(result.screenshotMeta?.height).toBe(result.screenshotMeta?.document.height);
  }, 120_000);

  it("stays inside its budget and stops scrolling when frames never fire", async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });

    try {
      await page.goto(fixtureUrl, { waitUntil: "networkidle2" });

      // Suspended frames are the case this guards: with an unbounded frame
      // wait the in-page step outlives the Node-side timeout and can scroll
      // the page while the next audit step is already measuring it.
      await page.evaluate(() => {
        const probe = window as unknown as {
          __scrolls: number[];
          requestAnimationFrame: (callback: FrameRequestCallback) => number;
          scrollTo: (options?: ScrollToOptions) => void;
        };
        probe.__scrolls = [];
        probe.requestAnimationFrame = () => 0;
        const realScrollTo = window.scrollTo.bind(window) as (options?: ScrollToOptions) => void;
        probe.scrollTo = (options?: ScrollToOptions) => {
          probe.__scrolls.push(options?.top ?? 0);
          realScrollTo(options);
        };
      });

      const readProbe = () =>
        page.evaluate(() => ({
          scrolls: (window as unknown as { __scrolls: number[] }).__scrolls.length,
          scrollY: window.scrollY,
          flags: Object.keys(window).filter((key) =>
            key.startsWith("__barrieretestLazyContentCancel_")
          ),
        }));

      const budgetMs = 1_500;
      const started = Date.now();
      await loadLazyContent(page, { budgetMs });
      const elapsed = Date.now() - started;

      // Below the Node-side timeout (budget plus a 1 s grace): the page has
      // to stop itself, the Node race is only the fallback. With unbounded
      // frame waits the step runs into that fallback instead.
      expect(elapsed).toBeLessThan(budgetMs + 1_000);

      const settled = await readProbe();
      expect(settled.scrollY).toBe(0);
      // The cancel flag is cleaned up, so the page is left as we found it.
      expect(settled.flags).toEqual([]);

      await new Promise((resolve) => setTimeout(resolve, 1_000));

      const later = await readProbe();
      expect(later.scrolls).toBe(settled.scrolls);
      expect(later.scrollY).toBe(0);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("stops at the scroll cap on a page taller than the cap", async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });

    try {
      await page.goto(fixtureUrl, { waitUntil: "networkidle2" });
      const summary = await loadLazyContent(page, { maxScrollPx: 1_440 });

      expect(summary.steps).toBe(2);
      expect(summary.reachedEnd).toBe(false);
      expect((await readState(page)).scrollY).toBe(0);
    } finally {
      await page.close();
    }
  }, 60_000);
});

/**
 * Rendering pass against real pages in a real browser: the conditions are
 * applied, captured and reverted by Chromium, so the acceptance criteria of
 * `docs/plans/rendering-checks.md` can only be checked here. Fixtures are
 * `file://` pages, one per criterion.
 */
describe("rendering checks (real audit, real browser)", () => {
  const REFLOW_FIXTURE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>Reflow fixture</title></head>
<body>
  <h1>Reflow</h1>
  <div id="wide" style="width: 400px; background: #cfe">A fixed 400 px wide block of text.</div>
  <p>Ordinary paragraph that reflows.</p>
</body></html>`;

  const TABLE_FIXTURE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>Table fixture</title></head>
<body>
  <h1>Data table</h1>
  <table id="data" style="width: 600px">
    <caption>Opening hours</caption>
    <thead><tr><th scope="col">Day</th><th scope="col">From</th><th scope="col">To</th></tr></thead>
    <tbody><tr><td>Monday</td><td>09:00</td><td>17:00</td></tr></tbody>
  </table>
</body></html>`;

  const CLIPPED_FIXTURE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>Clipped fixture</title></head>
<body>
  <h1>Clipping</h1>
  <p id="clipped" style="overflow: hidden; height: 2em; width: 200px; margin: 0">
    This paragraph is three lines long in a box that is two lines tall, so the rest is cut off.
  </p>
</body></html>`;

  const overlapFixture = (secondTop: number) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>Overlap fixture</title></head>
<body>
  <h1>Overlap</h1>
  <div style="position: relative; height: 260px">
    <p id="first" style="position: absolute; top: 0; left: 0; width: 200px; height: 100px; margin: 0">First block of text.</p>
    <p id="second" style="position: absolute; top: ${secondTop}px; left: 0; width: 200px; height: 100px; margin: 0">Second block of text.</p>
  </div>
</body></html>`;

  const MODE_FIXTURE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>Mode fixture</title>
<style>
  body { background: #fff; color: #111 }
  @media (prefers-color-scheme: dark) { body { background: #111; color: #eee } }
</style></head>
<body>
  <h1>Modes</h1>
  <p id="copy">Some copy to measure spacing on.</p>
</body></html>`;

  /**
   * The two layouts that produced false overlaps on real sites: a block of
   * off-canvas skip links stacked on one spot, and two links in one
   * paragraph where the second wraps, so its rect is the union of two lines
   * and covers the first one.
   */
  const NOT_OVERLAPPING_FIXTURE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>Not overlapping fixture</title></head>
<body>
  <section id="skiplinks">
    <a style="position: absolute; left: -1000px; top: -1000px" href="#main">Skip to content</a>
    <a style="position: absolute; left: -1000px; top: -1000px" href="#nav">Skip to navigation</a>
    <a style="position: absolute; left: -1000px; top: -1000px" href="#search">Skip to search</a>
  </section>
  <main id="main" style="width: 260px">
    <h1>Links in a paragraph</h1>
    <p>
      Text before <a href="https://example.com/one">the first link</a> and then some more words
      before <a href="https://example.com/two">a second link whose text is long enough to wrap
      across two lines</a> and a tail.
    </p>
  </main>
</body></html>`;

  /** Text that the narrow layout drops, outside any navigation region. */
  const HIDDEN_FIXTURE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>Hidden fixture</title>
<style>@media (max-width: 500px) { .desktop-only { display: none } }</style></head>
<body>
  <h1>Mobile drop</h1>
  <p class="desktop-only">Opening hours are Monday to Friday from nine to five.</p>
  <p>Always visible paragraph.</p>
</body></html>`;

  /**
   * The three tuning rules of the 2026-10-15 amendment, each with the case
   * it must report:
   *
   * - one section the narrow layout hides takes five paragraphs with it, and
   *   is one finding naming the section;
   * - the menu of the `nav` is revealable, because the hamburger that opens
   *   it sits outside the `nav` and carries `aria-expanded` — the page-wide
   *   rule, which `HIDDEN_NAV_FIXTURE` is the counter-case of;
   * - the label inside the search link is hidden while the link itself
   *   stays, and is not lost content.
   */
  const HIDDEN_REGION_FIXTURE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>Hidden region fixture</title>
<style>
  @media (max-width: 500px) { #promos, #menu, #search-label { display: none } }
  #hamburger { min-width: 44px; min-height: 44px }
</style></head>
<body>
  <header>
    <button type="button" id="hamburger" aria-expanded="false">Menu</button>
    <nav aria-label="Main">
      <ul id="menu">
        <li><a href="/offer">Our whole offer</a></li>
        <li><a href="/references">References from our clients</a></li>
      </ul>
    </nav>
    <a href="/search" id="search-link">Go &#x2192; <span id="search-label">Search the whole site</span></a>
  </header>
  <main>
    <h1>Hidden regions</h1>
    <div id="promos">
      <p>Opening hours are Monday to Friday from nine to five.</p>
      <p>Our whole offer is explained on the offer page.</p>
      <p>Call the office for an appointment.</p>
      <p>News from the last quarter of the year.</p>
      <p>Jobs are advertised twice a year.</p>
    </div>
    <p>Always visible paragraph.</p>
  </main>
</body></html>`;

  /**
   * A hidden region whose first member carries a finding of its own: the
   * section disappears at the narrow viewport, and the paragraph it starts
   * with clips its text at every viewport. Two findings about two different
   * boxes, so two markers — the region's own box, and the paragraph's.
   */
  const HIDDEN_CLIPPED_FIXTURE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>Hidden clipped fixture</title>
<style>
  body { margin: 0 }
  @media (max-width: 500px) { #promos { display: none } }
  #promos { width: 320px; padding: 40px 0 }
  #promos p { width: 300px; margin: 0 }
  #clipped-promo { overflow: hidden; height: 2em }
</style></head>
<body>
  <h1>Hidden and clipped</h1>
  <div id="promos">
    <p id="clipped-promo">Opening hours are Monday to Friday from nine to five, and on Saturday morning by appointment only.</p>
    <p id="second-promo">Our whole offer is explained on the offer page.</p>
  </div>
  <p>Always visible paragraph.</p>
</body></html>`;

  /**
   * The text-spacing override, observed while it is applied: a sampler keeps
   * every distinct set of computed values `#copy` went through, and the box
   * fits its text at the page's own spacing and clips under the override.
   */
  const SPACING_FIXTURE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>Spacing fixture</title>
<style>
  body { font-family: system-ui, sans-serif }
  #copy { font-size: 20px; margin: 0 }
  #spacing-fits { overflow: hidden; width: 320px; height: 60px; font-size: 16px; line-height: 1.2; margin: 0 }
</style></head>
<body>
  <h1>Text spacing</h1>
  <p id="copy">Some copy to measure spacing on.</p>
  <p id="spacing-fits">This paragraph fits its box at the spacing of the page and clips under the override.</p>
  <script>
    window.__spacingSamples = [];
    const copy = document.getElementById('copy');
    const sample = () => {
      const style = getComputedStyle(copy);
      const entry = {
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing,
        wordSpacing: style.wordSpacing,
        marginBottom: style.marginBottom,
      };
      const samples = window.__spacingSamples;
      const last = samples[samples.length - 1];
      if (samples.length > 50) return;
      if (!last || JSON.stringify(last) !== JSON.stringify(entry)) samples.push(entry);
    };
    sample();
    setInterval(sample, 10);
  </script>
</body></html>`;

  /** A patch of pure red, which Chromium's protanopia turns to dark olive. */
  const PATCH_FIXTURE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>Patch fixture</title>
<style>body { margin: 0 } #patch { width: 200px; height: 200px; background: rgb(255, 0, 0) }</style></head>
<body>
  <div id="patch"></div>
  <h1>Colour patch</h1>
</body></html>`;

  /**
   * A column of solid patches, for measuring the colour simulation against
   * the browser's own vision-deficiency emulation. Each patch is 120 by 120
   * CSS px and is sampled at its centre, far from any JPEG block edge.
   */
  const SIMULATION_PATCHES: [string, [number, number, number]][] = [
    ["red", [255, 0, 0]],
    ["green", [0, 255, 0]],
    ["blue", [0, 0, 255]],
    ["orange", [230, 120, 20]],
    ["teal", [0, 140, 140]],
    ["link", [26, 85, 177]],
  ];

  const PATCHES_FIXTURE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>Patches fixture</title>
<style>body { margin: 0 } div { width: 240px; height: 120px }</style></head>
<body>
${SIMULATION_PATCHES.map(
  ([name, [r, g, b]]) => `  <div id="${name}" style="background: rgb(${r}, ${g}, ${b})"></div>`
).join("\n")}
  <h1>Colour patches</h1>
</body></html>`;

  /**
   * The two CVD checks, with the cases they must not report next to the ones
   * they must.
   *
   * The colours are not decorative. The band where a link passes the
   * link-in-text-block ratio of 3:1 and fails it under a deficiency is
   * narrow, because the Machado matrices mostly preserve luminance: the
   * green link in navy text is 3.34:1 normally, 2.84:1 under protanopia and
   * 2.83:1 under deuteranopia, and the brick-red link in near-black text is
   * 3.26:1 normally and 2.56:1 under protanopia — while under deuteranopia
   * red gets *brighter*, so that one keeps its distance there. No red link
   * collapses under both, which is a property of the model, not of the
   * fixture.
   *
   * The link cases cover what each side of the comparison is: `#modern`
   * authors the same two colours in `color(srgb …)`, which Chromium
   * serialises in that space, so it only has a finding when the measurement
   * normalises colours in the page; `#span-neighbour` has navy spans around
   * it in a near-black block and `#nested-neighbour` near-black spans in a
   * navy block, so reading the block instead of the text beside the link
   * would miss the first and invent the second; `#mixed` has two colours in
   * its own text and `#between` disagreeing text on its two sides, and
   * neither can be judged. `#hidden-neighbour`, `#transparent-neighbour`
   * and `#sr-only-neighbour` have near-black text nobody sees between the
   * navy copy and the link, and `#hidden-inside` carries all three kinds
   * inside itself: text a reader is not shown is no neighbour and no second
   * style of the link's own text, so all four are the same finding
   * `#colour-only` is. Reading the hidden runs instead would compare the
   * link with near-black — 4.5:1 and no collapse — and judge the link with
   * the hidden words in it as text in two styles.
   *
   * The state pairs carry the same visible text and the same icon on both
   * sides, which is what leaves colour as the only cue: two labels that
   * merely read differently are a difference the check cannot tell from a
   * state marker, and it leaves those pairs alone. `#dot-one` is the
   * wrapper case — its comparison is the button in the next `<li>`, like
   * `<li><a aria-current="page">` — and the `select` is the only one of its
   * kind on the page, so nothing says what a valid one looks like.
   * `#empty-one` and `#collapse-one` are the two sides of a foreground that
   * paints nothing: the first pair paints the same grey and differs only in
   * a `color` an empty button shows nowhere, which is no cue at all, and the
   * second carries its state in a background that collapses while that
   * unused `color` survives, which must not stand in for the cue that is
   * gone.
   */
  /** The one icon both sides of a state pair carry, byte for byte. */
  const CVD_ICON =
    '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" fill="currentColor" /></svg>';

  const CVD_FIXTURE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>CVD fixture</title>
<style>
  body { background: #fff; color: #1a1a1a; font-family: system-ui, sans-serif; margin: 0; padding: 24px }
  .navy { color: #000088 }
  .ink { color: #1a1a1a }
  a { text-decoration: none }
  #colour-only, #span-neighbour, #nested-neighbour, #mixed, #between { color: #008800 }
  #hidden-neighbour, #transparent-neighbour, #sr-only-neighbour, #hidden-inside { color: #008800 }
  .gone { display: none }
  .transparent { opacity: 0 }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap }
  #underlined { color: #008800; text-decoration: underline }
  #baseline-fail { color: #336699 }
  #brick { color: #b94600 }
  .tab { padding: 4px 8px; border: 1px solid #ccc; background: #eee; color: #333; min-width: 44px; min-height: 44px }
  .tab[aria-selected="true"] { background: #cfe8cf }
  .marked[aria-selected="true"]::after { content: " \\2713" }
  .dots { list-style: none; display: flex; gap: 8px; margin: 0; padding: 0 }
  .dot { width: 44px; height: 44px; border: 0; border-radius: 50%; background: #747474 }
  .dot[aria-current="true"] { background: #008800 }
  /* Two empty dots that paint the same and differ in a colour nobody sees. */
  .plain-dot { width: 44px; height: 44px; border: 0; border-radius: 50%; background: #747474; color: #008800 }
  .plain-dot[aria-current="true"] { color: #bb0000 }
  /* The background carries the state; the unused colour survives the deficiency. */
  .collapse-dot { width: 44px; height: 44px; border: 0; border-radius: 50%; background: #747474; color: #000088 }
  .collapse-dot[aria-current="true"] { background: #008800; color: #bb0000 }
  /* Icon dots: the svg root passes currentColor down, but its only shape
     paints black, so the differing colour is painted nowhere. */
  .icon-dot { width: 44px; height: 44px; border: 0; border-radius: 50%; background: #747474; color: #008800 }
  .icon-dot[aria-current="true"] { color: #bb0000 }
  /* A framed paragraph: its border and shadow belong to both sides alike,
     while the link carries a cue of its own. */
  .framed { border: 1px solid #000088; padding: 4px; box-shadow: 0 0 4px #888888 }
  #border-cue { color: #008800; border-bottom: 1px solid #008800 }
  #shadow-cue { color: #008800; box-shadow: inset 0 -1px 0 #008800 }
</style></head>
<body>
  <main>
    <h1>Links and states</h1>
    <p class="navy">Some copy with <a id="colour-only" href="https://example.com/1">a green link with no underline</a> inside a block of navy text that goes on for a while.</p>
    <p class="navy">Some copy with <a id="underlined" href="https://example.com/2">an underlined green link</a> inside a block of navy text that goes on for a while.</p>
    <p class="navy">Some copy with <a id="baseline-fail" href="https://example.com/3">a link that already fails the ratio</a> inside a block of navy text that goes on for a while.</p>
    <p>Some copy with <a id="brick" href="https://example.com/4">a brick-red link with no underline</a> inside a block of near-black text that goes on for a while.</p>
    <p id="modern-block" style="color: color(srgb 0 0 0.533333)">Some copy with <a id="modern" href="https://example.com/5" style="color: color(srgb 0 0.533333 0)">a green link written in a modern colour space</a> inside a block of navy text that goes on for a while.</p>
    <p class="ink"><span class="navy">Some navy copy with </span><a id="span-neighbour" href="https://example.com/6">a green link with no underline</a><span class="navy"> around it, in a block whose own colour is near-black.</span></p>
    <p class="navy"><span class="ink">Some near-black copy with </span><a id="nested-neighbour" href="https://example.com/7">a green link with no underline</a><span class="ink"> around it, in a block whose own colour is navy.</span></p>
    <p class="navy">Some copy with <a id="mixed" href="https://example.com/8">a green link <span class="ink">with a near-black word in it</span></a> inside a block of navy text that goes on for a while.</p>
    <p class="navy">Some navy copy with <a id="between" href="https://example.com/9">a green link</a><span class="ink"> and near-black copy after it, so the two sides disagree.</span></p>
    <p class="navy">Some navy copy with <span class="ink gone">near-black copy nobody sees</span><a id="hidden-neighbour" href="https://example.com/10">a green link with no underline</a><span class="ink gone">more near-black copy nobody sees</span> and navy copy after it.</p>
    <p class="navy">Some navy copy with <span class="ink transparent">near-black copy nobody sees</span><a id="transparent-neighbour" href="https://example.com/11">a green link with no underline</a><span class="ink transparent">more near-black copy nobody sees</span> and navy copy after it.</p>
    <p class="navy">Some navy copy with <span class="ink sr-only">near-black copy nobody sees</span><a id="sr-only-neighbour" href="https://example.com/12">a green link with no underline</a><span class="ink sr-only"><span>more near-black copy nobody sees</span></span> and navy copy after it.</p>
    <p class="navy">Some copy with <a id="hidden-inside" href="https://example.com/13">a green link <span class="ink gone">with a word nobody sees</span><span class="ink transparent">and a transparent one</span><span class="ink sr-only">and one only a screen reader reads</span></a> inside a block of navy text that goes on for a while.</p>
    <div role="tablist" aria-label="Colour only">
      <button class="tab" role="tab" aria-selected="true" id="tab-one" aria-label="Chart">${CVD_ICON}</button>
      <button class="tab" role="tab" aria-selected="false" id="tab-two" aria-label="Table">${CVD_ICON}</button>
    </div>
    <div role="tablist" aria-label="With a marker">
      <button class="tab marked" role="tab" aria-selected="true" id="tab-marked" aria-label="Map">${CVD_ICON}</button>
      <button class="tab marked" role="tab" aria-selected="false" id="tab-plain" aria-label="List">${CVD_ICON}</button>
    </div>
    <nav aria-label="Slides">
      <ul class="dots">
        <li><button type="button" class="dot" id="dot-one" aria-current="true" aria-label="Slide 1"></button></li>
        <li><button type="button" class="dot" id="dot-two" aria-label="Slide 2"></button></li>
      </ul>
    </nav>
    <nav aria-label="Pages">
      <ul class="dots">
        <li><button type="button" class="plain-dot" id="empty-one" aria-current="true" aria-label="Page 1"></button></li>
        <li><button type="button" class="plain-dot" id="empty-two" aria-label="Page 2"></button></li>
      </ul>
    </nav>
    <nav aria-label="Steps">
      <ul class="dots">
        <li><button type="button" class="collapse-dot" id="collapse-one" aria-current="true" aria-label="Step 1"></button></li>
        <li><button type="button" class="collapse-dot" id="collapse-two" aria-label="Step 2"></button></li>
      </ul>
    </nav>
    <nav aria-label="Icons">
      <ul class="dots">
        <li><button type="button" class="icon-dot" id="icon-dot-one" aria-current="true" aria-label="Icon 1"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="2" y="2" width="12" height="12" fill="black" /></svg></button></li>
        <li><button type="button" class="icon-dot" id="icon-dot-two" aria-label="Icon 2"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="2" y="2" width="12" height="12" fill="black" /></svg></button></li>
      </ul>
    </nav>
    <p class="navy framed">Some copy with <a id="border-cue" href="https://example.com/14">a green link with a border underline</a> inside a framed block of navy text that goes on for a while.</p>
    <p class="navy framed">Some copy with <a id="shadow-cue" href="https://example.com/15">a green link with a shadow underline</a> inside a framed block of navy text that goes on for a while.</p>
    <form>
      <label for="lonely">Pick a region</label>
      <select id="lonely" aria-invalid="true"><option>Styria</option></select>
    </form>
  </main>
</body></html>`;

  /** The same menu, with no disclosure control anywhere on the page. */
  const HIDDEN_NAV_FIXTURE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>Hidden nav fixture</title>
<style>@media (max-width: 500px) { #menu { display: none } }</style></head>
<body>
  <header>
    <nav aria-label="Main">
      <ul id="menu">
        <li><a href="/offer">Our whole offer</a></li>
        <li><a href="/references">References from our clients</a></li>
      </ul>
    </nav>
  </header>
  <main><h1>No toggle</h1><p>Always visible paragraph.</p></main>
</body></html>`;

  /**
   * The disclosure exemption as the contract spells it out: a control only
   * exempts what it can reveal. The search button in the `header` reveals
   * nothing, so the opening hours the narrow layout drops are a finding; the
   * hamburger in the `nav` controls the menu, so the menu is not.
   */
  const DISCLOSURE_FIXTURE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>Disclosure fixture</title>
<style>@media (max-width: 500px) { .desktop-only, #menu { display: none } }</style></head>
<body>
  <header>
    <button type="button">Search</button>
    <p class="desktop-only" id="hours">Opening hours are Monday to Friday from nine to five.</p>
    <nav aria-label="Main">
      <button type="button" aria-controls="menu" aria-expanded="false">Menu</button>
      <ul id="menu">
        <li><a href="/offer">Our whole offer</a></li>
        <li><a href="/contact">Contact the office</a></li>
      </ul>
    </nav>
  </header>
  <main><p>Always visible paragraph.</p></main>
</body></html>`;

  /**
   * Criterion 4 (amended 2026-10-15): icon buttons of 16 by 16 px in a row.
   * WCAG 2.5.8 and axe let an undersized target pass when it has enough
   * space around it, so at the desktop width the row is spaced out and
   * passes, and on the phone the spacing collapses and it fails: the case
   * only the rendering check can see. `TARGET_ALWAYS_FIXTURE` is the same
   * row cramped at every width, which the engine pass reports itself.
   */
  const TARGET_FIXTURE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>Target fixture</title>
<style>
  body { margin: 0; font-family: system-ui, sans-serif }
  .icon { width: 16px; height: 16px; padding: 0; margin: 0; border: 0; background: #06c }
  #toolbar { display: flex; gap: 24px }
  @media (max-width: 600px) { #toolbar { gap: 2px } }
</style></head>
<body>
  <main>
    <h1>Icon buttons</h1>
    <div id="toolbar">
      <button class="icon" id="share" aria-label="Share"></button>
      <button class="icon" id="print" aria-label="Print"></button>
      <button class="icon" id="save" aria-label="Save"></button>
    </div>
  </main>
</body></html>`;

  const TARGET_ALWAYS_FIXTURE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>Target fixture</title>
<style>
  body { margin: 0; font-family: system-ui, sans-serif }
  .icon { width: 16px; height: 16px; padding: 0; margin: 0; border: 0; background: #06c }
  #toolbar { display: flex; gap: 2px }
</style></head>
<body>
  <main>
    <h1>Icon buttons</h1>
    <div id="toolbar">
      <button class="icon" id="share" aria-label="Share"></button>
      <button class="icon" id="print" aria-label="Print"></button>
      <button class="icon" id="save" aria-label="Save"></button>
    </div>
  </main>
</body></html>`;

  /**
   * Criterion 5: a link that only fails contrast in dark mode, next to one
   * that fails in both — the second is the baseline rule, and must not be
   * reported as something the mode broke.
   */
  const DARK_CONTRAST_FIXTURE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>Dark contrast fixture</title>
<style>
  body { background: #fff; color: #111; font-family: system-ui, sans-serif }
  a { color: #0b5ed7; text-decoration: underline }
  #always-bad { color: #eee }
  @media (prefers-color-scheme: dark) { #dark-only { color: #777; background: #666 } }
</style></head>
<body>
  <main>
    <h1>Modes and contrast</h1>
    <p>Some copy with <a id="dark-only" href="https://example.com/one">a link that only fails in dark mode</a> in it.</p>
    <p>More copy with <a id="always-bad" href="https://example.com/two">a link that fails in both</a> in it.</p>
  </main>
</body></html>`;

  /**
   * Forced colours: the icon button is rendered by its background image
   * alone and has nothing left under a forced palette; the button with a
   * label, the one with an inline `svg`, the decorative divider and the
   * bordered image submit — replaced content, which keeps rendering — do.
   *
   * The swatch panel opts out of the forced palette, which is a finding, and
   * `forced-color-adjust` is inherited: the swatch in it computes to `none`
   * as well, and the opt-out is reported once, where it was decided.
   */
  const FORCED_COLORS_FIXTURE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>Forced colours fixture</title>
<style>
  body { margin: 0; font-family: system-ui, sans-serif }
  #icon-only { width: 24px; height: 24px; border: 0; background-color: transparent;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Ccircle cx='12' cy='12' r='8' fill='%23333'/%3E%3C/svg%3E") }
  #divider { width: 200px; height: 4px; border-top: 1px solid #ccc }
  #image-submit { width: 24px; height: 24px; border: 1px solid #ccc; background-color: transparent }
</style></head>
<body>
  <main>
    <h1>Forced colours</h1>
    <button id="icon-only" type="button" aria-label="Search"></button>
    <button id="with-text" type="button">Print</button>
    <button id="with-svg" type="button" aria-label="Save"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect width="16" height="16" fill="currentColor"></rect></svg></button>
    <div id="divider"></div>
    <div id="swatches" style="forced-color-adjust: none; border: 1px solid #ccc; width: 60px; padding: 4px">
      <span id="swatch" style="display: inline-block; width: 20px; height: 20px; border: 1px solid #333"></span>
    </div>
    <form action="/search">
      <input id="image-submit" type="image" alt="Go" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Crect width='24' height='24' fill='%23333'/%3E%3C/svg%3E" />
    </form>
  </main>
</body></html>`;

  /**
   * A page that cross-fades its colours when the mode flips, the way a
   * Tailwind `duration-200` class does: mid-fade the link is grey on grey,
   * settled it is black on white. Measuring the fade is measuring a colour
   * nobody sees — 25 such findings on one live site before the pass waited
   * for the transitions.
   */
  const TRANSITION_FIXTURE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>Transition fixture</title>
<style>
  body { background: #fff; color: #111; font-family: system-ui, sans-serif }
  /* The background flips at once, the link colour needs 600 ms to follow. */
  #fading { color: #111; text-decoration: underline; transition: color 600ms linear }
  @media (prefers-color-scheme: dark) {
    body { background: #111; color: #eee }
    #fading { color: #eee }
  }
</style></head>
<body>
  <main>
    <h1>Colours that fade</h1>
    <p>Some copy with <a id="fading" href="https://example.com/">a link that fades to a readable colour</a> in it.</p>
  </main>
</body></html>`;

  /**
   * Fifty contrast failures the page has in both modes, and one it only has
   * in dark mode, last in document order. The condition's axe run carries 50
   * nodes per rule, so the one node a check can report only survives when
   * the baseline's own nodes are dropped before that cap applies.
   */
  const CONTRAST_CAP_FIXTURE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>Contrast cap fixture</title>
<style>
  body { background: #fff; color: #111; font-family: system-ui, sans-serif }
  a { text-decoration: underline }
  .always { color: #eee; background: #fff }
  #dark-only { color: #0b5ed7; background: #fff }
  @media (prefers-color-scheme: dark) {
    body { background: #111; color: #eee }
    #dark-only { color: #777; background: #666 }
  }
</style></head>
<body>
  <main>
    <h1>Fifty failures and one</h1>
${Array.from(
  { length: 50 },
  (_, index) =>
    `    <p>Copy with <a class="always" href="https://example.com/${index}">link ${index} that fails in both modes</a> in it.</p>`
).join("\n")}
    <p>Copy with <a id="dark-only" href="https://example.com/dark">a link that only fails in dark mode</a> in it.</p>
  </main>
</body></html>`;

  /**
   * More failures the mode introduced than one run carries, so the condition
   * is reported as truncated instead of silently partial.
   */
  const CONTRAST_MANY_FIXTURE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>Contrast many fixture</title>
<style>
  body { background: #fff; color: #111; font-family: system-ui, sans-serif }
  a { color: #0b5ed7; background: #fff; text-decoration: underline }
  @media (prefers-color-scheme: dark) {
    body { background: #111; color: #eee }
    a { color: #777; background: #666 }
  }
</style></head>
<body>
  <main>
    <h1>Sixty failures dark mode introduced</h1>
${Array.from(
  { length: 60 },
  (_, index) =>
    `    <p>Copy with <a href="https://example.com/${index}">link ${index} that only fails in dark mode</a> in it.</p>`
).join("\n")}
  </main>
</body></html>`;

  /**
   * The two forced-colours contrast cases, side by side, measured in
   * Chromium 2026-10-15.
   *
   * `#filled` is light text on a dark box, which passes as the page is
   * normally rendered. Under forced colours the palette replaces its `color`
   * with black and its background with white — black on white, perfectly
   * readable — while `-webkit-text-fill-color` keeps the author's `#dddddd`,
   * which is the colour axe measures: 1.35 against white, a failure about a
   * colour that is nowhere on the screen. That node is dropped.
   *
   * `#opted` sets `forced-color-adjust: none` under forced colours, with a
   * background and a text-fill colour of its own. The palette does not reach
   * it, so the fill colour is the painted one and axe's 1.3 is real: that
   * node stays, although its `color` and its fill colour differ too.
   */
  const FORCED_CONTRAST_FIXTURE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>Forced contrast fixture</title>
<style>
  body { background: #fff; color: #111; font-family: system-ui, sans-serif }
  #filled { background-color: #222222; color: #dddddd; -webkit-text-fill-color: #dddddd;
    padding: 4px }
  @media (forced-colors: active) {
    #opted {
      forced-color-adjust: none;
      background-color: #666666;
      color: #777777;
      -webkit-text-fill-color: #787878;
    }
  }
</style></head>
<body>
  <main>
    <h1>Forced colours and contrast</h1>
    <p id="filled">Copy the author draws light on a dark box of its own.</p>
    <p id="opted">Copy that keeps the author's own colours when the system forces its palette.</p>
  </main>
</body></html>`;

  /**
   * Two animations on one element, and a nested pair whose inner animation
   * starts first, so `getAnimations()` lists the descendant before its
   * ancestor. One element is one thing that moves, whatever order its
   * animations come in.
   */
  const MOTION_IDENTITY_FIXTURE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>Motion identity fixture</title>
<style>
  body { margin: 0; font-family: system-ui, sans-serif }
  #multi { width: 40px; height: 40px; background: #333;
    animation: spin 2s linear infinite, pulse 3s linear infinite }
  @keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
  @keyframes pulse { from { opacity: 1 } to { opacity: 0.4 } }
  #outer { width: 60px; height: 60px; background: #06c }
  #inner { width: 20px; height: 20px; background: #fff }
</style></head>
<body>
  <main>
    <h1>One element, two animations</h1>
    <div id="multi"></div>
    <div id="outer"><div id="inner"></div></div>
  </main>
  <script>
    /* The inner animation is created first, so it comes first in the list. */
    document.getElementById('inner').animate(
      [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
      { duration: 2000, iterations: Infinity }
    );
    document.getElementById('outer').animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.2)' }],
      { duration: 2000, iterations: Infinity }
    );
  </script>
</body></html>`;

  /**
   * `forced-color-adjust: none` on `html` or on `body`, which opts the whole
   * page out of the forced palette. The walk starts inside the body, so
   * neither element used to be collected at all: the opt-out had no owner to
   * be reported at, and the descendants that merely inherited it were
   * suppressed as the ancestor's decision — one finding became none.
   */
  const rootAdjustFixture = (owner: "html" | "body") => `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>Root opt-out fixture</title>
<style>
  body { font-family: system-ui, sans-serif }
  ${owner} { forced-color-adjust: none }
</style></head>
<body>
  <main>
    <h1>Colours the system may not replace</h1>
    <p>Copy under an element that opted the whole page out of the forced palette.</p>
    <span id="swatch" style="display: inline-block; width: 20px; height: 20px; background: #06c"></span>
  </main>
</body></html>`;

  /**
   * More bordered elements than the forced-colours group carries. None of
   * them is a finding — a plain divider is decoration — so only the
   * collection can report that it stopped early.
   */
  const PAINTED_CAP_FIXTURE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>Painted cap fixture</title>
<style>
  body { font-family: system-ui, sans-serif }
  .rule { width: 200px; height: 4px; border-top: 1px solid #ccc }
</style></head>
<body>
  <main>
    <h1>More borders than the group carries</h1>
${Array.from({ length: MAX_PAINTED + 20 }, () => '    <div class="rule"></div>').join("\n")}
  </main>
</body></html>`;

  /**
   * One animated carousel with more animated children than the motion group
   * carries. The children fold into the carousel, so the check reports one
   * movement and is nowhere near its own cap: only the collection can report
   * that it stopped early.
   */
  const MOTION_CAP_FIXTURE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>Motion cap fixture</title>
<style>
  body { margin: 0; font-family: system-ui, sans-serif }
  #carousel { padding: 4px }
  .dot { display: inline-block; width: 10px; height: 10px; margin: 1px; background: #06c }
</style></head>
<body>
  <main>
    <h1>One movement, many animations</h1>
    <div id="carousel">
${Array.from({ length: MAX_ANIMATIONS + 20 }, () => '      <span class="dot"></span>').join("\n")}
    </div>
  </main>
  <script>
    /* The carousel's own animation is created first, so it leads the list
       and the cap drops children rather than the element that owns them. */
    document.getElementById('carousel').animate(
      [{ transform: 'translateX(0)' }, { transform: 'translateX(10px)' }],
      { duration: 2000, iterations: Infinity }
    );
    for (const dot of document.querySelectorAll('.dot')) {
      dot.animate([{ opacity: 1 }, { opacity: 0.4 }], { duration: 2000, iterations: Infinity });
    }
  </script>
</body></html>`;

  /** Criterion 6, with and without a reduced-motion rule that stops it. */
  const motionFixture = (honoursReducedMotion: boolean) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>Motion fixture</title>
<style>
  body { margin: 0; font-family: system-ui, sans-serif }
  #spinner { width: 40px; height: 40px; background: #333; animation: spin 2s linear infinite }
  @keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
  ${honoursReducedMotion ? "@media (prefers-reduced-motion: reduce) { #spinner { animation: none } }" : ""}
</style></head>
<body>
  <main>
    <h1>Motion</h1>
    <div id="spinner"></div>
  </main>
</body></html>`;

  let browser: Awaited<ReturnType<typeof puppeteer.launch>>;
  let fixtureDir: string;
  const url = (name: string) => `file://${join(fixtureDir, name)}`;

  beforeAll(async () => {
    mock.module("./engines/axe.js", () => realAxe);
    mock.module("./puppeteer-launch.js", () => realPuppeteerLaunch);

    fixtureDir = mkdtempSync(join(tmpdir(), "barrieretest-rendering-"));
    writeFileSync(join(fixtureDir, "reflow.html"), REFLOW_FIXTURE);
    writeFileSync(join(fixtureDir, "table.html"), TABLE_FIXTURE);
    writeFileSync(join(fixtureDir, "clipped.html"), CLIPPED_FIXTURE);
    writeFileSync(join(fixtureDir, "overlap.html"), overlapFixture(50));
    writeFileSync(join(fixtureDir, "adjacent.html"), overlapFixture(120));
    writeFileSync(join(fixtureDir, "mode.html"), MODE_FIXTURE);
    writeFileSync(join(fixtureDir, "not-overlapping.html"), NOT_OVERLAPPING_FIXTURE);
    writeFileSync(join(fixtureDir, "hidden.html"), HIDDEN_FIXTURE);
    writeFileSync(join(fixtureDir, "hidden-region.html"), HIDDEN_REGION_FIXTURE);
    writeFileSync(join(fixtureDir, "hidden-clipped.html"), HIDDEN_CLIPPED_FIXTURE);
    writeFileSync(join(fixtureDir, "spacing.html"), SPACING_FIXTURE);
    writeFileSync(join(fixtureDir, "patch.html"), PATCH_FIXTURE);
    writeFileSync(join(fixtureDir, "patches.html"), PATCHES_FIXTURE);
    writeFileSync(join(fixtureDir, "cvd.html"), CVD_FIXTURE);
    writeFileSync(join(fixtureDir, "hidden-nav.html"), HIDDEN_NAV_FIXTURE);
    writeFileSync(join(fixtureDir, "disclosure.html"), DISCLOSURE_FIXTURE);
    writeFileSync(join(fixtureDir, "target.html"), TARGET_FIXTURE);
    writeFileSync(join(fixtureDir, "target-always.html"), TARGET_ALWAYS_FIXTURE);
    writeFileSync(join(fixtureDir, "dark-contrast.html"), DARK_CONTRAST_FIXTURE);
    writeFileSync(join(fixtureDir, "forced-colors.html"), FORCED_COLORS_FIXTURE);
    writeFileSync(join(fixtureDir, "contrast-cap.html"), CONTRAST_CAP_FIXTURE);
    writeFileSync(join(fixtureDir, "contrast-many.html"), CONTRAST_MANY_FIXTURE);
    writeFileSync(join(fixtureDir, "forced-contrast.html"), FORCED_CONTRAST_FIXTURE);
    writeFileSync(join(fixtureDir, "motion-identity.html"), MOTION_IDENTITY_FIXTURE);
    writeFileSync(join(fixtureDir, "transition.html"), TRANSITION_FIXTURE);
    writeFileSync(join(fixtureDir, "root-adjust-html.html"), rootAdjustFixture("html"));
    writeFileSync(join(fixtureDir, "root-adjust-body.html"), rootAdjustFixture("body"));
    writeFileSync(join(fixtureDir, "painted-cap.html"), PAINTED_CAP_FIXTURE);
    writeFileSync(join(fixtureDir, "motion-cap.html"), MOTION_CAP_FIXTURE);
    writeFileSync(join(fixtureDir, "motion.html"), motionFixture(false));
    writeFileSync(join(fixtureDir, "motion-reduced.html"), motionFixture(true));

    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }, 120_000);

  afterAll(async () => {
    try {
      await browser?.close();
      if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
    } finally {
      // A browser that refuses to close must not leave the real modules
      // mocked in for whatever runs next in this process.
      mock.module("./engines/axe.js", () => axeStubModule);
      mock.module("./puppeteer-launch.js", () => puppeteerLaunchStubModule);
    }
  });

  const renderIssues = (result: Awaited<ReturnType<typeof audit>>, checkId?: string) =>
    result.issues.filter(
      (issue) =>
        issue.rendering !== undefined &&
        (checkId === undefined || issue.rendering.checkId === checkId)
    );

  // Criterion 1
  it("reports a fixed-width element as a reflow failure, and nothing without the option", async () => {
    const withRendering = await audit(url("reflow.html"), {
      rendering: { conditions: ["viewport:320"] },
    });

    const findings = renderIssues(withRendering, "reflow-horizontal-scroll");
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding.id).toBe("render:reflow-horizontal-scroll");
    expect(finding.impact).toBe("serious");
    expect(finding.helpUrl).toContain("reflow");
    expect(finding.rendering?.condition).toBe("viewport:320");
    expect(finding.selector).toBe("#wide");
    expect(Number(finding.rendering?.evidence.scrollWidth)).toBeGreaterThan(320);
    // The rect sits on the element, in the capture's space.
    expect(finding.annotation?.state).toBe("resolved");
    expect(finding.annotation?.mark).toBe(1);
    expect(finding.annotation?.rect?.width).toBeGreaterThanOrEqual(400);
    expect(withRendering.renderingMeta?.conditionsRun).toEqual(["viewport:320"]);

    const plain = await audit(url("reflow.html"));
    expect(renderIssues(plain)).toEqual([]);
    expect(plain.renderingMeta).toBeUndefined();
    expect(plain.renderingCaptures).toBeUndefined();
    // The same audit otherwise: the engine findings and their annotations are
    // untouched, and only the added rendering finding moves the score, which
    // the scoring module weighs like any other issue.
    expect(plain.issues.map((issue) => issue.id)).toEqual(
      withRendering.issues.filter((issue) => !issue.rendering).map((issue) => issue.id)
    );
    expect(plain.issues.map((issue) => issue.annotation?.mark)).toEqual(
      withRendering.issues
        .filter((issue) => !issue.rendering)
        .map((issue) => issue.annotation?.mark)
    );
    expect(plain.score).toBeGreaterThan(withRendering.score);
  }, 120_000);

  // Criterion 7
  it("does not report a data table wider than the viewport", async () => {
    const result = await audit(url("table.html"), {
      rendering: { conditions: ["viewport:320"] },
    });

    expect(renderIssues(result, "reflow-horizontal-scroll")).toEqual([]);
    expect(result.renderingMeta?.conditionsRun).toEqual(["viewport:320"]);
  }, 120_000);

  // Criterion 2
  it("reports clipped text under text spacing and under the 320 px viewport", async () => {
    const result = await audit(url("clipped.html"), {
      rendering: { conditions: ["viewport:320", "text-spacing"] },
    });

    const findings = renderIssues(result, "overflow-clipped-text");
    expect(findings.map((issue) => issue.rendering?.condition).sort()).toEqual([
      "text-spacing",
      "viewport:320",
    ]);
    for (const finding of findings) {
      expect(finding.selector).toBe("#clipped");
      expect(finding.impact).toBe("serious");
      expect(Number(finding.rendering?.evidence.clippedBy)).toBeGreaterThan(1);
      expect(finding.annotation?.state).toBe("resolved");
    }
    expect(
      findings.find((issue) => issue.rendering?.condition === "text-spacing")?.helpUrl
    ).toContain("text-spacing");
  }, 120_000);

  // Criterion 3
  it("reports overlapping paragraphs and leaves adjacent ones alone", async () => {
    const overlapping = await audit(url("overlap.html"), {
      rendering: { conditions: ["viewport:1280"] },
    });

    const findings = renderIssues(overlapping, "overlap-text");
    expect(findings).toHaveLength(1);
    expect(findings[0].selector).toBe("#second");
    expect(findings[0].rendering?.evidence.otherSelector).toBe("#first");
    expect(Number(findings[0].rendering?.evidence.overlapRatio)).toBeCloseTo(0.5, 1);
    expect(findings[0].annotation?.rect?.height).toBeGreaterThan(40);

    const adjacent = await audit(url("adjacent.html"), {
      rendering: { conditions: ["viewport:1280"] },
    });
    expect(renderIssues(adjacent, "overlap-text")).toEqual([]);
  }, 120_000);

  it("does not report off-canvas links or a wrapped inline link as an overlap", async () => {
    const result = await audit(url("not-overlapping.html"), {
      rendering: { conditions: ["viewport:320", "viewport:1280"] },
    });

    expect(renderIssues(result, "overlap-text")).toEqual([]);
  }, 120_000);

  it("reports text the narrow layout drops, and only on the wide capture", async () => {
    const result = await audit(url("hidden.html"), {
      rendering: { conditions: ["viewport:1280", "viewport:360"] },
    });

    const findings = renderIssues(result, "content-hidden-at-viewport");
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding.impact).toBe("moderate");
    expect(finding.selector).toContain("p");
    expect(finding.failureSummary).toContain("Opening hours");
    expect(finding.rendering?.condition).toBe("viewport:1280");
    expect(finding.annotation?.state).toBe("resolved");
    expect(result.renderingCaptures?.[finding.rendering?.captureIndex ?? -1]?.condition).toBe(
      "viewport:1280"
    );
  }, 120_000);

  // Amendment 2026-10-15, the three tuning rules at once.
  it("reports a hidden region once and leaves the hamburger menu and a kept control's label alone", async () => {
    const result = await audit(url("hidden-region.html"), {
      rendering: { conditions: ["viewport:1280", "viewport:360"] },
    });

    const findings = renderIssues(result, "content-hidden-at-viewport");
    expect(findings.map((issue) => issue.selector)).toEqual(["#promos"]);
    const [finding] = findings;
    // One finding for the whole section, with the five paragraphs counted.
    expect(finding.rendering?.evidence.textElements).toBe(5);
    expect(finding.failureSummary).toContain("5 text elements");
    expect(finding.failureSummary).toContain("Opening hours");
    expect(finding.annotation?.state).toBe("resolved");
    // The box covers the whole section, not one paragraph.
    expect(finding.annotation?.rect?.height).toBeGreaterThan(80);
    // Rule 2: the hamburger sits outside the nav and has no aria-controls.
    expect(result.issues.map((issue) => issue.failureSummary).join(" ")).not.toContain(
      "References from our clients"
    );
    // Rule 3: the link keeps its box, so its hidden label is not lost.
    expect(result.issues.map((issue) => issue.failureSummary).join(" ")).not.toContain(
      "Search the whole site"
    );
  }, 120_000);

  it("gives a hidden region and a member with a finding of its own two markers", async () => {
    const result = await audit(url("hidden-clipped.html"), {
      rendering: { conditions: ["viewport:1280", "viewport:360"] },
    });

    const findings = renderIssues(result).filter(
      (issue) => issue.rendering?.condition === "viewport:1280"
    );
    const region = findings.find(
      (issue) => issue.rendering?.checkId === "content-hidden-at-viewport"
    );
    const clipped = findings.find((issue) => issue.rendering?.checkId === "overflow-clipped-text");

    expect(region?.selector).toBe("#promos");
    expect(region?.rendering?.evidence.textElements).toBe(2);
    expect(clipped?.selector).toBe("#clipped-promo");
    expect(region?.annotation?.state).toBe("resolved");
    expect(clipped?.annotation?.state).toBe("resolved");

    // Two elements, two marks: the region's number must not land on the
    // paragraph that has a finding of its own.
    expect(region?.annotation?.mark).not.toBe(clipped?.annotation?.mark);

    // And the region's box is the section's, which contains the paragraph's
    // and is taller than it by the section's padding.
    const regionRect = region?.annotation?.rect;
    const clippedRect = clipped?.annotation?.rect;
    if (!regionRect || !clippedRect) throw new Error("both findings need a rect");
    expect(regionRect.y).toBeLessThan(clippedRect.y);
    expect(regionRect.y + regionRect.height).toBeGreaterThan(clippedRect.y + clippedRect.height);
    expect(regionRect.height).toBeGreaterThan(clippedRect.height * 2);
  }, 120_000);

  it("reports a menu no control can reveal, once, naming the list", async () => {
    const result = await audit(url("hidden-nav.html"), {
      rendering: { conditions: ["viewport:1280", "viewport:360"] },
    });

    const findings = renderIssues(result, "content-hidden-at-viewport");
    expect(findings.map((issue) => issue.selector)).toEqual(["#menu"]);
    expect(findings[0].rendering?.evidence.textElements).toBe(2);
    expect(findings[0].annotation?.state).toBe("resolved");
  }, 120_000);

  it("exempts only what a control can reveal, not everything beside one", async () => {
    const result = await audit(url("disclosure.html"), {
      rendering: { conditions: ["viewport:1280", "viewport:360"] },
    });

    const findings = renderIssues(result, "content-hidden-at-viewport");
    // The paragraph next to the search button, and nothing from the nav the
    // hamburger controls.
    expect(findings.map((issue) => issue.selector)).toEqual(["#hours"]);
    expect(findings[0].failureSummary).toContain("Opening hours");
    expect(findings[0].annotation?.state).toBe("resolved");
    expect(result.issues.map((issue) => issue.failureSummary).join(" ")).not.toContain(
      "Contact the office"
    );
  }, 120_000);

  it("keeps a caller page's device settings and navigates no second time", async () => {
    const page = await browser.newPage();
    const original = {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    };
    await page.setViewport(original);

    /**
     * Puppeteer replaces the whole viewport on every change and reloads the
     * page when mobile or touch emulation changes, so a pass that passed the
     * dimensions alone reset the caller's device emulation and navigated a
     * second time.
     */
    let navigations = 0;
    const readState = () =>
      page.evaluate(() => ({
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        maxTouchPoints: navigator.maxTouchPoints,
        coarsePointer: window.matchMedia("(pointer: coarse)").matches,
      }));

    try {
      await page.goto(url("mode.html"), { waitUntil: "networkidle2" });
      // The baseline for the comparison is the page after an audit without
      // the rendering pass, so what is compared is the pass alone: Puppeteer
      // leaves touch emulation off after any full-page screenshot, which the
      // engine pass takes as well.
      await audit(page, {});
      const before = await readState();
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) navigations++;
      });

      const result = await audit(page, {
        rendering: { conditions: ["viewport:320", "viewport:768", "text-spacing"] },
      });

      expect(result.renderingMeta?.conditionsRun).toEqual([
        "viewport:320",
        "viewport:768",
        "text-spacing",
      ]);
      expect(result.renderingMeta?.restorationFailed).toBeUndefined();
      expect(navigations).toBe(0);
      expect(page.viewport()).toEqual(original);
      expect(await readState()).toEqual(before);
    } finally {
      await page.close();
    }
  }, 120_000);

  // Criterion 9
  it("returns one capture per condition, each matching its own condition", async () => {
    const conditions = ["viewport:320", "viewport:768", "media:dark", "text-spacing"];
    const result = await audit(url("mode.html"), { rendering: { conditions } });

    expect(result.renderingMeta?.conditionsRun).toEqual(conditions);
    expect(result.renderingCaptures).toHaveLength(conditions.length);

    const captures = result.renderingCaptures ?? [];
    expect(captures.map((capture) => capture.condition)).toEqual(conditions);
    expect(captures.map((capture) => capture.meta.viewport.width)).toEqual([320, 768, 1280, 1280]);

    for (const capture of captures) {
      // Readable JPEG geometry, in CSS px, matching its condition's viewport.
      expect(capture.screenshot.length).toBeGreaterThan(100);
      expect(capture.screenshot[0]).toBe(0xff);
      expect(capture.screenshot[1]).toBe(0xd8);
      expect(capture.meta.width).toBe(capture.meta.viewport.width);
      expect(capture.meta.fullPage).toBe(true);
      expect(capture.meta.scroll).toEqual({ x: 0, y: 0 });
    }

    // A capture index points at its own capture.
    for (const issue of renderIssues(result)) {
      const index = issue.rendering?.captureIndex ?? -1;
      expect(captures[index]?.condition).toBe(issue.rendering?.condition);
    }
  }, 120_000);

  // Criterion 8
  it("leaves the page at its original viewport, emulation and styles", async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });

    /**
     * The state the pass must restore. Read before and after instead of
     * asserted as literals: the browser's own defaults (a headless Chrome can
     * prefer dark) are what "original" means here.
     */
    const readState = () =>
      page.evaluate(() => ({
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        dark: window.matchMedia("(prefers-color-scheme: dark)").matches,
        forcedColors: window.matchMedia("(forced-colors: active)").matches,
        moreContrast: window.matchMedia("(prefers-contrast: more)").matches,
        reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        background: getComputedStyle(document.body).backgroundColor,
        letterSpacing: getComputedStyle(document.getElementById("copy") as Element).letterSpacing,
        lineHeight: getComputedStyle(document.getElementById("copy") as Element).lineHeight,
        adoptedSheets: document.adoptedStyleSheets.length,
        textSpacingFlag: (window as unknown as Record<string, unknown>).__barrieretestTextSpacing,
        scrollY: window.scrollY,
      }));

    try {
      await page.goto(url("mode.html"), { waitUntil: "networkidle2" });
      const before = await readState();

      // Every kind of condition, including the composite.
      const result = await audit(page, {
        rendering: {
          conditions: [
            "viewport:320",
            "media:dark",
            "media:forced-colors",
            "media:more-contrast",
            "media:reduced-motion",
            "cvd:protanopia",
            "text-spacing",
            "viewport:320+text-spacing",
          ],
        },
      });

      expect(result.renderingMeta?.conditionsRun).toEqual([
        "viewport:320",
        "media:dark",
        "media:forced-colors",
        "media:more-contrast",
        "media:reduced-motion",
        "cvd:protanopia",
        "text-spacing",
        "viewport:320+text-spacing",
      ]);
      expect(result.renderingMeta?.conditionsSkipped).toEqual([]);

      const after = await readState();
      expect(after).toEqual(before);
      expect(after.innerWidth).toBe(1280);
      expect(after.innerHeight).toBe(720);
      expect(after.letterSpacing).toBe("normal");
      expect(after.textSpacingFlag).toBeUndefined();
      expect(after.scrollY).toBe(0);
    } finally {
      await page.close();
    }
  }, 120_000);

  it("applies the whole text-spacing override while the condition runs, and takes it back", async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });

    interface SpacingSample {
      fontSize: string;
      lineHeight: string;
      letterSpacing: string;
      wordSpacing: string;
      marginBottom: string;
    }

    /** What the page itself saw, in the order it saw it. */
    const samples = () =>
      page.evaluate(
        () => (window as unknown as { __spacingSamples: SpacingSample[] }).__spacingSamples
      );

    try {
      await page.goto(url("spacing.html"), { waitUntil: "networkidle2" });
      const before = await samples();
      expect(before).toHaveLength(1);

      const result = await audit(page, {
        rendering: { conditions: ["viewport:1280", "text-spacing"] },
      });

      expect(result.renderingMeta?.conditionsRun).toEqual(["viewport:1280", "text-spacing"]);

      // Every value WCAG 1.4.12 asks for, computed on the page while the
      // condition was applied: 1.5 times the 20 px font size, 0.12em,
      // 0.16em, and 2em of paragraph spacing.
      const seen = await samples();
      const underOverride = seen.filter((sample) => sample.letterSpacing !== "normal");
      expect(underOverride.length).toBeGreaterThan(0);
      for (const sample of underOverride) {
        expect(sample.fontSize).toBe("20px");
        expect(sample.lineHeight).toBe("30px");
        expect(sample.letterSpacing).toBe("2.4px");
        expect(sample.wordSpacing).toBe("3.2px");
        expect(sample.marginBottom).toBe("40px");
      }

      // And the page is back at its own spacing afterwards.
      expect(seen[seen.length - 1]).toEqual(before[0]);
      expect(
        await page.evaluate(() => {
          const style = getComputedStyle(document.getElementById("copy") as Element);
          return {
            lineHeight: style.lineHeight,
            letterSpacing: style.letterSpacing,
            wordSpacing: style.wordSpacing,
            marginBottom: style.marginBottom,
          };
        })
      ).toEqual({
        lineHeight: before[0].lineHeight,
        letterSpacing: before[0].letterSpacing,
        wordSpacing: before[0].wordSpacing,
        marginBottom: before[0].marginBottom,
      });

      // The override is what the finding is about: the box fits its text at
      // the page's own spacing and loses a line to the override.
      const clipped = renderIssues(result, "overflow-clipped-text").filter(
        (issue) => issue.selector === "#spacing-fits"
      );
      expect(clipped.map((issue) => issue.rendering?.condition)).toEqual(["text-spacing"]);
      expect(Number(clipped[0].rendering?.evidence.scrollHeight)).toBeGreaterThan(
        Number(clipped[0].rendering?.evidence.clientHeight)
      );
    } finally {
      await page.close();
    }
  }, 120_000);

  /**
   * The colour simulation the CVD checks reason with, against the browser
   * that renders the capture. The checks read computed colours and apply the
   * Machado matrices themselves (contract amendment of 2026-10-14), so the
   * two have to agree — if they did not, a check would judge colours nobody
   * is shown.
   *
   * Measured 2026-10-15 and 2026-10-16: every channel of every patch within
   * 2 of 255 under all four simulated deficiencies, with the JPEG capture
   * its own small source of error (the pure implementation matches a PNG
   * capture exactly, or by one on four of 28 channels).
   */
  it("simulates the colours Chromium's own emulation renders", async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    const probe = await browser.newPage();

    /** The colour of one pixel of a JPEG, decoded in the browser itself. */
    const colourAt = (image: Uint8Array, x: number, y: number) =>
      probe.evaluate(
        async (input: { data: string; x: number; y: number }) => {
          const binary = atob(input.data);
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index++) {
            bytes[index] = binary.charCodeAt(index);
          }
          const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const context = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
          context.drawImage(bitmap, 0, 0);
          const [r, g, b] = context.getImageData(input.x, input.y, 1, 1).data;
          return { r, g, b };
        },
        { data: Buffer.from(image).toString("base64"), x, y }
      );

    try {
      await page.goto(url("patches.html"), { waitUntil: "networkidle2" });

      const result = await audit(page, {
        rendering: {
          conditions: ["cvd:protanopia", "cvd:deuteranopia", "cvd:tritanopia", "cvd:achromatopsia"],
        },
      });

      expect(result.renderingMeta?.conditionsRun).toEqual([
        "cvd:protanopia",
        "cvd:deuteranopia",
        "cvd:tritanopia",
        "cvd:achromatopsia",
      ]);

      let worst = 0;
      for (const deficiency of SIMULATED_DEFICIENCIES) {
        const capture = result.renderingCaptures?.find(
          (entry) => entry.condition === `cvd:${deficiency}`
        );
        if (!capture) throw new Error(`the ${deficiency} condition needs its capture`);

        for (const [index, [name, [r, g, b]]] of SIMULATION_PATCHES.entries()) {
          const rendered = await colourAt(capture.screenshot, 120, index * 120 + 60);
          const expected = simulateDeficiency({ r, g, b }, deficiency);
          const delta = Math.max(
            Math.abs(rendered.r - expected.r),
            Math.abs(rendered.g - expected.g),
            Math.abs(rendered.b - expected.b)
          );
          worst = Math.max(worst, delta);
          if (delta > 4) {
            throw new Error(
              `${deficiency} ${name}: the browser rendered rgb(${rendered.r}, ${rendered.g}, ${rendered.b}), the simulation says rgb(${expected.r}, ${expected.g}, ${expected.b})`
            );
          }
        }
      }

      // Not only "no patch is far off": the agreement is pixel-level.
      expect(worst).toBeLessThanOrEqual(4);
    } finally {
      await probe.close();
      await page.close();
    }
  }, 120_000);

  it("reports a colour-only link whose distinction the deficiency takes", async () => {
    const result = await audit(url("cvd.html"), {
      rendering: {
        conditions: ["cvd:protanopia", "cvd:deuteranopia", "cvd:achromatopsia"],
        checks: ["cvd-link-distinction"],
      },
    });

    const findings = renderIssues(result, "cvd-link-distinction");
    expect(
      findings.map((issue) => `${issue.rendering?.condition} ${issue.selector}`).sort()
    ).toEqual([
      "cvd:deuteranopia #colour-only",
      "cvd:deuteranopia #hidden-inside",
      "cvd:deuteranopia #hidden-neighbour",
      "cvd:deuteranopia #modern",
      "cvd:deuteranopia #span-neighbour",
      "cvd:deuteranopia #sr-only-neighbour",
      "cvd:deuteranopia #transparent-neighbour",
      "cvd:protanopia #brick",
      "cvd:protanopia #colour-only",
      "cvd:protanopia #hidden-inside",
      "cvd:protanopia #hidden-neighbour",
      "cvd:protanopia #modern",
      "cvd:protanopia #span-neighbour",
      "cvd:protanopia #sr-only-neighbour",
      "cvd:protanopia #transparent-neighbour",
    ]);

    const [first] = findings;
    expect(first.id).toBe("render:cvd-link-distinction");
    expect(first.impact).toBe("moderate");
    expect(first.helpUrl).toContain("use-of-color");
    expect(Number(first.rendering?.evidence.contrast)).toBeGreaterThanOrEqual(3);
    expect(Number(first.rendering?.evidence.simulatedContrast)).toBeLessThan(3);
    // Drawn on its own condition's capture.
    expect(first.annotation?.state).toBe("resolved");
    expect(first.annotation?.mark).toBe(1);

    // The underlined link is distinguished without colour, under every
    // deficiency; the link that already fails the ratio is axe's finding on
    // the page as it is normally rendered, and the engine pass reports it.
    expect(findings.some((issue) => issue.selector === "#underlined")).toBe(false);
    expect(findings.some((issue) => issue.selector === "#baseline-fail")).toBe(false);
    expect(
      result.issues.some(
        (issue) => issue.id === "link-in-text-block" && issue.selector?.includes("baseline-fail")
      )
    ).toBe(true);

    // The page authors its colours in `color(srgb …)`, which Chromium
    // serialises in that space: the measurement normalises it in the page,
    // and the finding is the same one its hex counterpart gets. Without the
    // normalisation the check parses nothing and reports nothing.
    const modern = findings.find((issue) => issue.selector === "#modern");
    expect(modern?.rendering?.evidence.linkColor).toBe("rgb(0, 136, 0)");
    expect(modern?.rendering?.evidence.textColor).toBe("rgb(0, 0, 136)");
    const hex = findings.find((issue) => issue.selector === "#colour-only");
    expect(modern?.rendering?.evidence.contrast).toBe(hex?.rendering?.evidence.contrast);
    expect(modern?.rendering?.evidence.simulatedContrast).toBe(
      hex?.rendering?.evidence.simulatedContrast
    );
  }, 120_000);

  /**
   * The comparison is the text that actually runs alongside the link, not
   * the block's own computed colour: a block whose text sits in spans of
   * its own paints none of it, and reading the block would judge a colour
   * pair nobody is shown.
   */
  it("judges a link against the text beside it, not against its block's own colour", async () => {
    const result = await audit(url("cvd.html"), {
      rendering: {
        conditions: ["cvd:protanopia", "cvd:deuteranopia", "cvd:achromatopsia"],
        checks: ["cvd-link-distinction"],
      },
    });

    const findings = renderIssues(result, "cvd-link-distinction");
    const selectors = findings.map((issue) => issue.selector);

    // Navy spans around a green link in a near-black block: the surrounding
    // text is navy, the collapse is real, and the block's own colour would
    // have hidden it.
    const span = findings.find((issue) => issue.selector === "#span-neighbour");
    expect(span?.rendering?.evidence.textColor).toBe("rgb(0, 0, 136)");
    expect(Number(span?.rendering?.evidence.contrast)).toBeGreaterThanOrEqual(3);
    expect(Number(span?.rendering?.evidence.simulatedContrast)).toBeLessThan(3);

    // Near-black spans around a green link in a navy block: 4.5:1 against
    // the text beside it and no collapse. The block's navy would have made
    // this a finding that is not there.
    expect(selectors).not.toContain("#nested-neighbour");
    // The link's own text is in two colours, so there is no one colour to
    // judge; and one with navy before it and near-black after it has no
    // surrounding colour the two sides agree on.
    expect(selectors).not.toContain("#mixed");
    expect(selectors).not.toContain("#between");
  }, 120_000);

  /**
   * Text a reader is not shown carries no colour anything is compared with.
   * A `display: none`, transparent or screen-reader-only span between the
   * copy and the link would otherwise be the surrounding text, and one
   * inside the link would make its own text look like two styles — either
   * way the verdict is about a colour pair nobody is shown.
   */
  it("skips hidden, transparent and screen-reader-only text beside and inside a link", async () => {
    const result = await audit(url("cvd.html"), {
      rendering: {
        conditions: ["cvd:protanopia", "cvd:deuteranopia", "cvd:achromatopsia"],
        checks: ["cvd-link-distinction"],
      },
    });

    const findings = renderIssues(result, "cvd-link-distinction");
    const reference = findings.find(
      (issue) =>
        issue.selector === "#colour-only" && issue.rendering?.condition === "cvd:protanopia"
    );

    for (const selector of [
      "#hidden-neighbour",
      "#transparent-neighbour",
      "#sr-only-neighbour",
      "#hidden-inside",
    ]) {
      const finding = findings.find(
        (issue) => issue.selector === selector && issue.rendering?.condition === "cvd:protanopia"
      );
      // The same verdict the link without the hidden text gets: the navy
      // copy beside it is the surrounding colour, not the near-black words
      // nobody sees.
      expect(finding?.rendering?.evidence.textColor).toBe("rgb(0, 0, 136)");
      expect(finding?.rendering?.evidence.linkColor).toBe("rgb(0, 136, 0)");
      expect(finding?.rendering?.evidence.contrast).toBe(reference?.rendering?.evidence.contrast);
      expect(finding?.rendering?.evidence.simulatedContrast).toBe(
        reference?.rendering?.evidence.simulatedContrast
      );
    }

    // The hidden words inside the link are not in the text the finding
    // quotes either.
    const inside = findings.find((issue) => issue.selector === "#hidden-inside");
    expect(inside?.failureSummary).toContain('"a green link"');
  }, 120_000);

  it("reports a state only colour conveys, and not one with a marker", async () => {
    const result = await audit(url("cvd.html"), {
      rendering: {
        conditions: ["cvd:protanopia", "cvd:deuteranopia", "cvd:achromatopsia"],
        checks: ["cvd-state-by-color"],
      },
    });

    const findings = renderIssues(result, "cvd-state-by-color");
    expect(
      findings.map((issue) => `${issue.rendering?.condition} ${issue.selector}`).sort()
    ).toEqual([
      "cvd:achromatopsia #collapse-one",
      "cvd:achromatopsia #dot-one",
      "cvd:achromatopsia #tab-one",
      "cvd:deuteranopia #tab-one",
    ]);

    const tab = findings.find((issue) => issue.selector === "#tab-one");
    expect(tab?.id).toBe("render:cvd-state-by-color");
    expect(tab?.impact).toBe("moderate");
    expect(tab?.rendering?.evidence.state).toBe("aria-selected");
    expect(tab?.rendering?.evidence.property).toBe("background colour");
    expect(tab?.rendering?.evidence.comparedWith).toBe("#tab-two");
    expect(Number(tab?.rendering?.evidence.simulatedDistance)).toBeLessThan(10);
    expect(tab?.annotation?.state).toBe("resolved");

    // The tab pair with a pseudo-element tick has a cue that is not colour.
    expect(findings.some((issue) => issue.selector === "#tab-marked")).toBe(false);

    // The carousel dot has no sibling of its own: its comparison is the
    // button in the next `<li>`, found a wrapper level up — the shape
    // `<li><a aria-current="page">` has too.
    const dot = findings.find((issue) => issue.selector === "#dot-one");
    expect(dot?.rendering?.evidence.state).toBe("aria-current");
    expect(dot?.rendering?.evidence.comparedWith).toBe("#dot-two");
    expect(dot?.rendering?.evidence.property).toBe("background colour");

    // The invalid `select` is the only one of its kind on the page, so
    // nothing says what a valid one looks like and nothing is reported.
    expect(findings.some((issue) => issue.selector === "#lonely")).toBe(false);
  }, 120_000);

  /**
   * A colour is a cue only where it paints something. Two empty dots whose
   * `color` differs look identical, and an unused `color` that survives the
   * deficiency says nothing about the background cue that is gone.
   */
  it("compares a state's foreground only where it paints visible text or a graphic", async () => {
    const result = await audit(url("cvd.html"), {
      rendering: {
        conditions: ["cvd:protanopia", "cvd:deuteranopia", "cvd:achromatopsia"],
        checks: ["cvd-state-by-color"],
      },
    });

    const findings = renderIssues(result, "cvd-state-by-color");

    // Identical paint, and a `color` an empty button shows nowhere: nothing
    // sets the state apart, so there is no colour that collapsed.
    expect(findings.some((issue) => issue.selector === "#empty-one")).toBe(false);

    // The background carries the state and is gone under achromatopsia; the
    // unused `color` difference survives it and must not stand in for the
    // cue that is gone.
    const collapse = findings.filter((issue) => issue.selector === "#collapse-one");
    expect(collapse.map((issue) => issue.rendering?.condition)).toEqual(["cvd:achromatopsia"]);
    expect(collapse[0]?.rendering?.evidence.property).toBe("background colour");
    expect(collapse[0]?.rendering?.evidence.stateColor).toBe("rgb(0, 136, 0)");
    expect(collapse[0]?.rendering?.evidence.siblingColor).toBe("rgb(116, 116, 116)");
    expect(collapse[0]?.rendering?.evidence.comparedWith).toBe("#collapse-two");
  }, 120_000);

  it("ignores an svg root's unused fill and a framed block's own border and shadow", async () => {
    const result = await audit(url("cvd.html"), {
      rendering: {
        conditions: ["cvd:protanopia", "cvd:deuteranopia", "cvd:achromatopsia"],
        checks: ["cvd-state-by-color", "cvd-link-distinction"],
      },
    });

    expect(result.renderingMeta?.conditionsSkipped).toEqual([]);
    expect(result.renderingMeta?.checksRun).toEqual(
      expect.arrayContaining(["cvd-state-by-color", "cvd-link-distinction"])
    );
    // The root's currentColor fill reaches no shape that paints with it.
    expect(
      renderIssues(result, "cvd-state-by-color").some((issue) => issue.selector === "#icon-dot-one")
    ).toBe(false);
    // The frame is on both sides; the link's own border or shadow sets it apart.
    const links = renderIssues(result, "cvd-link-distinction").map((issue) => issue.selector);
    expect(links).not.toContain("#border-cue");
    expect(links).not.toContain("#shadow-cue");
  }, 120_000);

  it("applies and removes the vision-deficiency emulation, seen in the pixels", async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    const probe = await browser.newPage();

    /** The colour of one pixel of a JPEG, decoded in the browser itself. */
    const colourAt = (image: Uint8Array, x: number, y: number) =>
      probe.evaluate(
        async (input: { data: string; x: number; y: number }) => {
          const binary = atob(input.data);
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index++) {
            bytes[index] = binary.charCodeAt(index);
          }
          const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const context = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
          context.drawImage(bitmap, 0, 0);
          const [r, g, b] = context.getImageData(input.x, input.y, 1, 1).data;
          return { r, g, b };
        },
        { data: Buffer.from(image).toString("base64"), x, y }
      );

    try {
      await page.goto(url("patch.html"), { waitUntil: "networkidle2" });

      const result = await audit(page, { rendering: { conditions: ["cvd:protanopia"] } });

      expect(result.renderingMeta?.conditionsRun).toEqual(["cvd:protanopia"]);
      const capture = result.renderingCaptures?.[0];
      if (!capture) throw new Error("the condition needs its capture");

      // Pure red is not red under protanopia: Chromium's Machado model
      // drops the red channel and raises the green one.
      const simulated = await colourAt(capture.screenshot, 100, 100);
      expect(simulated.r).toBeLessThan(180);
      expect(simulated.g).toBeGreaterThan(50);

      // And the page the pass hands back shows the patch as it was.
      const after = await page.screenshot({ type: "jpeg", quality: 85, fullPage: true });
      const restored = await colourAt(after, 100, 100);
      expect(restored.r).toBeGreaterThan(200);
      expect(restored.g).toBeLessThan(60);
    } finally {
      await probe.close();
      await page.close();
    }
  }, 120_000);

  it("emulates the media conditions it reverts", async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });

    try {
      await page.goto(url("mode.html"), { waitUntil: "networkidle2" });

      // The adapter is what the pass uses; this proves the emulations it
      // claims really reach the page, which the revert test cannot show.
      const { createRenderingCapabilities } = await import("./rendering/capabilities.js");
      const capabilities = await createRenderingCapabilities(page as unknown as BrowserPage);

      const matches = () =>
        page.evaluate(() => ({
          forcedColors: window.matchMedia("(forced-colors: active)").matches,
          moreContrast: window.matchMedia("(prefers-contrast: more)").matches,
          reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        }));

      await capabilities.emulateMedia({ forcedColors: "active" });
      expect((await matches()).forcedColors).toBe(true);

      await capabilities.emulateMedia({ prefersContrast: "more" });
      const contrast = await matches();
      expect(contrast.moreContrast).toBe(true);
      expect(contrast.forcedColors).toBe(false);

      await capabilities.emulateMedia({ reducedMotion: "reduce" });
      expect((await matches()).reducedMotion).toBe(true);

      await capabilities.emulateMedia({});
      expect(await matches()).toEqual({
        forcedColors: false,
        moreContrast: false,
        reducedMotion: false,
      });

      await capabilities.dispose();
    } finally {
      await page.close();
    }
  }, 120_000);

  // Criterion 4, as amended on 2026-10-15: the rule runs in the normal
  // engine pass too (decision 2), so the rendering check reports what only
  // the phone layout breaks, and never repeats what the engine pass said.
  it("reports targets that only fail on the phone, and leaves the rest to the normal pass", async () => {
    const result = await audit(url("target.html"), {
      rendering: { conditions: ["viewport:360"] },
    });

    const findings = renderIssues(result, "target-size");
    expect(findings.map((issue) => issue.selector).sort()).toEqual(["#print", "#save", "#share"]);
    const [finding] = findings;
    expect(finding.id).toBe("render:target-size");
    expect(finding.impact).toBe("serious");
    expect(finding.rendering?.condition).toBe("viewport:360");
    expect(finding.rendering?.evidence.rule).toBe("target-size");
    expect(finding.rendering?.evidence.viewportWidth).toBe(360);
    expect(finding.rendering?.evidence.outcome).toBe("violation");
    expect(finding.failureSummary).toContain("360 px wide viewport");
    // Drawn on its own capture, at the button's own box.
    expect(finding.annotation?.state).toBe("resolved");
    expect(finding.annotation?.rect?.width).toBe(16);
    expect(result.renderingCaptures?.[finding.rendering?.captureIndex ?? -1]?.condition).toBe(
      "viewport:360"
    );
    // Three buttons, three marks — and `undefined` is not one of them.
    for (const issue of findings) expect(issue.annotation?.mark).toBeDefined();
    expect(new Set(findings.map((issue) => issue.annotation?.mark)).size).toBe(3);

    // At the desktop width the row is spaced out: the normal pass is clean.
    const plain = await audit(url("target.html"));
    expect(renderIssues(plain)).toEqual([]);
    expect(plain.issues.filter((issue) => issue.id === "target-size")).toHaveLength(0);

    // A row cramped at every width is the engine pass's finding, once:
    // neither the phone nor the baseline viewport repeats it.
    const always = await audit(url("target-always.html"), {
      rendering: { conditions: ["viewport:1280", "viewport:360"] },
    });
    expect(always.issues.filter((issue) => issue.id === "target-size")).toHaveLength(3);
    expect(renderIssues(always, "target-size")).toEqual([]);
    // Nothing from the rendering check is only evidence when both
    // conditions ran and the check itself got to judge them.
    expect(always.renderingMeta?.conditionsRun).toEqual(["viewport:1280", "viewport:360"]);
    expect(always.renderingMeta?.conditionsSkipped).toEqual([]);
    expect(always.renderingMeta?.checksRun).toContain("target-size");
  }, 120_000);

  // Criterion 5
  it("reports a contrast failure that only dark mode has, and not one the page already has", async () => {
    const result = await audit(url("dark-contrast.html"), {
      rendering: { conditions: ["viewport:1280", "media:dark"] },
    });

    const findings = renderIssues(result, "contrast-under-mode");
    expect(findings.map((issue) => issue.selector)).toEqual(["#dark-only"]);
    const [finding] = findings;
    expect(finding.id).toBe("render:contrast-under-mode");
    expect(finding.impact).toBe("serious");
    expect(finding.rendering?.condition).toBe("media:dark");
    expect(finding.rendering?.evidence.rule).toBe("color-contrast");
    expect(finding.rendering?.evidence.mode).toBe("dark mode");
    expect(finding.failureSummary).toContain("Under dark mode");
    expect(finding.annotation?.state).toBe("resolved");

    // The link that fails in both is the engine pass's finding, once.
    const baselineFailures = result.issues.filter(
      (issue) => issue.id === "color-contrast" && issue.selector === "#always-bad"
    );
    expect(baselineFailures).toHaveLength(1);
    expect(
      result.issues.filter(
        (issue) =>
          issue.rendering?.checkId === "contrast-under-mode" && issue.selector === "#always-bad"
      )
    ).toEqual([]);
  }, 120_000);

  it("keeps a failure the mode introduced behind fifty the page already has", async () => {
    // The condition's axe run carries 50 nodes per rule. The engine pass
    // already reported the first 50 links, so the one the mode introduced is
    // node 51 and only survives when the baseline's nodes are dropped before
    // the cap applies.
    const result = await audit(url("contrast-cap.html"), {
      rendering: { conditions: ["media:dark"] },
    });

    expect(result.issues.filter((issue) => issue.id === "color-contrast")).toHaveLength(50);
    const findings = renderIssues(result, "contrast-under-mode");
    expect(findings.map((issue) => issue.selector)).toEqual(["#dark-only"]);
    expect(result.renderingMeta?.conditionsRun).toEqual(["media:dark"]);
    expect(result.renderingMeta?.conditionsSkipped).toEqual([]);
    expect(result.renderingMeta?.truncatedConditions).toBeUndefined();
  }, 120_000);

  it("reports a condition whose own failures did not fit the run", async () => {
    const result = await audit(url("contrast-many.html"), {
      rendering: { conditions: ["media:dark"] },
    });

    const findings = renderIssues(result, "contrast-under-mode");
    expect(findings.length).toBeGreaterThan(0);
    // Sixty eligible nodes, a run that carries 50 of them: partial, and the
    // meta says so instead of presenting the findings as the whole picture.
    expect(result.renderingMeta?.truncatedConditions).toEqual(["media:dark"]);
    expect(result.renderingMeta?.conditionsSkipped).toEqual([]);
  }, 120_000);

  it("drops the forced-colours contrast axe misread and keeps the opted-out one", async () => {
    const result = await audit(url("forced-contrast.html"), {
      rendering: { conditions: ["media:forced-colors"] },
    });

    const findings = renderIssues(result, "contrast-under-mode");
    // `#filled` is reached by the forced palette, so axe's ratio is about a
    // colour the browser does not paint; `#opted` keeps its own colours, so
    // axe measured what is on the screen.
    expect(findings.map((issue) => issue.selector)).toEqual(["#opted"]);
    expect(findings[0].rendering?.evidence.rule).toBe("color-contrast");
    expect(findings[0].annotation?.state).toBe("resolved");
    expect(result.renderingMeta?.conditionsRun).toEqual(["media:forced-colors"]);
    expect(result.renderingMeta?.conditionsSkipped).toEqual([]);
    expect(result.renderingMeta?.checksRun).toContain("contrast-under-mode");
  }, 120_000);

  it("gives one finding to an element with two animations and to a nested pair", async () => {
    const result = await audit(url("motion-identity.html"), {
      rendering: { conditions: ["media:reduced-motion"] },
    });

    const findings = renderIssues(result, "motion-not-reduced");
    // One element, one identity, one finding — and the nested pair is one
    // movement, reported on the outer element although the inner animation
    // comes first in `getAnimations()`.
    expect(findings.map((issue) => issue.selector).sort()).toEqual(["#multi", "#outer"]);
    const multi = findings.find((issue) => issue.selector === "#multi");
    expect(multi?.rendering?.evidence.animations).toBe(2);
    for (const issue of findings) expect(issue.annotation?.mark).toBeDefined();
    expect(new Set(findings.map((issue) => issue.annotation?.mark)).size).toBe(2);
    expect(result.renderingMeta?.conditionsRun).toEqual(["media:reduced-motion"]);
    expect(result.renderingMeta?.conditionsSkipped).toEqual([]);
  }, 120_000);

  it("waits for the colours of a mode to finish fading before it judges them", async () => {
    const result = await audit(url("transition.html"), {
      rendering: { conditions: ["viewport:1280", "media:dark"] },
    });

    // The background flips at once and the link colour fades over 600 ms, so
    // mid-fade the link is near-black on black; settled it is #eee on #111.
    expect(renderIssues(result, "contrast-under-mode")).toEqual([]);
    // An empty result is only evidence when the check actually ran: a
    // condition that timed out, or a collection that failed, finds nothing
    // either.
    expect(result.renderingMeta?.conditionsRun).toEqual(["viewport:1280", "media:dark"]);
    expect(result.renderingMeta?.conditionsSkipped).toEqual([]);
    expect(result.renderingMeta?.checksRun).toContain("contrast-under-mode");
  }, 120_000);

  it("does not settle a condition while a transition has not finished", async () => {
    // The real-browser test above proves the wait on a page that fades its
    // colours; this one proves it is the wait and not the timing: the
    // transition's `finished` promise is the test's, so a settle step that
    // stopped waiting for transitions would come back before it is released.
    const page = await browser.newPage();

    try {
      await page.goto(url("mode.html"), { waitUntil: "networkidle2" });
      await page.evaluate(() => {
        const held = window as unknown as { __release?: () => void };
        let release = (): void => {};
        const finished = new Promise<void>((resolve) => {
          release = () => resolve();
        });
        held.__release = release;
        document.getAnimations = () =>
          [
            { transitionProperty: "color", playState: "running", finished },
          ] as unknown as Animation[];
      });

      let settled = false;
      const settling = settleCondition(page as unknown as BrowserPage).then(() => {
        settled = true;
      });

      // Well past the two animation frames and well inside the one-second
      // cap, so only the transition can be what it is still waiting for.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);

      await page.evaluate(() => {
        (window as unknown as { __release: () => void }).__release();
      });
      await settling;
      expect(settled).toBe(true);
    } finally {
      await page.close();
    }
  }, 120_000);

  it("reports an element that forced colours leave nothing of, and nothing else", async () => {
    const result = await audit(url("forced-colors.html"), {
      rendering: { conditions: ["media:forced-colors"] },
    });

    const findings = renderIssues(result, "forced-colors-loss");
    // The button with a label, the one with an inline svg, the divider and
    // the bordered image submit — which is replaced content itself — all
    // keep something under a forced palette. The swatch panel does not: it
    // opts out of it, once, and the swatch that inherited the opt-out is not
    // a second finding about the same decision.
    expect(findings.map((issue) => issue.selector)).toEqual(["#icon-only", "#swatches"]);
    expect(findings[1].rendering?.evidence.reason).toBe("forced-color-adjust");
    const [finding] = findings;
    expect(finding.id).toBe("render:forced-colors-loss");
    expect(finding.impact).toBe("serious");
    expect(finding.rendering?.condition).toBe("media:forced-colors");
    expect(finding.rendering?.evidence.reason).toBe("paint-only");
    expect(finding.rendering?.evidence.backgroundImage).toBe(true);
    expect(finding.failureSummary).toContain("background image");
    expect(finding.annotation?.state).toBe("resolved");
    expect(finding.annotation?.rect?.width).toBe(24);
  }, 120_000);

  it("reports a root opt-out once, at the element that sets it", async () => {
    for (const [owner, fixture] of [
      ["html", "root-adjust-html.html"],
      ["body", "root-adjust-body.html"],
    ] as const) {
      const result = await audit(url(fixture), {
        rendering: { conditions: ["media:forced-colors"] },
      });

      const findings = renderIssues(result, "forced-colors-loss");
      // One decision about the whole page, reported where it was made; the
      // swatch under it only inherited the opt-out.
      expect(findings).toHaveLength(1);
      expect(findings[0].failureSummary).toContain(`The <${owner}> sets`);
      expect(findings[0].rendering?.evidence.reason).toBe("forced-color-adjust");
      expect(findings[0].rendering?.condition).toBe("media:forced-colors");
      expect(result.renderingMeta?.checksRun).toContain("forced-colors-loss");
      expect(result.renderingMeta?.conditionsSkipped).toEqual([]);
    }
  }, 120_000);

  it("reports the forced-colours collection that hit its cap", async () => {
    const result = await audit(url("painted-cap.html"), {
      rendering: { conditions: ["media:forced-colors"] },
    });

    // Decoration, so there is nothing to report — and the collection still
    // says it carried less than the page has.
    expect(renderIssues(result, "forced-colors-loss")).toEqual([]);
    expect(result.renderingMeta?.truncatedConditions).toEqual(["media:forced-colors"]);
    expect(result.renderingMeta?.conditionsSkipped).toEqual([]);
    expect(result.renderingMeta?.checksRun).toContain("forced-colors-loss");
  }, 120_000);

  it("reports the motion collection that hit its cap, with the movement still one finding", async () => {
    const result = await audit(url("motion-cap.html"), {
      rendering: { conditions: ["media:reduced-motion"] },
    });

    const findings = renderIssues(result, "motion-not-reduced");
    // The children fold into the carousel, so the check is nowhere near its
    // own cap: the collection is what stopped early, and it says so.
    expect(findings.map((issue) => issue.selector)).toEqual(["#carousel"]);
    expect(findings[0].rendering?.evidence.animations).toBe(MAX_ANIMATIONS);
    expect(result.renderingMeta?.truncatedConditions).toEqual(["media:reduced-motion"]);
    expect(result.renderingMeta?.conditionsSkipped).toEqual([]);
  }, 120_000);

  // Criterion 6
  it("reports an infinite animation under reduced motion, unless the page stops it", async () => {
    const running = await audit(url("motion.html"), {
      rendering: { conditions: ["media:reduced-motion"] },
    });

    const findings = renderIssues(running, "motion-not-reduced");
    expect(findings.map((issue) => issue.selector)).toEqual(["#spinner"]);
    const [finding] = findings;
    expect(finding.id).toBe("render:motion-not-reduced");
    expect(finding.impact).toBe("moderate");
    expect(finding.rendering?.condition).toBe("media:reduced-motion");
    expect(finding.rendering?.evidence.kind).toBe("infinite-animation");
    expect(finding.rendering?.evidence.animation).toBe("spin");
    expect(finding.failureSummary).toContain("repeats forever");
    expect(finding.annotation?.state).toBe("resolved");
    // The box of the rotating square, which is wider than the square: the
    // rect is the one the element occupies at the moment it was measured.
    expect(finding.annotation?.rect?.width).toBeGreaterThanOrEqual(40);

    const stopped = await audit(url("motion-reduced.html"), {
      rendering: { conditions: ["media:reduced-motion"] },
    });
    expect(renderIssues(stopped, "motion-not-reduced")).toEqual([]);
    // The page stopping the animation is why there is nothing, not a
    // condition that never ran or a check that never got its data.
    expect(stopped.renderingMeta?.conditionsRun).toEqual(["media:reduced-motion"]);
    expect(stopped.renderingMeta?.conditionsSkipped).toEqual([]);
    expect(stopped.renderingMeta?.checksRun).toContain("motion-not-reduced");
  }, 120_000);

  /**
   * The missing-capability half of criterion 10: a page that does not expose
   * the vision-deficiency method at all, so the conditions are skipped at
   * detection. The runtime half — a Playwright context whose CDP session is
   * refused, which is what a non-Chromium browser does — is covered against
   * a Playwright-shaped page in `src/rendering/runner.test.ts`; this is not
   * Firefox acceptance.
   */
  it("skips the CVD conditions on a page that lacks the capability and still completes", async () => {
    const real = await browser.newPage();
    await real.setViewport({ width: 1280, height: 720 });

    try {
      await real.goto(url("mode.html"), { waitUntil: "networkidle2" });

      // Everything a Puppeteer page exposes except `emulateVisionDeficiency`.
      const limited = {
        url: () => real.url(),
        title: () => real.title(),
        goto: (target: string) => real.goto(target),
        screenshot: (options: unknown) =>
          real.screenshot(options as Parameters<typeof real.screenshot>[0]),
        evaluate: ((fn: never, arg: never) => real.evaluate(fn, arg)) as BrowserPage["evaluate"],
        browser: () => real.browser(),
        viewport: () => real.viewport(),
        setViewport: (size: { width: number; height: number }) => real.setViewport(size),
        emulateMediaFeatures: (features: { name: string; value: string }[]) =>
          real.emulateMediaFeatures(features),
      } as unknown as BrowserPage;

      const result = await audit(limited, {
        rendering: { conditions: ["viewport:320", "cvd:protanopia", "cvd:deuteranopia"] },
      });

      expect(result.renderingMeta?.conditionsRun).toEqual(["viewport:320"]);
      expect(result.renderingMeta?.conditionsSkipped).toEqual([
        {
          condition: "cvd:protanopia",
          reason: "the browser page cannot emulate visionDeficiency",
        },
        {
          condition: "cvd:deuteranopia",
          reason: "the browser page cannot emulate visionDeficiency",
        },
      ]);
      expect(result.renderingCaptures).toHaveLength(1);
      expect(result.documentTitle).toBe("Mode fixture");
      expect(result.score).toBeGreaterThan(0);
    } finally {
      await real.close();
    }
  }, 120_000);
});

/**
 * The capture sections of the HTML report, end to end: a real audit with the
 * rendering pass, a real report, loaded in a real browser.
 *
 * The sections are the only place a rendering finding's marker can be drawn,
 * because its annotation is in its own condition's capture space — so this
 * measures those markers against those rects, the way the main view's
 * geometry test does, and runs axe over the whole document (with
 * `setBypassCSP(true)`, since the report's own policy blocks the injection).
 */
describe("renderHtmlReport capture sections (real audit, real browser)", () => {
  const FIXTURE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Capture sections fixture</title>
  <style>
    body { margin: 0; font: 16px/1.5 system-ui, sans-serif; color: #1a1a1a; padding: 24px }
    a { text-decoration: none }
    .navy { color: #000088 }
    #colour-only { color: #008800 }
    #wide { width: 400px; background: #cfe }
    /* Long enough that a 320 px capture of it cannot fit a printed page. */
    #tall { height: 3000px; background: #f4f6f8 }
  </style>
</head>
<body>
  <main>
    <h1>Capture sections fixture</h1>
    <p class="navy">Some copy with <a id="colour-only" href="https://example.com/1">a green link with no underline</a> inside a block of navy text that goes on for a while.</p>
    <div id="wide">A fixed 400 px wide block of text.</div>
    <div id="tall">A tall block, so the capture is taller than one printed page.</div>
  </main>
</body></html>`;

  let browser: Awaited<ReturnType<typeof puppeteer.launch>>;
  let fixtureDir: string;
  let auditResult: Awaited<ReturnType<typeof audit>>;
  let reportPage: Awaited<ReturnType<typeof browser.newPage>>;

  beforeAll(async () => {
    mock.module("./engines/axe.js", () => realAxe);

    fixtureDir = mkdtempSync(join(tmpdir(), "barrieretest-capture-sections-"));
    const fixturePath = join(fixtureDir, "fixture.html");
    writeFileSync(fixturePath, FIXTURE);

    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const fixturePage = await browser.newPage();
    await fixturePage.setViewport({ width: 1280, height: 720 });
    await fixturePage.goto(`file://${fixturePath}`);

    auditResult = await audit(fixturePage, {
      rendering: { conditions: ["viewport:320", "cvd:protanopia", "media:dark"] },
    });

    reportPage = await browser.newPage();
    await reportPage.setViewport({ width: 1440, height: 900 });
    await reportPage.setBypassCSP(true);
    await reportPage.setContent(renderHtmlReport(auditResult), { waitUntil: "load" });
  }, 180_000);

  afterAll(async () => {
    try {
      await browser?.close();
      if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
    } finally {
      // A browser that refuses to close must not leave the real module
      // mocked in for whatever runs next in this process.
      mock.module("./engines/axe.js", () => axeStubModule);
    }
  });

  it("gives every capture its own section, in capture order", async () => {
    expect(auditResult.renderingCaptures?.map((capture) => capture.condition)).toEqual([
      "viewport:320",
      "media:dark",
      "cvd:protanopia",
    ]);

    const sections = await reportPage.evaluate(() =>
      [...document.querySelectorAll("section.capture")].map((element) => ({
        title: element.querySelector("h2")?.textContent ?? "",
        note: element.querySelector(".capture__note")?.textContent ?? "",
        images: element.querySelectorAll(".shot__frame img").length,
      }))
    );

    expect(sections.map((section) => section.title)).toEqual([
      "At 320 px width",
      "Dark mode",
      "Protanopia (red-green colour blindness)",
    ]);
    expect(sections.every((section) => section.images === 1)).toBe(true);
    expect(sections[2].note).toContain("red cone cells");
  });

  /** Every section's image box and marker boxes, in document coordinates. */
  const measureSections = () =>
    reportPage.evaluate(() =>
      [...document.querySelectorAll("section.capture")].map((section) => {
        const image = section.querySelector(".shot__frame img") as HTMLImageElement;
        const box = image.getBoundingClientRect();
        return {
          title: section.querySelector("h2")?.textContent ?? "",
          // `cap<index>-<slug>-title`: the capture this section shows.
          captureIndex: Number(
            (section.getAttribute("aria-labelledby") ?? "").replace(/^cap/, "").split("-")[0]
          ),
          image: {
            left: box.left + window.scrollX,
            top: box.top + window.scrollY,
            width: box.width,
            height: box.height,
          },
          markers: [...section.querySelectorAll(".marker")].map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              id: element.id,
              left: rect.left + window.scrollX,
              top: rect.top + window.scrollY,
              width: rect.width,
              height: rect.height,
            };
          }),
        };
      })
    );

  /** The marks a condition's findings were annotated with, in mark order. */
  const expectedMarks = (condition: string): number[] =>
    [
      ...new Set(
        auditResult.issues
          .filter(
            (issue) =>
              issue.rendering?.condition === condition &&
              typeof issue.annotation?.mark === "number" &&
              issue.annotation?.rect !== undefined
          )
          .map((issue) => issue.annotation?.mark as number)
      ),
    ].sort((a, b) => a - b);

  it("draws a marker for every annotated mark of its condition, and no other", async () => {
    const measured = await measureSections();
    expect(measured).toHaveLength(auditResult.renderingCaptures?.length ?? 0);

    let drawn = 0;
    for (const section of measured) {
      const capture = auditResult.renderingCaptures?.[section.captureIndex];
      if (!capture) throw new Error(`no capture for ${section.title}`);
      const marks = section.markers
        .map((marker) => Number(marker.id.split("-").at(-1)))
        .sort((a, b) => a - b);

      // Equality, not "the ones that are there are right": a dropped marker
      // is a finding the report does not show on its capture.
      expect(marks).toEqual(expectedMarks(capture.condition));
      drawn += marks.length;
    }

    // And the sections together carry every annotated rendering finding.
    expect(drawn).toBe(
      (auditResult.renderingCaptures ?? []).reduce(
        (total, capture) => total + expectedMarks(capture.condition).length,
        0
      )
    );
    expect(drawn).toBeGreaterThan(0);
  });

  it("places every section marker on its finding's rect within a pixel", async () => {
    const measured = await measureSections();

    const renderingFindings = auditResult.issues.filter((issue) => issue.rendering);
    expect(renderingFindings.length).toBeGreaterThan(0);
    expect(measured.flatMap((section) => section.markers).length).toBeGreaterThan(0);

    for (const section of measured) {
      for (const marker of section.markers) {
        // `marker-cap<index>-<slug>-<mark>`: the capture the mark belongs to
        // and the mark itself.
        const parts = marker.id.split("-");
        const mark = Number(parts[parts.length - 1]);
        const captureIndex = Number(parts[1].replace("cap", ""));
        const capture = auditResult.renderingCaptures?.[captureIndex];
        if (!capture) throw new Error(`no capture for ${marker.id}`);

        const issue = renderingFindings.find(
          (candidate) =>
            candidate.rendering?.condition === capture.condition &&
            candidate.annotation?.mark === mark
        );
        const rect = issue?.annotation?.rect;
        if (!rect) throw new Error(`no rect for ${marker.id}`);

        const scale = section.image.width / capture.meta.width;
        expect(Math.abs(marker.left - section.image.left - rect.x * scale)).toBeLessThanOrEqual(1);
        expect(Math.abs(marker.top - section.image.top - rect.y * scale)).toBeLessThanOrEqual(1);
        expect(Math.abs(marker.width - rect.width * scale)).toBeLessThanOrEqual(1);
        expect(Math.abs(marker.height - rect.height * scale)).toBeLessThanOrEqual(1);
      }
    }
  });

  /**
   * Print bounds a capture to one page tall, and a 320 px capture of a long
   * page does not fit: it is clipped. The clipping is on the outer box, so
   * the box the markers are positioned in percentages of keeps the
   * capture's full geometry — capping that box instead would pull every
   * marker up into the visible crop, onto content it has nothing to do with.
   */
  it("keeps every marker on its element where print clips a tall capture", async () => {
    await reportPage.emulateMediaType("print");
    const measured = await measureSections();
    const clipped = await reportPage.evaluate(() =>
      [...document.querySelectorAll("section.capture")].map((section) => {
        const clip = section.querySelector(".shot__clip") as HTMLElement;
        const frame = section.querySelector(".shot__frame") as HTMLElement;
        return {
          clipHeight: clip.getBoundingClientRect().height,
          frameHeight: frame.getBoundingClientRect().height,
          overflow: getComputedStyle(clip).overflowY,
        };
      })
    );
    await reportPage.emulateMediaType(null);

    let checked = 0;
    for (const [index, section] of measured.entries()) {
      const capture = auditResult.renderingCaptures?.[section.captureIndex];
      if (!capture) throw new Error(`no capture for ${section.title}`);
      const scale = section.image.width / capture.meta.width;

      // The frame keeps the capture's whole height, clipped or not.
      expect(Math.abs(section.image.height - capture.meta.height * scale)).toBeLessThanOrEqual(1);
      expect(clipped[index].overflow).toBe("hidden");
      expect(clipped[index].clipHeight).toBeLessThanOrEqual(clipped[index].frameHeight + 1);

      for (const marker of section.markers) {
        const mark = Number(marker.id.split("-").at(-1));
        const rect = auditResult.issues.find(
          (issue) =>
            issue.rendering?.condition === capture.condition && issue.annotation?.mark === mark
        )?.annotation?.rect;
        if (!rect) throw new Error(`no rect for ${marker.id}`);
        expect(Math.abs(marker.left - section.image.left - rect.x * scale)).toBeLessThanOrEqual(1);
        expect(Math.abs(marker.top - section.image.top - rect.y * scale)).toBeLessThanOrEqual(1);
        checked += 1;
      }
    }

    // At least one capture is actually clipped: the 320 px one of a page
    // that is far taller than one printed page.
    expect(clipped.some((entry) => entry.clipHeight < entry.frameHeight - 1)).toBe(true);
    expect(checked).toBeGreaterThan(0);
  });

  it("shows each rendering finding in its condition's section and nowhere else", async () => {
    const placement = await reportPage.evaluate(() => {
      const main = document.querySelector("main > .columns") as HTMLElement;
      return {
        mainText: main.textContent ?? "",
        sections: [...document.querySelectorAll("section.capture")].map((section) => ({
          title: section.querySelector("h2")?.textContent ?? "",
          rules: [...section.querySelectorAll("dd code")].map(
            (element) => element.textContent ?? ""
          ),
          empty: section.querySelector(".empty")?.textContent ?? "",
        })),
        summary: document.querySelector(".summary")?.textContent ?? "",
        ruleTable: [...document.querySelectorAll(".rules__id")].map(
          (element) => element.textContent ?? ""
        ),
      };
    });

    // The main view has none of them, and does not keep a "not located" group
    // for them either.
    expect(placement.mainText).not.toContain("render:");
    expect(placement.mainText).not.toContain("Not located on the screenshot");

    const reflow = placement.sections.find((section) => section.title === "At 320 px width");
    const protanopia = placement.sections.find((section) => section.title.startsWith("Protanopia"));
    const dark = placement.sections.find((section) => section.title === "Dark mode");
    expect(reflow?.rules).toContain("render:reflow-horizontal-scroll");
    expect(protanopia?.rules).toContain("render:cvd-link-distinction");
    // Nothing broke in dark mode on this fixture, and the section says so.
    expect(dark?.rules).toEqual([]);
    expect(dark?.empty).toBe("No findings under this condition.");

    // The summary line and the findings-by-rule table still count them.
    expect(placement.summary).toContain("under rendering conditions");
    expect(placement.ruleTable).toContain("render:cvd-link-distinction");
  });

  it("keeps every element id unique across the sections", async () => {
    const duplicates = await reportPage.evaluate(() => {
      const counts = new Map<string, number>();
      for (const element of document.querySelectorAll("[id]")) {
        counts.set(element.id, (counts.get(element.id) ?? 0) + 1);
      }
      return [...counts].filter(([, count]) => count > 1).map(([id]) => id);
    });

    expect(duplicates).toEqual([]);
  });

  it("passes its own axe audit with zero violations, with the sections in it", async () => {
    const axeModule = (await import("axe-core")) as unknown as {
      source?: string;
      default?: { source: string };
    };
    const axeSource = axeModule.source ?? axeModule.default?.source;
    if (!axeSource) throw new Error("Unable to load axe-core source.");

    await reportPage.evaluate((source: string) => {
      const script = document.createElement("script");
      script.textContent = source;
      (document.head ?? document.documentElement).appendChild(script);
    }, axeSource);

    const violations = await reportPage.evaluate(async () => {
      const runtime = globalThis as unknown as {
        axe: { run: (context: Document) => Promise<{ violations: { id: string }[] }> };
      };
      const results = await runtime.axe.run(document);
      return results.violations.map((violation) => violation.id);
    });

    expect(violations).toEqual([]);
  });

  it("reflows at 320 CSS px without horizontal scrolling", async () => {
    await reportPage.setViewport({ width: 320, height: 800 });
    const overflow = await reportPage.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    await reportPage.setViewport({ width: 1440, height: 900 });

    expect(overflow).toBeLessThanOrEqual(1);
  });
});

// ----- navigation status (real local server, real browser) -----

/**
 * The navigation facts and `failOnHttpError` against a real HTTP server, so
 * the statuses, the `Retry-After` header and the redirect come from a real
 * Chromium navigation rather than from a stubbed response object.
 *
 * The AI provider is a stub (an error page must cost no AI request, and the
 * success path must not call a real one) and pa11y is stubbed, because what
 * is under test happens before either of them would run.
 */
describe("navigation status (real local server, real browser)", () => {
  const ERROR_PAGE = (title: string) =>
    `<!doctype html><html><head><title>${title}</title></head>` +
    `<body><h1>${title}</h1><img src="data:," /><p>Nothing to see here.</p></body></html>`;

  const OK_PAGE =
    `<!doctype html><html lang="en"><head><title>Fine</title></head>` +
    `<body><main><h1>Fine</h1><p>All good.</p></main></body></html>`;

  /** Every path the server was asked for, so the fail path can be shown to stop. */
  let requestedPaths: string[];
  let server: import("node:http").Server;
  let base: string;
  let browser: Awaited<ReturnType<typeof puppeteer.launch>>;

  /** Calls the stub AI provider received; the fail path must leave it empty. */
  let providerCalls: number;
  /** URLs pa11y itself was asked to audit; the fail path must leave it empty. */
  let pa11yCalls: string[];
  /** The real pa11y module, so the stub below does not outlive this suite. */
  let realPa11yModule: Record<string, unknown> | undefined;

  const stubProvider = {
    name: "stub",
    model: "stub-model",
    async analyze() {
      return { contextualAnalysis: "n/a", suggestedFix: "n/a", confidence: 1 };
    },
    async analyzeSemantic() {
      providerCalls += 1;
      return {
        content: JSON.stringify({ issues: [], detectedLanguage: "en" }),
        model: "stub-model",
      };
    },
  };

  const semanticOptions = {
    provider: { name: "nebius" as const, apiKey: "stub" },
    checks: ["aria-mismatch"],
  };

  /** Catch the navigation error of a promise that must reject with one. */
  async function expectNavigationHttpError(promise: Promise<unknown>) {
    let caught: unknown;
    try {
      await promise;
    } catch (error) {
      caught = error;
    }

    expect(isNavigationHttpError(caught)).toBe(true);
    return caught as NavigationHttpError;
  }

  /**
   * A real page that counts what it is asked to do, so "no axe run, no
   * screenshot, no rendering, no cookie banner, no lazy scroll" is one
   * assertion: every one of those steps goes through `evaluate` or
   * `screenshot`.
   */
  function countingPage(
    page: Awaited<ReturnType<typeof browser.newPage>>,
    { asPuppeteerPage = true }: { asPuppeteerPage?: boolean } = {}
  ) {
    const counts = { evaluate: 0, screenshot: 0 };
    const base = {
      url: () => page.url(),
      title: () => page.title(),
      // biome-ignore lint/suspicious/noExplicitAny: the proxy mirrors the overloaded page signatures
      goto: (url: string, options?: any) => page.goto(url, options),
      // biome-ignore lint/suspicious/noExplicitAny: the proxy mirrors the overloaded page signatures
      evaluate: (fn: any, arg?: any) => {
        counts.evaluate += 1;
        return arg === undefined ? page.evaluate(fn) : page.evaluate(fn, arg);
      },
      // biome-ignore lint/suspicious/noExplicitAny: the proxy mirrors the overloaded page signatures
      screenshot: (options?: any) => {
        counts.screenshot += 1;
        return page.screenshot(options);
      },
      // biome-ignore lint/suspicious/noExplicitAny: the proxy mirrors the overloaded page signatures
      on: (event: any, handler: any) => page.on(event, handler),
      // biome-ignore lint/suspicious/noExplicitAny: the proxy mirrors the overloaded page signatures
      off: (event: any, handler: any) => page.off(event, handler),
      setViewport: (viewport: { width: number; height: number }) => page.setViewport(viewport),
    };

    // Without `browser()` the object is a generic page (what a Playwright
    // caller hands in), so the engine takes its non-Puppeteer branch.
    const proxy = (asPuppeteerPage
      ? { ...base, browser: () => page.browser() }
      : base) as unknown as BrowserPage;

    return { proxy, counts };
  }

  beforeAll(async () => {
    mock.module("./engines/axe.js", () => realAxe);
    mock.module("./puppeteer-launch.js", () => realPuppeteerLaunch);
    mock.module("./ai/index.js", () => ({ ...realAi, createProvider: () => stubProvider }));
    // The standalone entry point has to run the real pass, not this file's
    // runner stub, for "no AI request on the fail path" to mean anything.
    mock.module("./semantic/runner.js", () => realSemanticRunner);
    // Captured before the stub takes its place, so `afterAll` can put the
    // real module back for anything that runs after this suite.
    // A copy, not the live namespace: mock.module rebinds the namespace's
    // exports, so handing the namespace back would reinstall the stub.
    realPa11yModule = { ...(await import("pa11y")) } as Record<string, unknown>;
    // Pa11y itself is not what is under test here, and importing the real one
    // is what the engine's own unit test avoids as well.
    mock.module("pa11y", () => ({
      default: async (url: string) => {
        pa11yCalls.push(url);
        return { issues: [], documentTitle: "Forbidden", pageUrl: url };
      },
    }));

    const { createServer } = await import("node:http");
    server = createServer((request, response) => {
      const path = (request.url ?? "/").split("?")[0];
      requestedPaths.push(path);

      if (path === "/forbidden") {
        response.writeHead(403, { "content-type": "text/html" });
        response.end(ERROR_PAGE("Forbidden"));
        return;
      }
      if (path === "/rate-limited") {
        response.writeHead(429, { "content-type": "text/html", "retry-after": "30" });
        response.end(ERROR_PAGE("Too many requests"));
        return;
      }
      if (path === "/unavailable") {
        response.writeHead(503, { "content-type": "text/html" });
        response.end(ERROR_PAGE("Service unavailable"));
        return;
      }
      if (path === "/old") {
        response.writeHead(301, { location: "/new" });
        response.end();
        return;
      }
      if (path === "/moved") {
        response.writeHead(302, { location: "/new" });
        response.end();
        return;
      }

      response.writeHead(200, { "content-type": "text/html" });
      response.end(OK_PAGE);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not report a port");
    }
    base = `http://127.0.0.1:${address.port}`;

    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }, 120_000);

  afterAll(async () => {
    try {
      await browser?.close();
      server?.closeAllConnections?.();
      await new Promise<void>((resolve) => {
        if (!server) return resolve();
        server.close(() => resolve());
      });
    } finally {
      mock.module("./engines/axe.js", () => axeStubModule);
      mock.module("./puppeteer-launch.js", () => puppeteerLaunchStubModule);
      mock.module("./ai/index.js", () => realAi);
      mock.module("./semantic/runner.js", () => semanticRunnerStubModule);
      if (realPa11yModule) {
        mock.module("pa11y", () => realPa11yModule);
      }
    }
  });

  beforeEach(() => {
    requestedPaths = [];
    providerCalls = 0;
    pa11yCalls = [];
  });

  it("reports a 403 on the result and audits the served page by default", async () => {
    const { result, run } = await watchOwnBrowsers(() => audit(`${base}/forbidden`));

    expect(result.navigation).toEqual({
      navigated: true,
      requestedUrl: `${base}/forbidden`,
      finalUrl: `${base}/forbidden`,
      status: 403,
      redirected: false,
    });
    // The served error page, audited as usual.
    expect(result.documentTitle).toBe("Forbidden");
    expect(result.issues.map((issue) => issue.id)).toContain("image-alt");
    expect(result.score).toBeLessThan(100);

    // Invariant 1: exactly one warning, with the status and the URL.
    const warnings = consoleWarnSpy.calls.map((call) => String(call[0]));
    expect(warnings.filter((message) => message.includes("403"))).toHaveLength(1);
    expect(warnings[0]).toContain(`${base}/forbidden`);

    // The default path does work on the page and still closes the browser it
    // launched — so the "nothing happened" assertions below mean something.
    expect(run.counts.some((counts) => counts.evaluate > 0 && counts.screenshot > 0)).toBe(true);
    expect(run.browsers.map((candidate) => candidate.connected)).toEqual([false]);
  }, 60_000);

  it("rejects with a NavigationHttpError and spends nothing else on a 403", async () => {
    const { result: error, run } = await watchOwnBrowsers(() =>
      expectNavigationHttpError(
        audit(`${base}/forbidden`, {
          failOnHttpError: true,
          rendering: true,
          semantic: semanticOptions,
        })
      )
    );

    expect(error.code).toBe("NAVIGATION_HTTP_ERROR");
    expect(error.status).toBe(403);
    expect(error.url).toBe(`${base}/forbidden`);
    expect(error.finalUrl).toBe(`${base}/forbidden`);
    expect(error.retryable).toBe(false);
    expect(error.retryAfterSeconds).toBeUndefined();
    expect(error.message).toContain("403");

    // No AI request, and nothing beyond the document itself was fetched
    // (Chromium asks for a favicon on its own account).
    expect(providerCalls).toBe(0);
    expect(requestedPaths.filter((path) => path !== "/favicon.ico")).toEqual(["/forbidden"]);
    // Nothing was warned either: the error carries the status.
    expect(consoleWarnSpy.calls.map((call) => String(call[0]))).toEqual([]);
    // No axe, no screenshot, no rendering, no banner, no scroll — and the
    // session audit() owned was closed on the way out (invariant 2).
    expectNoWorkAndClosed(run);
  }, 60_000);

  it("runs no axe, no screenshot and no page work at all on the fail path", async () => {
    const page = await browser.newPage();
    const { proxy, counts } = countingPage(page);

    try {
      await expectNavigationHttpError(
        realAxe.runAxeCore(`${base}/forbidden`, { page: proxy, failOnHttpError: true })
      );

      expect(counts).toEqual({ evaluate: 0, screenshot: 0 });

      // The same page, same engine, without the option: axe and the
      // screenshot do run, so the counters above mean something. The page is
      // sent back to about:blank first, because the engine only navigates a
      // page that is not already at the target URL.
      await page.goto("about:blank");
      const result = await realAxe.runAxeCore(`${base}/forbidden`, { page: proxy });
      expect(result.navigation.status).toBe(403);
      expect(counts.evaluate).toBeGreaterThan(0);
      expect(counts.screenshot).toBeGreaterThan(0);

      // A browser the caller owns is never closed by the failing call.
      expect(page.isClosed()).toBe(false);
      expect(browser.connected).toBe(true);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("does the same for a generic page that is not a Puppeteer page", async () => {
    const page = await browser.newPage();
    const { proxy, counts } = countingPage(page, { asPuppeteerPage: false });

    try {
      const error = await expectNavigationHttpError(
        realAxe.runAxeCore(`${base}/forbidden`, { page: proxy, failOnHttpError: true })
      );
      expect(error.status).toBe(403);
      expect(counts).toEqual({ evaluate: 0, screenshot: 0 });
      expect(page.isClosed()).toBe(false);
      expect(browser.connected).toBe(true);

      // And without the option the generic branch reports the status and
      // audits the served page, like the Puppeteer one.
      await page.goto("about:blank");
      const result = await realAxe.runAxeCore(`${base}/forbidden`, { page: proxy });
      expect(result.navigation).toEqual({
        navigated: true,
        requestedUrl: `${base}/forbidden`,
        finalUrl: `${base}/forbidden`,
        status: 403,
        redirected: false,
      });
      expect(result.issues.map((issue) => issue.id)).toContain("image-alt");
      expect(counts.evaluate).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("carries Retry-After and retryable for 429, and retryable for 503", async () => {
    const rateLimited = await expectNavigationHttpError(
      audit(`${base}/rate-limited`, { failOnHttpError: true })
    );
    expect(rateLimited.status).toBe(429);
    expect(rateLimited.retryable).toBe(true);
    expect(rateLimited.retryAfterSeconds).toBe(30);

    const unavailable = await expectNavigationHttpError(
      audit(`${base}/unavailable`, { failOnHttpError: true })
    );
    expect(unavailable.status).toBe(503);
    expect(unavailable.retryable).toBe(true);
    expect(unavailable.retryAfterSeconds).toBeUndefined();

    // Default: both are reported on the result instead.
    const result = await audit(`${base}/rate-limited`);
    expect(result.navigation?.status).toBe(429);
  }, 90_000);

  it("reports a redirect with the final URL and the final status", async () => {
    const permanent = await audit(`${base}/old`);

    expect(permanent.navigation?.redirected).toBe(true);
    expect(permanent.navigation?.requestedUrl).toBe(`${base}/old`);
    expect(permanent.navigation?.finalUrl).toBe(`${base}/new`);
    expect(permanent.navigation?.status).toBe(200);
    expect(permanent.documentTitle).toBe("Fine");

    const temporary = await audit(`${base}/moved`);
    expect(temporary.navigation?.redirected).toBe(true);
    expect(temporary.navigation?.finalUrl).toBe(`${base}/new`);
    expect(temporary.navigation?.status).toBe(200);
  }, 90_000);

  it("treats a page it did not navigate as having no response to judge", async () => {
    const page = await browser.newPage();

    try {
      await page.goto(`${base}/forbidden`, { waitUntil: "networkidle2" });
      requestedPaths = [];

      // The option is set and the page is an error page, but core did not
      // navigate it, so there is nothing to fail on (invariant 4).
      const result = await audit(page, { failOnHttpError: true });

      expect(result.navigation).toEqual({
        navigated: false,
        requestedUrl: `${base}/forbidden`,
        finalUrl: `${base}/forbidden`,
        status: null,
        redirected: false,
      });
      expect(result.issues.map((issue) => issue.id)).toContain("image-alt");
      // Nothing was navigated, so the server saw no second document request
      // (Chromium's own favicon request does not count).
      expect(requestedPaths.filter((path) => path !== "/favicon.ico")).toEqual([]);
      // The caller's page and browser are left as they were.
      expect(page.isClosed()).toBe(false);
      expect(browser.connected).toBe(true);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("behaves the same on the pa11y engine", async () => {
    const { result: served, run: servedRun } = await watchOwnBrowsers(() =>
      audit(`${base}/forbidden`, { engine: "pa11y" })
    );
    expect(served.navigation).toEqual({
      navigated: true,
      requestedUrl: `${base}/forbidden`,
      finalUrl: `${base}/forbidden`,
      status: 403,
      redirected: false,
    });
    expect(pa11yCalls).toEqual([`${base}/forbidden`]);
    expect(consoleWarnSpy.calls.map((call) => String(call[0]))[0]).toContain("403");
    expect(servedRun.counts.some((counts) => counts.evaluate > 0)).toBe(true);

    pa11yCalls = [];
    const { result: error, run } = await watchOwnBrowsers(() =>
      expectNavigationHttpError(
        audit(`${base}/forbidden`, { engine: "pa11y", failOnHttpError: true })
      )
    );
    expect(error.status).toBe(403);
    expect(error.retryable).toBe(false);
    // The engine threw before pa11y itself ran, touched nothing on the page,
    // and the browser it launched for itself is closed.
    expect(pa11yCalls).toEqual([]);
    expectNoWorkAndClosed(run);
  }, 120_000);

  it("behaves the same on the standalone semanticAudit(url)", async () => {
    const { result: served, run: servedRun } = await watchOwnBrowsers(() =>
      realSemanticRunner.runSemanticAuditOnUrl(`${base}/forbidden`, semanticOptions)
    );
    expect(served.navigation).toEqual({
      navigated: true,
      requestedUrl: `${base}/forbidden`,
      finalUrl: `${base}/forbidden`,
      status: 403,
      redirected: false,
    });
    // The pass itself ran, so the fail-path assertion below is about the
    // option and not about a provider that is never called anyway.
    expect(providerCalls).toBe(1);
    expect(servedRun.counts.some((counts) => counts.evaluate > 0)).toBe(true);

    providerCalls = 0;
    const { result: error, run } = await watchOwnBrowsers(() =>
      expectNavigationHttpError(
        realSemanticRunner.runSemanticAuditOnUrl(`${base}/forbidden`, {
          ...semanticOptions,
          failOnHttpError: true,
        })
      )
    );
    expect(error.status).toBe(403);
    expect(providerCalls).toBe(0);
    expectNoWorkAndClosed(run);
  }, 120_000);

  it("reports that it navigated nothing for a page handed to semanticAudit()", async () => {
    const { semanticAudit } = await import("./semantic/index.js");
    const page = await browser.newPage();

    try {
      await page.goto(`${base}/forbidden`, { waitUntil: "networkidle2" });

      // The option is set and the page is an error page, but this entry
      // point navigates nothing, so it runs and says so (invariant 4).
      const result = await semanticAudit(page as unknown as BrowserPage, {
        ...semanticOptions,
        failOnHttpError: true,
      });

      expect(result.navigation).toEqual({
        navigated: false,
        requestedUrl: `${base}/forbidden`,
        finalUrl: `${base}/forbidden`,
        status: null,
        redirected: false,
      });
      expect(providerCalls).toBe(1);
      expect(page.isClosed()).toBe(false);
      expect(browser.connected).toBe(true);
    } finally {
      await page.close();
    }
  }, 120_000);

  it("exits non-zero with the status when the CLI is asked to fail on it", async () => {
    const { spawn } = await import("node:child_process");
    const child = spawn(
      process.execPath,
      ["src/cli/bin.ts", "audit", `${base}/forbidden`, "--fail-on-http-error"],
      { cwd: join(import.meta.dir, ".."), stdio: ["ignore", "pipe", "pipe"] }
    );

    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
    });

    expect(exitCode).not.toBe(0);
    expect(output).toContain("403");
    // The audit stopped instead of scoring the error page — otherwise the
    // default path would satisfy the assertions above on its own (it warns
    // about the 403 and exits 1 because the page has issues).
    expect(output).not.toContain("Score:");
  }, 120_000);
});

// ----- egress proxy (real local proxy, real browser) -----

/**
 * The proxy option against a real filtering proxy and a real Chromium: that
 * every launch path routes through it, that loopback is not exempt, and that
 * a refusal arrives as a `NavigationNetworkError` rather than as an audit of
 * the proxy's error page.
 *
 * The proxy imitates Smokescreen: it tunnels `CONNECT` and forwards plain
 * HTTP for the hosts it allows, and answers everything else itself with a
 * status and an `X-Smokescreen-Error` header. Pa11y and the AI provider are
 * stubbed, because what is under test happens before either of them runs.
 */
describe("egress proxy (real local proxy, real browser)", () => {
  /** Chromium's own default launch arguments for every path core launches. */
  const DEFAULT_ARGS = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
  ];

  const PROXY_ARGS = (proxy: string) => [
    `--proxy-server=${proxy}`,
    "--proxy-bypass-list=<-loopback>",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  ];

  const PROXY_ERROR_HEADER = "X-Smokescreen-Error";

  /** Hosts the proxy answers itself, with the status each is mapped to. */
  const refusals = new Map<string, number>([
    ["refused-407.example", 407],
    ["refused-502.example", 502],
    ["refused-403.example", 403],
    ["httprefused-407.example", 407],
    ["httprefused-502.example", 502],
    ["refused-image.example", 407],
  ]);

  /** Hosts the proxy connects to for the browser. */
  const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost"]);

  let proxyRequests: string[];
  /** Requests that reached the target server without passing the proxy. */
  let directHits: string[];

  let targetServer: import("node:http").Server;
  let proxyServer: import("node:http").Server;
  let target: string;
  let proxy: string;

  let providerCalls: number;
  let pa11yCalls: string[];
  let realPa11yModule: Record<string, unknown> | undefined;

  const stubProvider = {
    name: "stub",
    model: "stub-model",
    async analyze() {
      return { contextualAnalysis: "n/a", suggestedFix: "n/a", confidence: 1 };
    },
    async analyzeSemantic() {
      providerCalls += 1;
      return {
        content: JSON.stringify({ issues: [], detectedLanguage: "en" }),
        model: "stub-model",
      };
    },
  };

  const semanticOptions = {
    provider: { name: "nebius" as const, apiKey: "stub" },
    checks: ["aria-mismatch"],
  };

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

  beforeAll(async () => {
    mock.module("./engines/axe.js", () => realAxe);
    mock.module("./puppeteer-launch.js", () => realPuppeteerLaunch);
    mock.module("./ai/index.js", () => ({ ...realAi, createProvider: () => stubProvider }));
    mock.module("./semantic/runner.js", () => realSemanticRunner);
    realPa11yModule = { ...(await import("pa11y")) } as Record<string, unknown>;
    mock.module("pa11y", () => ({
      default: async (url: string) => {
        pa11yCalls.push(url);
        return { issues: [], documentTitle: "Proxied", pageUrl: url };
      },
    }));

    const { createServer, request: forwardRequest } = await import("node:http");
    const { connect: netConnect } = await import("node:net");

    targetServer = createServer((request, response) => {
      const path = (request.url ?? "/").split("?")[0];
      // The proxy marks everything it forwards, so anything unmarked reached
      // this server without going through it.
      if (request.headers["x-test-proxied"] !== "1") {
        directHits.push(path);
      }

      if (path === "/pixel.png") {
        response.writeHead(200, { "content-type": "image/png" });
        response.end();
        return;
      }
      if (path === "/frame") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          '<!doctype html><html lang="en"><head><title>Frame</title></head>' +
            "<body><p>Framed.</p></body></html>"
        );
        return;
      }
      if (path === "/loopback") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          '<!doctype html><html lang="en"><head><title>Loopback</title></head>' +
            "<body><main><h1>Loopback</h1>" +
            `<img src="${target}/pixel.png" alt="A pixel">` +
            `<iframe src="http://localhost:${new URL(target).port}/frame" title="Framed"></iframe>` +
            "</main></body></html>"
        );
        return;
      }
      if (path === "/refused-subresource") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          '<!doctype html><html lang="en"><head><title>Refused image</title></head>' +
            "<body><main><h1>Refused image</h1>" +
            '<img src="http://refused-image.example/pixel.png" alt="A pixel">' +
            "</main></body></html>"
        );
        return;
      }

      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        '<!doctype html><html lang="en"><head><title>Proxied</title></head>' +
          "<body><main><h1>Proxied</h1><p>All good.</p></main></body></html>"
      );
    });

    proxyServer = createServer((request, response) => {
      // A browser that drops a connection must never crash the test process.
      request.on("error", () => undefined);
      response.on("error", () => undefined);

      let requested: URL;
      try {
        requested = new URL(request.url ?? "");
      } catch {
        response.writeHead(400);
        response.end();
        return;
      }

      proxyRequests.push(`http ${requested.host}${requested.pathname}`);

      const refusal = refusals.get(requested.hostname);
      if (refusal !== undefined || !ALLOWED_HOSTS.has(requested.hostname)) {
        response.writeHead(refusal ?? 502, {
          "content-type": "text/html",
          [PROXY_ERROR_HEADER]: "Request rejected by proxy",
          ...(refusal === 429 ? { "retry-after": "1" } : {}),
        });
        response.end("<!doctype html><title>Denied</title><p>Denied.</p>");
        return;
      }

      const headers = { ...request.headers, "x-test-proxied": "1" };
      delete headers["proxy-connection"];
      const forwarded = forwardRequest(
        {
          host: requested.hostname,
          port: requested.port || 80,
          path: `${requested.pathname}${requested.search}`,
          method: request.method,
          headers,
        },
        (answer) => {
          response.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(response);
        }
      );
      forwarded.on("error", () => {
        response.writeHead(502, { [PROXY_ERROR_HEADER]: "Connection failed" });
        response.end();
      });
      request.pipe(forwarded);
    });

    proxyServer.on("connect", (request, socket) => {
      socket.on("error", () => undefined);

      const [host, port] = (request.url ?? "").split(":");
      proxyRequests.push(`connect ${request.url}`);

      const refusal = refusals.get(host);
      if (refusal !== undefined || !ALLOWED_HOSTS.has(host)) {
        socket.write(
          `HTTP/1.1 ${refusal ?? 502} Proxy Error\r\n` +
            `${PROXY_ERROR_HEADER}: Request rejected by proxy\r\n` +
            "Content-Length: 0\r\n\r\n"
        );
        socket.end();
        return;
      }

      const upstream = netConnect(Number(port || 443), host, () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on("error", () => {
        socket.write("HTTP/1.1 502 Proxy Error\r\n\r\n");
        socket.end();
      });
      socket.on("close", () => upstream.destroy());
    });

    await new Promise<void>((resolve) => {
      targetServer.listen(0, "127.0.0.1", () => resolve());
    });
    await new Promise<void>((resolve) => {
      proxyServer.listen(0, "127.0.0.1", () => resolve());
    });

    const targetAddress = targetServer.address();
    const proxyAddress = proxyServer.address();
    if (!targetAddress || typeof targetAddress === "string") {
      throw new Error("Target server did not report a port");
    }
    if (!proxyAddress || typeof proxyAddress === "string") {
      throw new Error("Proxy server did not report a port");
    }
    target = `http://127.0.0.1:${targetAddress.port}`;
    proxy = `http://127.0.0.1:${proxyAddress.port}`;
  }, 120_000);

  afterAll(async () => {
    try {
      targetServer?.closeAllConnections?.();
      proxyServer?.closeAllConnections?.();
      await new Promise<void>((resolve) => {
        if (!targetServer) return resolve();
        targetServer.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        if (!proxyServer) return resolve();
        proxyServer.close(() => resolve());
      });
    } finally {
      mock.module("./engines/axe.js", () => axeStubModule);
      mock.module("./puppeteer-launch.js", () => puppeteerLaunchStubModule);
      mock.module("./ai/index.js", () => realAi);
      mock.module("./semantic/runner.js", () => semanticRunnerStubModule);
      if (realPa11yModule) {
        mock.module("pa11y", () => realPa11yModule);
      }
    }
  });

  beforeEach(() => {
    proxyRequests = [];
    directHits = [];
    providerCalls = 0;
    pa11yCalls = [];
  });

  it("sends loopback subresources through the proxy and nothing to the target directly", async () => {
    const result = await audit(`${target}/loopback`, { browser: { proxyServer: proxy } });

    expect(result.documentTitle).toBe("Loopback");
    // The document, the 127.0.0.1 image and the localhost iframe all passed
    // the proxy: the implicit loopback bypass is gone (invariant 1).
    expect(proxyRequests).toContain(`http 127.0.0.1:${new URL(target).port}/loopback`);
    expect(proxyRequests).toContain(`http 127.0.0.1:${new URL(target).port}/pixel.png`);
    expect(proxyRequests).toContain(`http localhost:${new URL(target).port}/frame`);
    // And the target saw no request that had not passed the proxy.
    expect(directHits).toEqual([]);
  }, 120_000);

  it("audits the page as rendered when a subresource is refused", async () => {
    const result = await audit(`${target}/refused-subresource`, {
      browser: { proxyServer: proxy, proxyErrorHeader: PROXY_ERROR_HEADER },
    });

    // Invariant 6: the image never arrived, the page is still audited.
    expect(proxyRequests).toContain("http refused-image.example/pixel.png");
    expect(result.documentTitle).toBe("Refused image");
    expect(result.score).toBeGreaterThan(0);
  }, 120_000);

  it("tells a 407 refusal from a tunnel failure, which says nothing either way", async () => {
    const refused = await expectNetworkError(
      audit("https://refused-407.example/", { browser: { proxyServer: proxy } })
    );
    expect(refused.netError).toBe("ERR_PROXY_AUTH_UNSUPPORTED");
    expect(refused.refusedByProxy).toBe(true);
    expect(refused.retryable).toBe(false);
    expect(refused.url).toBe("https://refused-407.example/");
    expect(proxyRequests).toContain("connect refused-407.example:443");

    // 502 (the proxy could not reach the destination) and 403 (how a proxy
    // other than Smokescreen may refuse a CONNECT) are the same net error to
    // the browser, with no status, body or header behind it: `refusedByProxy`
    // stays absent for both (A2).
    for (const host of ["refused-502.example", "refused-403.example"]) {
      const failed = await expectNetworkError(
        audit(`https://${host}/`, { browser: { proxyServer: proxy } })
      );
      expect(failed.netError).toBe("ERR_TUNNEL_CONNECTION_FAILED");
      expect(failed.refusedByProxy).toBeUndefined();
      expect(failed.retryable).toBe(false);
      expect(proxyRequests).toContain(`connect ${host}:443`);
    }
  }, 120_000);

  it("throws on the proxy's own http answer instead of auditing it, without failOnHttpError", async () => {
    const browser = { proxyServer: proxy, proxyErrorHeader: PROXY_ERROR_HEADER };

    const { result: refused, run } = await watchOwnBrowsers(() =>
      expectNetworkError(audit("http://httprefused-407.example/", { browser }))
    );
    expect(refused.netError).toBeNull();
    expect(refused.proxyStatus).toBe(407);
    expect(refused.refusedByProxy).toBe(true);
    expect(refused.retryable).toBe(false);
    expect(refused.message).toContain("Request rejected by proxy");
    // Nothing was done on the proxy's error page, and the session was closed.
    expectNoWorkAndClosed(run);

    const failed = await expectNetworkError(audit("http://httprefused-502.example/", { browser }));
    expect(failed.netError).toBeNull();
    expect(failed.proxyStatus).toBe(502);
    expect(failed.refusedByProxy).toBe(false);
    expect(failed.retryable).toBe(false);
  }, 120_000);

  it("does no work on the fatal path with rendering on, on pa11y, and on semanticAudit(url)", async () => {
    const browser = { proxyServer: proxy, proxyErrorHeader: PROXY_ERROR_HEADER };
    const refusedUrl = "http://httprefused-407.example/";

    // The rendering pass is the most work audit() can do after the
    // navigation, so this is the strongest form of "nothing ran".
    const { run: renderingRun } = await watchOwnBrowsers(() =>
      expectNetworkError(audit(refusedUrl, { browser, rendering: true }))
    );
    expectNoWorkAndClosed(renderingRun);

    const { run: pa11yRun } = await watchOwnBrowsers(() =>
      expectNetworkError(audit(refusedUrl, { engine: "pa11y", browser }))
    );
    // The engine threw before pa11y itself ran, and closed what it launched.
    expect(pa11yCalls).toEqual([]);
    expectNoWorkAndClosed(pa11yRun);

    const { run: semanticRun } = await watchOwnBrowsers(() =>
      expectNetworkError(
        realSemanticRunner.runSemanticAuditOnUrl(refusedUrl, { ...semanticOptions, browser })
      )
    );
    // No AI request was paid for the proxy's error answer.
    expect(providerCalls).toBe(0);
    expectNoWorkAndClosed(semanticRun);
  }, 300_000);

  it("reports an unresolvable hostname without a proxy, and an unreachable proxy with one", async () => {
    const unresolvable = await expectNetworkError(audit("http://does-not-exist.invalid/"));
    expect(unresolvable.netError).toBe("ERR_NAME_NOT_RESOLVED");
    expect(unresolvable.retryable).toBe(false);
    // No proxy was configured, so nothing is claimed about one.
    expect(unresolvable.refusedByProxy).toBeUndefined();

    const unreachable = await expectNetworkError(
      audit(`${target}/`, { browser: { proxyServer: "http://127.0.0.1:1" } })
    );
    expect(unreachable.netError).toBe("ERR_PROXY_CONNECTION_FAILED");
    expect(unreachable.retryable).toBe(true);
    expect(unreachable.refusedByProxy).toBe(false);
  }, 120_000);

  it("launches every path through the proxy, and keeps today's arguments without the option", async () => {
    const browser = { proxyServer: proxy };
    const expected = [...DEFAULT_ARGS, ...PROXY_ARGS(proxy)];

    // 1. The shared session helper.
    const { run: sessionRun } = await watchOwnBrowsers(async () => {
      const session = await realPuppeteerLaunch.launchPuppeteerSession({ browser });
      await realPuppeteerLaunch.closeSession(session);
    });
    expect(sessionRun.args).toEqual([expected]);

    // 2. The axe engine's own launch.
    const { run: axeRun } = await watchOwnBrowsers(() =>
      realAxe.runAxeCore(`${target}/`, { browser })
    );
    expect(axeRun.args).toEqual([expected]);

    // 3. audit()'s own session (annotation keeps the page, so it owns one).
    const { run: auditRun } = await watchOwnBrowsers(() => audit(`${target}/`, { browser }));
    expect(auditRun.args).toEqual([expected]);

    // 4. The pa11y engine, whose own base list the proxy arguments extend.
    const { run: pa11yRun } = await watchOwnBrowsers(() =>
      audit(`${target}/`, { engine: "pa11y", browser })
    );
    expect(pa11yRun.args).toEqual([expected]);
    expect(pa11yCalls).toEqual([`${target}/`]);

    // 5. The standalone semantic audit.
    const { run: semanticRun } = await watchOwnBrowsers(() =>
      realSemanticRunner.runSemanticAuditOnUrl(`${target}/`, { ...semanticOptions, browser })
    );
    expect(semanticRun.args).toEqual([expected]);
    expect(providerCalls).toBe(1);

    // Without the option every one of them launches with exactly the list it
    // launched with before the option existed (invariant 2).
    const { run: plainAxeRun } = await watchOwnBrowsers(() => realAxe.runAxeCore(`${target}/`, {}));
    expect(plainAxeRun.args).toEqual([DEFAULT_ARGS]);

    const { run: plainPa11yRun } = await watchOwnBrowsers(() =>
      audit(`${target}/`, { engine: "pa11y" })
    );
    expect(plainPa11yRun.args).toEqual([DEFAULT_ARGS]);
  }, 300_000);

  it("rejects a proxy URL and an extra argument that would undo the proxy", async () => {
    const { run: badUrl } = await watchOwnBrowsers(async () => {
      await expect(
        audit(`${target}/`, { browser: { proxyServer: "127.0.0.1:4750" } })
      ).rejects.toThrow("must be a URL with an explicit scheme");
    });
    // No browser was started for either of them.
    expect(badUrl.browsers).toEqual([]);

    const { run: badArg } = await watchOwnBrowsers(async () => {
      await expect(
        audit(`${target}/`, {
          browser: { proxyServer: proxy, extraArgs: ["--proxy-bypass-list=<local>"] },
        })
      ).rejects.toThrow("--proxy-bypass-list=<local>");
    });
    expect(badArg.browsers).toEqual([]);

    const { run: emptyProxy } = await watchOwnBrowsers(async () => {
      await expect(audit(`${target}/`, { browser: { proxyServer: "  " } })).rejects.toThrow(
        "supplied but empty"
      );
    });
    expect(emptyProxy.browsers).toEqual([]);
  }, 120_000);

  it("rejects a pa11y chromeArgs list that contradicts the proxy, before any launch", async () => {
    const { runPa11y } = await import("./engines/pa11y.js");

    const { run } = await watchOwnBrowsers(async () => {
      await expect(
        runPa11y(`${target}/`, {
          chromeArgs: [...DEFAULT_ARGS, "--no-proxy-server"],
          browser: { proxyServer: proxy },
        })
      ).rejects.toThrow("--no-proxy-server");
    });

    // The engine's own base list is checked too, so no browser started and
    // pa11y never ran.
    expect(run.browsers).toEqual([]);
    expect(pa11yCalls).toEqual([]);
  }, 120_000);
});
