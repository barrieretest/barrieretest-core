/**
 * Element screenshot capture for accessibility issue localization
 *
 * Captures focused screenshots of problem elements with padding,
 * handling off-screen elements and missing elements gracefully.
 */

import type { BrowserPage } from "../browser.js";

export interface ElementScreenshotResult {
  /** Screenshot data as Uint8Array */
  screenshot: Uint8Array;
  /** Bounding box used for capture (with padding) */
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface ScreenshotOptions {
  /** Padding around the element in pixels */
  padding?: number;
}

const DEFAULT_PADDING = 20;

/**
 * Captures a screenshot of a specific element on the page
 *
 * @param page - Browser page object
 * @param selector - CSS selector for the target element
 * @param options - Screenshot options
 * @returns Screenshot result or null if element doesn't exist
 */
export async function captureElementScreenshot(
  page: BrowserPage,
  selector: string,
  options: ScreenshotOptions = {}
): Promise<ElementScreenshotResult | null> {
  const padding = options.padding ?? DEFAULT_PADDING;

  const elementInfo = await page.evaluate(
    (
      selector: string
    ): {
      exists: boolean;
      box: { x: number; y: number; width: number; height: number } | null;
      viewport: { width: number; height: number };
    } => {
      const element = document.querySelector(selector);
      if (!element) {
        return {
          exists: false,
          box: null,
          viewport: { width: window.innerWidth, height: window.innerHeight },
        };
      }

      element.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });

      const rect = element.getBoundingClientRect();

      return {
        exists: true,
        box: {
          x: rect.x + window.scrollX,
          y: rect.y + window.scrollY,
          width: rect.width,
          height: rect.height,
        },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      };
    },
    selector
  );

  if (!elementInfo.exists || !elementInfo.box) {
    return null;
  }

  const { box, viewport } = elementInfo;

  const clip = {
    x: Math.max(0, box.x - padding),
    y: Math.max(0, box.y - padding),
    width: Math.min(box.width + padding * 2, viewport.width - Math.max(0, box.x - padding)),
    height: Math.min(box.height + padding * 2, viewport.height - Math.max(0, box.y - padding)),
  };

  clip.width = Math.max(clip.width, 1);
  clip.height = Math.max(clip.height, 1);

  const screenshot = await page.screenshot({
    type: "png",
    clip,
  });

  return {
    screenshot,
    boundingBox: clip,
  };
}

/**
 * Captures screenshots for multiple elements
 *
 * @param page - Browser page object
 * @param selectors - Array of CSS selectors
 * @param options - Screenshot options
 * @returns Map of selector to screenshot result (null for missing elements)
 */
export async function captureMultipleElementScreenshots(
  page: BrowserPage,
  selectors: string[],
  options: ScreenshotOptions = {}
): Promise<Map<string, ElementScreenshotResult | null>> {
  const results = new Map<string, ElementScreenshotResult | null>();

  for (const selector of selectors) {
    const result = await captureElementScreenshot(page, selector, options);
    results.set(selector, result);
  }

  return results;
}
