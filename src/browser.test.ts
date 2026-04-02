import { describe, expect, test } from "bun:test";
import { isPlaywrightPage, isPuppeteerPage, isUrl } from "./browser";

describe("browser detection", () => {
  describe("isUrl", () => {
    test("returns true for string URLs", () => {
      expect(isUrl("https://example.com")).toBe(true);
      expect(isUrl("http://localhost:3000")).toBe(true);
      expect(isUrl("/relative/path")).toBe(true);
    });

    test("returns false for non-strings", () => {
      expect(isUrl(null)).toBe(false);
      expect(isUrl(undefined)).toBe(false);
      expect(isUrl(123)).toBe(false);
      expect(isUrl({})).toBe(false);
    });
  });

  describe("isPuppeteerPage", () => {
    test("returns false for null/undefined", () => {
      expect(isPuppeteerPage(null)).toBe(false);
      expect(isPuppeteerPage(undefined)).toBe(false);
    });

    test("returns false for plain objects", () => {
      expect(isPuppeteerPage({})).toBe(false);
      expect(isPuppeteerPage({ foo: "bar" })).toBe(false);
    });

    test("returns true for Puppeteer-like page objects", () => {
      const puppeteerPage = {
        evaluate: () => {},
        goto: () => {},
        screenshot: () => {},
        browser: () => {},
      };
      expect(isPuppeteerPage(puppeteerPage)).toBe(true);
    });

    test("returns false for Playwright-like page objects", () => {
      const playwrightPage = {
        evaluate: () => {},
        goto: () => {},
        screenshot: () => {},
        context: () => {},
        _guid: "page@123",
      };
      expect(isPuppeteerPage(playwrightPage)).toBe(false);
    });
  });

  describe("isPlaywrightPage", () => {
    test("returns false for null/undefined", () => {
      expect(isPlaywrightPage(null)).toBe(false);
      expect(isPlaywrightPage(undefined)).toBe(false);
    });

    test("returns false for plain objects", () => {
      expect(isPlaywrightPage({})).toBe(false);
      expect(isPlaywrightPage({ foo: "bar" })).toBe(false);
    });

    test("returns true for Playwright-like page objects", () => {
      const playwrightPage = {
        evaluate: () => {},
        goto: () => {},
        screenshot: () => {},
        context: () => {},
        _guid: "page@123",
      };
      expect(isPlaywrightPage(playwrightPage)).toBe(true);
    });

    test("returns false for Puppeteer-like page objects", () => {
      const puppeteerPage = {
        evaluate: () => {},
        goto: () => {},
        screenshot: () => {},
        browser: () => {},
      };
      expect(isPlaywrightPage(puppeteerPage)).toBe(false);
    });
  });
});
