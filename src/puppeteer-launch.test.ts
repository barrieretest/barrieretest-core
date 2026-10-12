import { describe, expect, mock, test } from "bun:test";
import type { NavigationResponse, PuppeteerPageLike } from "./browser.js";
import { navigateTo } from "./puppeteer-launch.js";

function makeFakePage(response: NavigationResponse): PuppeteerPageLike {
  return {
    goto: async () => response,
    evaluate: async () => undefined,
    screenshot: async () => new Uint8Array(),
    url: () => "about:blank",
    title: async () => "Stub",
    browser: () => ({ newPage: async () => makeFakePage(null) }),
  } as unknown as PuppeteerPageLike;
}

describe("navigateTo", () => {
  test("returns the status and warns when navigation returns an HTTP error status", async () => {
    const originalWarn = console.warn;
    const warn = mock(() => undefined);
    console.warn = warn;

    try {
      await expect(
        navigateTo(makeFakePage({ status: () => 403 }), "https://blocked.example")
      ).resolves.toBe(403);
    } finally {
      console.warn = originalWarn;
    }

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain("403");
    expect(message).toContain("https://blocked.example");
  });

  test("returns HTTP status when navigation succeeds", async () => {
    await expect(
      navigateTo(makeFakePage({ status: () => 200 }), "https://ok.example")
    ).resolves.toBe(200);
  });

  test("does not throw when navigation returns null", async () => {
    await expect(navigateTo(makeFakePage(null), "https://no-response.example")).resolves.toBe(
      undefined
    );
  });
});
