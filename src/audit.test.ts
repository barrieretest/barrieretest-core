import { describe, expect, test } from "bun:test";
import type { Issue, IssueSeverity } from "./types";

// Extract filtering logic for testing
const severityOrder: IssueSeverity[] = ["minor", "moderate", "serious", "critical"];

function meetsSeverityThreshold(issueSeverity: IssueSeverity, minSeverity: IssueSeverity): boolean {
  const issueIndex = severityOrder.indexOf(issueSeverity);
  const minIndex = severityOrder.indexOf(minSeverity);
  return issueIndex >= minIndex;
}

function filterIssues(
  issues: Issue[],
  options: { minSeverity?: IssueSeverity; ignore?: string[] }
): Issue[] {
  const { minSeverity, ignore = [] } = options;

  return issues.filter((issue) => {
    if (ignore.includes(issue.id)) {
      return false;
    }
    if (minSeverity && !meetsSeverityThreshold(issue.impact, minSeverity)) {
      return false;
    }
    return true;
  });
}

const mockIssues: Issue[] = [
  {
    id: "rule-critical",
    impact: "critical",
    description: "Critical issue",
    help: "Help",
    selector: "#a",
    nodes: [{ html: "<div></div>" }],
  },
  {
    id: "rule-serious",
    impact: "serious",
    description: "Serious issue",
    help: "Help",
    selector: "#b",
    nodes: [{ html: "<div></div>" }],
  },
  {
    id: "rule-moderate",
    impact: "moderate",
    description: "Moderate issue",
    help: "Help",
    selector: "#c",
    nodes: [{ html: "<div></div>" }],
  },
  {
    id: "rule-minor",
    impact: "minor",
    description: "Minor issue",
    help: "Help",
    selector: "#d",
    nodes: [{ html: "<div></div>" }],
  },
];

describe("audit filtering", () => {
  describe("severity threshold", () => {
    test("filters out issues below minimum severity", () => {
      const result = filterIssues(mockIssues, { minSeverity: "serious" });

      expect(result).toHaveLength(2);
      expect(result.map((i) => i.impact)).toEqual(["critical", "serious"]);
    });

    test("keeps all issues when minSeverity is minor", () => {
      const result = filterIssues(mockIssues, { minSeverity: "minor" });
      expect(result).toHaveLength(4);
    });

    test("keeps only critical when minSeverity is critical", () => {
      const result = filterIssues(mockIssues, { minSeverity: "critical" });
      expect(result).toHaveLength(1);
      expect(result[0].impact).toBe("critical");
    });

    test("keeps all issues when no minSeverity specified", () => {
      const result = filterIssues(mockIssues, {});
      expect(result).toHaveLength(4);
    });
  });

  describe("rule ignoring", () => {
    test("filters out ignored rules", () => {
      const result = filterIssues(mockIssues, {
        ignore: ["rule-critical", "rule-minor"],
      });

      expect(result).toHaveLength(2);
      expect(result.map((i) => i.id)).toEqual(["rule-serious", "rule-moderate"]);
    });

    test("keeps all issues when ignore list is empty", () => {
      const result = filterIssues(mockIssues, { ignore: [] });
      expect(result).toHaveLength(4);
    });

    test("handles non-matching ignore rules", () => {
      const result = filterIssues(mockIssues, {
        ignore: ["non-existent-rule"],
      });
      expect(result).toHaveLength(4);
    });
  });

  describe("combined filtering", () => {
    test("applies both severity and ignore filters", () => {
      const result = filterIssues(mockIssues, {
        minSeverity: "moderate",
        ignore: ["rule-critical"],
      });

      expect(result).toHaveLength(2);
      expect(result.map((i) => i.id)).toEqual(["rule-serious", "rule-moderate"]);
    });
  });

  describe("meetsSeverityThreshold", () => {
    test("critical meets all thresholds", () => {
      expect(meetsSeverityThreshold("critical", "critical")).toBe(true);
      expect(meetsSeverityThreshold("critical", "serious")).toBe(true);
      expect(meetsSeverityThreshold("critical", "moderate")).toBe(true);
      expect(meetsSeverityThreshold("critical", "minor")).toBe(true);
    });

    test("minor only meets minor threshold", () => {
      expect(meetsSeverityThreshold("minor", "critical")).toBe(false);
      expect(meetsSeverityThreshold("minor", "serious")).toBe(false);
      expect(meetsSeverityThreshold("minor", "moderate")).toBe(false);
      expect(meetsSeverityThreshold("minor", "minor")).toBe(true);
    });

    test("moderate meets moderate and below", () => {
      expect(meetsSeverityThreshold("moderate", "critical")).toBe(false);
      expect(meetsSeverityThreshold("moderate", "serious")).toBe(false);
      expect(meetsSeverityThreshold("moderate", "moderate")).toBe(true);
      expect(meetsSeverityThreshold("moderate", "minor")).toBe(true);
    });
  });
});
