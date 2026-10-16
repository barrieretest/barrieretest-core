/**
 * The colour maths behind the CVD checks.
 *
 * The simulation's reference values are not invented here: they are the
 * pixels Chromium's own vision-deficiency emulation produced for the same
 * patches, read out of a capture (see the colour-patch test in
 * `src/audit-integration.test.ts`, which measures the agreement in a
 * browser). These assertions keep the pure implementation on those numbers
 * without needing one.
 */

import { describe, expect, it } from "bun:test";
import {
  channelToLinear,
  compositeOver,
  contrastRatio,
  deltaE,
  isSimulatedDeficiency,
  linearToChannel,
  parseColor,
  relativeLuminance,
  type Rgb,
  SIMULATED_DEFICIENCIES,
  simulateDeficiency,
} from "./color.js";

const rgb = (r: number, g: number, b: number): Rgb => ({ r, g, b });

describe("sRGB transfer function", () => {
  it("maps the ends and the linear segment exactly", () => {
    expect(channelToLinear(0)).toBe(0);
    expect(channelToLinear(255)).toBeCloseTo(1, 10);
    // Below the knee the curve is a straight line, not the power function.
    expect(channelToLinear(10)).toBeCloseTo(10 / 255 / 12.92, 10);
    expect(channelToLinear(128)).toBeCloseTo(0.21586, 5);
  });

  it("round-trips every channel value", () => {
    for (let channel = 0; channel <= 255; channel++) {
      expect(linearToChannel(channelToLinear(channel))).toBe(channel);
    }
  });

  it("clamps what the matrix pushed out of range", () => {
    expect(linearToChannel(-0.4)).toBe(0);
    expect(linearToChannel(1.7)).toBe(255);
  });
});

describe("simulateDeficiency", () => {
  /** What Chromium's emulation rendered for these patches, read from a capture. */
  const MEASURED: Record<string, Record<string, [number, number, number]>> = {
    protanopia: {
      "255,0,0": [109, 95, 0],
      "0,255,0": [255, 229, 0],
      "0,0,255": [0, 89, 255],
      "230,120,20": [153, 134, 0],
      "0,140,140": [130, 132, 140],
      "128,128,128": [128, 128, 128],
      "26,85,177": [20, 96, 180],
    },
    deuteranopia: {
      "255,0,0": [163, 144, 0],
      "0,255,0": [239, 214, 58],
      "230,120,20": [179, 159, 17],
      "0,140,140": [113, 120, 141],
      "128,128,128": [128, 128, 128],
      "26,85,177": [0, 82, 175],
    },
    tritanopia: {
      "0,255,0": [0, 247, 217],
      "0,0,255": [0, 107, 150],
      "0,140,140": [0, 145, 140],
      "26,85,177": [0, 108, 123],
    },
    achromatopsia: {
      "255,0,0": [127, 127, 127],
      "0,255,0": [220, 220, 220],
      "0,0,255": [76, 76, 76],
      "26,85,177": [89, 89, 89],
    },
  };

  for (const [deficiency, patches] of Object.entries(MEASURED)) {
    it(`reproduces the browser's ${deficiency} for every reference patch`, () => {
      for (const [input, expected] of Object.entries(patches)) {
        const [r, g, b] = input.split(",").map(Number);
        const simulated = simulateDeficiency(
          rgb(r, g, b),
          deficiency as (typeof SIMULATED_DEFICIENCIES)[number]
        );
        expect([simulated.r, simulated.g, simulated.b]).toEqual(expected);
      }
    });
  }

  it("leaves black and white where they are, and greys grey", () => {
    for (const deficiency of SIMULATED_DEFICIENCIES) {
      expect(simulateDeficiency(rgb(0, 0, 0), deficiency)).toEqual(rgb(0, 0, 0));
      expect(simulateDeficiency(rgb(255, 255, 255), deficiency)).toEqual(rgb(255, 255, 255));
      expect(simulateDeficiency(rgb(128, 128, 128), deficiency)).toEqual(rgb(128, 128, 128));
    }
  });

  it("applies the matrix to linear light, not to the encoded channels", () => {
    // In encoded space the protanopia row would give 0.1523 × 255 = 39 for
    // the red channel; the browser renders 109, which is what linearising
    // first and encoding after produces.
    expect(simulateDeficiency(rgb(255, 0, 0), "protanopia").r).toBe(109);
  });

  it("makes achromatopsia the luminance of the colour", () => {
    const grey = simulateDeficiency(rgb(230, 120, 20), "achromatopsia");
    expect(grey.r).toBe(grey.g);
    expect(grey.g).toBe(grey.b);
  });

  it("knows which deficiencies it can simulate", () => {
    expect(isSimulatedDeficiency("protanopia")).toBe(true);
    expect(isSimulatedDeficiency("achromatopsia")).toBe(true);
    expect(isSimulatedDeficiency("reducedContrast")).toBe(false);
    expect(isSimulatedDeficiency("blurredVision")).toBe(false);
    expect(isSimulatedDeficiency(undefined)).toBe(false);
  });
});

describe("parseColor", () => {
  it("reads the forms the measurement normalises to", () => {
    expect(parseColor("rgb(1, 2, 3)")).toEqual({ r: 1, g: 2, b: 3, a: 1 });
    expect(parseColor("rgba(1, 2, 3, 0.5)")).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
    expect(parseColor("rgb(1 2 3 / 0.25)")).toEqual({ r: 1, g: 2, b: 3, a: 0.25 });
    expect(parseColor("  RGB(255,255,255)  ")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });

  it("clamps and rounds what it was given", () => {
    expect(parseColor("rgba(300, -4, 2.6, 3)")).toEqual({ r: 255, g: 0, b: 3, a: 1 });
  });

  it("returns null for a syntax it must not guess at", () => {
    for (const value of [
      "oklch(0.7 0.15 250)",
      "lab(50 40 -30)",
      "color(srgb 0.2 0.4 0.6)",
      "#112233",
      "red",
      "",
      "rgb(1, 2)",
      "rgb(a, b, c)",
      undefined,
    ]) {
      expect(parseColor(value)).toBeNull();
    }
  });
});

describe("compositeOver", () => {
  it("paints an opaque colour as itself", () => {
    expect(compositeOver({ r: 10, g: 20, b: 30, a: 1 }, rgb(255, 255, 255))).toEqual(
      rgb(10, 20, 30)
    );
  });

  it("mixes a half-transparent colour into the background", () => {
    expect(compositeOver({ r: 0, g: 0, b: 0, a: 0.5 }, rgb(255, 255, 255))).toEqual(
      rgb(128, 128, 128)
    );
  });

  it("shows only the background through a fully transparent colour", () => {
    expect(compositeOver({ r: 0, g: 0, b: 0, a: 0 }, rgb(12, 34, 56))).toEqual(rgb(12, 34, 56));
  });
});

describe("contrastRatio", () => {
  it("is 21 for black on white and 1 for a colour on itself", () => {
    expect(contrastRatio(rgb(0, 0, 0), rgb(255, 255, 255))).toBeCloseTo(21, 5);
    expect(contrastRatio(rgb(26, 85, 177), rgb(26, 85, 177))).toBeCloseTo(1, 10);
  });

  it("does not depend on which colour is named first", () => {
    const a = rgb(0, 136, 0);
    const b = rgb(0, 0, 136);
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10);
  });

  it("uses the WCAG relative luminance", () => {
    expect(relativeLuminance(rgb(255, 255, 255))).toBeCloseTo(1, 10);
    expect(relativeLuminance(rgb(0, 255, 0))).toBeCloseTo(0.7152, 4);
  });
});

describe("deltaE", () => {
  it("is zero for the same colour", () => {
    expect(deltaE(rgb(12, 34, 56), rgb(12, 34, 56))).toBe(0);
  });

  it("sees a hue difference a contrast ratio cannot", () => {
    // Two colours of nearly the same luminance: the ratio says they are the
    // same, the distance says they are plainly different.
    const red = rgb(216, 0, 0);
    const green = rgb(0, 143, 0);
    expect(contrastRatio(red, green)).toBeLessThan(1.3);
    expect(deltaE(red, green)).toBeGreaterThan(80);
  });

  it("collapses for a red-green pair under deuteranopia", () => {
    const red = rgb(187, 0, 0);
    const green = rgb(0, 136, 0);
    expect(deltaE(red, green)).toBeGreaterThan(100);
    expect(
      deltaE(simulateDeficiency(red, "deuteranopia"), simulateDeficiency(green, "deuteranopia"))
    ).toBeLessThan(10);
  });
});
