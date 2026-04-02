/**
 * Codebase search strategy for source code localization
 *
 * Searches project files for element identifiers to find
 * where components are defined.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { BrowserPage } from "../browser";

export interface SearchMatch {
  /** File path relative to project root */
  filePath: string;
  /** Line number (1-indexed) */
  lineNumber: number;
  /** The matched line content */
  lineContent: string;
  /** What identifier matched */
  matchedIdentifier: string;
  /** Confidence score (0-1) */
  confidence: number;
}

export interface SearchOptions {
  /** Project root directory to search */
  projectRoot: string;
  /** File extensions to search */
  extensions?: string[];
  /** Directories to exclude */
  excludeDirs?: string[];
  /** Maximum files to search */
  maxFiles?: number;
}

/**
 * Extended page type with full evaluate signature
 */
type PageWithEvaluate = BrowserPage & {
  evaluate: <T, Args extends unknown[]>(fn: (...args: Args) => T, ...args: Args) => Promise<T>;
};

const DEFAULT_EXTENSIONS = [".tsx", ".jsx", ".ts", ".js", ".vue", ".svelte"];
const DEFAULT_EXCLUDE_DIRS = ["node_modules", ".git", "dist", "build", ".next", "coverage"];
const DEFAULT_MAX_FILES = 1000;

/**
 * Extracts searchable identifiers from an element
 */
export async function extractSearchableIdentifiers(
  page: BrowserPage,
  selector: string
): Promise<string[]> {
  const evalPage = page as PageWithEvaluate;

  const identifiers = await evalPage.evaluate((selector: string): string[] => {
    const element = document.querySelector(selector);
    if (!element) return [];

    const results: string[] = [];

    // Class names (filter out utility classes)
    const classes = Array.from(element.classList).filter((cls) => {
      // Skip obvious utility classes
      if (/^(p|m|w|h|flex|grid|text|bg|border|rounded)-/.test(cls)) return false;
      if (/^(col|row)-\d+$/.test(cls)) return false;
      // Keep component-like classes
      return cls.length > 3;
    });
    results.push(...classes);

    // ID attribute
    const id = element.id;
    if (id && id.length > 2) {
      results.push(id);
    }

    // ARIA label
    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.length > 3 && ariaLabel.length < 50) {
      results.push(ariaLabel);
    }

    // Text content (for buttons, links - short text only)
    if (element.tagName === "BUTTON" || element.tagName === "A") {
      const text = element.textContent?.trim();
      if (text && text.length > 2 && text.length < 30 && !/\s{2,}/.test(text)) {
        results.push(text);
      }
    }

    // Data attributes that might indicate component names
    const testId = element.getAttribute("data-testid");
    if (testId) results.push(testId);

    return [...new Set(results)];
  }, selector);

  return identifiers;
}

/**
 * Searches project files for identifiers
 */
export async function searchCodebase(
  identifiers: string[],
  options: SearchOptions
): Promise<SearchMatch[]> {
  const {
    projectRoot,
    extensions = DEFAULT_EXTENSIONS,
    excludeDirs = DEFAULT_EXCLUDE_DIRS,
    maxFiles = DEFAULT_MAX_FILES,
  } = options;

  if (identifiers.length === 0) {
    return [];
  }

  // Collect files to search
  const files = await collectFiles(projectRoot, extensions, excludeDirs, maxFiles);

  const matches: SearchMatch[] = [];

  // Search each file
  for (const filePath of files) {
    try {
      const content = await readFile(filePath, "utf-8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        for (const identifier of identifiers) {
          if (line.includes(identifier)) {
            const confidence = calculateConfidence(identifier, line, filePath);

            matches.push({
              filePath: relative(projectRoot, filePath),
              lineNumber: i + 1,
              lineContent: line.trim().slice(0, 200),
              matchedIdentifier: identifier,
              confidence,
            });
          }
        }
      }
    } catch {
      // Skip files that can't be read
    }
  }

  // Sort by confidence (highest first)
  matches.sort((a, b) => b.confidence - a.confidence);

  // Return top matches (limit to avoid overwhelming results)
  return matches.slice(0, 10);
}

/**
 * Recursively collects files matching extensions
 */
async function collectFiles(
  dir: string,
  extensions: string[],
  excludeDirs: string[],
  maxFiles: number,
  collected: string[] = []
): Promise<string[]> {
  if (collected.length >= maxFiles) {
    return collected;
  }

  try {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (collected.length >= maxFiles) break;

      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!excludeDirs.includes(entry.name)) {
          await collectFiles(fullPath, extensions, excludeDirs, maxFiles, collected);
        }
      } else if (entry.isFile()) {
        if (extensions.some((ext) => entry.name.endsWith(ext))) {
          collected.push(fullPath);
        }
      }
    }
  } catch {
    // Skip directories that can't be read
  }

  return collected;
}

/**
 * Calculates confidence score for a match
 */
function calculateConfidence(identifier: string, line: string, filePath: string): number {
  let confidence = 0.3; // Base confidence

  // Higher confidence for component files
  if (/\.(tsx|jsx)$/.test(filePath)) {
    confidence += 0.1;
  }

  // Higher confidence if identifier appears in a JSX-like context
  if (line.includes(`className="${identifier}"`) || line.includes(`className='${identifier}'`)) {
    confidence += 0.3;
  }
  if (line.includes(`className={`) && line.includes(identifier)) {
    confidence += 0.2;
  }

  // Higher confidence for component definition patterns
  if (line.includes(`function ${identifier}`) || line.includes(`const ${identifier}`)) {
    confidence += 0.4;
  }

  // Higher confidence for data-testid matches
  if (
    line.includes(`data-testid="${identifier}"`) ||
    line.includes(`data-testid='${identifier}'`)
  ) {
    confidence += 0.3;
  }

  // Higher confidence for aria-label matches
  if (line.includes(`aria-label="${identifier}"`) || line.includes(`aria-label='${identifier}'`)) {
    confidence += 0.2;
  }

  // Lower confidence for very common identifiers
  if (["button", "link", "header", "footer", "main", "nav"].includes(identifier.toLowerCase())) {
    confidence -= 0.2;
  }

  return Math.min(1, Math.max(0, confidence));
}

/**
 * High-level search: extract identifiers and search codebase
 */
export async function searchForElement(
  page: BrowserPage,
  selector: string,
  options: SearchOptions
): Promise<SearchMatch | null> {
  const identifiers = await extractSearchableIdentifiers(page, selector);

  if (identifiers.length === 0) {
    return null;
  }

  const matches = await searchCodebase(identifiers, options);

  // Return the highest confidence match
  return matches[0] || null;
}
