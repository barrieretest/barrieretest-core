import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import type { Issue } from "../types";
import { generateIssueHash } from "./hash";
import type { BaselineFile } from "./types";
import { readBaseline, updateBaseline, writeBaseline } from "./write";

const TEST_DIR = "/tmp/barrieretest-test";
const TEST_FILE = `${TEST_DIR}/test-baseline.json`;

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

describe("writeBaseline", () => {
  it("creates a new baseline file", async () => {
    const issues = [createIssue()];

    await writeBaseline(TEST_FILE, "https://example.com", issues);

    expect(existsSync(TEST_FILE)).toBe(true);
  });

  it("writes valid JSON with correct structure", async () => {
    const issues = [createIssue()];

    await writeBaseline(TEST_FILE, "https://example.com", issues);

    const content = await Bun.file(TEST_FILE).json();
    expect(content.version).toBe(1);
    expect(content.url).toBe("https://example.com");
    expect(content.issues).toHaveLength(1);
    expect(content.issues[0].rule).toBe("WCAG2AA.Principle1.Guideline1_4.1_4_3");
    expect(content.issues[0].selector).toBe("button.submit");
    expect(content.issues[0].hash).toBe(generateIssueHash(issues[0]));
  });

  it("includes ISO date timestamps", async () => {
    await writeBaseline(TEST_FILE, "https://example.com", []);

    const content = await Bun.file(TEST_FILE).json();
    expect(content.created).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(content.updated).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("creates parent directories if they don't exist", async () => {
    const nestedPath = `${TEST_DIR}/nested/deep/baseline.json`;

    await writeBaseline(nestedPath, "https://example.com", []);

    expect(existsSync(nestedPath)).toBe(true);
  });

  it("writes empty issues array when no issues", async () => {
    await writeBaseline(TEST_FILE, "https://example.com", []);

    const content = await Bun.file(TEST_FILE).json();
    expect(content.issues).toEqual([]);
  });
});

describe("readBaseline", () => {
  it("reads a valid baseline file", async () => {
    await writeBaseline(TEST_FILE, "https://example.com", [createIssue()]);

    const baseline = await readBaseline(TEST_FILE);

    expect(baseline.version).toBe(1);
    expect(baseline.url).toBe("https://example.com");
    expect(baseline.issues).toHaveLength(1);
  });

  it("returns null for non-existent file", async () => {
    const baseline = await readBaseline("/non/existent/file.json");

    expect(baseline).toBeNull();
  });

  it("throws for invalid JSON", async () => {
    await Bun.write(TEST_FILE, "not valid json");

    await expect(readBaseline(TEST_FILE)).rejects.toThrow();
  });

  it("throws for invalid baseline structure", async () => {
    await Bun.write(TEST_FILE, JSON.stringify({ foo: "bar" }));

    await expect(readBaseline(TEST_FILE)).rejects.toThrow("Invalid baseline file");
  });
});

describe("updateBaseline", () => {
  it("merges new issues into existing baseline", async () => {
    const existingIssue = createIssue({ selector: "#existing" });
    const newIssue = createIssue({ selector: "#new" });

    await writeBaseline(TEST_FILE, "https://example.com", [existingIssue]);
    await updateBaseline(TEST_FILE, [newIssue]);

    const baseline = await readBaseline(TEST_FILE);
    expect(baseline!.issues).toHaveLength(2);
  });

  it("does not duplicate existing issues", async () => {
    const issue = createIssue();

    await writeBaseline(TEST_FILE, "https://example.com", [issue]);
    await updateBaseline(TEST_FILE, [issue]); // Same issue again

    const baseline = await readBaseline(TEST_FILE);
    expect(baseline!.issues).toHaveLength(1);
  });

  it("preserves original created date", async () => {
    await writeBaseline(TEST_FILE, "https://example.com", []);
    const original = await readBaseline(TEST_FILE);

    // Wait a bit to ensure timestamp would change
    await new Promise((resolve) => setTimeout(resolve, 10));

    await updateBaseline(TEST_FILE, [createIssue()]);
    const updated = await readBaseline(TEST_FILE);

    expect(updated!.created).toBe(original!.created);
    expect(updated!.updated).not.toBe(original!.updated);
  });

  it("throws if baseline file does not exist", async () => {
    await expect(updateBaseline("/non/existent/file.json", [createIssue()])).rejects.toThrow(
      "Baseline file not found"
    );
  });
});
