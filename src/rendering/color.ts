/**
 * Colour maths for the vision-deficiency checks.
 *
 * The CVD checks read computed colours, not decoded pixels (contract
 * amendment of 2026-10-14), so the simulation the browser applies to the
 * capture has to be reproduced here — exactly, or a check would judge
 * colours nobody is shown.
 *
 * Chromium's `Emulation.setEmulatedVisionDeficiency` is an SVG
 * `feColorMatrix` filter over the page, carrying the Machado et al. (2009)
 * matrices at severity 1.0, and SVG filters interpolate in `linearRGB`
 * unless the filter says otherwise — Chromium's does not. The matrix is
 * therefore applied to *linearised* channels, not to the sRGB-encoded ones,
 * and the result is encoded back. Verified against real captures: pure red
 * under protanopia is `rgb(109, 95, 0)` in the browser and `rgb(109, 95, 0)`
 * here. The reference values in `color.test.ts` are what Chromium rendered
 * for those patches under all four deficiencies, and the colour-patch test
 * in `src/audit-integration.test.ts` measures the agreement against a live
 * capture: no channel differs by more than 2 of 255, the JPEG capture's own
 * error included.
 *
 * `cvd:reduced-contrast` and `cvd:blurred-vision` are not colour
 * transformations and have no matrix: the checks do not run under them.
 */

/** sRGB colour with 8-bit channels. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** sRGB colour with 8-bit channels and an alpha of 0 to 1. */
export interface Rgba extends Rgb {
  a: number;
}

/** The deficiencies that are a colour transformation, so a matrix exists. */
export type SimulatedDeficiency = "protanopia" | "deuteranopia" | "tritanopia" | "achromatopsia";

export const SIMULATED_DEFICIENCIES: readonly SimulatedDeficiency[] = [
  "protanopia",
  "deuteranopia",
  "tritanopia",
  "achromatopsia",
];

export function isSimulatedDeficiency(value: string | undefined): value is SimulatedDeficiency {
  return value !== undefined && (SIMULATED_DEFICIENCIES as readonly string[]).includes(value);
}

/**
 * Machado, Oliveira and Fernandes (2009), severity 1.0 — the matrices
 * Chromium's emulation carries, row-major. Achromatopsia is not from that
 * model: it is luminance, with the Rec. 709 coefficients Chromium uses, in
 * all three rows.
 */
const MATRICES: Record<SimulatedDeficiency, readonly number[]> = {
  protanopia: [
    0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998,
  ],
  deuteranopia: [
    0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881,
  ],
  tritanopia: [
    1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039,
  ],
  achromatopsia: [0.213, 0.715, 0.072, 0.213, 0.715, 0.072, 0.213, 0.715, 0.072],
};

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** The sRGB transfer function, inverted: an 8-bit channel to linear light. */
export function channelToLinear(channel: number): number {
  const value = clamp01(channel / 255);
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** Linear light back to an 8-bit sRGB channel. */
export function linearToChannel(value: number): number {
  const linear = clamp01(value);
  const encoded = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
  return Math.round(clamp01(encoded) * 255);
}

/**
 * The colour as someone with the deficiency sees it, the way the browser
 * renders it: linearise, multiply, clamp, encode.
 */
export function simulateDeficiency(color: Rgb, deficiency: SimulatedDeficiency): Rgb {
  const m = MATRICES[deficiency];
  const r = channelToLinear(color.r);
  const g = channelToLinear(color.g);
  const b = channelToLinear(color.b);
  return {
    r: linearToChannel(m[0] * r + m[1] * g + m[2] * b),
    g: linearToChannel(m[3] * r + m[4] * g + m[5] * b),
    b: linearToChannel(m[6] * r + m[7] * g + m[8] * b),
  };
}

/**
 * Parse a colour the measurement reports. Only the `rgb()` and `rgba()`
 * forms, with commas or spaces and an optional `/ alpha`: the measurement
 * normalises every computed colour to one of them in the page, where the
 * browser can resolve `oklch()`, `lab()` and `color(srgb …)` itself. Returns
 * `null` for anything else, and the checks then report nothing rather than
 * guess at a colour.
 */
export function parseColor(value: string | undefined): Rgba | null {
  if (typeof value !== "string") return null;
  const match = /^rgba?\(([^)]*)\)$/i.exec(value.trim());
  if (!match) return null;

  const parts = match[1]
    .split(/[,/\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return null;

  const channels: number[] = [];
  for (const part of parts.slice(0, 3)) {
    const number = Number.parseFloat(part);
    if (!Number.isFinite(number)) return null;
    channels.push(part.endsWith("%") ? (number / 100) * 255 : number);
  }

  let alpha = 1;
  if (parts.length === 4) {
    const number = Number.parseFloat(parts[3]);
    if (!Number.isFinite(number)) return null;
    alpha = parts[3].endsWith("%") ? number / 100 : number;
  }

  const channel = (value: number) => Math.round(Math.min(255, Math.max(0, value)));
  return {
    r: channel(channels[0]),
    g: channel(channels[1]),
    b: channel(channels[2]),
    a: Math.min(1, Math.max(0, alpha)),
  };
}

/** A semi-transparent colour over an opaque one: what is painted. */
export function compositeOver(color: Rgba, background: Rgb): Rgb {
  const alpha = clamp01(color.a);
  const mix = (over: number, under: number) => Math.round(over * alpha + under * (1 - alpha));
  return {
    r: mix(color.r, background.r),
    g: mix(color.g, background.g),
    b: mix(color.b, background.b),
  };
}

/** WCAG relative luminance. */
export function relativeLuminance(color: Rgb): number {
  return (
    0.2126 * channelToLinear(color.r) +
    0.7152 * channelToLinear(color.g) +
    0.0722 * channelToLinear(color.b)
  );
}

/** WCAG contrast ratio, 1 to 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/** CIE Lab, D65, from sRGB — the space the colour distance is measured in. */
interface Lab {
  l: number;
  a: number;
  b: number;
}

export function toLab(color: Rgb): Lab {
  const r = channelToLinear(color.r);
  const g = channelToLinear(color.g);
  const b = channelToLinear(color.b);

  // sRGB to CIE XYZ, D65.
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;

  const f = (value: number) => (value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116);

  return { l: 116 * f(y) - 16, a: 500 * (f(x) - f(y)), b: 200 * (f(y) - f(z)) };
}

/**
 * CIE76 colour distance. Unlike the contrast ratio it sees hue: two colours
 * of the same luminance and different hue — the red and the green of a
 * status indicator — have a contrast ratio of 1 and a large distance here,
 * which is exactly the difference a colour-vision deficiency takes away.
 */
export function deltaE(a: Rgb, b: Rgb): number {
  const first = toLab(a);
  const second = toLab(b);
  return Math.sqrt(
    (first.l - second.l) ** 2 + (first.a - second.a) ** 2 + (first.b - second.b) ** 2
  );
}
