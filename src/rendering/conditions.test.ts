import { describe, expect, it } from "bun:test";
import {
  DEFAULT_RENDERING_CONDITIONS,
  RENDERING_CONDITION_IDS,
  requiredCapabilities,
  resolveCondition,
  resolveConditions,
} from "./conditions.js";

describe("resolveCondition", () => {
  it("resolves a viewport condition", () => {
    expect(resolveCondition("viewport:320")).toEqual({
      id: "viewport:320",
      parts: ["viewport:320"],
      viewport: { width: 320, height: 720 },
    });
  });

  it("resolves a media condition", () => {
    expect(resolveCondition("media:forced-colors")).toEqual({
      id: "media:forced-colors",
      parts: ["media:forced-colors"],
      media: { forcedColors: "active" },
    });
  });

  it("resolves a vision-deficiency condition in CDP spelling", () => {
    expect(resolveCondition("cvd:reduced-contrast").visionDeficiency).toBe("reducedContrast");
  });

  it("composes parts joined with +", () => {
    expect(resolveCondition("viewport:320+text-spacing")).toEqual({
      id: "viewport:320+text-spacing",
      parts: ["viewport:320", "text-spacing"],
      viewport: { width: 320, height: 720 },
      textSpacing: true,
    });
  });

  it("merges media features of composed parts", () => {
    expect(resolveCondition("media:dark+media:reduced-motion").media).toEqual({
      colorScheme: "dark",
      reducedMotion: "reduce",
    });
  });

  it("rejects a composite whose parts contradict each other", () => {
    // The last part used to win silently, so the run was not the one asked
    // for and the capture carried the wrong condition id.
    expect(() => resolveCondition("viewport:320+viewport:1280")).toThrow(
      /Conflicting rendering condition id: 'viewport:320\+viewport:1280'.*both set the viewport/
    );
    expect(() => resolveCondition("cvd:protanopia+cvd:deuteranopia")).toThrow(
      /both set the vision deficiency/
    );
    expect(() => resolveCondition("media:dark+media:dark+media:more-contrast")).not.toThrow();
  });

  it("drops a repeated part instead of calling it a conflict", () => {
    expect(resolveCondition("viewport:320+viewport:320")).toEqual({
      id: "viewport:320",
      parts: ["viewport:320"],
      viewport: { width: 320, height: 720 },
    });
  });

  it("throws on an unknown id, naming what is known", () => {
    expect(() => resolveCondition("viewport:999")).toThrow(/Unknown rendering condition id/);
    expect(() => resolveCondition("viewport:320+nope")).toThrow(/'nope'/);
  });

  it("knows every condition of the contract table", () => {
    expect([...RENDERING_CONDITION_IDS]).toEqual([
      "viewport:320",
      "viewport:360",
      "viewport:768",
      "viewport:1280",
      "cvd:protanopia",
      "cvd:deuteranopia",
      "cvd:tritanopia",
      "cvd:achromatopsia",
      "cvd:reduced-contrast",
      "cvd:blurred-vision",
      "media:dark",
      "media:forced-colors",
      "media:more-contrast",
      "media:reduced-motion",
      "text-spacing",
    ]);
  });
});

describe("resolveConditions", () => {
  it("defaults to the lean set the contract names", () => {
    // The seven ids of decision 1, written out: comparing the resolver with
    // the constant it reads would let dark mode, a CVD or text spacing fall
    // out of the default set without a test noticing.
    expect(resolveConditions().map((condition) => condition.id)).toEqual([
      "viewport:1280",
      "viewport:320",
      "viewport:360",
      "media:dark",
      "cvd:protanopia",
      "cvd:deuteranopia",
      "text-spacing",
    ]);
    // The exported constant is that set, in its documented order.
    expect([...DEFAULT_RENDERING_CONDITIONS]).toEqual([
      "viewport:1280",
      "viewport:320",
      "viewport:360",
      "media:dark",
      "cvd:protanopia",
      "cvd:deuteranopia",
      "text-spacing",
    ]);
  });

  it("includes both viewports content-hidden-at-viewport compares, so it runs by default", () => {
    const ids = resolveConditions().map((condition) => condition.id);

    expect(ids).toContain("viewport:1280");
    expect(ids).toContain("viewport:360");
  });

  it("orders viewports, then media, then CVD, then text-spacing, then composites", () => {
    const ids = resolveConditions([
      "viewport:320+text-spacing",
      "text-spacing",
      "cvd:protanopia",
      "media:dark",
      "viewport:768",
    ]).map((condition) => condition.id);

    expect(ids).toEqual([
      "viewport:768",
      "media:dark",
      "cvd:protanopia",
      "text-spacing",
      "viewport:320+text-spacing",
    ]);
  });

  it("de-duplicates by resolved id and keeps the requested order within a kind", () => {
    expect(
      resolveConditions(["viewport:360", "viewport:320", "viewport:360"]).map(
        (condition) => condition.id
      )
    ).toEqual(["viewport:360", "viewport:320"]);
  });
});

describe("requiredCapabilities", () => {
  it("names only what the condition needs", () => {
    expect(requiredCapabilities(resolveCondition("viewport:320"))).toEqual(["viewport"]);
    expect(requiredCapabilities(resolveCondition("media:dark"))).toEqual(["media"]);
    expect(requiredCapabilities(resolveCondition("cvd:protanopia"))).toEqual(["visionDeficiency"]);
    expect(requiredCapabilities(resolveCondition("text-spacing"))).toEqual([]);
    expect(requiredCapabilities(resolveCondition("viewport:320+text-spacing"))).toEqual([
      "viewport",
    ]);
  });
});
