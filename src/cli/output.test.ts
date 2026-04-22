import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { SemanticMeta } from "../semantic/types.js";
import type { Issue } from "../types.js";

let nextIssues: Issue[] = [];
let nextSemanticMeta: SemanticMeta | undefined;

mock.module("../audit.js", () => ({
  audit: async (url: string) => ({
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
  }),
}));

const { runCli } = await import("./index.js");

const MISSING_CONFIG = "/tmp/barrieretest-output-test-missing-config.json";

beforeEach(() => {
  nextIssues = [];
  nextSemanticMeta = undefined;
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
