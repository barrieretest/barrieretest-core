/**
 * Parser for semantic-audit AI responses.
 *
 * The runner asks the model for a JSON document containing findings plus
 * pass-level metadata. This module is responsible for extracting that JSON
 * (even if wrapped in markdown fences), validating its shape, and producing
 * `RawSemanticFinding[]` + `SemanticMeta` for the runner to map into Issues.
 */

import type { RawSemanticFinding, SemanticLandmark, SemanticSeverity } from "./types.js";

export interface ParsedSemanticResponse {
  findings: RawSemanticFinding[];
  detectedLanguage?: string;
  declaredLanguage?: string;
  landmarks?: SemanticLandmark[];
  overallAssessment?: string;
}

const VALID_SEVERITIES: ReadonlySet<SemanticSeverity> = new Set(["error", "warning", "notice"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function coerceSeverity(value: unknown): SemanticSeverity {
  if (typeof value === "string" && VALID_SEVERITIES.has(value as SemanticSeverity)) {
    return value as SemanticSeverity;
  }
  return "warning";
}

function coerceFinding(raw: unknown): RawSemanticFinding | null {
  if (!isObject(raw)) return null;

  const checkType = pickString(raw.checkType);
  const message = pickString(raw.message);
  if (!checkType || !message) return null;

  return {
    checkType,
    severity: coerceSeverity(raw.severity),
    message,
    location: pickString(raw.location) ?? "",
    context: pickString(raw.context),
    suggestion: pickString(raw.suggestion),
    confidence: typeof raw.confidence === "number" ? raw.confidence : undefined,
  };
}

function coerceLandmark(raw: unknown): SemanticLandmark | null {
  if (!isObject(raw)) return null;
  const type = pickString(raw.type);
  if (!type) return null;
  return {
    type,
    label: pickString(raw.label),
    location: pickString(raw.location),
  };
}

/**
 * Extract a JSON object from a model response, even if it is wrapped in
 * a markdown code fence or has surrounding prose.
 */
export function extractJsonObject(content: string): string {
  const fenceMatch = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenceMatch) return fenceMatch[1];

  const braceMatch = content.match(/\{[\s\S]*\}/);
  if (braceMatch) return braceMatch[0];

  throw new Error("No JSON object found in semantic AI response");
}

/**
 * Parse the model's JSON response into structured findings and metadata.
 */
export function parseSemanticResponse(content: string): ParsedSemanticResponse {
  const json = extractJsonObject(content);
  const parsed = JSON.parse(json) as unknown;

  if (!isObject(parsed)) {
    throw new Error("Semantic AI response was not a JSON object");
  }

  const issuesRaw = Array.isArray(parsed.issues) ? parsed.issues : [];
  const findings = issuesRaw
    .map(coerceFinding)
    .filter((finding): finding is RawSemanticFinding => finding !== null);

  const landmarksRaw = Array.isArray(parsed.landmarks) ? parsed.landmarks : undefined;
  const landmarks = landmarksRaw
    ?.map(coerceLandmark)
    .filter((l): l is SemanticLandmark => l !== null);

  return {
    findings,
    detectedLanguage: pickString(parsed.detectedLanguage),
    declaredLanguage: pickString(parsed.declaredLanguage),
    landmarks: landmarks && landmarks.length > 0 ? landmarks : undefined,
    overallAssessment: pickString(parsed.overallAssessment),
  };
}
