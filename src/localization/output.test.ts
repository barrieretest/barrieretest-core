import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateIssueHash } from "../baseline/hash";
import type { Issue } from "../types";
import type { LocalizationResult, LocalizedIssue } from "./index";
import {
  issuesWithScreenshotPaths,
  prepareOutputWithScreenshots,
  saveAllScreenshots,
  saveIssueScreenshot,
} from "./output";

const createIssue = (overrides: Partial<Issue> = {}): Issue => ({
  id: "WCAG2AA.Principle1.Guideline1_4.1_4_3",
  impact: "critical",
  description: "Contrast issue",
  help: "Fix the contrast",
  selector: "button.submit",
  nodes: [{ html: '<button class="submit">Submit</button>' }],
  ...overrides,
});

const createLocalization = (overrides: Partial<LocalizationResult> = {}): LocalizationResult => ({
  selector: "button.submit",
  confidence: "high",
  strategy: "react",
  ...overrides,
});

const createLocalizedIssue = (
  issueOverrides: Partial<Issue> = {},
  localizationOverrides: Partial<LocalizationResult> = {}
): LocalizedIssue => ({
  ...createIssue(issueOverrides),
  localization: createLocalization(localizationOverrides),
});

// Create a simple PNG-like buffer for testing
const createMockScreenshot = (): Uint8Array => {
  // PNG magic bytes followed by some data
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00]);
};

describe("screenshot output", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `barrieretest-output-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("saveIssueScreenshot", () => {
    it("saves screenshot to disk", async () => {
      const screenshot = createMockScreenshot();
      const issue = createLocalizedIssue({}, { screenshot });

      const result = await saveIssueScreenshot(issue, { outputDir: testDir });

      expect(result).not.toBeNull();
      expect(result!.success).toBe(true);
      expect(result!.filePath).toContain(testDir);
      expect(result!.filePath).toEndWith(".png");

      // Verify file was written
      const fileContent = await readFile(result!.filePath);
      expect(fileContent.length).toBe(screenshot.length);
    });

    it("returns null for issues without screenshots", async () => {
      const issue = createLocalizedIssue({}, { screenshot: undefined });

      const result = await saveIssueScreenshot(issue, { outputDir: testDir });

      expect(result).toBeNull();
    });

    it("uses custom filename prefix", async () => {
      const screenshot = createMockScreenshot();
      const issue = createLocalizedIssue({}, { screenshot });

      const result = await saveIssueScreenshot(issue, {
        outputDir: testDir,
        filenamePrefix: "a11y",
      });

      expect(result!.filePath).toContain("a11y-");
    });

    it("includes issue hash in filename", async () => {
      const screenshot = createMockScreenshot();
      const issue = createLocalizedIssue({}, { screenshot });

      const result = await saveIssueScreenshot(issue, { outputDir: testDir });

      expect(result!.hash).toBeDefined();
      expect(result!.filePath).toContain(result!.hash);
    });

    it("creates directory if it does not exist", async () => {
      const screenshot = createMockScreenshot();
      const issue = createLocalizedIssue({}, { screenshot });
      const newDir = join(testDir, "new-subdir");

      const result = await saveIssueScreenshot(issue, {
        outputDir: newDir,
        createDir: true,
      });

      expect(result!.success).toBe(true);
    });
  });

  describe("saveAllScreenshots", () => {
    it("saves screenshots for all issues with localization", async () => {
      const screenshot = createMockScreenshot();
      const issues = [
        createLocalizedIssue({ id: "rule1" }, { screenshot }),
        createLocalizedIssue({ id: "rule2" }, { screenshot }),
        createLocalizedIssue({ id: "rule3" }, { screenshot: undefined }), // No screenshot
      ];

      const results = await saveAllScreenshots(issues, { outputDir: testDir });

      expect(results.length).toBe(2); // Only 2 have screenshots
      expect(results.every((r) => r.success)).toBe(true);
    });

    it("returns empty array for issues without screenshots", async () => {
      const issues = [
        createLocalizedIssue({}, { screenshot: undefined }),
        createLocalizedIssue({}, { screenshot: undefined }),
      ];

      const results = await saveAllScreenshots(issues, { outputDir: testDir });

      expect(results).toEqual([]);
    });
  });

  describe("issuesWithScreenshotPaths", () => {
    it("replaces screenshot buffers with file paths", () => {
      const screenshot = createMockScreenshot();
      const issues = [createLocalizedIssue({}, { screenshot })];
      const hash = generateIssueHash(issues[0]);

      const screenshotResults = [
        {
          issueId: issues[0].id,
          hash,
          filePath: "/path/to/screenshot.png",
          success: true,
        },
      ];

      const output = issuesWithScreenshotPaths(issues, screenshotResults);

      expect(output[0].screenshotPath).toBe("/path/to/screenshot.png");
      // Screenshot buffer should not be in localization
      expect((output[0] as LocalizedIssue).localization?.screenshot).toBeUndefined();
    });

    it("preserves other localization data", () => {
      const screenshot = createMockScreenshot();
      const issues = [
        createLocalizedIssue(
          {},
          {
            screenshot,
            componentName: "MyButton",
            sourceFile: "src/Button.tsx",
            sourceLine: 42,
          }
        ),
      ];
      const hash = generateIssueHash(issues[0]);

      const screenshotResults = [
        {
          issueId: issues[0].id,
          hash,
          filePath: "/path/to/screenshot.png",
          success: true,
        },
      ];

      const output = issuesWithScreenshotPaths(issues, screenshotResults);
      const localization = (output[0] as LocalizedIssue).localization;

      expect(localization?.componentName).toBe("MyButton");
      expect(localization?.sourceFile).toBe("src/Button.tsx");
      expect(localization?.sourceLine).toBe(42);
    });

    it("handles failed screenshot saves", () => {
      const screenshot = createMockScreenshot();
      const issues = [createLocalizedIssue({}, { screenshot })];
      const hash = generateIssueHash(issues[0]);

      const screenshotResults = [
        {
          issueId: issues[0].id,
          hash,
          filePath: "/path/to/screenshot.png",
          success: false,
          error: "Permission denied",
        },
      ];

      const output = issuesWithScreenshotPaths(issues, screenshotResults);

      expect(output[0].screenshotPath).toBeUndefined();
    });
  });

  describe("prepareOutputWithScreenshots", () => {
    it("saves screenshots and returns issues with paths", async () => {
      const screenshot = createMockScreenshot();
      const issues = [
        createLocalizedIssue({ id: "rule1" }, { screenshot }),
        createLocalizedIssue({ id: "rule2" }, { screenshot }),
      ];

      const result = await prepareOutputWithScreenshots(issues, testDir);

      expect(result.screenshots.length).toBe(2);
      expect(result.issues.length).toBe(2);
      expect(result.issues[0].screenshotPath).toBeDefined();
      expect(result.issues[1].screenshotPath).toBeDefined();
    });
  });
});
