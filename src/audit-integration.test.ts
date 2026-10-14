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
    expect(annotation?.mark).toBe(1);
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
    expect(annotationFor("image-alt")?.mark).toBe(1);
    expect(annotationFor("image-redundant-alt")?.mark).toBe(1);

    const marks = result.issues
      .map((issue) => issue.annotation?.mark)
      .filter((mark): mark is number => mark !== undefined);
    const distinct = [...new Set(marks)].sort((a, b) => a - b);

    expect(distinct).toEqual([1, 2, 3, 4]);
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
    #lazy { display: block; width: 400px; height: 300px; }
    #reveal { height: 200px; background: #eee; opacity: 0; }
    #reveal.shown { opacity: 1; }
  </style>
</head>
<body>
  <main>
    <h1>Lazy content fixture</h1>
    <div class="spacer"></div>
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

  beforeAll(async () => {
    mock.module("./engines/axe.js", () => realAxe);
    mock.module("./puppeteer-launch.js", () => realPuppeteerLaunch);

    fixtureDir = mkdtempSync(join(tmpdir(), "barrieretest-lazy-"));
    writeFileSync(join(fixtureDir, "picture.svg"), PICTURE);
    const fixturePath = join(fixtureDir, "fixture.html");
    writeFileSync(fixturePath, FIXTURE);
    fixtureUrl = `file://${fixturePath}`;

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
