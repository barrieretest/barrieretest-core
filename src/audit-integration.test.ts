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

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import puppeteer from "puppeteer";
import type { BrowserPage } from "./browser.js";
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
let consoleWarnSpy: { calls: unknown[][]; restore: () => void };

const ENGINE_URL = "https://example.test/page";

mock.module("./engines/axe.js", () => ({
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
      screenshot: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    };
  },
  transformAxeViolation: () => [],
}));

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

// Stub puppeteer-launch so audit() doesn't try to launch a real browser
// when handed a URL with `semantic` set.
mock.module("./puppeteer-launch.js", () => ({
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
}));

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
