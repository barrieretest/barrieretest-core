/**
 * HTML context extraction for semantic audits.
 *
 * Pulls page metadata + a curated set of element snippets out of a live
 * browser page so the LLM has structured input it can reason over without
 * being handed the entire DOM.
 *
 * Ported from `backend/src/core/ai-audit.ts:extractHTMLContext`.
 */

import type { BrowserPage } from "../browser.js";
import type { SemanticContextLimits, SemanticContextSection } from "./types.js";

export interface ExtractedContext {
  pageTitle: string;
  langAttr: string;
  headSnippet: string;
  bodySnippet: string;
  ariaElements: string[];
  formElements: string[];
  images: string[];
  landmarks: string[];
}

export const DEFAULT_CONTEXT_LIMITS: Required<SemanticContextLimits> = {
  headSnippetChars: 1000,
  bodySnippetChars: 5000,
  maxAriaElements: 50,
  maxFormElements: 50,
  maxImages: 30,
  maxLandmarks: 50,
};

interface ResolvedLimits {
  headSnippetChars: number;
  bodySnippetChars: number;
  maxAriaElements: number;
  maxFormElements: number;
  maxImages: number;
  maxLandmarks: number;
}

function resolveLimits(limits?: SemanticContextLimits): ResolvedLimits {
  return {
    ...DEFAULT_CONTEXT_LIMITS,
    ...(limits ?? {}),
  };
}

/**
 * Extract structured HTML context from a live page.
 *
 * Only the categories named in `sections` are populated; others come back
 * as empty strings/arrays. This keeps prompt size proportional to what the
 * selected checks actually need.
 */
export async function extractHtmlContext(
  page: BrowserPage,
  sections: SemanticContextSection[],
  limits?: SemanticContextLimits
): Promise<ExtractedContext> {
  const resolved = resolveLimits(limits);
  const sectionSet = new Set(sections);

  const args = {
    needsHead: sectionSet.has("head"),
    needsBody: sectionSet.has("body"),
    needsAria: sectionSet.has("aria"),
    needsForms: sectionSet.has("forms"),
    needsImages: sectionSet.has("images"),
    needsLandmarks: sectionSet.has("landmarks"),
    headSnippetChars: resolved.headSnippetChars,
    bodySnippetChars: resolved.bodySnippetChars,
    maxAriaElements: resolved.maxAriaElements,
    maxFormElements: resolved.maxFormElements,
    maxImages: resolved.maxImages,
    maxLandmarks: resolved.maxLandmarks,
  };

  return page.evaluate((opts) => {
    const doc = document;
    const pageTitle = doc.title;
    const langAttr = doc.documentElement.lang || "not specified";

    const headSnippet = opts.needsHead
      ? doc.head.innerHTML.substring(0, opts.headSnippetChars)
      : "";

    const bodySnippet = opts.needsBody
      ? doc.body.innerHTML.substring(0, opts.bodySnippetChars)
      : "";

    const ariaElements: string[] = [];
    if (opts.needsAria) {
      doc.querySelectorAll("[aria-label], [aria-labelledby], [aria-describedby]").forEach((el) => {
        ariaElements.push(el.outerHTML.substring(0, 200));
      });
    }

    const formElements: string[] = [];
    if (opts.needsForms) {
      doc.querySelectorAll("input, select, textarea, button").forEach((el) => {
        formElements.push(el.outerHTML.substring(0, 200));
      });
    }

    const images: string[] = [];
    if (opts.needsImages) {
      doc.querySelectorAll("img").forEach((el) => {
        images.push(el.outerHTML.substring(0, 200));
      });
    }

    const landmarks: string[] = [];
    if (opts.needsLandmarks) {
      doc.querySelectorAll("main, nav, aside, header, footer, [role]").forEach((el) => {
        landmarks.push(el.outerHTML.substring(0, 200));
      });
    }

    return {
      pageTitle,
      langAttr,
      headSnippet,
      bodySnippet,
      ariaElements: ariaElements.slice(0, opts.maxAriaElements),
      formElements: formElements.slice(0, opts.maxFormElements),
      images: images.slice(0, opts.maxImages),
      landmarks: landmarks.slice(0, opts.maxLandmarks),
    };
  }, args);
}

/**
 * Format an `ExtractedContext` as a structured plain-text block suitable for
 * inclusion in an LLM prompt. Sections that weren't extracted are omitted.
 */
export function formatExtractedContext(context: ExtractedContext): string {
  const parts: string[] = [
    `Page Title: ${context.pageTitle}`,
    `Lang Attribute: ${context.langAttr}`,
  ];

  if (context.headSnippet) {
    parts.push("", "=== HEAD (snippet) ===", context.headSnippet);
  }
  if (context.bodySnippet) {
    parts.push("", "=== BODY (snippet) ===", context.bodySnippet);
  }
  if (context.ariaElements.length > 0) {
    parts.push("", "=== ARIA ELEMENTS ===", context.ariaElements.join("\n"));
  }
  if (context.formElements.length > 0) {
    parts.push("", "=== FORM ELEMENTS ===", context.formElements.join("\n"));
  }
  if (context.images.length > 0) {
    parts.push("", "=== IMAGES ===", context.images.join("\n"));
  }
  if (context.landmarks.length > 0) {
    parts.push("", "=== LANDMARKS ===", context.landmarks.join("\n"));
  }

  return parts.join("\n");
}
