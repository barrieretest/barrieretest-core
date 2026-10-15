/**
 * Runner behaviour against a stub page: apply/revert pairing on success and
 * on a thrown condition, the union of the collection needs per condition, and
 * the skip path when a capability is missing.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { BrowserPage } from "../browser.js";
import { CLEANUP_TIMEOUT_MS, runRenderingChecks } from "./runner.js";
import type { RenderingCollect, RenderingMeasurement } from "./types.js";

/** A JPEG whose start-of-frame segment is all the size reader looks at. */
function jpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
  ]);
}

interface StubOptions {
  /** Capabilities the page does not have. */
  without?: ("setViewport" | "emulateMediaFeatures" | "emulateVisionDeficiency")[];
  /** Emulations that throw when applied. */
  failOn?: ("protanopia" | "viewport")[];
  /** Make the capture fail. */
  failScreenshot?: boolean;
  /** Delay an applied viewport change, so the condition loses its race mid-apply. */
  viewportDelayMs?: number;
  /**
   * Hold an applied viewport change until this resolves, so a test decides
   * when the abandoned work lands instead of betting on a margin.
   */
  viewportGate?: Promise<unknown>;
  /** Never resolve the capture, so the condition cannot be confirmed stopped. */
  hangScreenshot?: boolean;
  /** Reject this many attempts to restore the original viewport. */
  failRestore?: number;
  /** Never answer a restore attempt, so restoration cannot be established. */
  hangRestore?: boolean;
  /** Never answer the settle steps after this many, the last one included. */
  hangSettleAfter?: number;
  /** Reject the settle steps after this many, the last one included. */
  rejectSettleAfter?: number;
  /** Report the element cap in every measurement. */
  truncated?: boolean;
  /** Report the forced-colours cap in every measurement. */
  paintedTruncated?: boolean;
  /** Report the motion cap in every measurement. */
  motionTruncated?: boolean;
  /** Report the ancestor-box cap in every measurement. */
  ancestorsTruncated?: boolean;
  /** Answer the settle steps after this many only after this delay, in ms. */
  slowSettleAfter?: { after: number; delayMs: number };
  /** Pretend axe is not on the page, so the run has to inject it. */
  axeMissing?: boolean;
  /** Delay the axe-presence probe, so the condition loses its race during it. */
  axeProbeDelayMs?: number;
  /** Never answer the axe run, so the condition cannot be confirmed stopped. */
  hangAxe?: boolean;
  /** Reject the axe run, the way a page that navigated under it does. */
  failAxe?: boolean;
  /** Report the axe node cap in every axe run. */
  axeTruncated?: boolean;
  /** Nodes every rule of the axe run reports, so a check can hit its own cap. */
  axeNodes?: number;
}

interface Stub {
  page: BrowserPage;
  /** Every emulation and in-page step, in order. */
  log: string[];
  /** The collect descriptor of each measurement, by call order. */
  collects: RenderingCollect[];
  viewport: { width: number; height: number };
}

function createStub(options: StubOptions = {}): Stub {
  const log: string[] = [];
  const collects: RenderingCollect[] = [];
  const state = { viewport: { width: 1280, height: 720 } };
  const without = new Set(options.without ?? []);
  const failOn = new Set(options.failOn ?? []);
  let restoreFailures = options.failRestore ?? 0;

  const measurementFor = (): RenderingMeasurement => ({
    elements: [],
    truncated: options.truncated === true,
    devicePixelRatio: 1,
    viewport: { ...state.viewport },
    document: { width: state.viewport.width, height: 2000 },
    client: { ...state.viewport },
    scroll: { x: 0, y: 0 },
    ...(options.paintedTruncated ? { painted: [], paintedTruncated: true } : {}),
    ...(options.ancestorsTruncated ? { ancestors: [], ancestorsTruncated: true } : {}),
    ...(options.motionTruncated
      ? { motion: { animations: [], elements: [], truncated: true } }
      : {}),
  });

  // The in-page steps are told apart by the argument they carry:
  // `{ networkCapMs }` is the settle step, the text-spacing key the override
  // removal, `{ key, css }` its injection, `{ rules }` the condition's axe
  // run, and the measurement's own argument bag the measurement. The
  // axe-presence probe takes no argument at all; any other string is the
  // axe-core source, which only a page without axe on it is sent.
  let settles = 0;
  const evaluate = (async (_fn: unknown, arg?: unknown) => {
    if (arg && typeof arg === "object" && "networkCapMs" in (arg as Record<string, unknown>)) {
      settles++;
      if (options.hangSettleAfter !== undefined && settles > options.hangSettleAfter) {
        log.push("settle:pending");
        await new Promise(() => {});
      }
      if (options.rejectSettleAfter !== undefined && settles > options.rejectSettleAfter) {
        log.push("settle:rejected");
        throw new Error("Execution context was destroyed");
      }
      if (options.slowSettleAfter && settles > options.slowSettleAfter.after) {
        await new Promise((resolve) => setTimeout(resolve, options.slowSettleAfter?.delayMs));
      }
      log.push("settle");
      return undefined;
    }
    if (typeof arg === "string") {
      log.push(arg.startsWith("__barrieretest") ? "text-spacing:off" : "axe:inject");
      return undefined;
    }
    if (arg && typeof arg === "object" && "css" in (arg as Record<string, unknown>)) {
      log.push("text-spacing:on");
      return undefined;
    }
    if (arg && typeof arg === "object" && "collect" in (arg as Record<string, unknown>)) {
      const { collect } = arg as { collect: RenderingCollect };
      collects.push(collect);
      log.push("measure");
      return measurementFor();
    }
    if (arg && typeof arg === "object" && "rules" in (arg as Record<string, unknown>)) {
      const { rules } = arg as { rules: string[] };
      if (options.hangAxe) {
        // Logged before it hangs, so a test can tell a run that started from
        // one that never did.
        log.push("axe:pending");
        await new Promise(() => {});
      }
      if (options.failAxe) {
        log.push("axe:rejected");
        throw new Error("Execution context was destroyed");
      }
      log.push(`axe:${rules.join(",")}`);
      return rules.map((rule) => ({
        id: rule,
        outcome: "violation",
        description: "Stub rule",
        help: "Stub help",
        helpUrl: "https://example.test/",
        impact: "serious",
        nodes: Array.from({ length: options.axeNodes ?? 0 }, (_, node) => ({
          target: [`#n${node}`],
          html: `<a id="n${node}">`,
          impact: "serious",
          failureSummary: "Element has insufficient color contrast of 1.03",
        })),
        ...(options.axeTruncated ? { truncated: true } : {}),
      }));
    }
    if (arg === undefined) {
      log.push("axe:probe");
      if (options.axeProbeDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.axeProbeDelayMs));
      }
      return options.axeMissing !== true;
    }
    return undefined;
  }) as BrowserPage["evaluate"];

  const page = {
    evaluate,
    goto: async () => undefined,
    url: () => "https://example.test/",
    title: async () => "Stub",
    screenshot: async () => {
      if (options.failScreenshot) throw new Error("capture failed");
      // A page that never answers: the runner cannot establish that the
      // abandoned condition has stopped touching it.
      if (options.hangScreenshot) await new Promise(() => {});
      log.push("screenshot");
      return jpeg(state.viewport.width, 1800);
    },
    // What makes `isPuppeteerPage` accept it.
    browser: () => ({ newPage: async () => page }),
    viewport: () => ({ ...state.viewport }),
    ...(without.has("setViewport")
      ? {}
      : {
          setViewport: async (size: { width: number; height: number }) => {
            if (failOn.has("viewport") && size.width === 320) {
              throw new Error("viewport refused");
            }
            // The original viewport, so this is a restore attempt.
            const restore = size.width === 1280 && size.height === 720;
            if (restore && restoreFailures > 0) {
              restoreFailures--;
              log.push("viewport:restore-refused");
              throw new Error("viewport restore refused");
            }
            if (restore && options.hangRestore) {
              // Logged before it hangs, so a test can count the attempts a
              // restoration that never answers was given.
              log.push("viewport:restore-pending");
              await new Promise(() => {});
            }
            // Only an applied condition is slow; a restore answers at once,
            // so a test can tell the two apart by when they land.
            if (options.viewportDelayMs && !restore) {
              await new Promise((resolve) => setTimeout(resolve, options.viewportDelayMs));
            }
            if (options.viewportGate && !restore) await options.viewportGate;
            // In place, so `stub.viewport` is the page's current viewport
            // and not the one it started with.
            Object.assign(state.viewport, size);
            log.push(`viewport:${size.width}x${size.height}`);
          },
        }),
    ...(without.has("emulateMediaFeatures")
      ? {}
      : {
          emulateMediaFeatures: async (features: { name: string; value: string }[]) => {
            log.push(
              features.length === 0
                ? "media:none"
                : `media:${features.map((f) => `${f.name}=${f.value}`).join(",")}`
            );
          },
        }),
    ...(without.has("emulateVisionDeficiency")
      ? {}
      : {
          emulateVisionDeficiency: async (type: string) => {
            if (failOn.has("protanopia") && type === "protanopia") {
              throw new Error("deficiency refused");
            }
            log.push(`cvd:${type}`);
          },
        }),
  } as unknown as BrowserPage & { viewport: () => { width: number; height: number } };

  return { page, log, collects, viewport: state.viewport };
}

interface PlaywrightStubOptions {
  /**
   * Whether the context has a viewport override to restore. Without one
   * `viewportSize()` is null, which is Playwright's `viewport: null`.
   */
  viewportOverride?: boolean;
  /**
   * Refuse the CDP session, which is what every non-Chromium Playwright
   * browser does: the method exists on the context, and attaching fails.
   */
  cdpFails?: boolean;
}

/** A page with Playwright's surface, in one of those two states. */
function playwrightStub(options: PlaywrightStubOptions = {}): Stub {
  const log: string[] = [];
  const collects: RenderingCollect[] = [];
  const viewport = { width: 1280, height: 720 };

  const evaluate = (async (_fn: unknown, arg?: unknown) => {
    if (arg && typeof arg === "object" && "networkCapMs" in (arg as Record<string, unknown>)) {
      log.push("settle");
      return undefined;
    }
    if (typeof arg === "string") {
      log.push("text-spacing:off");
      return undefined;
    }
    if (arg && typeof arg === "object" && "css" in (arg as Record<string, unknown>)) {
      log.push("text-spacing:on");
      return undefined;
    }
    if (arg && typeof arg === "object" && "collect" in (arg as Record<string, unknown>)) {
      collects.push((arg as { collect: RenderingCollect }).collect);
      log.push("measure");
      return {
        elements: [],
        truncated: false,
        devicePixelRatio: 1,
        viewport: { ...viewport },
        document: { width: viewport.width, height: 2000 },
        client: { ...viewport },
        scroll: { x: 0, y: 0 },
      } satisfies RenderingMeasurement;
    }
    if (arg && typeof arg === "object" && "rules" in (arg as Record<string, unknown>)) {
      log.push(`axe:${(arg as { rules: string[] }).rules.join(",")}`);
      return [];
    }
    if (arg === undefined) return true;
    return { width: viewport.width, height: viewport.height };
  }) as BrowserPage["evaluate"];

  const page = {
    // What makes `isPlaywrightPage` accept it.
    _guid: "page@1",
    evaluate,
    goto: async () => undefined,
    url: () => "https://example.test/",
    title: async () => "Stub",
    screenshot: async () => {
      log.push("screenshot");
      return jpeg(viewport.width, 1800);
    },
    context: () => ({
      newCDPSession: async () => {
        if (options.cdpFails) {
          log.push("cdp:refused");
          throw new Error("CDP sessions are only available in Chromium");
        }
        return {
          send: async () => undefined,
          detach: async () => undefined,
        };
      },
    }),
    viewportSize: () => (options.viewportOverride ? { ...viewport } : null),
    setViewportSize: async (size: { width: number; height: number }) => {
      // In place, so the measurement and `stub.viewport` report the page's
      // current viewport and not the one it started with.
      Object.assign(viewport, size);
      log.push(`setViewportSize ${size.width}x${size.height}`);
    },
    emulateMedia: async (options: Record<string, string | null>) => {
      log.push(`media ${JSON.stringify(options)}`);
    },
  } as unknown as BrowserPage;

  return { page, log, collects, viewport };
}

/** Wait for work the pass owns but no longer awaits. */
async function settled(done: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`${what} never happened`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

let warnings: string[];
let restoreWarn: () => void;

beforeEach(() => {
  warnings = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  restoreWarn = () => {
    console.warn = original;
  };
});

afterEach(() => {
  restoreWarn();
});

describe("runRenderingChecks", () => {
  it("applies, measures, captures and reverts every condition in order", async () => {
    const stub = createStub();

    const result = await runRenderingChecks(stub.page, {
      conditions: ["viewport:320", "media:dark", "cvd:protanopia", "text-spacing"],
    });

    expect(result.meta.conditionsRun).toEqual([
      "viewport:320",
      "media:dark",
      "cvd:protanopia",
      "text-spacing",
    ]);
    expect(result.meta.conditionsSkipped).toEqual([]);
    expect(stub.log).toEqual([
      "viewport:320x720",
      "settle",
      "measure",
      "screenshot",
      "viewport:1280x720",
      "media:prefers-color-scheme=dark",
      "settle",
      "measure",
      // The mode-specific contrast check needs axe's verdict under the
      // mode; it is part of the same step and runs before the capture. The
      // probe is what spares a page that already has axe the injection.
      "axe:probe",
      "axe:color-contrast,link-in-text-block",
      "screenshot",
      "media:none",
      "cvd:protanopia",
      "settle",
      "measure",
      "screenshot",
      "cvd:none",
      "text-spacing:on",
      "settle",
      "measure",
      "screenshot",
      "text-spacing:off",
      // The pass ends by putting the page back at the top.
      "settle",
    ]);
  });

  it("returns one capture per condition, each with its own geometry", async () => {
    const stub = createStub();

    const result = await runRenderingChecks(stub.page, {
      conditions: ["viewport:320", "viewport:768"],
    });

    expect(result.captures.map((capture) => capture.condition)).toEqual([
      "viewport:320",
      "viewport:768",
    ]);
    expect(result.captures.map((capture) => capture.meta.viewport.width)).toEqual([320, 768]);
    expect(result.captures[0].meta.width).toBe(320);
    expect(result.captures[0].screenshot.length).toBeGreaterThan(0);
  });

  it("keeps no captures when captures is false", async () => {
    const stub = createStub();
    const result = await runRenderingChecks(stub.page, {
      conditions: ["viewport:320"],
      captures: false,
    });

    expect(result.captures).toEqual([]);
    expect(result.meta.conditionsRun).toEqual(["viewport:320"]);
  });

  it("collects only what the checks of that condition need", async () => {
    const stub = createStub();

    await runRenderingChecks(stub.page, {
      conditions: ["viewport:320", "media:dark", "text-spacing"],
    });

    expect(stub.collects).toEqual([
      // reflow, clipped text and overlap
      { elements: true, clipping: true, stacking: true },
      // contrast under the mode: no element walk, two axe rules
      { elements: false, axeRules: ["color-contrast", "link-in-text-block"] },
      // clipped text and overlap
      { elements: true, clipping: true, stacking: true },
    ]);
  });

  it("collects only what the requested checks need", async () => {
    const stub = createStub();

    await runRenderingChecks(stub.page, {
      conditions: ["viewport:320"],
      checks: ["reflow-horizontal-scroll"],
    });

    expect(stub.collects).toEqual([{ elements: true }]);
  });

  it("skips a condition whose emulation the page cannot do, and warns", async () => {
    const stub = createStub({ without: ["emulateVisionDeficiency"] });

    const result = await runRenderingChecks(stub.page, {
      conditions: ["cvd:protanopia", "viewport:320"],
    });

    expect(result.meta.conditionsRun).toEqual(["viewport:320"]);
    expect(result.meta.conditionsSkipped).toEqual([
      {
        condition: "cvd:protanopia",
        reason: "the browser page cannot emulate visionDeficiency",
      },
    ]);
    expect(warnings[0]).toStartWith("Rendering condition cvd:protanopia skipped:");
    expect(stub.log).not.toContain("cvd:protanopia");
  });

  it("reverts a condition that threw and carries on with the next", async () => {
    const stub = createStub({ failOn: ["protanopia"] });

    const result = await runRenderingChecks(stub.page, {
      conditions: ["cvd:protanopia", "cvd:deuteranopia"],
    });

    expect(result.meta.conditionsRun).toEqual(["cvd:deuteranopia"]);
    expect(result.meta.conditionsSkipped).toEqual([
      { condition: "cvd:protanopia", reason: "deficiency refused" },
    ]);
    expect(warnings[0]).toStartWith("Rendering condition cvd:protanopia skipped:");
    // The revert of the failed condition ran before the next one started.
    expect(stub.log).toEqual([
      "cvd:none",
      "cvd:deuteranopia",
      "settle",
      "measure",
      "screenshot",
      "cvd:none",
      "settle",
    ]);
  });

  it("restores the original viewport after a condition that could not apply it", async () => {
    const stub = createStub({ failOn: ["viewport"] });

    const result = await runRenderingChecks(stub.page, { conditions: ["viewport:320"] });

    expect(result.meta.conditionsRun).toEqual([]);
    expect(stub.log).toEqual(["viewport:1280x720", "settle"]);
  });

  it("skips a condition whose capture cannot be read", async () => {
    const stub = createStub({ failScreenshot: true });

    const result = await runRenderingChecks(stub.page, { conditions: ["viewport:320"] });

    expect(result.meta.conditionsRun).toEqual([]);
    expect(result.meta.conditionsSkipped).toEqual([
      { condition: "viewport:320", reason: "capture failed" },
    ]);
  });

  it("gives up on a condition that exceeds its budget and still reverts", async () => {
    const stub = createStub();
    const slow = {
      ...stub.page,
      screenshot: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return jpeg(320, 1000);
      },
    } as BrowserPage;

    const result = await runRenderingChecks(slow, {
      conditions: ["viewport:320"],
      conditionTimeout: 10,
    });

    expect(result.meta.conditionsRun).toEqual([]);
    expect(result.meta.conditionsSkipped[0].reason).toBe("the condition timed out after 10ms");
    expect(stub.log).toContain("viewport:1280x720");
  });

  it("stops an abandoned condition before it can mutate the page again", async () => {
    // The apply is mid-viewport-change when the budget runs out. Without a
    // cancellation token it resumes afterwards and injects the composite's
    // text-spacing override into a page the runner has already reverted and
    // handed on.
    const stub = createStub({ viewportDelayMs: 60 });

    const result = await runRenderingChecks(stub.page, {
      conditions: ["viewport:320+text-spacing"],
      conditionTimeout: 10,
    });

    expect(result.meta.conditionsRun).toEqual([]);
    expect(result.meta.conditionsSkipped[0].reason).toBe("the condition timed out after 10ms");
    // The abandoned work is confirmed stopped before the revert, so the pass
    // carries on normally.
    expect(result.meta.restorationFailed).toBeUndefined();
    expect(stub.log).not.toContain("text-spacing:on");

    const afterReturn = [...stub.log];
    // Long after the delayed viewport change resolved: nothing of the
    // abandoned condition reached the page.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(stub.log).toEqual(afterReturn);
    expect(stub.log).not.toContain("text-spacing:on");
    expect(stub.viewport).toEqual({ width: 1280, height: 720 });
  });

  it("stops the pass when an abandoned condition cannot be confirmed to have stopped", async () => {
    // The capture never answers, so the condition may still be mid-step: the
    // runner must not measure another condition on that page.
    const stub = createStub({ hangScreenshot: true });

    const result = await runRenderingChecks(stub.page, {
      conditions: ["viewport:320", "viewport:768"],
      conditionTimeout: 10,
    });

    expect(result.meta.conditionsRun).toEqual([]);
    expect(result.meta.restorationFailed).toEqual(["viewport:320"]);
    expect(result.meta.pageUnsafe).toBe(true);
    expect(result.meta.conditionsSkipped).toEqual([
      { condition: "viewport:320", reason: "the condition timed out after 10ms" },
      {
        condition: "viewport:768",
        reason:
          "the pass stopped after it could not establish the page's state following viewport:320",
      },
    ]);
    expect(
      warnings.some((warning) => warning.includes("could not be confirmed to have stopped"))
    ).toBe(true);
    // The second condition never ran; viewport:768 is 768x1024, so nothing
    // of it may show up in the log at all.
    expect(stub.log.some((entry) => entry.startsWith("viewport:768x"))).toBe(false);
    // No restore while the abandoned work may still hold the page: the one
    // after it settles is the pass's last word on the page's state.
    expect(stub.log).not.toContain("viewport:1280x720");
  }, 10_000);

  it("keeps ownership of work that outlives the grace and restores the page when it settles", async () => {
    // The apply is still mid-viewport-change when the grace period ends:
    // the runner cannot wait any longer, but the work is still its own. The
    // gate is only opened after the pass returned, so the ordering is the
    // test's and not a margin's.
    let openGate = (): void => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const stub = createStub({ viewportGate: gate });

    const result = await runRenderingChecks(stub.page, {
      conditions: ["viewport:320"],
      conditionTimeout: 10,
    });

    expect(result.meta.conditionsRun).toEqual([]);
    expect(result.meta.restorationFailed).toEqual(["viewport:320"]);
    expect(result.meta.pageUnsafe).toBe(true);
    // Nothing of the abandoned apply reached the page while the pass ran.
    expect(stub.log).not.toContain("viewport:320x720");
    openGate();
    // Nothing claims the page is back while that work is outstanding.
    expect(warnings).not.toContain("Rendering pass restored the page after it stopped early.");
    expect(warnings.some((warning) => warning.includes("cannot establish the page's state"))).toBe(
      true
    );

    await settled(
      () => warnings.some((warning) => warning.includes("after the abandoned work settled")),
      "the late restore"
    );

    // The abandoned apply did reach the page, and the pass undid it.
    expect(stub.log).toContain("viewport:320x720");
    expect(stub.log.lastIndexOf("viewport:1280x720")).toBeGreaterThan(
      stub.log.lastIndexOf("viewport:320x720")
    );
    expect(stub.viewport).toEqual({ width: 1280, height: 720 });
    expect(warnings).toContain(
      "Rendering pass restored the page after the abandoned work settled."
    );
  }, 15_000);

  it("skips the viewport conditions of a Playwright page that reports no viewport", async () => {
    // `viewportSize()` is null for a context without a viewport override.
    // Installing one and "restoring" it would hand the caller a page that
    // never had a fixed viewport, so those conditions do not run.
    const stub = playwrightStub();

    const result = await runRenderingChecks(stub.page, {
      conditions: ["viewport:320", "viewport:320+text-spacing", "media:dark", "text-spacing"],
    });

    expect(result.meta.conditionsRun).toEqual(["media:dark", "text-spacing"]);
    expect(result.meta.conditionsSkipped).toEqual([
      { condition: "viewport:320", reason: "the browser page cannot emulate viewport" },
      {
        condition: "viewport:320+text-spacing",
        reason: "the browser page cannot emulate viewport",
      },
    ]);
    expect(stub.log).not.toContain("setViewportSize 320x720");
    expect(stub.log).toContain(
      'media {"colorScheme":"dark","forcedColors":null,"contrast":null,"reducedMotion":null}'
    );
    expect(stub.log).toContain("text-spacing:on");
  });

  // Criterion 10 on the runner: the CDP session of a non-Chromium Playwright
  // browser fails at the first vision-deficiency condition, not at detection.
  it("skips the CVD conditions of a Playwright page whose CDP session is refused", async () => {
    const stub = playwrightStub({ viewportOverride: true, cdpFails: true });

    const result = await runRenderingChecks(stub.page, {
      conditions: [
        "viewport:320",
        "media:dark",
        "cvd:protanopia",
        "cvd:deuteranopia",
        "text-spacing",
      ],
    });

    // Everything the page can do still runs, in run order.
    expect(result.meta.conditionsRun).toEqual(["viewport:320", "media:dark", "text-spacing"]);
    expect(result.meta.conditionsSkipped.map((skipped) => skipped.condition)).toEqual([
      "cvd:protanopia",
      "cvd:deuteranopia",
    ]);
    // The first one learns it by attaching; the second is skipped before it
    // is applied at all.
    expect(result.meta.conditionsSkipped[0].reason).toContain(
      "no CDP session for vision-deficiency emulation"
    );
    expect(result.meta.conditionsSkipped[1].reason).toBe(
      "the browser page cannot emulate visionDeficiency"
    );
    expect(stub.log.filter((entry) => entry === "cdp:refused")).toHaveLength(1);

    // And the page is handed back in its original state.
    expect(result.meta.restorationFailed).toBeUndefined();
    expect(result.meta.pageUnsafe).toBeUndefined();
    expect(stub.log.filter((entry) => entry.startsWith("setViewportSize"))).toEqual([
      "setViewportSize 320x720",
      "setViewportSize 1280x720",
    ]);
    expect(stub.log.lastIndexOf("text-spacing:off")).toBeGreaterThan(
      stub.log.lastIndexOf("text-spacing:on")
    );
    const cleared =
      'media {"colorScheme":null,"forcedColors":null,"contrast":null,"reducedMotion":null}';
    expect(stub.log.lastIndexOf(cleared)).toBeGreaterThan(
      stub.log.lastIndexOf(
        'media {"colorScheme":"dark","forcedColors":null,"contrast":null,"reducedMotion":null}'
      )
    );
    expect(stub.viewport).toEqual({ width: 1280, height: 720 });
  });

  it("retries a failed revert and carries on when the second attempt works", async () => {
    const stub = createStub({ failRestore: 1 });

    const result = await runRenderingChecks(stub.page, {
      conditions: ["viewport:320", "viewport:768"],
    });

    expect(result.meta.conditionsRun).toEqual(["viewport:320", "viewport:768"]);
    expect(result.meta.restorationFailed).toBeUndefined();
    expect(warnings.some((warning) => warning.includes("needed a second attempt to revert"))).toBe(
      true
    );
    // The second attempt is what put the page back, so the next condition
    // started from the original viewport and not from 320 px.
    expect(stub.log.slice(0, 7)).toEqual([
      "viewport:320x720",
      "settle",
      "measure",
      "screenshot",
      "viewport:restore-refused",
      "viewport:1280x720",
      "viewport:768x1024",
    ]);
  });

  it("runs no further condition when a revert cannot be established", async () => {
    // Every restore attempt is refused: the next condition would be measured
    // at 320 px and reported as an independent result.
    const stub = createStub({ failRestore: 10 });

    const result = await runRenderingChecks(stub.page, {
      conditions: ["viewport:320", "viewport:768", "media:dark"],
    });

    // The condition's own run was measured under the state it reports, so it
    // is kept; everything after it is not run at all.
    expect(result.meta.conditionsRun).toEqual(["viewport:320"]);
    expect(result.meta.restorationFailed).toEqual(["viewport:320"]);
    expect(result.captures.map((capture) => capture.condition)).toEqual(["viewport:320"]);
    // The last restoration failed too, so the page is not the state the pass
    // promised and nothing may measure it as if it were.
    expect(result.meta.pageUnsafe).toBe(true);
    // Everything that was asked for and did not run is accounted for.
    expect(result.meta.conditionsSkipped).toEqual([
      {
        condition: "viewport:768",
        reason:
          "the pass stopped after it could not establish the page's state following viewport:320",
      },
      {
        condition: "media:dark",
        reason:
          "the pass stopped after it could not establish the page's state following viewport:320",
      },
    ]);
    expect(stub.log.some((entry) => entry.startsWith("viewport:768x"))).toBe(false);
    expect(stub.log).not.toContain("media:prefers-color-scheme=dark");
    expect(warnings.some((warning) => warning.includes("no further condition is run"))).toBe(true);
    // One full restore is still attempted at the end.
    expect(stub.log.filter((entry) => entry === "viewport:restore-refused").length).toBeGreaterThan(
      2
    );
  });

  it("counts a restoration that never answers as failed and does not race it", async () => {
    // The restore attempt is still outstanding when its bound runs out. A
    // second call to the same emulation would race work that still holds the
    // page, so the condition is the pass's last, and the page is unsafe.
    const stub = createStub({ hangRestore: true });
    const started = Date.now();

    const result = await runRenderingChecks(stub.page, {
      conditions: ["viewport:320", "viewport:768"],
    });

    // Bounded from Node: the pass returns although the page never answered.
    expect(Date.now() - started).toBeLessThan(10 * CLEANUP_TIMEOUT_MS);
    expect(result.meta.conditionsRun).toEqual(["viewport:320"]);
    expect(result.meta.restorationFailed).toEqual(["viewport:320"]);
    expect(result.meta.pageUnsafe).toBe(true);
    expect(result.meta.conditionsSkipped).toEqual([
      {
        condition: "viewport:768",
        reason:
          "the pass stopped after it could not establish the page's state following viewport:320",
      },
    ]);
    // One attempt, and no further condition.
    expect(stub.log.filter((entry) => entry === "viewport:restore-pending")).toHaveLength(1);
    expect(stub.log.some((entry) => entry.startsWith("viewport:768x"))).toBe(false);
    expect(warnings.some((warning) => warning.includes("that work is still outstanding"))).toBe(
      true
    );
  }, 20_000);

  it("marks the page unsafe when the final scroll to the top never answers", async () => {
    // Every condition ran and reverted, but the last settle is still
    // outstanding: it can scroll the page under a measurement taken after
    // the pass returned.
    const stub = createStub({ hangSettleAfter: 1 });
    const started = Date.now();

    const result = await runRenderingChecks(stub.page, { conditions: ["viewport:320"] });

    expect(Date.now() - started).toBeLessThan(10 * CLEANUP_TIMEOUT_MS);
    expect(result.meta.conditionsRun).toEqual(["viewport:320"]);
    expect(result.meta.restorationFailed).toBeUndefined();
    expect(result.meta.pageUnsafe).toBe(true);
    expect(
      warnings.some((warning) =>
        warning.includes("could not settle the page after the last condition")
      )
    ).toBe(true);
    // The emulations were reverted before it: only the scroll is in doubt.
    expect(stub.log).toContain("viewport:1280x720");
  }, 20_000);

  it("marks the page unsafe when the final scroll to the top fails", async () => {
    // A settle that rejected cannot move the page later, but the page is
    // left wherever the last condition put it, so later passes must not
    // measure it either.
    const stub = createStub({ rejectSettleAfter: 1 });

    const result = await runRenderingChecks(stub.page, { conditions: ["viewport:320"] });

    expect(result.meta.conditionsRun).toEqual(["viewport:320"]);
    expect(result.meta.pageUnsafe).toBe(true);
    expect(stub.log).toContain("settle:rejected");
    expect(
      warnings.some((warning) =>
        warning.includes("could not settle the page after the last condition")
      )
    ).toBe(true);
  });

  it("keeps the page when an axe run is still outstanding past the budget", async () => {
    // The axe run owns no clock of its own: the browser operation is still
    // in flight when the condition's budget runs out, so the condition may
    // still be mid-step and nothing after it may be measured on that page.
    const stub = createStub({ hangAxe: true });

    // Media conditions run before the CVD ones, so the hanging one is first.
    const result = await runRenderingChecks(stub.page, {
      conditions: ["media:dark", "cvd:protanopia"],
      conditionTimeout: 20,
      // Shorter than the grace period: a bound of its own inside the axe
      // step would settle the chain here and let the pass believe the
      // abandoned work had stopped while the browser was still running it.
      timeout: 50,
    });

    expect(result.meta.conditionsRun).toEqual([]);
    expect(result.meta.conditionsSkipped).toEqual([
      { condition: "media:dark", reason: "the condition timed out after 20ms" },
      {
        condition: "cvd:protanopia",
        reason:
          "the pass stopped after it could not establish the page's state following media:dark",
      },
    ]);
    expect(result.meta.restorationFailed).toEqual(["media:dark"]);
    expect(result.meta.pageUnsafe).toBe(true);
    expect(stub.log).toContain("axe:pending");
    // No next condition, and no restore racing the run that still holds the
    // page.
    expect(stub.log).not.toContain("cvd:protanopia");
    expect(stub.log).not.toContain("media:none");
  }, 10_000);

  it("injects and runs nothing when the condition is abandoned during the axe probe", async () => {
    // The page has no axe on it, and the budget runs out while the probe is
    // in flight: the injection and the run are mutations of a page the
    // runner has already given up on.
    const stub = createStub({ axeMissing: true, axeProbeDelayMs: 80 });

    const result = await runRenderingChecks(stub.page, {
      conditions: ["media:dark"],
      conditionTimeout: 10,
    });

    expect(result.meta.conditionsRun).toEqual([]);
    expect(result.meta.conditionsSkipped[0].reason).toBe("the condition timed out after 10ms");
    expect(stub.log).toContain("axe:probe");
    expect(stub.log).not.toContain("axe:inject");
    expect(stub.log.some((entry) => entry.startsWith("axe:color-contrast"))).toBe(false);
    // The probe answered, so the chain stopped at its next step and the page
    // is the pass's own again.
    expect(result.meta.restorationFailed).toBeUndefined();
    expect(result.meta.pageUnsafe).toBeUndefined();
    expect(stub.log).toContain("media:none");

    const afterReturn = [...stub.log];
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(stub.log).toEqual(afterReturn);
  }, 10_000);

  it("skips a condition whose axe run is rejected and reverts the page", async () => {
    const stub = createStub({ failAxe: true });

    const result = await runRenderingChecks(stub.page, {
      conditions: ["media:dark", "cvd:protanopia"],
    });

    expect(result.meta.conditionsRun).toEqual(["cvd:protanopia"]);
    expect(result.meta.conditionsSkipped).toEqual([
      { condition: "media:dark", reason: "Execution context was destroyed" },
    ]);
    expect(result.meta.checksRun).not.toContain("contrast-under-mode");
    // The condition was reverted before the next one started, and the pass
    // carried on.
    expect(stub.log).toEqual([
      "media:prefers-color-scheme=dark",
      "settle",
      "measure",
      "axe:probe",
      "axe:rejected",
      "media:none",
      "cvd:protanopia",
      "settle",
      "measure",
      "screenshot",
      "cvd:none",
      "settle",
    ]);
    expect(result.meta.pageUnsafe).toBeUndefined();
  });

  it("reports a condition whose axe run hit its node cap", async () => {
    const stub = createStub({ axeTruncated: true });

    const result = await runRenderingChecks(stub.page, { conditions: ["media:dark"] });

    expect(result.meta.conditionsRun).toEqual(["media:dark"]);
    expect(result.meta.truncatedConditions).toEqual(["media:dark"]);
    expect(warnings.some((warning) => warning.includes("hit a collection cap"))).toBe(true);
  });

  it("reports a condition whose check could not report everything the run carried", async () => {
    // Twenty-six nodes the mode introduced and a check that reports 25: the
    // axe run carried them all, so only the check can say the result is
    // partial.
    const stub = createStub({ axeNodes: 26 });

    const result = await runRenderingChecks(stub.page, { conditions: ["media:dark"] });

    expect(
      result.issues.filter((issue) => issue.rendering?.checkId === "contrast-under-mode")
    ).toHaveLength(25);
    expect(result.meta.truncatedConditions).toEqual(["media:dark"]);
    expect(warnings.some((warning) => warning.includes("hit a collection cap"))).toBe(true);
  });

  it("reports a condition whose collected group hit its cap", async () => {
    // The painted group and the motion group are capped in the browser, and
    // the measurement says which one stopped early.
    const painted = createStub({ paintedTruncated: true });
    expect(
      (await runRenderingChecks(painted.page, { conditions: ["media:forced-colors"] })).meta
        .truncatedConditions
    ).toEqual(["media:forced-colors"]);

    const motion = createStub({ motionTruncated: true });
    expect(
      (await runRenderingChecks(motion.page, { conditions: ["media:reduced-motion"] })).meta
        .truncatedConditions
    ).toEqual(["media:reduced-motion"]);
    expect(warnings.some((warning) => warning.includes("hit a collection cap"))).toBe(true);
  });

  it("reports an ancestor-box collection that hit its cap", async () => {
    const stub = createStub({ ancestorsTruncated: true });

    const result = await runRenderingChecks(stub.page, { conditions: ["viewport:1280"] });

    expect(result.meta.truncatedConditions).toEqual(["viewport:1280"]);
  });

  it("gives the final settle room for its own waits", async () => {
    // settleCondition waits up to its network and transition caps in a row;
    // a page that uses both is slow, not unsafe.
    const stub = createStub({
      slowSettleAfter: { after: 1, delayMs: CLEANUP_TIMEOUT_MS + 500 },
    });

    const result = await runRenderingChecks(stub.page, { conditions: ["viewport:320"] });

    expect(result.meta.conditionsRun).toEqual(["viewport:320"]);
    expect(result.meta.pageUnsafe).toBeUndefined();
    expect(stub.log.at(-1)).toBe("settle");
  }, 20_000);

  it("reports a measurement that hit its element cap", async () => {
    const stub = createStub({ truncated: true });

    const result = await runRenderingChecks(stub.page, { conditions: ["viewport:320"] });

    expect(result.meta.truncatedConditions).toEqual(["viewport:320"]);
    expect(warnings.some((warning) => warning.includes("hit a collection cap"))).toBe(true);
  });

  it("runs the cross-condition check only when both of its conditions ran", async () => {
    const stub = createStub();

    const withoutReference = await runRenderingChecks(stub.page, {
      conditions: ["viewport:1280"],
      checks: ["content-hidden-at-viewport"],
    });
    expect(withoutReference.meta.checksRun).toEqual([]);

    const withBoth = await runRenderingChecks(stub.page, {
      conditions: ["viewport:1280", "viewport:360"],
      checks: ["content-hidden-at-viewport"],
    });
    expect(withBoth.meta.checksRun).toEqual(["content-hidden-at-viewport"]);
  });

  it("throws on an unknown condition or check id", async () => {
    const stub = createStub();

    await expect(runRenderingChecks(stub.page, { conditions: ["viewport:999"] })).rejects.toThrow(
      /Unknown rendering condition id/
    );
    await expect(runRenderingChecks(stub.page, { checks: ["nope"] })).rejects.toThrow(
      /Unknown rendering check id/
    );
  });
});
