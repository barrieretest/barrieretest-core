/**
 * JSON Schema for the semantic-audit response.
 *
 * Mirrors the prose contract `buildResponseSection` puts in the prompt, so
 * both request paths ask for the same document: providers without native
 * structured output get the prose version, providers with it get this schema.
 *
 * Strict mode on Mistral and OpenAI requires every property to appear in
 * `required` and `additionalProperties: false` on every object, so optional
 * fields are expressed as nullable instead. The parser treats `null` as
 * absent.
 */

import type { JsonSchemaObject } from "../ai/types.js";

const NULLABLE_STRING = { type: ["string", "null"] } as const;

function buildSchema(checkType: JsonSchemaObject): JsonSchemaObject {
  return {
    type: "object",
    additionalProperties: false,
    required: ["issues", "detectedLanguage", "declaredLanguage", "landmarks", "overallAssessment"],
    properties: {
      issues: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "checkType",
            "severity",
            "message",
            "location",
            "context",
            "suggestion",
            "confidence",
          ],
          properties: {
            checkType,
            severity: { type: "string", enum: ["error", "warning", "notice"] },
            message: { type: "string" },
            location: { type: "string" },
            context: { ...NULLABLE_STRING },
            suggestion: { ...NULLABLE_STRING },
            confidence: { type: "number" },
          },
        },
      },
      detectedLanguage: { ...NULLABLE_STRING },
      declaredLanguage: { ...NULLABLE_STRING },
      landmarks: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["type", "label", "location"],
          properties: {
            type: { type: "string" },
            label: { ...NULLABLE_STRING },
            location: { ...NULLABLE_STRING },
          },
        },
      },
      overallAssessment: { ...NULLABLE_STRING },
    },
  };
}

/**
 * The response schema with `checkType` unconstrained.
 */
export const SEMANTIC_RESPONSE_SCHEMA: JsonSchemaObject = buildSchema({ type: "string" });

/**
 * The response schema with `checkType` restricted to the checks of one run,
 * which is the schema equivalent of the prompt's "must be one of" list.
 */
export function buildSemanticResponseSchema(checkIds: string[]): JsonSchemaObject {
  if (checkIds.length === 0) {
    return buildSchema({ type: "string" });
  }
  return buildSchema({ type: "string", enum: [...checkIds] });
}
