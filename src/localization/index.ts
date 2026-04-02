/**
 * Unified localization service for accessibility issues
 *
 * Orchestrates multiple strategies to locate the source code
 * responsible for accessibility issues.
 */

import type { BrowserPage } from "../browser.js";
import type { Issue } from "../types.js";
import {
  type AttributeMatch,
  type AttributeSearchOptions,
  findComponentAttribute,
} from "./attributes.js";
import { getReactSourceLocation, type ReactSourceLocation } from "./react.js";
import {
  captureElementScreenshot,
  type ElementScreenshotResult,
  type ScreenshotOptions,
} from "./screenshot.js";
import { type SearchMatch, type SearchOptions, searchForElement } from "./search.js";
import { analyzeSelector, type SelectorAnalysis } from "./selector.js";

export type LocalizationConfidence = "high" | "medium" | "low";

export interface LocalizationResult {
  /** Screenshot of the element */
  screenshot?: Uint8Array;
  /** Bounding box of the captured screenshot */
  screenshotBoundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /** CSS selector for the element */
  selector: string;
  /** Source file path (if found) */
  sourceFile?: string;
  /** Line number in source file */
  sourceLine?: number;
  /** Column number in source file */
  sourceColumn?: number;
  /** Component name (if identified) */
  componentName?: string;
  /** Confidence level of the localization */
  confidence: LocalizationConfidence;
  /** Which strategy provided the result */
  strategy: "react" | "attribute" | "search" | "selector" | "none";
}

export interface LocalizedIssue extends Issue {
  /** Localization information */
  localization?: LocalizationResult;
}

export interface LocalizationOptions {
  /** Whether to capture element screenshots */
  captureScreenshots?: boolean;
  /** Screenshot options */
  screenshotOptions?: ScreenshotOptions;
  /** Project root for codebase search */
  projectRoot?: string;
  /** Custom data attributes to search for */
  customAttributes?: string[];
  /** Maximum ancestor depth for attribute search */
  maxAncestorDepth?: number;
  /** Which strategies to enable (default: all) */
  enabledStrategies?: ("react" | "attribute" | "search" | "selector")[];
  /** File extensions to search (for codebase search) */
  searchExtensions?: string[];
  /** Directories to exclude from search */
  searchExcludeDirs?: string[];
}

const DEFAULT_STRATEGIES: ("react" | "attribute" | "search" | "selector")[] = [
  "react",
  "attribute",
  "search",
  "selector",
];

/**
 * Localizes a single accessibility issue
 *
 * Runs localization strategies in order until a high-confidence match is found,
 * then captures an element screenshot.
 *
 * @param page - Browser page object
 * @param issue - The accessibility issue to localize
 * @param options - Localization options
 * @returns Localization result
 */
export async function localizeIssue(
  page: BrowserPage,
  issue: Issue,
  options: LocalizationOptions = {}
): Promise<LocalizationResult> {
  const {
    captureScreenshots = true,
    screenshotOptions,
    projectRoot,
    customAttributes,
    maxAncestorDepth,
    enabledStrategies = DEFAULT_STRATEGIES,
    searchExtensions,
    searchExcludeDirs,
  } = options;

  const selector = issue.selector;

  // Initialize result with defaults
  const result: LocalizationResult = {
    selector: selector || "",
    confidence: "low",
    strategy: "none",
  };

  if (!selector) {
    return result;
  }

  // Try strategies in order
  for (const strategy of enabledStrategies) {
    const strategyResult = await runStrategy(strategy, page, selector, {
      projectRoot,
      customAttributes,
      maxAncestorDepth,
      searchExtensions,
      searchExcludeDirs,
    });

    if (strategyResult) {
      result.strategy = strategy;
      result.confidence = strategyResult.confidence;

      if (strategyResult.componentName) {
        result.componentName = strategyResult.componentName;
      }
      if (strategyResult.sourceFile) {
        result.sourceFile = strategyResult.sourceFile;
      }
      if (strategyResult.sourceLine) {
        result.sourceLine = strategyResult.sourceLine;
      }
      if (strategyResult.sourceColumn) {
        result.sourceColumn = strategyResult.sourceColumn;
      }

      // Stop on high-confidence match
      if (strategyResult.confidence === "high") {
        break;
      }
    }
  }

  // Capture screenshot if enabled
  if (captureScreenshots && selector) {
    try {
      const screenshotResult = await captureElementScreenshot(page, selector, screenshotOptions);
      if (screenshotResult) {
        result.screenshot = screenshotResult.screenshot;
        result.screenshotBoundingBox = screenshotResult.boundingBox;
      }
    } catch {
      // Screenshot capture is optional
    }
  }

  return result;
}

interface StrategyResult {
  confidence: LocalizationConfidence;
  componentName?: string;
  sourceFile?: string;
  sourceLine?: number;
  sourceColumn?: number;
}

/**
 * Runs a single localization strategy
 */
async function runStrategy(
  strategy: "react" | "attribute" | "search" | "selector",
  page: BrowserPage,
  selector: string,
  options: {
    projectRoot?: string;
    customAttributes?: string[];
    maxAncestorDepth?: number;
    searchExtensions?: string[];
    searchExcludeDirs?: string[];
  }
): Promise<StrategyResult | null> {
  try {
    switch (strategy) {
      case "react":
        return await runReactStrategy(page, selector);
      case "attribute":
        return await runAttributeStrategy(page, selector, options);
      case "search":
        return await runSearchStrategy(page, selector, options);
      case "selector":
        return runSelectorStrategy(selector);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

async function runReactStrategy(
  page: BrowserPage,
  selector: string
): Promise<StrategyResult | null> {
  const reactInfo = await getReactSourceLocation(page, selector);
  if (!reactInfo) return null;

  return {
    confidence: reactInfo.sourceFile ? "high" : "medium",
    componentName: reactInfo.componentName,
    sourceFile: reactInfo.sourceFile,
    sourceLine: reactInfo.sourceLine,
    sourceColumn: reactInfo.sourceColumn,
  };
}

async function runAttributeStrategy(
  page: BrowserPage,
  selector: string,
  options: { customAttributes?: string[]; maxAncestorDepth?: number }
): Promise<StrategyResult | null> {
  const attrOptions: AttributeSearchOptions = {};
  if (options.customAttributes) {
    attrOptions.customAttributes = options.customAttributes;
  }
  if (options.maxAncestorDepth !== undefined) {
    attrOptions.maxAncestorDepth = options.maxAncestorDepth;
  }

  const attrMatch = await findComponentAttribute(page, selector, attrOptions);
  if (!attrMatch) return null;

  // Higher confidence if found on the element itself
  const confidence: LocalizationConfidence = attrMatch.fromAncestor ? "medium" : "high";

  return {
    confidence,
    componentName: attrMatch.componentName,
  };
}

async function runSearchStrategy(
  page: BrowserPage,
  selector: string,
  options: { projectRoot?: string; searchExtensions?: string[]; searchExcludeDirs?: string[] }
): Promise<StrategyResult | null> {
  if (!options.projectRoot) return null;

  const searchOptions: SearchOptions = {
    projectRoot: options.projectRoot,
  };
  if (options.searchExtensions) {
    searchOptions.extensions = options.searchExtensions;
  }
  if (options.searchExcludeDirs) {
    searchOptions.excludeDirs = options.searchExcludeDirs;
  }

  const searchMatch = await searchForElement(page, selector, searchOptions);
  if (!searchMatch) return null;

  // Map numeric confidence to level
  const confidence: LocalizationConfidence =
    searchMatch.confidence >= 0.7 ? "high" : searchMatch.confidence >= 0.4 ? "medium" : "low";

  return {
    confidence,
    sourceFile: searchMatch.filePath,
    sourceLine: searchMatch.lineNumber,
  };
}

function runSelectorStrategy(selector: string): StrategyResult | null {
  const analysis = analyzeSelector(selector);
  if (!analysis) return null;

  return {
    confidence: "low",
    componentName: analysis.componentName,
  };
}

/**
 * Localizes multiple issues
 *
 * @param page - Browser page object
 * @param issues - Array of issues to localize
 * @param options - Localization options
 * @returns Array of issues with localization data
 */
export async function localizeIssues(
  page: BrowserPage,
  issues: Issue[],
  options: LocalizationOptions = {}
): Promise<LocalizedIssue[]> {
  const results: LocalizedIssue[] = [];

  for (const issue of issues) {
    const localization = await localizeIssue(page, issue, options);
    results.push({
      ...issue,
      localization,
    });
  }

  return results;
}

export type { AttributeMatch, AttributeSearchOptions } from "./attributes.js";
export { findComponentAttribute } from "./attributes.js";
export type {
  IssueWithScreenshotPath,
  ScreenshotOutputOptions,
  ScreenshotOutputResult,
} from "./output.js";
export {
  issuesWithScreenshotPaths,
  prepareOutputWithScreenshots,
  saveAllScreenshots,
  saveIssueScreenshot,
} from "./output.js";
export type { ReactSourceLocation } from "./react.js";
export { getReactSourceLocation, isReactDevelopmentMode, isReactDevToolsAvailable } from "./react.js";
export type { ElementScreenshotResult, ScreenshotOptions } from "./screenshot.js";
export { captureElementScreenshot, captureMultipleElementScreenshots } from "./screenshot.js";
export type { SearchMatch, SearchOptions } from "./search.js";
export { extractSearchableIdentifiers, searchCodebase, searchForElement } from "./search.js";
export type { SelectorAnalysis } from "./selector.js";
export { analyzeSelector, extractAllComponentHints } from "./selector.js";
