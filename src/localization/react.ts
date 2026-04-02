/**
 * React DevTools integration for source code localization
 *
 * Queries React's internal fiber tree to find component source locations.
 * Only works in development mode with React DevTools installed.
 */

import type { BrowserPage } from "../browser.js";

/**
 * Extended page type with full evaluate signature
 */
type PageWithEvaluate = BrowserPage & {
  evaluate: <T, Args extends unknown[]>(fn: (...args: Args) => T, ...args: Args) => Promise<T>;
};

export interface ReactSourceLocation {
  /** Component name */
  componentName: string;
  /** Source file path (if available) */
  sourceFile?: string;
  /** Line number in source file */
  sourceLine?: number;
  /** Column number in source file */
  sourceColumn?: number;
}

/**
 * Attempts to find React component source information for an element
 *
 * This uses React DevTools' internal hook to access the fiber tree.
 * Works only when:
 * - React is present on the page
 * - React is in development mode
 * - React DevTools hook is installed
 *
 * @param page - Browser page object
 * @param selector - CSS selector for the target element
 * @returns Source location info or null if unavailable
 */
export async function getReactSourceLocation(
  page: BrowserPage,
  selector: string
): Promise<ReactSourceLocation | null> {
  const evalPage = page as PageWithEvaluate;
  const result = await evalPage.evaluate(
    (
      selector: string
    ): {
      found: boolean;
      componentName?: string;
      sourceFile?: string;
      sourceLine?: number;
      sourceColumn?: number;
    } => {
      const element = document.querySelector(selector);
      if (!element) {
        return { found: false };
      }

      // Check for React DevTools hook
      const hook = (window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown })
        .__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (!hook) {
        return { found: false };
      }

      // Try to find the fiber node for this element
      // React attaches internal keys to DOM elements
      const fiberKey = Object.keys(element).find(
        (key) => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")
      );

      if (!fiberKey) {
        return { found: false };
      }

      const fiber = (element as unknown as Record<string, unknown>)[fiberKey] as {
        type?: {
          name?: string;
          displayName?: string;
        };
        _debugSource?: {
          fileName?: string;
          lineNumber?: number;
          columnNumber?: number;
        };
        return?: unknown;
      } | null;

      if (!fiber) {
        return { found: false };
      }

      // Walk up the fiber tree to find a component with source info
      let current: typeof fiber = fiber;
      while (current) {
        const source = current._debugSource;
        const type = current.type;

        // Get component name
        let componentName: string | undefined;
        if (typeof type === "function") {
          componentName =
            (type as { displayName?: string; name?: string }).displayName ||
            (type as { name?: string }).name;
        } else if (type && typeof type === "object") {
          componentName = (type as { displayName?: string }).displayName;
        }

        // If we have source info, return it
        if (source?.fileName) {
          return {
            found: true,
            componentName: componentName || "Unknown",
            sourceFile: source.fileName,
            sourceLine: source.lineNumber,
            sourceColumn: source.columnNumber,
          };
        }

        // If we have a component name but no source, keep looking but remember the name
        if (componentName && !componentName.startsWith("_")) {
          // Check parent for source info
          const parent = current.return as typeof fiber;
          if (parent?._debugSource?.fileName) {
            return {
              found: true,
              componentName,
              sourceFile: parent._debugSource.fileName,
              sourceLine: parent._debugSource.lineNumber,
              sourceColumn: parent._debugSource.columnNumber,
            };
          }

          // Return component name even without source
          return {
            found: true,
            componentName,
          };
        }

        current = current.return as typeof fiber;
      }

      return { found: false };
    },
    selector
  );

  if (!result.found) {
    return null;
  }

  return {
    componentName: result.componentName || "Unknown",
    sourceFile: result.sourceFile,
    sourceLine: result.sourceLine,
    sourceColumn: result.sourceColumn,
  };
}

/**
 * Checks if React DevTools is available on the page
 *
 * @param page - Browser page object
 * @returns true if React DevTools hook is present
 */
export async function isReactDevToolsAvailable(page: BrowserPage): Promise<boolean> {
  return page.evaluate((): boolean => {
    return !!(window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown })
      .__REACT_DEVTOOLS_GLOBAL_HOOK__;
  });
}

/**
 * Checks if React is present on the page (development mode)
 *
 * @param page - Browser page object
 * @returns true if React development mode is detected
 */
export async function isReactDevelopmentMode(page: BrowserPage): Promise<boolean> {
  return page.evaluate((): boolean => {
    // Check for React DevTools hook with renderers (indicates React is loaded)
    const hook = (
      window as unknown as {
        __REACT_DEVTOOLS_GLOBAL_HOOK__?: { renderers?: Map<unknown, unknown> };
      }
    ).__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook?.renderers) {
      return false;
    }
    return hook.renderers.size > 0;
  });
}
