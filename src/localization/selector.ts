/**
 * Selector-based fallback for component localization
 *
 * Parses CSS selectors to extract component name hints from class names.
 * This is a low-confidence fallback when other strategies fail.
 */

export interface SelectorAnalysis {
  /** Guessed component name */
  componentName: string;
  /** Confidence level (always 'low' for this strategy) */
  confidence: "low";
  /** The class or pattern that suggested this name */
  source: string;
}

/**
 * Patterns for CSS module hashes (framework-specific)
 */
const CSS_MODULE_PATTERNS = [
  // Next.js/Webpack: ComponentName_className__hash
  /^([A-Z][a-zA-Z0-9]+)_[a-z][a-zA-Z0-9]*__[a-zA-Z0-9]+$/,
  // Vite: _componentName_hash
  /^_([a-z][a-zA-Z0-9]+)_[a-zA-Z0-9]+$/,
  // CSS Modules generic: styles_ComponentName__hash
  /^styles_([A-Z][a-zA-Z0-9]+)__[a-zA-Z0-9]+$/,
  // Emotion/styled-components: css-hash (less useful, skip)
];

/**
 * Generic utility class prefixes to ignore
 */
const UTILITY_PREFIXES = [
  "btn",
  "col",
  "row",
  "flex",
  "grid",
  "text",
  "bg",
  "border",
  "rounded",
  "shadow",
  "p-",
  "m-",
  "w-",
  "h-",
  "gap-",
  "space-",
  "justify-",
  "items-",
  "font-",
  "leading-",
  "tracking-",
  "opacity-",
  "z-",
  "overflow-",
  "cursor-",
  "transition-",
  "transform-",
  "animate-",
  "hover:",
  "focus:",
  "active:",
  "disabled:",
  "dark:",
  "sm:",
  "md:",
  "lg:",
  "xl:",
  "2xl:",
];

/**
 * Analyzes a CSS selector to extract component name hints
 *
 * @param selector - CSS selector string
 * @returns Analysis result or null if no component pattern detected
 */
export function analyzeSelector(selector: string): SelectorAnalysis | null {
  if (!selector) return null;

  // Extract class names from selector
  const classMatches = selector.match(/\.([a-zA-Z_-][a-zA-Z0-9_-]*)/g);
  const classes = classMatches ? classMatches.map((m) => m.slice(1)) : [];

  // Try class-based extraction first

  for (const className of classes) {
    // Skip utility classes
    if (isUtilityClass(className)) continue;

    // Try CSS module patterns
    for (const pattern of CSS_MODULE_PATTERNS) {
      const match = className.match(pattern);
      if (match) {
        const name = match[1];
        // Normalize to PascalCase if needed
        const componentName = name.charAt(0).toUpperCase() + name.slice(1);
        return {
          componentName,
          confidence: "low",
          source: className,
        };
      }
    }

    // Check for PascalCase class names (likely component names)
    if (/^[A-Z][a-zA-Z0-9]+$/.test(className)) {
      return {
        componentName: className,
        confidence: "low",
        source: className,
      };
    }

    // Check for BEM-style: component__element or component--modifier
    const bemMatch = className.match(/^([A-Z][a-zA-Z0-9]+)(?:__|--)/);
    if (bemMatch) {
      return {
        componentName: bemMatch[1],
        confidence: "low",
        source: className,
      };
    }

    // Check for kebab-case component names (e.g., user-profile)
    if (className.includes("-") && !isUtilityClass(className)) {
      const parts = className.split("-");
      // Only consider if first part looks component-like (not a utility prefix)
      if (parts.length >= 2 && parts[0].length > 2) {
        const componentName = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
        // Only return if it looks like a component (starts with capital after conversion)
        if (/^[A-Z][a-zA-Z0-9]+$/.test(componentName)) {
          return {
            componentName,
            confidence: "low",
            source: className,
          };
        }
      }
    }
  }

  // Try to extract from ID in selector
  const idMatch = selector.match(/#([a-zA-Z][a-zA-Z0-9_-]*)/);
  if (idMatch) {
    const id = idMatch[1];
    if (!isUtilityClass(id)) {
      // Convert ID to PascalCase
      const componentName = id
        .split(/[-_]/)
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
        .join("");
      if (/^[A-Z][a-zA-Z0-9]+$/.test(componentName)) {
        return {
          componentName,
          confidence: "low",
          source: `#${id}`,
        };
      }
    }
  }

  return null;
}

/**
 * Checks if a class name is a utility class
 */
function isUtilityClass(className: string): boolean {
  const lowerName = className.toLowerCase();

  // Check prefixes
  for (const prefix of UTILITY_PREFIXES) {
    if (lowerName.startsWith(prefix)) return true;
  }

  // Check for Tailwind arbitrary value pattern: [value]
  if (className.includes("[") && className.includes("]")) return true;

  // Check for pure numeric or very short names
  if (/^\d+$/.test(className) || className.length <= 2) return true;

  // Check for common utility patterns
  if (/^(hidden|visible|block|inline|static|fixed|absolute|relative)$/.test(lowerName)) {
    return true;
  }

  return false;
}

/**
 * Extracts all potential component names from a selector
 * Returns them sorted by likelihood (most likely first)
 */
export function extractAllComponentHints(selector: string): string[] {
  if (!selector) return [];

  const hints: string[] = [];
  const seen = new Set<string>();

  // Extract class names
  const classMatches = selector.match(/\.([a-zA-Z_-][a-zA-Z0-9_-]*)/g);
  if (classMatches) {
    for (const match of classMatches) {
      const className = match.slice(1);
      if (isUtilityClass(className)) continue;

      // Try CSS module patterns
      for (const pattern of CSS_MODULE_PATTERNS) {
        const moduleMatch = className.match(pattern);
        if (moduleMatch) {
          const name = moduleMatch[1];
          const componentName = name.charAt(0).toUpperCase() + name.slice(1);
          if (!seen.has(componentName)) {
            seen.add(componentName);
            hints.push(componentName);
          }
          break;
        }
      }

      // PascalCase names
      if (/^[A-Z][a-zA-Z0-9]+$/.test(className) && !seen.has(className)) {
        seen.add(className);
        hints.push(className);
      }
    }
  }

  return hints;
}
