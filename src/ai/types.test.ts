import { describe, expect, it } from "bun:test";
import type { Issue } from "../types";
import { buildAnalysisPrompt, parseAnalysisResponse } from "./types";

const createIssue = (overrides: Partial<Issue> = {}): Issue => ({
  id: "WCAG2AA.Principle1.Guideline1_4.1_4_3",
  impact: "critical",
  description: "This element has insufficient color contrast",
  help: "Ensure the contrast ratio between text and background is at least 4.5:1",
  helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html",
  selector: "button.submit",
  nodes: [{ html: '<button class="submit" style="color: #999; background: #fff">Submit</button>' }],
  ...overrides,
});

describe("buildAnalysisPrompt", () => {
  it("includes issue details in prompt", () => {
    const issue = createIssue();
    const prompt = buildAnalysisPrompt({ issue });

    expect(prompt).toContain(issue.id);
    expect(prompt).toContain(issue.impact);
    expect(prompt).toContain(issue.description);
    expect(prompt).toContain(issue.help);
  });

  it("includes help URL when available", () => {
    const issue = createIssue();
    const prompt = buildAnalysisPrompt({ issue });

    expect(prompt).toContain(issue.helpUrl!);
  });

  it("includes selector when available", () => {
    const issue = createIssue({ selector: ".my-button" });
    const prompt = buildAnalysisPrompt({ issue });

    expect(prompt).toContain(".my-button");
  });

  it("includes HTML nodes", () => {
    const issue = createIssue();
    const prompt = buildAnalysisPrompt({ issue });

    expect(prompt).toContain(issue.nodes[0].html);
  });

  it("includes context when provided", () => {
    const issue = createIssue();
    const prompt = buildAnalysisPrompt({
      issue,
      context: {
        componentName: "SubmitButton",
        sourceFile: "src/components/SubmitButton.tsx",
      },
    });

    expect(prompt).toContain("SubmitButton");
    expect(prompt).toContain("src/components/SubmitButton.tsx");
  });

  it("requests JSON response format", () => {
    const issue = createIssue();
    const prompt = buildAnalysisPrompt({ issue });

    expect(prompt).toContain("JSON");
    expect(prompt).toContain("contextualAnalysis");
    expect(prompt).toContain("suggestedFix");
    expect(prompt).toContain("confidence");
  });
});

describe("parseAnalysisResponse", () => {
  it("parses valid JSON response", () => {
    const response = JSON.stringify({
      contextualAnalysis:
        "This button has low contrast making it hard for users with visual impairments to read.",
      suggestedFix: '<button class="submit" style="color: #333; background: #fff">Submit</button>',
      confidence: 0.85,
    });

    const result = parseAnalysisResponse(response);

    expect(result.contextualAnalysis).toContain("low contrast");
    expect(result.suggestedFix).toContain("color: #333");
    expect(result.confidence).toBe(0.85);
  });

  it("extracts JSON from response with surrounding text", () => {
    const response = `Here is my analysis:

{
  "contextualAnalysis": "The issue is...",
  "suggestedFix": "<button>Fixed</button>",
  "confidence": 0.9
}

Let me know if you need more details.`;

    const result = parseAnalysisResponse(response);

    expect(result.contextualAnalysis).toBe("The issue is...");
    expect(result.suggestedFix).toBe("<button>Fixed</button>");
    expect(result.confidence).toBe(0.9);
  });

  it("defaults confidence to 0.5 if not provided", () => {
    const response = JSON.stringify({
      contextualAnalysis: "Analysis here",
      suggestedFix: "<div>Fixed</div>",
    });

    const result = parseAnalysisResponse(response);

    expect(result.confidence).toBe(0.5);
  });

  it("throws error for invalid JSON", () => {
    expect(() => parseAnalysisResponse("not json at all")).toThrow("No JSON found");
  });

  it("throws error for missing required fields", () => {
    const response = JSON.stringify({
      contextualAnalysis: "Only analysis, no fix",
    });

    expect(() => parseAnalysisResponse(response)).toThrow("Invalid AI response format");
  });

  it("handles JSON with extra fields", () => {
    const response = JSON.stringify({
      contextualAnalysis: "Analysis",
      suggestedFix: "Fix",
      confidence: 0.8,
      extraField: "ignored",
    });

    const result = parseAnalysisResponse(response);

    expect(result.contextualAnalysis).toBe("Analysis");
    expect(result.suggestedFix).toBe("Fix");
    expect(result.confidence).toBe(0.8);
  });
});
