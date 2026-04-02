import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Issue } from "../types";
import { CACHE_DIR, clearOldCache, getLastRun, saveLastRun } from "./cache";

const createIssue = (overrides: Partial<Issue> = {}): Issue => ({
  id: "WCAG2AA.Principle1.Guideline1_4.1_4_3",
  impact: "critical",
  description: "Contrast issue",
  help: "Fix the contrast",
  selector: "button.submit",
  nodes: [{ html: '<button class="submit">Submit</button>' }],
  ...overrides,
});

// Use test-specific cache dir to avoid conflicts
const TEST_CACHE_DIR = "/tmp/barrieretest-cache-test";

beforeEach(() => {
  mkdirSync(TEST_CACHE_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_CACHE_DIR)) {
    rmSync(TEST_CACHE_DIR, { recursive: true });
  }
});

describe("saveLastRun", () => {
  it("saves run results to cache", async () => {
    const issues = [createIssue()];

    await saveLastRun("https://example.com", issues, TEST_CACHE_DIR);

    const cacheFile = join(TEST_CACHE_DIR, "last-run.json");
    expect(existsSync(cacheFile)).toBe(true);
  });

  it("saves issues and url", async () => {
    const issues = [createIssue()];

    await saveLastRun("https://example.com", issues, TEST_CACHE_DIR);

    const cacheFile = join(TEST_CACHE_DIR, "last-run.json");
    const content = await Bun.file(cacheFile).json();
    expect(content.url).toBe("https://example.com");
    expect(content.issues).toHaveLength(1);
  });

  it("includes timestamp", async () => {
    await saveLastRun("https://example.com", [], TEST_CACHE_DIR);

    const cacheFile = join(TEST_CACHE_DIR, "last-run.json");
    const content = await Bun.file(cacheFile).json();
    expect(content.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("creates cache directory if it doesn't exist", async () => {
    const nestedDir = join(TEST_CACHE_DIR, "nested", "cache");

    await saveLastRun("https://example.com", [], nestedDir);

    expect(existsSync(join(nestedDir, "last-run.json"))).toBe(true);
  });
});

describe("getLastRun", () => {
  it("returns cached run data", async () => {
    const issues = [createIssue()];
    await saveLastRun("https://example.com", issues, TEST_CACHE_DIR);

    const lastRun = await getLastRun(TEST_CACHE_DIR);

    expect(lastRun).not.toBeNull();
    expect(lastRun!.url).toBe("https://example.com");
    expect(lastRun!.issues).toHaveLength(1);
  });

  it("returns null when no cache exists", async () => {
    const lastRun = await getLastRun("/non/existent/path");

    expect(lastRun).toBeNull();
  });

  it("returns null for corrupted cache", async () => {
    const cacheFile = join(TEST_CACHE_DIR, "last-run.json");
    await Bun.write(cacheFile, "not valid json");

    const lastRun = await getLastRun(TEST_CACHE_DIR);

    expect(lastRun).toBeNull();
  });
});

describe("clearOldCache", () => {
  it("removes cache files older than threshold", async () => {
    // Save a cache file
    await saveLastRun("https://example.com", [], TEST_CACHE_DIR);
    const cacheFile = join(TEST_CACHE_DIR, "last-run.json");

    // Wait a bit to ensure file is older than 0ms
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Clear with 0ms threshold (everything is old)
    await clearOldCache(0, TEST_CACHE_DIR);

    expect(existsSync(cacheFile)).toBe(false);
  });

  it("preserves recent cache files", async () => {
    await saveLastRun("https://example.com", [], TEST_CACHE_DIR);
    const cacheFile = join(TEST_CACHE_DIR, "last-run.json");

    // Clear with 1 hour threshold
    await clearOldCache(60 * 60 * 1000, TEST_CACHE_DIR);

    expect(existsSync(cacheFile)).toBe(true);
  });

  it("does nothing when cache dir doesn't exist", async () => {
    // Should not throw
    await clearOldCache(0, "/non/existent/path");
  });
});

describe("CACHE_DIR", () => {
  it("is under .barrieretest/cache", () => {
    expect(CACHE_DIR).toContain(".barrieretest/cache");
  });
});
