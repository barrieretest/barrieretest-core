/**
 * React DevTools integration for source code localization
 *
 * Queries React's internal fiber tree to find component source locations.
 * Only works in development mode with React DevTools installed.
 */

import type { BrowserPage } from "../browser.js";

type ReactDevToolsHook = {
  renderers?: Map<unknown, unknown>;
};

type ReactDevToolsWindow = Window & {
  __REACT_DEVTOOLS_GLOBAL_HOOK__?: ReactDevToolsHook;
};

type ReactComponentFunction = ((...args: never[]) => unknown) & {
  displayName?: string;
  name?: string;
};

type ReactFiber = {
  type?: { name?: string; displayName?: string } | ReactComponentFunction;
  _debugSource?: {
    fileName?: string;
    lineNumber?: number;
    columnNumber?: number;
  };
  return?: ReactFiber | null;
};

type ReactElementWithFiber = Element & Record<string, unknown>;

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
  const result = await page.evaluate(
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

      const reactWindow = window as ReactDevToolsWindow;
      const hook = reactWindow.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (!hook) {
        return { found: false };
      }

      const fiberKey = Object.keys(element).find(
        (key) => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")
      );

      if (!fiberKey) {
        return { found: false };
      }

      const fiber = (element as ReactElementWithFiber)[fiberKey] as ReactFiber | null;
      if (!fiber) {
        return { found: false };
      }

      let current: ReactFiber | null | undefined = fiber;
      while (current) {
        const source = current._debugSource;
        const type = current.type;

        let componentName: string | undefined;
        if (typeof type === "function") {
          componentName = type.displayName || type.name;
        } else if (type && typeof type === "object") {
          componentName = type.displayName;
        }

        if (source?.fileName) {
          return {
            found: true,
            componentName: componentName || "Unknown",
            sourceFile: source.fileName,
            sourceLine: source.lineNumber,
            sourceColumn: source.columnNumber,
          };
        }

        if (componentName && !componentName.startsWith("_")) {
          const parent = current.return;
          if (parent?._debugSource?.fileName) {
            return {
              found: true,
              componentName,
              sourceFile: parent._debugSource.fileName,
              sourceLine: parent._debugSource.lineNumber,
              sourceColumn: parent._debugSource.columnNumber,
            };
          }

          return {
            found: true,
            componentName,
          };
        }

        current = current.return;
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
    const reactWindow = window as ReactDevToolsWindow;
    return !!reactWindow.__REACT_DEVTOOLS_GLOBAL_HOOK__;
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
    const reactWindow = window as ReactDevToolsWindow;
    const hook = reactWindow.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook?.renderers) {
      return false;
    }
    return hook.renderers.size > 0;
  });
}
