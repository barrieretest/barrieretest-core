import type { AIAnalysis, AIProviderConfig, AIProviderName } from "./ai/index.js";
import type { BaselineInfo } from "./baseline/integration.js";
import type { BrowserPage } from "./browser.js";
import type { LocalizationResult } from "./localization/index.js";
import type { ScoreInterpretation, SeverityLevel, TransformedIssue } from "./scoring.js";
import type { SemanticMeta, SemanticOptions } from "./semantic/types.js";

/**
 * Severity levels for accessibility issues
 */
export type IssueSeverity = "critical" | "serious" | "moderate" | "minor";

/**
 * Accessibility engine to use for audits.
 * - "axe": axe-core (default) — runs directly in the page, works with any browser
 * - "pa11y": pa11y with HTML CodeSniffer — requires puppeteer
 */
export type AuditEngine = "axe" | "pa11y";

/**
 * Severity hierarchy for filtering (higher index = more severe)
 */
export const SEVERITY_HIERARCHY: IssueSeverity[] = ["minor", "moderate", "serious", "critical"];

/**
 * Detail levels for audit output
 */
export type DetailLevel = "minimal" | "actionable" | "fix-ready";

/**
 * Per-issue metadata attached when an Issue was produced by a semantic check
 * (see `src/semantic/`). Lives here to keep the `Issue` shape self-contained
 * and avoid circular imports between `types.ts` and `semantic/types.ts`.
 */
export interface SemanticIssueMeta {
  /** Check identifier, e.g. "aria-mismatch". */
  checkType: string;
  /** Confidence 0-1 reported by the AI. */
  confidence: number;
  /** Suggested fix from the AI, if any. */
  suggestion?: string;
}

/**
 * Rectangle of an annotated element, in CSS pixels in document space, origin
 * at the top-left of the full-page screenshot. Whole pixels, rounded outward
 * from the measured box and clipped to the captured area.
 */
export interface AnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * How well an `Issue.selector` resolved against the measured DOM.
 * - "resolved": matched exactly one element with a usable rect inside the capture
 * - "ambiguous": matched more than one element; rect and mark belong to the first match
 * - "hidden": matched, but the (first) element is not visibly rendered in the capture
 * - "page": the issue is about the page itself (the selector resolved to `html`
 *   or `body`, as page-level axe rules do), so there is nothing to box
 * - "unresolved": selector null/empty, invalid, no match, or measurement failed
 */
export type AnnotationState = "resolved" | "ambiguous" | "hidden" | "page" | "unresolved";

/**
 * Where an issue sits on the page screenshot (see `AuditResult.screenshotMeta`).
 * Attached by `audit()` when annotation is effective.
 */
export interface IssueAnnotation {
  /** The selector that was resolved (`Issue.selector` at annotation time). */
  selector: string | null;
  state: AnnotationState;
  /** Only for "resolved" and "ambiguous". Clipped to the captured area. */
  rect?: AnnotationRect;
  /** Only for "resolved" and "ambiguous". 1-based; issues on the same element share one number. */
  mark?: number;
  /** Present (true) when the element or an ancestor is `position: fixed` or `sticky`. */
  anchored?: true;
}

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
  /** Rule-level remediation summary */
  help: string;
  /** Link to WCAG documentation */
  helpUrl?: string;
  /** Per-node failure summary describing what is wrong with the specific element, when the engine provides one */
  failureSummary?: string;
  /** CSS selector for the affected element */
  selector: string | null;
  /** Affected DOM nodes */
  nodes: { html: string }[];
  /** Localization data (when localization is enabled) */
  localization?: LocalizationResult;
  /** AI analysis data (when AI is enabled) */
  ai?: AIAnalysis;
  /** Semantic-check metadata (when produced by `semanticAudit`) */
  semantic?: SemanticIssueMeta;
  /** Position on the page screenshot (when annotation ran) */
  annotation?: IssueAnnotation;
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
   * Accessibility engine to use.
   * - "axe": axe-core (default) — works with any browser page
   * - "pa11y": pa11y with HTML CodeSniffer — requires puppeteer
   * @default "axe"
   */
  engine?: AuditEngine;

  /**
   * Pa11y runners to use. Only relevant when `engine` is `'pa11y'`.
   * - "htmlcs": HTML CodeSniffer (default)
   * - "axe": axe-core (pa11y's built-in runner)
   * @default ["htmlcs"]
   * @deprecated Use `engine: 'axe'` instead of `runners: ['axe']`.
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
   * Whether to annotate issues with their position on the screenshot
   * (`Issue.annotation`) and report the capture geometry
   * (`AuditResult.screenshotMeta`).
   *
   * Effective only when `captureScreenshot` is true, the engine is `'axe'`,
   * and a screenshot was actually captured. Costs one browser round trip.
   * @default true
   */
  annotate?: boolean;

  /**
   * Whether to scroll the page through once before anything is measured, so
   * images with `loading="lazy"`, script-based lazy loaders and
   * reveal-on-scroll effects below the first viewport have loaded. Bounded by
   * hard caps on distance, steps and time, and it never fails an audit; the
   * page ends back at scroll position 0.
   *
   * Runs whenever the audit itself navigates: the axe engine navigates only
   * when the page is not already at the target URL, the pa11y engine always
   * navigates. So a browser page you pass in keeps the scroll position you
   * left it at only when it is already at the target URL and the engine is
   * `axe`; with `engine: 'pa11y'` it is navigated and then scrolled.
   *
   * Turning it off restores the earlier behavior, where content below the
   * fold was audited and captured unloaded.
   * @default true
   */
  loadLazyContent?: boolean;

  /**
   * Progress callback for tracking audit status
   */
  onProgress?: (data: { percent: number; message: string }) => void | Promise<void>;

  /**
   * Detail level for formatted output.
   * - "minimal": rule, severity, count only
   * - "actionable": + selector, WCAG criterion, description (default)
   * - "fix-ready": + help text, per-element failure summary, code snippet, documentation links
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

  /**
   * Optional semantic-audit pass.
   *
   * When set, after the regular engine pass `audit()` runs `semanticAudit()`
   * against the same page and merges the resulting issues into
   * `result.issues`. Pass-level metadata is attached as `result.semanticMeta`.
   *
   * Supported combinations:
   * - URL target with `engine: 'axe'` (default) — `audit()` owns the browser
   *   so the engine and semantic passes share a single page.
   * - Existing browser page target — both passes use the page you provided.
   *
   * Not supported in this release:
   * - URL target with `engine: 'pa11y'` — the semantic pass is skipped with
   *   a warning, since pa11y manages its own browser internally and we'd
   *   need a second launch to run semantic.
   */
  semantic?: SemanticOptions;
}

/**
 * Geometry of the page screenshot on an `AuditResult`, so a consumer can
 * place `IssueAnnotation` rects without knowing how the capture was taken.
 */
export interface ScreenshotMeta {
  /** CSS px size of the captured image (PNG pixel size / `deviceScaleFactor`). */
  width: number;
  height: number;
  deviceScaleFactor: number;
  viewport: { width: number; height: number };
  fullPage: true;
  /**
   * Document scroll size at measurement time, CSS px. Differs from
   * `width`/`height` when the page grew after the capture or the capture
   * was truncated.
   */
  document: { width: number; height: number };
  /** Scroll offset at measurement time. Non-zero means rects of anchored elements are unreliable. */
  scroll: { x: number; y: number };
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
  /** Semantic-pass metadata (if `semantic` option was set) */
  semanticMeta?: SemanticMeta;
  /** Geometry of `screenshot`, for placing `Issue.annotation` rects (if annotation ran) */
  screenshotMeta?: ScreenshotMeta;
}

export type { BrowserPage } from "./browser.js";
export type { ScoreInterpretation, SeverityLevel, TransformedIssue };
