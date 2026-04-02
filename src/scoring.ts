import type { Pa11yIssue } from "./engines/pa11y";

/**
 * Severity thresholds for score interpretation (0-100 scale)
 */
export const SEVERITY_THRESHOLDS = {
  EXCELLENT: 95, // 95-100: Excellent
  GOOD: 70, // 70-94: Good
  NEEDS_IMPROVEMENT: 40, // 40-69: Needs improvement
  CRITICAL: 15, // 15-39: Critical
  // 0-14: Severe
} as const;

export type SeverityLevel = "excellent" | "good" | "needs-improvement" | "critical" | "severe";

export type ScoreInterpretation = {
  range: string;
  level: SeverityLevel;
  title: string;
  description: string;
  action: string;
  urgency: "low" | "medium" | "high" | "urgent";
  recommendConsulting: boolean;
  color: string;
};

export type TransformedIssue = {
  id: string;
  impact: "critical" | "serious" | "moderate" | "minor";
  description: string;
  help: string;
  helpUrl?: string;
  selector: string | null;
  nodes: { html: string }[];
};

/**
 * Filter out false positive pa11y issues
 *
 * Known false positives:
 * - Contrast issues on elements with aria-hidden="true" (decorative elements)
 */
export function shouldFilterPa11yIssue(issue: Pa11yIssue): boolean {
  const isContrastIssue = issue.code.includes("1_4_3") || issue.code.includes("1_4_6");

  if (!isContrastIssue) {
    return false;
  }

  const context = issue.context || "";
  const hasAriaHidden = /aria-hidden\s*=\s*["']true["']/i.test(context);

  return hasAriaHidden;
}

/**
 * Transform pa11y issue to a standardized format
 */
export function transformPa11yIssue(issue: Pa11yIssue): TransformedIssue {
  const impactMap: Record<string, TransformedIssue["impact"]> = {
    error: "critical",
    warning: "serious",
    notice: "moderate",
  };

  return {
    id: issue.code,
    impact: impactMap[issue.type] || "moderate",
    description: issue.message,
    help: issue.context || issue.message,
    helpUrl: issue.code.startsWith("WCAG2AA.")
      ? `https://www.w3.org/WAI/WCAG21/quickref/#${issue.code
          .replace("WCAG2AA.", "")
          .toLowerCase()}`
      : undefined,
    selector: issue.selector || null,
    nodes: [{ html: issue.context }],
  };
}

/**
 * Calculate accessibility score from 0-100 based on issues
 *
 * Scoring rules:
 * - Start at 100 (perfect score)
 * - Deduct points based on severity:
 *   - Critical/Error: -26 points
 *   - Warning/Serious: -10 points
 *   - Notice/Moderate: -3 points
 * - Diminishing returns: After 2 occurrences of same issue, deduct only 50%
 * - Floor: Minimum 5 (or 1 if >100 issues)
 */
export function calculateScore(
  issues: Array<{ id?: string; code?: string; impact?: string; type?: string }>
): number {
  if (issues.length === 0) {
    return 100;
  }

  let score = 100;

  // Group issues by their code/type to detect duplicates
  const issuesByCode = new Map<string, typeof issues>();

  for (const issue of issues) {
    const code = issue.id || issue.code || "unknown";
    if (!issuesByCode.has(code)) {
      issuesByCode.set(code, []);
    }
    issuesByCode.get(code)!.push(issue);
  }

  // Calculate deductions for each issue type
  for (const [, issueGroup] of issuesByCode.entries()) {
    for (let i = 0; i < issueGroup.length; i++) {
      const issue = issueGroup[i];
      const occurrenceIndex = i;

      // Determine base severity deduction
      let baseDeduction = 0;
      const impact = issue.impact || issue.type || "moderate";

      if (impact === "error" || impact === "critical") {
        baseDeduction = 26;
      } else if (impact === "warning" || impact === "serious") {
        baseDeduction = 10;
      } else {
        baseDeduction = 3;
      }

      // Apply diminishing returns for repeated issues
      let deduction = baseDeduction;
      if (occurrenceIndex >= 2) {
        deduction = baseDeduction * 0.5;
      }

      score -= deduction;
    }
  }

  // Floor at 5 unless absolutely awful (more than 100 issues)
  if (issues.length > 100) {
    score = Math.max(score, 1);
  } else {
    score = Math.max(score, 5);
  }

  // Cap at 100
  score = Math.min(score, 100);

  return Math.round(score);
}

/**
 * Get score interpretation with severity level, title, and recommendations
 */
export function getScoreInterpretation(score: number): ScoreInterpretation {
  if (score >= SEVERITY_THRESHOLDS.EXCELLENT) {
    return {
      range: "95-100",
      level: "excellent",
      title: "Excellent",
      description:
        "No or very few automatically detectable accessibility issues found. Note that automated tests can only cover about 30-40% of all WCAG criteria.",
      action: "Conduct regular manual testing to ensure complete accessibility.",
      urgency: "low",
      recommendConsulting: false,
      color: "#16a34a",
    };
  } else if (score >= SEVERITY_THRESHOLDS.GOOD) {
    return {
      range: "70-94",
      level: "good",
      title: "Good",
      description:
        "Some minor issues found. These should be addressed to further improve accessibility.",
      action: "Fix the identified issues and run the test again.",
      urgency: "low",
      recommendConsulting: false,
      color: "#65a30d",
    };
  } else if (score >= SEVERITY_THRESHOLDS.NEEDS_IMPROVEMENT) {
    return {
      range: "40-69",
      level: "needs-improvement",
      title: "Needs Improvement",
      description:
        "Multiple issues found that affect accessibility. A professional audit is recommended.",
      action: "Prioritize fixing critical issues and consider a professional accessibility audit.",
      urgency: "medium",
      recommendConsulting: true,
      color: "#d97706",
    };
  } else if (score >= SEVERITY_THRESHOLDS.CRITICAL) {
    return {
      range: "15-39",
      level: "critical",
      title: "Critical",
      description:
        "Many issues found that severely limit usability for people with disabilities. Urgent action needed!",
      action: "Contact an accessibility expert immediately and plan comprehensive improvements.",
      urgency: "high",
      recommendConsulting: true,
      color: "#ea580c",
    };
  } else {
    return {
      range: "0-14",
      level: "severe",
      title: "Severe",
      description:
        "Critical issues found. The website is not usable for many people with disabilities. Immediate action required!",
      action:
        "Stop further development and focus on fundamental accessibility improvements. Professional support is strongly recommended.",
      urgency: "urgent",
      recommendConsulting: true,
      color: "#dc2626",
    };
  }
}

/**
 * Get severity level from score
 */
export function getSeverityLevel(score: number): SeverityLevel {
  if (score >= SEVERITY_THRESHOLDS.EXCELLENT) return "excellent";
  if (score >= SEVERITY_THRESHOLDS.GOOD) return "good";
  if (score >= SEVERITY_THRESHOLDS.NEEDS_IMPROVEMENT) return "needs-improvement";
  if (score >= SEVERITY_THRESHOLDS.CRITICAL) return "critical";
  return "severe";
}
