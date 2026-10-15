import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { SemanticMeta } from "../semantic/types.js";
import type { AuditOptions, Issue, RenderingCapture, RenderingMeta } from "../types.js";

let nextIssues: Issue[] = [];
let nextSemanticMeta: SemanticMeta | undefined;
let nextRenderingCaptures: RenderingCapture[] | undefined;
let nextRenderingMeta: RenderingMeta | undefined;
/** What the CLI asked `audit()` for, so the flag resolution can be checked. */
let auditCalls: { url: string; options: AuditOptions | undefined }[] = [];

mock.module("../audit.js", () => ({
  audit: async (url: string, options?: AuditOptions) => {
    auditCalls.push({ url, options });
    return {
      url,
      documentTitle: "Stub page",
      score: 72,
      severityLevel: "good",
      scoreInterpretation: {
        range: "70-94",
        level: "good",
        title: "Good",
        description: "Stub",
        action: "Stub",
        urgency: "low",
        recommendConsulting: false,
        color: "green",
      },
      issues: nextIssues,
      timestamp: new Date().toISOString(),
      semanticMeta: nextSemanticMeta,
      renderingCaptures: nextRenderingCaptures,
      renderingMeta: nextRenderingMeta,
    };
  },
}));

const { runCli } = await import("./index.js");

const MISSING_CONFIG = "/tmp/barrieretest-output-test-missing-config.json";

beforeEach(() => {
  nextIssues = [];
  nextSemanticMeta = undefined;
  nextRenderingCaptures = undefined;
  nextRenderingMeta = undefined;
  auditCalls = [];
});

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "color-contrast",
    impact: "serious",
    description: "Elements must have sufficient color contrast.",
    help: "Color contrast must meet the minimum ratio.",
    helpUrl: "https://dequeuniversity.com/rules/axe/4.10/color-contrast",
    selector: "#header > h1",
    nodes: [{ html: '<h1 style="color:#777">Header</h1>' }],
    ...overrides,
  };
}

describe("CLI fix-ready output", () => {
  it("prints rule help, failure summary, and docs", async () => {
    nextIssues = [
      makeIssue({
        failureSummary:
          "Fix any of the following:\n  Element has insufficient color contrast of 2.89",
      }),
    ];

    const result = await runCli({
      command: "audit",
      url: "https://example.com",
      detail: "fix-ready",
      headless: true,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("Help: Color contrast must meet the minimum ratio.");
    expect(result.message).toContain("Fix any of the following:");
    expect(result.message).toContain("Element has insufficient color contrast of 2.89");
    expect(result.message).toContain(
      "Docs: https://dequeuniversity.com/rules/axe/4.10/color-contrast"
    );
  });

  it("keeps distinct elements separate when they share the same rule id", async () => {
    nextIssues = [
      makeIssue({
        selector: "#header > h1",
        nodes: [{ html: "<h1>Header</h1>" }],
        failureSummary: "Fix any of the following:\n  Contrast is 2.89",
      }),
      makeIssue({
        selector: "#footer > p",
        nodes: [{ html: "<p>Footer</p>" }],
        failureSummary: "Fix any of the following:\n  Contrast is 3.12",
      }),
    ];

    const result = await runCli({
      command: "audit",
      url: "https://example.com",
      detail: "fix-ready",
      headless: true,
    });

    expect(result.message).toContain("Element: #header > h1");
    expect(result.message).toContain("Element: #footer > p");
    expect(result.message).toContain("Contrast is 2.89");
    expect(result.message).toContain("Contrast is 3.12");
    expect(result.message).toContain("2 issues found");
  });
});

describe("CLI semantic summary block", () => {
  it("prints provider, model, check count, and finding count when semanticMeta is set", async () => {
    nextIssues = [
      makeIssue({
        id: "semantic:page-title",
        impact: "moderate",
        description: "Page title is not descriptive",
      }),
    ];
    nextSemanticMeta = {
      provider: "nebius",
      model: "openai/gpt-oss-120b",
      checksRun: ["aria-mismatch", "page-title"],
    };

    const result = await runCli(
      {
        command: "audit",
        url: "https://example.com",
        detail: "actionable",
        headless: true,
        semantic: true,
      },
      {
        env: { NEBIUS_API_KEY: "test" },
        configPath: MISSING_CONFIG,
      }
    );

    expect(result.message).toContain("Semantic audit:");
    expect(result.message).toContain("Provider: nebius (openai/gpt-oss-120b)");
    expect(result.message).toContain("Checks run: 2");
    expect(result.message).toContain("Findings: 1");

    nextSemanticMeta = undefined;
  });

  it("prints one provider line per tier when two tiers ran", async () => {
    nextIssues = [];
    nextSemanticMeta = {
      provider: "mistral",
      model: "mistral-large-4",
      checksRun: ["page-title", "alt-text-quality"],
      tiers: {
        large: {
          provider: "mistral",
          model: "mistral-large-4",
          checksRun: ["page-title"],
        },
        small: {
          provider: "openai",
          model: "gpt-4o-mini",
          checksRun: ["alt-text-quality"],
        },
      },
    };

    const result = await runCli(
      {
        command: "audit",
        url: "https://example.com",
        detail: "actionable",
        headless: true,
        semantic: true,
      },
      { env: { MISTRAL_API_KEY: "mk" }, configPath: MISSING_CONFIG }
    );

    expect(result.message).toContain("Provider (large): mistral (mistral-large-4)");
    expect(result.message).toContain("Provider (small): openai (gpt-4o-mini)");
    expect(result.message).not.toContain("    Provider: ");
    // The page review is reported first.
    const lines = (result.message ?? "").split("\n");
    expect(lines.findIndex((l) => l.includes("Provider (large)"))).toBeLessThan(
      lines.findIndex((l) => l.includes("Provider (small)"))
    );

    nextSemanticMeta = undefined;
  });

  it("keeps the single provider line when only one tier ran", async () => {
    nextIssues = [];
    nextSemanticMeta = {
      provider: "mistral",
      model: "mistral-large-4",
      checksRun: ["page-title"],
      tiers: {
        large: { provider: "mistral", model: "mistral-large-4", checksRun: ["page-title"] },
      },
    };

    const result = await runCli(
      {
        command: "audit",
        url: "https://example.com",
        detail: "actionable",
        headless: true,
        semantic: true,
      },
      { env: { MISTRAL_API_KEY: "mk" }, configPath: MISSING_CONFIG }
    );

    expect(result.message).toContain("Provider: mistral (mistral-large-4)");
    expect(result.message).not.toContain("Provider (large)");

    nextSemanticMeta = undefined;
  });

  it("omits the semantic summary when semanticMeta is absent", async () => {
    nextIssues = [];
    nextSemanticMeta = undefined;

    const result = await runCli({
      command: "audit",
      url: "https://example.com",
      detail: "actionable",
      headless: true,
    });

    expect(result.message).not.toContain("Semantic audit:");
  });

  it("emits JSON output with semanticMeta present", async () => {
    nextIssues = [];
    nextSemanticMeta = {
      provider: "openai",
      model: "gpt-4o",
      checksRun: ["page-title"],
    };

    const result = await runCli(
      {
        command: "audit",
        url: "https://example.com",
        detail: "actionable",
        headless: true,
        semantic: true,
        json: true,
      },
      {
        env: { OPENAI_API_KEY: "sk" },
        configPath: MISSING_CONFIG,
      }
    );

    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.message ?? "{}");
    expect(parsed.semanticMeta).toBeDefined();
    expect(parsed.semanticMeta.provider).toBe("openai");
    expect(parsed.semanticMeta.checksRun).toEqual(["page-title"]);

    nextSemanticMeta = undefined;
  });

  it("fails early on pa11y + semantic", async () => {
    nextIssues = [];
    nextSemanticMeta = undefined;

    const result = await runCli(
      {
        command: "audit",
        url: "https://example.com",
        detail: "actionable",
        headless: true,
        engine: "pa11y",
        semantic: true,
      },
      {
        env: { NEBIUS_API_KEY: "test" },
        configPath: MISSING_CONFIG,
      }
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("pa11y");
  });
});

/**
 * The rendering flags end to end: what they turn into on the `audit()` call,
 * and how the captures leave the CLI. Parsing is covered in `cli.test.ts`;
 * these run the command.
 */
describe("CLI rendering flags", () => {
  const audited = () => auditCalls[0]?.options?.rendering;

  const capture = (): RenderingCapture => ({
    condition: "viewport:320",
    screenshot: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    meta: {
      width: 320,
      height: 900,
      deviceScaleFactor: 1,
      viewport: { width: 320, height: 720 },
      document: { width: 320, height: 900 },
      scroll: { x: 0, y: 0 },
      fullPage: true,
    },
  });

  let outputDir: string;

  beforeEach(() => {
    outputDir = mkdtempSync(join(tmpdir(), "barrieretest-cli-rendering-"));
  });

  afterEach(() => {
    if (existsSync(outputDir)) rmSync(outputDir, { recursive: true, force: true });
  });

  it("enables the pass from --rendering-conditions alone", async () => {
    await runCli(
      {
        command: "audit",
        url: "https://example.com",
        headless: true,
        renderingConditions: ["viewport:320", "viewport:320+text-spacing"],
      },
      { configPath: MISSING_CONFIG, env: {} }
    );

    expect(audited()).toEqual({ conditions: ["viewport:320", "viewport:320+text-spacing"] });
  });

  it("enables the pass from --rendering-checks alone", async () => {
    await runCli(
      {
        command: "audit",
        url: "https://example.com",
        headless: true,
        renderingChecks: ["overlap-text"],
      },
      { configPath: MISSING_CONFIG, env: {} }
    );

    expect(audited()).toEqual({ checks: ["overlap-text"] });
  });

  it("leaves the pass off without a rendering flag", async () => {
    await runCli(
      { command: "audit", url: "https://example.com", headless: true },
      { configPath: MISSING_CONFIG, env: {} }
    );

    expect(audited()).toBeUndefined();
  });

  it("drops the captures for JSON on stdout and keeps them for a file", async () => {
    await runCli(
      { command: "audit", url: "https://example.com", headless: true, rendering: true, json: true },
      { configPath: MISSING_CONFIG, env: {} }
    );
    // On stdout the base64 of a dozen full-page captures would drown the JSON.
    expect(audited()).toEqual({ captures: false });

    auditCalls = [];
    await runCli(
      {
        command: "audit",
        url: "https://example.com",
        headless: true,
        rendering: true,
        json: true,
        output: join(outputDir, "result.json"),
      },
      { configPath: MISSING_CONFIG, env: {} }
    );
    expect(audited()).toEqual({});
  });

  it("writes the captures to the output file as base64", async () => {
    nextRenderingCaptures = [capture()];
    nextRenderingMeta = {
      conditionsRun: ["viewport:320"],
      conditionsSkipped: [],
      checksRun: ["reflow-horizontal-scroll"],
      durationMs: 42,
    };
    const file = join(outputDir, "result.json");

    const result = await runCli(
      {
        command: "audit",
        url: "https://example.com",
        headless: true,
        rendering: true,
        output: file,
      },
      { configPath: MISSING_CONFIG, env: {} }
    );

    const written = JSON.parse(readFileSync(file, "utf8"));
    expect(written.renderingCaptures).toHaveLength(1);
    expect(written.renderingCaptures[0].condition).toBe("viewport:320");
    expect([...Buffer.from(written.renderingCaptures[0].screenshot, "base64")]).toEqual([
      0xff, 0xd8, 0xff, 0xd9,
    ]);
    expect(written.renderingCaptures[0].meta.viewport).toEqual({ width: 320, height: 720 });
    // The text output names the condition and its findings.
    expect(result.message).toContain("Rendering checks:");
    expect(result.message).toContain("viewport:320: 0 findings");
  });
});
