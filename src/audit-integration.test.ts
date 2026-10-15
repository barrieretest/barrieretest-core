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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import puppeteer from "puppeteer";
import { measureSelectors, readPngSize } from "./annotate/index.js";
import type { BrowserPage } from "./browser.js";
import { dismissCookieBanner } from "./cookie-banner.js";
import { renderHtmlReport } from "./html-report/index.js";
import { loadLazyContent } from "./lazy-content.js";
import { extractHtmlContext } from "./semantic/context.js";
import type { Issue } from "./types.js";

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

mock.module("./semantic/runner.js", () => ({
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
}));

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
  navigateTo: realPuppeteerLaunchModule.navigateTo,
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
  navigateTo: async () => undefined,
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
    await browser?.close();
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
    mock.module("./engines/axe.js", () => axeStubModule);
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
    await browser?.close();
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
    mock.module("./engines/axe.js", () => axeStubModule);
    mock.module("./puppeteer-launch.js", () => puppeteerLaunchStubModule);
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
    writeFileSync(join(fixtureDir, "hidden-nav.html"), HIDDEN_NAV_FIXTURE);
    writeFileSync(join(fixtureDir, "disclosure.html"), DISCLOSURE_FIXTURE);

    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
    mock.module("./engines/axe.js", () => axeStubModule);
    mock.module("./puppeteer-launch.js", () => puppeteerLaunchStubModule);
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
