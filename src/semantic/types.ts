/**
 * Types for AI-driven semantic accessibility audits.
 *
 * The `semanticAudit()` feature runs vision + reasoning checks that
 * traditional rule engines (axe, pa11y) cannot find on their own — for
 * example whether an `aria-label` actually matches the visible text, or
 * whether the page title is meaningful.
 *
 * Designed around an extensible check registry so new checks are one new
 * file plus one registry entry.
 */

import type { Issue, IssueSeverity, SemanticIssueMeta } from "../types.js";

export type { SemanticIssueMeta };

/**
 * Severity used by AI semantic checks before mapping to core's `IssueSeverity`.
 */
export type SemanticSeverity = "error" | "warning" | "notice";

/**
 * Categories of HTML context a semantic check might need extracted from
 * the page. Only the union of needed sections is gathered for a given run.
 */
export type SemanticContextSection =
  | "head"
  | "body"
  | "aria"
  | "forms"
  | "images"
  | "landmarks";

/**
 * A finding produced by the AI for a single check, before it is normalized
 * into the standard `Issue` shape.
 */
export interface RawSemanticFinding {
  checkType: string;
  severity: SemanticSeverity;
  message: string;
  location: string;
  context?: string;
  suggestion?: string;
  /** Confidence score reported by the AI (0-100). */
  confidence?: number;
}

/**
 * A semantic check descriptor. Adding a new check is one new file plus one
 * registry entry — no plumbing changes elsewhere.
 */
export interface SemanticCheck {
  /** Unique ID, e.g. "aria-mismatch". Used in `Issue.id` as `semantic:<id>`. */
  id: string;
  /** Short title shown in reports and prompts. */
  title: string;
  /** Longer description shown in the prompt. */
  description: string;
  /** Numbered prompt instruction injected into the assembled prompt. */
  promptSection: string;
  /** Whether this check needs the screenshot in the AI call. */
  needsScreenshot: boolean;
  /** Which HTML context sections this check needs. */
  needsContext: SemanticContextSection[];
  /** Optional WCAG help URL. */
  helpUrl?: string;
  /**
   * Optional override for converting a raw finding into an `Issue`. Most
   * checks can rely on the runner's default mapping.
   */
  parseIssue?: (raw: RawSemanticFinding, check: SemanticCheck) => Issue;
}

/**
 * Tunable HTML context extraction limits. Defaults are reasonable for the
 * built-in checks; bump them if a custom check needs more.
 */
export interface SemanticContextLimits {
  headSnippetChars?: number;
  bodySnippetChars?: number;
  maxAriaElements?: number;
  maxFormElements?: number;
  maxImages?: number;
  maxLandmarks?: number;
}

/**
 * Identified landmark region from the AI's pass.
 */
export interface SemanticLandmark {
  type: string;
  label?: string;
  location?: string;
}

/**
 * Pass-level metadata returned by a semantic audit.
 */
export interface SemanticMeta {
  detectedLanguage?: string;
  declaredLanguage?: string;
  landmarks?: SemanticLandmark[];
  overallAssessment?: string;
  /** Which check IDs ran in this pass. */
  checksRun: string[];
  /** Provider name (e.g., "nebius"). */
  provider: string;
  /** Model identifier used. */
  model: string;
}

/**
 * Result of a standalone `semanticAudit()` call.
 */
export interface SemanticAuditResult {
  url: string;
  issues: Issue[];
  meta: SemanticMeta;
  screenshot?: Uint8Array;
  timestamp: string;
}

/**
 * Provider configuration for the semantic pass. Same shape as the per-issue
 * `audit({ ai: ... })` config — kept separate so the two AI features can
 * evolve independently.
 */
export interface SemanticProviderConfig {
  name: "nebius" | "openai" | "anthropic";
  apiKey: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Options for `semanticAudit()` and the `audit({ semantic: ... })` integration.
 */
export interface SemanticOptions {
  /** AI provider configuration. */
  provider: SemanticProviderConfig;
  /** Which check IDs to run. Defaults to all built-in checks. */
  checks?: string[];
  /** Custom checks to register for this run. */
  customChecks?: SemanticCheck[];
  /** HTML context extraction tuning. */
  context?: SemanticContextLimits;
  /** Progress callback. */
  onProgress?: (data: { percent: number; message: string }) => void | Promise<void>;
  /** Timeout for the AI call (ms). Default 120_000. */
  timeout?: number;
  /** Headless browser launch flag (only used when target is a URL). */
  headless?: boolean;
  /** Viewport for screenshot (only used when target is a URL). */
  viewport?: { width: number; height: number };
}

/**
 * Input passed to `AIProvider.analyzeSemantic()`. Unlike the per-issue
 * `AIAnalysisInput`, the prompt is fully assembled by the runner so the
 * provider only handles transport and message shape.
 */
export interface SemanticAnalysisInput {
  /** Fully assembled user prompt. */
  prompt: string;
  /** Optional PNG screenshot to include in the message. */
  screenshot?: Uint8Array;
  /** Optional system prompt. */
  system?: string;
  /** Per-call timeout in milliseconds. */
  timeout?: number;
}

/**
 * Raw response shape returned by `AIProvider.analyzeSemantic()`. The runner
 * is responsible for parsing the content into findings + metadata.
 */
export interface SemanticAnalysisResponse {
  /** Raw text content from the model (expected to be JSON). */
  content: string;
  /** Model identifier the provider actually used (for metadata). */
  model: string;
}

/**
 * Severity hierarchy used by the default `RawSemanticFinding -> Issue` mapper.
 * Exposed so custom `parseIssue` overrides can stay consistent.
 */
export const SEMANTIC_SEVERITY_MAP: Record<SemanticSeverity, IssueSeverity> = {
  error: "serious",
  warning: "moderate",
  notice: "minor",
};
