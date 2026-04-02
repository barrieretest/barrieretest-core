import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import type { Issue } from "../types";
import { generateIssueHash } from "./hash";
import { type BaselineIntegrationResult, processAuditWithBaseline } from "./integration";
import type { BaselineFile, BaselineIssue } from "./types";
import { writeBaseline } from "./write";

const TEST_DIR = "/tmp/barrieretest-integration-test";
const TEST_BASELINE = `${TEST_DIR}/baseline.json`;

const createIssue = (overrides: Partial<Issue> = {}): Issue => ({
  id: "WCAG2AA.Principle1.Guideline1_4.1_4_3",
  impact: "critical",
  description: "Contrast issue",
  help: "Fix the contrast",
  selector: "button.submit",
  nodes: [{ html: '<button class="submit">Submit</button>' }],
  ...overrides,
});

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
});

describe("processAuditWithBaseline", () => {
  it("returns all issues as new when no baseline provided", async () => {
    const issues = [createIssue()];

    const result = await processAuditWithBaseline(issues, "https://example.com", {});

    expect(result.allIssues).toEqual(issues);
    expect(result.baseline).toBeUndefined();
  });

  it("returns baseline diff when baseline path provided", async () => {
    const knownIssue = createIssue({ selector: "#known" });
    const newIssue = createIssue({ selector: "#new" });

    // Create baseline with known issue
    await writeBaseline(TEST_BASELINE, "https://example.com", [knownIssue]);

    const result = await processAuditWithBaseline([knownIssue, newIssue], "https://example.com", {
      baseline: TEST_BASELINE,
    });

    expect(result.baseline).toBeDefined();
    expect(result.baseline!.path).toBe(TEST_BASELINE);
    expect(result.baseline!.newIssues).toHaveLength(1);
    expect(result.baseline!.newIssues[0].selector).toBe("#new");
    expect(result.baseline!.knownIssues).toHaveLength(1);
    expect(result.baseline!.knownIssues[0].selector).toBe("#known");
  });

  it("identifies fixed issues", async () => {
    const fixedIssue = createIssue({ selector: "#fixed" });

    await writeBaseline(TEST_BASELINE, "https://example.com", [fixedIssue]);

    const result = await processAuditWithBaseline(
      [], // No current issues
      "https://example.com",
      { baseline: TEST_BASELINE }
    );

    expect(result.baseline!.fixedIssues).toHaveLength(1);
    expect(result.baseline!.fixedIssues[0].selector).toBe("#fixed");
  });

  it("creates new baseline when updateBaseline is true and no baseline exists", async () => {
    const issues = [createIssue()];
    const newBaseline = `${TEST_DIR}/new-baseline.json`;

    const result = await processAuditWithBaseline(issues, "https://example.com", {
      baseline: newBaseline,
      updateBaseline: true,
    });

    expect(existsSync(newBaseline)).toBe(true);
    expect(result.baseline?.newIssues).toHaveLength(0); // All issues now in baseline
  });

  it("updates existing baseline when updateBaseline is true", async () => {
    const existingIssue = createIssue({ selector: "#existing" });
    const newIssue = createIssue({ selector: "#new" });

    // Create initial baseline
    await writeBaseline(TEST_BASELINE, "https://example.com", [existingIssue]);

    // Run with new issue
    await processAuditWithBaseline([existingIssue, newIssue], "https://example.com", {
      baseline: TEST_BASELINE,
      updateBaseline: true,
    });

    // Verify baseline was updated
    const updatedBaseline = await Bun.file(TEST_BASELINE).json();
    expect(updatedBaseline.issues).toHaveLength(2);
  });

  it("returns null baseline when baseline file does not exist", async () => {
    const result = await processAuditWithBaseline([createIssue()], "https://example.com", {
      baseline: "/non/existent/file.json",
    });

    // No baseline = no diff info, but doesn't throw
    expect(result.baseline).toBeUndefined();
  });

  it("respects BARRIERETEST_UPDATE_BASELINE env var", async () => {
    const issues = [createIssue()];
    const newBaseline = `${TEST_DIR}/env-baseline.json`;

    // Set env var
    const originalEnv = process.env.BARRIERETEST_UPDATE_BASELINE;
    process.env.BARRIERETEST_UPDATE_BASELINE = "true";

    try {
      await processAuditWithBaseline(issues, "https://example.com", { baseline: newBaseline });

      expect(existsSync(newBaseline)).toBe(true);
    } finally {
      // Restore env
      if (originalEnv === undefined) {
        delete process.env.BARRIERETEST_UPDATE_BASELINE;
      } else {
        process.env.BARRIERETEST_UPDATE_BASELINE = originalEnv;
      }
    }
  });

  it("caches last run for baseline:accept", async () => {
    const issues = [createIssue()];
    const cacheDir = `${TEST_DIR}/cache`;

    await processAuditWithBaseline(
      issues,
      "https://example.com",
      { baseline: TEST_BASELINE },
      cacheDir
    );

    expect(existsSync(`${cacheDir}/last-run.json`)).toBe(true);
  });
});
