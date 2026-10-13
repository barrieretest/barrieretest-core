import { describe, expect, it } from "bun:test";
import type { BrowserPage } from "../browser.js";
import type { Issue } from "../types.js";
import { annotateIssues } from "./index.js";
import {
  applyAnnotations,
  captureSizeFrom,
  resolveSelectorAnnotations,
  screenshotMetaFrom,
  unresolvedAnnotations,
} from "./map.js";
import { isPageMeasurement } from "./measure.js";
import type { PageMeasurement, SelectorMeasurement } from "./measure.js";
import { readPngSize } from "./png.js";

/**
 * Minimal PNG: signature plus a structurally complete IHDR chunk — the
 * declared 13 data bytes are all there, as a real PNG has them.
 */
function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(29);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8; // bit depth
  bytes[25] = 6; // colour type: RGBA
  return bytes;
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "rule",
    impact: "serious",
    description: "stub",
    help: "stub help",
    selector: ".a",
    nodes: [{ html: "<div></div>" }],
    ...overrides,
  };
}

function makeMeasurement(
  selectors: SelectorMeasurement[],
  overrides: Partial<PageMeasurement> = {}
): PageMeasurement {
  return {
    selectors,
    devicePixelRatio: 1,
    viewport: { width: 1280, height: 720 },
    document: { width: 1280, height: 2000 },
    scroll: { x: 0, y: 0 },
    ...overrides,
  };
}

/** A visible 100x50 box at (10, 20), as the browser would report it. */
function visibleEntry(overrides: Partial<SelectorMeasurement> = {}): SelectorMeasurement {
  return {
    matchCount: 1,
    invalid: false,
    elementIndex: 0,
    rect: { x: 10, y: 20, width: 100, height: 50 },
    rendered: true,
    anchored: false,
    ...overrides,
  };
}

/**
 * Stub page in the shape `annotateIssues` uses: it records the arguments of
 * every `evaluate` call and answers with canned measurement data.
 */
function makeStubPage(
  answer: (selectors: string[]) => unknown,
  calls: { selectors: string[] }[] = []
): BrowserPage {
  return {
    url: () => "https://stub.test/page",
    title: async () => "Stub",
    goto: async () => undefined,
    screenshot: async () => pngBytes(1280, 2000),
    evaluate: (async (_fn: unknown, arg?: unknown) => {
      const selectors = (arg ?? []) as string[];
      calls.push({ selectors });
      return answer(selectors);
    }) as unknown as BrowserPage["evaluate"],
  };
}

/** Collect `console.warn` output for the duration of one call. */
async function withWarnings<T>(run: () => Promise<T>): Promise<{ value: T; warnings: string[] }> {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(String(args[0] ?? ""));
  };
  try {
    const value = await run();
    return { value, warnings };
  } finally {
    console.warn = original;
  }
}

const CAPTURE = { width: 1280, height: 2000 };

// ----- PNG header -----

describe("readPngSize", () => {
  it("reads width and height from the IHDR chunk", () => {
    expect(readPngSize(pngBytes(1280, 4200))).toEqual({ width: 1280, height: 4200 });
  });

  it("rejects bytes that are too short to hold an IHDR chunk", () => {
    expect(readPngSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });

  it("rejects a wrong signature", () => {
    const bytes = pngBytes(100, 100);
    bytes[1] = 0x00;
    expect(readPngSize(bytes)).toBeNull();
  });

  it("rejects a first chunk that is not IHDR", () => {
    const bytes = pngBytes(100, 100);
    bytes.set([0x49, 0x44, 0x41, 0x54], 12);
    expect(readPngSize(bytes)).toBeNull();
  });

  it("rejects a zero-sized image", () => {
    expect(readPngSize(pngBytes(0, 100))).toBeNull();
    expect(readPngSize(pngBytes(100, 0))).toBeNull();
  });

  it("rejects a first chunk that does not declare the 13 IHDR data bytes", () => {
    const bytes = pngBytes(100, 100);
    new DataView(bytes.buffer).setUint32(8, 10);
    expect(readPngSize(bytes)).toBeNull();
  });

  it("rejects a header truncated inside the IHDR data", () => {
    expect(readPngSize(pngBytes(100, 100).slice(0, 28))).toBeNull();
  });

  it("reads a size from a buffer that carries more than the header", () => {
    const header = pngBytes(800, 600);
    const long = new Uint8Array(200);
    long.set(header, 0);
    expect(readPngSize(long)).toEqual({ width: 800, height: 600 });
  });
});

// ----- capture geometry -----

describe("captureSizeFrom and screenshotMetaFrom", () => {
  it("divides the image size by the device pixel ratio", () => {
    expect(captureSizeFrom({ width: 2560, height: 4000 }, 2)).toEqual({
      width: 1280,
      height: 2000,
    });
  });

  it("falls back to a ratio of 1 for a nonsensical ratio", () => {
    expect(captureSizeFrom({ width: 1280, height: 2000 }, 0)).toEqual({
      width: 1280,
      height: 2000,
    });
  });

  it("reports the capture geometry the consumer needs", () => {
    const meta = screenshotMetaFrom(
      { width: 2560, height: 4000 },
      makeMeasurement([], {
        devicePixelRatio: 2,
        viewport: { width: 1280, height: 720 },
        document: { width: 1280, height: 2100 },
        scroll: { x: 0, y: 40 },
      })
    );

    expect(meta).toEqual({
      width: 1280,
      height: 2000,
      deviceScaleFactor: 2,
      viewport: { width: 1280, height: 720 },
      fullPage: true,
      document: { width: 1280, height: 2100 },
      scroll: { x: 0, y: 40 },
    });
  });
});

// ----- state mapping -----

describe("resolveSelectorAnnotations", () => {
  const resolveOne = (entry: SelectorMeasurement) =>
    resolveSelectorAnnotations([".a"], makeMeasurement([entry]), CAPTURE).get(".a");

  it("resolves a single visible match and rounds the rect outward", () => {
    const annotation = resolveOne(
      visibleEntry({ rect: { x: 10.4, y: 20.6, width: 100.2, height: 50.1 } })
    );

    expect(annotation?.state).toBe("resolved");
    expect(annotation?.rect).toEqual({ x: 10, y: 20, width: 101, height: 51 });
  });

  it("marks a selector that matched several elements ambiguous", () => {
    expect(resolveOne(visibleEntry({ matchCount: 3 }))?.state).toBe("ambiguous");
  });

  it("marks an element that is not rendered hidden", () => {
    const annotation = resolveOne(visibleEntry({ rendered: false }));
    expect(annotation?.state).toBe("hidden");
    expect(annotation?.rect).toBeUndefined();
  });

  it("marks a screen-reader-only box hidden", () => {
    expect(resolveOne(visibleEntry({ rect: { x: 0, y: 0, width: 1, height: 1 } }))?.state).toBe(
      "hidden"
    );
  });

  it("marks an element outside the captured area hidden", () => {
    expect(
      resolveOne(visibleEntry({ rect: { x: -400, y: 100, width: 300, height: 50 } }))?.state
    ).toBe("hidden");
    expect(
      resolveOne(visibleEntry({ rect: { x: 10, y: 2400, width: 300, height: 50 } }))?.state
    ).toBe("hidden");
  });

  it("clips a rect that reaches past the captured area", () => {
    const annotation = resolveOne(
      visibleEntry({ rect: { x: 1200, y: 1980, width: 300, height: 100 } })
    );

    expect(annotation?.state).toBe("resolved");
    expect(annotation?.rect).toEqual({ x: 1200, y: 1980, width: 80, height: 20 });
  });

  it("clips to the whole-pixel capture box of a fractional capture size", () => {
    const capture = { width: 100.4, height: 100.4 };
    const resolveIn = (rect: { x: number; y: number; width: number; height: number }) =>
      resolveSelectorAnnotations([".a"], makeMeasurement([visibleEntry({ rect })]), capture).get(
        ".a"
      );

    // Just inside: the rect is clamped to floor(capture), never past the image.
    const inside = resolveIn({ x: 95.2, y: 10, width: 20, height: 20 });
    expect(inside?.state).toBe("resolved");
    expect(inside?.rect).toEqual({ x: 95, y: 10, width: 5, height: 20 });

    // Inside the unrounded capture but with no whole pixel left after clamping.
    expect(resolveIn({ x: 100.2, y: 10, width: 20, height: 20 })?.state).toBe("hidden");
    expect(resolveIn({ x: 10, y: 100.2, width: 20, height: 20 })?.state).toBe("hidden");

    // Starting at or past the capture edge: outside.
    expect(resolveIn({ x: 100.4, y: 10, width: 20, height: 20 })?.state).toBe("hidden");
    expect(resolveIn({ x: 10, y: 140, width: 20, height: 20 })?.state).toBe("hidden");
  });

  it("calls a selector that resolved to html or body a page-level annotation", () => {
    const annotation = resolveOne(
      visibleEntry({ page: true, rect: { x: 0, y: 0, width: 1280, height: 2000 } })
    );

    expect(annotation?.state).toBe("page");
    expect(annotation?.rect).toBeUndefined();
    expect(annotation?.elementIndex).toBeUndefined();
    expect(annotation?.anchored).toBeUndefined();
  });

  it("leaves an invalid selector and a selector without a match unresolved", () => {
    expect(resolveOne({ matchCount: 0, invalid: true })?.state).toBe("unresolved");
    expect(resolveOne({ matchCount: 0, invalid: false })?.state).toBe("unresolved");
  });

  it("flags an anchored element, including a hidden one", () => {
    expect(resolveOne(visibleEntry({ anchored: true }))?.anchored).toBe(true);
    expect(resolveOne(visibleEntry({ anchored: true, rendered: false }))?.anchored).toBe(true);
    expect(resolveOne(visibleEntry())?.anchored).toBeUndefined();
  });

  it("leaves a selector the measurement did not answer unresolved", () => {
    const resolved = resolveSelectorAnnotations(
      [".a", ".b"],
      makeMeasurement([visibleEntry()]),
      CAPTURE
    );
    expect(resolved.get(".b")?.state).toBe("unresolved");
  });
});

// ----- measurement validation -----

describe("isPageMeasurement", () => {
  it("accepts what the browser returns, with and without optional fields", () => {
    expect(isPageMeasurement(makeMeasurement([visibleEntry()]))).toBe(true);
    expect(isPageMeasurement(makeMeasurement([{ matchCount: 0, invalid: true }]))).toBe(true);
    expect(isPageMeasurement(makeMeasurement([visibleEntry({ page: true })]))).toBe(true);
  });

  it("rejects a match count that is not a non-negative integer", () => {
    for (const matchCount of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      expect(isPageMeasurement(makeMeasurement([visibleEntry({ matchCount })]))).toBe(false);
    }
  });

  it("rejects a non-finite number in a rect or in the page-level geometry", () => {
    expect(
      isPageMeasurement(
        makeMeasurement([visibleEntry({ rect: { x: Number.NaN, y: 0, width: 10, height: 10 } })])
      )
    ).toBe(false);
    expect(
      isPageMeasurement(
        makeMeasurement([
          visibleEntry({ rect: { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 10 } }),
        ])
      )
    ).toBe(false);
    expect(isPageMeasurement(makeMeasurement([], { devicePixelRatio: Number.NaN }))).toBe(false);
    expect(
      isPageMeasurement(makeMeasurement([], { viewport: { width: Number.NaN, height: 720 } }))
    ).toBe(false);
    expect(
      isPageMeasurement(
        makeMeasurement([], { document: { width: 1280, height: Number.POSITIVE_INFINITY } })
      )
    ).toBe(false);
    expect(isPageMeasurement(makeMeasurement([], { scroll: { x: 0, y: Number.NaN } }))).toBe(false);
  });

  it("rejects a rect without a usable element index", () => {
    expect(isPageMeasurement(makeMeasurement([visibleEntry({ elementIndex: undefined })]))).toBe(
      false
    );
    expect(isPageMeasurement(makeMeasurement([visibleEntry({ elementIndex: -1 })]))).toBe(false);
    expect(isPageMeasurement(makeMeasurement([visibleEntry({ elementIndex: 1.5 })]))).toBe(false);
  });

  it("rejects a non-boolean flag", () => {
    const withFlag = (flag: Record<string, unknown>) =>
      isPageMeasurement(
        makeMeasurement([{ ...visibleEntry(), ...flag } as unknown as SelectorMeasurement])
      );

    expect(withFlag({ rendered: "yes" })).toBe(false);
    expect(withFlag({ anchored: 1 })).toBe(false);
    expect(withFlag({ page: null })).toBe(false);
  });

  it("rejects data that is not a measurement at all", () => {
    expect(isPageMeasurement(undefined)).toBe(false);
    expect(isPageMeasurement({})).toBe(false);
    expect(isPageMeasurement({ ...makeMeasurement([]), selectors: "none" })).toBe(false);
  });
});

// ----- marks -----

describe("applyAnnotations", () => {
  it("gives two issues on the same element one mark and numbers contiguously from 1", () => {
    const issues = [
      makeIssue({ id: "a", selector: ".one" }),
      makeIssue({ id: "b", selector: ".alias-of-one" }),
      makeIssue({ id: "c", selector: ".prose location" }),
      makeIssue({ id: "d", selector: ".two" }),
    ];

    const resolved = resolveSelectorAnnotations(
      [".one", ".alias-of-one", ".prose location", ".two"],
      makeMeasurement([
        visibleEntry({ elementIndex: 0 }),
        visibleEntry({ elementIndex: 0 }),
        { matchCount: 0, invalid: true },
        visibleEntry({ elementIndex: 1, rect: { x: 0, y: 400, width: 200, height: 40 } }),
      ]),
      CAPTURE
    );

    const annotated = applyAnnotations(issues, resolved);

    expect(annotated.map((issue) => issue.annotation?.mark)).toEqual([1, 1, undefined, 2]);
    expect(annotated[2].annotation?.state).toBe("unresolved");
  });

  it("numbers marks in final issue order", () => {
    const issues = [makeIssue({ selector: ".second" }), makeIssue({ selector: ".first" })];
    const resolved = resolveSelectorAnnotations(
      [".second", ".first"],
      makeMeasurement([visibleEntry({ elementIndex: 3 }), visibleEntry({ elementIndex: 1 })]),
      CAPTURE
    );

    expect(applyAnnotations(issues, resolved).map((issue) => issue.annotation?.mark)).toEqual([
      1, 2,
    ]);
  });

  it("gives a hidden element no mark", () => {
    const resolved = resolveSelectorAnnotations(
      [".a"],
      makeMeasurement([visibleEntry({ rendered: false })]),
      CAPTURE
    );
    const annotated = applyAnnotations([makeIssue()], resolved);

    expect(annotated[0].annotation?.state).toBe("hidden");
    expect(annotated[0].annotation?.mark).toBeUndefined();
    expect(annotated[0].annotation?.rect).toBeUndefined();
  });

  it("gives a page-level annotation no rect and no mark", () => {
    const resolved = resolveSelectorAnnotations(
      ["html"],
      makeMeasurement([
        visibleEntry({ page: true, rect: { x: 0, y: 0, width: 1280, height: 2000 } }),
      ]),
      CAPTURE
    );
    const annotated = applyAnnotations(
      [makeIssue({ id: "page-has-heading-one", selector: "html" })],
      resolved
    );

    expect(annotated[0].annotation).toEqual({ selector: "html", state: "page" });
  });

  it("leaves an issue without a selector unresolved", () => {
    const annotated = applyAnnotations([makeIssue({ selector: null })], new Map());

    expect(annotated[0].annotation).toEqual({ selector: null, state: "unresolved" });
  });

  it("records the selector it resolved", () => {
    const resolved = resolveSelectorAnnotations(
      ["#hero"],
      makeMeasurement([visibleEntry()]),
      CAPTURE
    );
    const annotated = applyAnnotations([makeIssue({ selector: "#hero" })], resolved);

    expect(annotated[0].annotation?.selector).toBe("#hero");
  });

  it("annotates copies and leaves the input issues untouched", () => {
    const issues = [makeIssue()];
    const resolved = resolveSelectorAnnotations([".a"], makeMeasurement([visibleEntry()]), CAPTURE);

    const annotated = applyAnnotations(issues, resolved);

    expect(annotated[0]).not.toBe(issues[0]);
    expect(issues[0].annotation).toBeUndefined();
  });
});

describe("unresolvedAnnotations", () => {
  it("marks every issue unresolved on copies", () => {
    const issues = [makeIssue(), makeIssue({ selector: null })];
    const degraded = unresolvedAnnotations(issues);

    expect(degraded.map((issue) => issue.annotation?.state)).toEqual(["unresolved", "unresolved"]);
    expect(degraded.map((issue) => issue.annotation?.selector)).toEqual([".a", null]);
    expect(issues.every((issue) => issue.annotation === undefined)).toBe(true);
  });
});

// ----- orchestration -----

describe("annotateIssues", () => {
  it("measures the de-duplicated selectors in a single evaluate call", async () => {
    const calls: { selectors: string[] }[] = [];
    const page = makeStubPage(
      (selectors) => makeMeasurement(selectors.map(() => visibleEntry())),
      calls
    );

    const issues = [
      makeIssue({ selector: ".a" }),
      makeIssue({ selector: ".a" }),
      makeIssue({ selector: ".b" }),
      makeIssue({ selector: null }),
      makeIssue({ selector: "  " }),
    ];

    const result = await annotateIssues(page, issues, pngBytes(1280, 2000));

    expect(calls).toHaveLength(1);
    expect(calls[0].selectors).toEqual([".a", ".b"]);
    expect(result.screenshotMeta?.width).toBe(1280);
    expect(result.issues.map((issue) => issue.annotation?.state)).toEqual([
      "resolved",
      "resolved",
      "resolved",
      "unresolved",
      "unresolved",
    ]);
  });

  it("gives two issues sharing an element the same mark", async () => {
    const page = makeStubPage(() =>
      makeMeasurement([visibleEntry({ elementIndex: 0 }), visibleEntry({ elementIndex: 0 })])
    );

    const result = await annotateIssues(
      page,
      [makeIssue({ selector: "#x" }), makeIssue({ selector: "main #x" })],
      pngBytes(1280, 2000)
    );

    expect(result.issues.map((issue) => issue.annotation?.mark)).toEqual([1, 1]);
  });

  it("skips annotation and warns when the screenshot is not a readable PNG", async () => {
    const calls: { selectors: string[] }[] = [];
    const page = makeStubPage(() => makeMeasurement([visibleEntry()]), calls);

    const { value, warnings } = await withWarnings(() =>
      annotateIssues(page, [makeIssue()], new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
    );

    expect(calls).toHaveLength(0);
    expect(value.screenshotMeta).toBeUndefined();
    expect(value.issues[0].annotation).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toStartWith("Annotation");
  });

  it("degrades to all-unresolved and warns when the measurement throws", async () => {
    const page = makeStubPage(() => {
      throw new Error("Execution context was destroyed");
    });

    const { value, warnings } = await withWarnings(() =>
      annotateIssues(page, [makeIssue(), makeIssue({ selector: ".b" })], pngBytes(1280, 2000))
    );

    expect(value.screenshotMeta).toBeUndefined();
    expect(value.issues.map((issue) => issue.annotation?.state)).toEqual([
      "unresolved",
      "unresolved",
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toStartWith("Annotation");
    expect(warnings[0]).toContain("Execution context was destroyed");
  });

  it("degrades to all-unresolved and warns when the measurement times out", async () => {
    const page: BrowserPage = {
      ...makeStubPage(() => makeMeasurement([])),
      evaluate: (() => new Promise(() => {})) as unknown as BrowserPage["evaluate"],
    };

    const { value, warnings } = await withWarnings(() =>
      annotateIssues(page, [makeIssue()], pngBytes(1280, 2000), { timeout: 20 })
    );

    expect(value.screenshotMeta).toBeUndefined();
    expect(value.issues[0].annotation?.state).toBe("unresolved");
    expect(warnings[0]).toStartWith("Annotation");
    expect(warnings[0]).toContain("timed out");
  });

  it("degrades to all-unresolved when the page answers with unexpected data", async () => {
    const page = makeStubPage(() => ({}));

    const { value, warnings } = await withWarnings(() =>
      annotateIssues(page, [makeIssue()], pngBytes(1280, 2000))
    );

    expect(value.screenshotMeta).toBeUndefined();
    expect(value.issues[0].annotation?.state).toBe("unresolved");
    expect(warnings[0]).toStartWith("Annotation");
  });

  it("reports geometry for an issue-free page", async () => {
    const page = makeStubPage(() => makeMeasurement([]));

    const result = await annotateIssues(page, [], pngBytes(2560, 4000));

    expect(result.issues).toEqual([]);
    expect(result.screenshotMeta).toBeDefined();
  });

  it("never mutates the issues handed to it, so the baseline writes stay clean", async () => {
    const page = makeStubPage(() => makeMeasurement([visibleEntry()]));
    const issues = [makeIssue()];

    const result = await annotateIssues(page, issues, pngBytes(1280, 2000));

    expect(result.issues[0].annotation?.state).toBe("resolved");
    expect(issues[0].annotation).toBeUndefined();
    expect(JSON.stringify(issues)).not.toContain("annotation");
  });
});
