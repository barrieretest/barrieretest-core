/**
 * Prompt context sanitizer.
 *
 * Strips obviously dangerous markup (script/style/iframe/...) and obvious
 * prompt-injection cues from page content before it is sent to the LLM.
 *
 * Ported from the previous `backend/src/utils/prompt-sanitizer.ts`.
 */

type Pattern = {
  label: string;
  pattern: RegExp;
};

const BLOCKED_SECTION_PATTERNS: Pattern[] = [
  { label: "script", pattern: /<script\b[^>]*>[\s\S]*?<\/script>/gi },
  { label: "style", pattern: /<style\b[^>]*>[\s\S]*?<\/style>/gi },
  { label: "iframe", pattern: /<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi },
  { label: "noscript", pattern: /<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi },
  { label: "object", pattern: /<object\b[^>]*>[\s\S]*?<\/object>/gi },
  { label: "embed", pattern: /<embed\b[^>]*>[\s\S]*?<\/embed>/gi },
];

const PROMPT_INJECTION_PATTERNS: Pattern[] = [
  {
    label: "ignore-previous-instructions",
    pattern: /ignore\s+(?:all\s+)?previous instructions/gi,
  },
  {
    label: "system-prompt-override",
    pattern: /(?:system\s+prompt|reset\s+instructions)/gi,
  },
  { label: "role-change", pattern: /you\s+are\s+(?:now|no\s+longer)/gi },
  { label: "act-as", pattern: /act\s+as\s+/gi },
  { label: "prompt-injection-callout", pattern: /prompt\s+injection/gi },
  {
    label: "tool-disable",
    pattern: /(disable|ignore)\s+(?:security|safety)\s+(?:filters|guardrails)/gi,
  },
  {
    label: "data-exfil",
    pattern: /(exfiltrate|leak|expose)\s+(?:data|secrets?)/gi,
  },
];

export interface SanitizedPromptContext {
  sanitized: string;
  removedSections: string[];
  flaggedPatterns: string[];
  originalLength: number;
}

const buildRegex = (pattern: RegExp) => new RegExp(pattern.source, pattern.flags);

/**
 * Remove obvious prompt-injection attempts and high-risk markup before
 * sending context to the LLM.
 */
export function sanitizePromptContext(raw: string): SanitizedPromptContext {
  const original = raw ?? "";
  let sanitized = original;
  const removedSections: string[] = [];
  const flaggedPatterns: string[] = [];

  for (const { label, pattern } of BLOCKED_SECTION_PATTERNS) {
    const regex = buildRegex(pattern);
    if (regex.test(sanitized)) {
      removedSections.push(label);
      sanitized = sanitized.replace(regex, `[REMOVED_${label.toUpperCase()}]`);
    }
  }

  for (const { label, pattern } of PROMPT_INJECTION_PATTERNS) {
    const regex = buildRegex(pattern);
    if (regex.test(sanitized)) {
      flaggedPatterns.push(label);
      sanitized = sanitized.replace(regex, `[REMOVED_PROMPT_INJECTION:${label}]`);
    }
  }

  // Strip null bytes and control characters that commonly show up in
  // obfuscated injections.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — stripping control chars is the point
  sanitized = sanitized.replace(/[\u0000-\u001F\u007F]/g, " ").trim();

  return {
    sanitized,
    removedSections,
    flaggedPatterns,
    originalLength: original.length,
  };
}
