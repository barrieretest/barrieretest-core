/**
 * Data attribute strategy for component localization
 *
 * Searches elements and their ancestors for data attributes
 * that hint at component identity or source location.
 */

import type { BrowserPage } from "../browser.js";

/**
 * Extended page type with full evaluate signature
 */
type PageWithEvaluate = BrowserPage & {
  evaluate: <T, Args extends unknown[]>(fn: (...args: Args) => T, ...args: Args) => Promise<T>;
};

export interface AttributeMatch {
  /** The attribute name that matched */
  attribute: string;
  /** The attribute value */
  value: string;
  /** Extracted component name (if identifiable) */
  componentName?: string;
  /** Whether the match was on the element itself or an ancestor */
  fromAncestor: boolean;
  /** How many levels up the ancestor is (0 = element itself) */
  ancestorDepth: number;
}

export interface AttributeSearchOptions {
  /** Additional data attributes to search for (beyond defaults) */
  customAttributes?: string[];
  /** Maximum ancestor depth to search */
  maxAncestorDepth?: number;
}

/** Default data attributes to search for */
const DEFAULT_ATTRIBUTES = [
  "data-testid",
  "data-test-id",
  "data-cy", // Cypress
  "data-component",
  "data-source",
  "data-module",
];

const DEFAULT_MAX_DEPTH = 5;

/**
 * Searches an element and its ancestors for component-identifying data attributes
 *
 * @param page - Browser page object
 * @param selector - CSS selector for the target element
 * @param options - Search options
 * @returns First matching attribute or null if none found
 */
export async function findComponentAttribute(
  page: BrowserPage,
  selector: string,
  options: AttributeSearchOptions = {}
): Promise<AttributeMatch | null> {
  const attributes = [...DEFAULT_ATTRIBUTES, ...(options.customAttributes || [])];
  const maxDepth = options.maxAncestorDepth ?? DEFAULT_MAX_DEPTH;
  const evalPage = page as PageWithEvaluate;

  const result = await evalPage.evaluate(
    (
      selector: string,
      attributes: string[],
      maxDepth: number
    ): {
      found: boolean;
      attribute?: string;
      value?: string;
      fromAncestor?: boolean;
      ancestorDepth?: number;
    } => {
      const element = document.querySelector(selector);
      if (!element) {
        return { found: false };
      }

      let current: Element | null = element;
      let depth = 0;

      while (current && depth <= maxDepth) {
        for (const attr of attributes) {
          const value = current.getAttribute(attr);
          if (value) {
            return {
              found: true,
              attribute: attr,
              value,
              fromAncestor: depth > 0,
              ancestorDepth: depth,
            };
          }
        }

        current = current.parentElement;
        depth++;
      }

      return { found: false };
    },
    selector,
    attributes,
    maxDepth
  );

  if (!result.found || !result.attribute || !result.value) {
    return null;
  }

  return {
    attribute: result.attribute,
    value: result.value,
    componentName: extractComponentName(result.value),
    fromAncestor: result.fromAncestor ?? false,
    ancestorDepth: result.ancestorDepth ?? 0,
  };
}

/**
 * Extracts a component name from an attribute value
 *
 * Handles common patterns:
 * - "UserProfile" -> "UserProfile"
 * - "user-profile" -> "UserProfile"
 * - "UserProfile__header" -> "UserProfile"
 * - "user-profile-header" -> "UserProfileHeader" (or "user-profile" prefix)
 */
function extractComponentName(value: string): string | undefined {
  if (!value) return undefined;

  // If it looks like a PascalCase component name, use it directly
  if (/^[A-Z][a-zA-Z0-9]*$/.test(value)) {
    return value;
  }

  // Handle BEM-style: ComponentName__element or ComponentName--modifier
  const bemMatch = value.match(/^([A-Z][a-zA-Z0-9]*)(?:__|--)/);
  if (bemMatch) {
    return bemMatch[1];
  }

  // Handle kebab-case: component-name -> ComponentName
  if (value.includes("-") && /^[a-z]/.test(value)) {
    // Only convert if it looks like a component name (not a generic class like "btn-primary")
    if (!isGenericClassName(value)) {
      return kebabToPascal(value.split("__")[0].split("--")[0]);
    }
  }

  // Handle snake_case: component_name -> ComponentName
  if (value.includes("_") && /^[a-z]/.test(value)) {
    return snakeToPascal(value);
  }

  // Return the value as-is if it seems component-like
  if (/[A-Z]/.test(value) && value.length > 2) {
    return value;
  }

  return undefined;
}

/**
 * Checks if a class name is a generic utility class rather than a component
 */
function isGenericClassName(name: string): boolean {
  const genericPrefixes = [
    "btn",
    "col",
    "row",
    "flex",
    "grid",
    "text",
    "bg",
    "border",
    "p-",
    "m-",
    "w-",
    "h-",
    "mt-",
    "mb-",
    "ml-",
    "mr-",
    "pt-",
    "pb-",
    "pl-",
    "pr-",
    "px-",
    "py-",
    "mx-",
    "my-",
  ];

  return genericPrefixes.some((prefix) => name.startsWith(prefix));
}

/**
 * Converts kebab-case to PascalCase
 */
function kebabToPascal(str: string): string {
  return str
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/**
 * Converts snake_case to PascalCase
 */
function snakeToPascal(str: string): string {
  return str
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}
