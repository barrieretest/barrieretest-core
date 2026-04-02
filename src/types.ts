import type { AIAnalysis, AIProviderConfig, AIProviderName } from "./ai/index.js";
import type { BaselineInfo } from "./baseline/integration.js";
import type { BrowserPage } from "./browser.js";
import type { LocalizationResult } from "./localization/index.js";
import type { ScoreInterpretation, SeverityLevel, TransformedIssue } from "./scoring.js";

/**
 * Severity levels for accessibility issues
 */
export type IssueSeverity = "critical" | "serious" | "moderate" | "minor";

/**
 * Severity hierarchy for filtering (higher index = more severe)
 */
export const SEVERITY_HIERARCHY: IssueSeverity[] = ["minor", "moderate", "serious", "critical"];

/**
 * Detail levels for audit output
 */
export type DetailLevel = "minimal" | "actionable" | "fix-ready";

/**
 * A single accessibility issue
 */
export interface Issue {
  /** Rule/code identifier (e.g., "WCAG2AA.Principle1.Guideline1_4.1_4_3") */
  id: string;
  /** Severity level */
  impact: IssueSeverity;
  /** Human-readable description of the issue */
  description: string;
  /** Additional context or help text */
  help: string;
  /** Link to WCAG documentation */
  helpUrl?: string;
  /** CSS selector for the affected element */
  selector: string | null;
  /** Affected DOM nodes */
  nodes: { html: string }[];
  /** Localization data (when localization is enabled) */
  localization?: LocalizationResult;
  /** AI analysis data (when AI is enabled) */
  ai?: AIAnalysis;
}

/**
 * Target for an accessibility audit - URL string or browser page object
 */
export type AuditTarget = string | BrowserPage;

/**
 * Options for running an accessibility audit
 */
export interface AuditOptions {
  /**
   * Pa11y runners to use.
   * - "htmlcs": HTML CodeSniffer (default)
   * - "axe": axe-core
   * @default ["htmlcs"]
   */
  runners?: ("htmlcs" | "axe")[];

  /**
   * Viewport dimensions for the browser.
   * Ignored when a page object is provided.
   * @default { width: 1280, height: 720 }
   */
  viewport?: { width: number; height: number };

  /**
   * Whether to run headless.
   * Ignored when a page object is provided.
   * @default true
   */
  headless?: boolean;

  /**
   * Audit timeout in milliseconds
   * @default 60000
   */
  timeout?: number;

  /**
   * Whether to capture a screenshot
   * @default true
   */
  captureScreenshot?: boolean;

  /**
   * Progress callback for tracking audit status
   */
  onProgress?: (data: { percent: number; message: string }) => void | Promise<void>;

  /**
   * Detail level for formatted output.
   * - "minimal": rule, severity, count only
   * - "actionable": + selector, WCAG criterion, description (default)
   * - "fix-ready": + suggested fix, code snippet, documentation links
   * @default "actionable"
   */
  detail?: DetailLevel;

  /**
   * Minimum severity level to report.
   * Issues below this severity will be filtered out.
   * Hierarchy: critical > serious > moderate > minor
   */
  minSeverity?: IssueSeverity;

  /**
   * Rule IDs to ignore.
   * Issues with matching rule IDs will be filtered out.
   */
  ignore?: string[];

  /**
   * Path to baseline file for tracking known issues.
   * When provided, audit results include baseline diff info.
   */
  baseline?: string;

  /**
   * Whether to update or create the baseline file with current issues.
   * Can also be enabled via BARRIERETEST_UPDATE_BASELINE=true env var.
   */
  updateBaseline?: boolean;

  /**
   * Localization options for finding source code locations.
   * Only runs when detail is 'fix-ready' and an existing Puppeteer page is provided.
   */
  localization?: {
    /** Whether to enable localization (default: true when detail is 'fix-ready') */
    enabled?: boolean;
    /** Whether to capture element screenshots */
    captureScreenshots?: boolean;
    /** Project root for codebase search */
    projectRoot?: string;
    /** Custom data attributes to search for */
    customAttributes?: string[];
    /** Which strategies to enable */
    enabledStrategies?: ("react" | "attribute" | "search" | "selector")[];
  };

  /**
   * AI enhancement options.
   * Requires an AI provider configuration.
   */
  ai?: {
    /** AI provider to use */
    provider: AIProviderName;
    /** Provider API key */
    apiKey: string;
    /** Model to use (provider-specific) */
    model?: string;
    /** Maximum issues to analyze (for cost control) */
    maxIssues?: number;
    /** Maximum concurrent requests */
    concurrency?: number;
  };
}

/**
 * Result of an accessibility audit
 */
export interface AuditResult {
  /** The URL that was audited */
  url: string;
  /** Document title of the audited page */
  documentTitle: string;
  /** Accessibility score (0-100) */
  score: number;
  /** Severity level based on score */
  severityLevel: SeverityLevel;
  /** Detailed score interpretation */
  scoreInterpretation: ScoreInterpretation;
  /** List of accessibility issues found */
  issues: Issue[];
  /** Screenshot of the page (if captured) */
  screenshot?: Uint8Array;
  /** Timestamp of the audit */
  timestamp: string;
  /** Baseline comparison info (if baseline was provided) */
  baseline?: BaselineInfo;
}

export type { BrowserPage } from "./browser.js";
export type { ScoreInterpretation, SeverityLevel, TransformedIssue };
