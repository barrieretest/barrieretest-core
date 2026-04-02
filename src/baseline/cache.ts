import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Issue } from "../types";

/**
 * Default cache directory under .barrieretest/cache
 */
export const CACHE_DIR = join(process.cwd(), ".barrieretest", "cache");

const CACHE_FILE = "last-run.json";

/**
 * Structure of the cached last run
 */
export interface LastRunCache {
  url: string;
  timestamp: string;
  issues: Issue[];
}

/**
 * Saves the results of the last audit run to cache
 */
export async function saveLastRun(
  url: string,
  issues: Issue[],
  cacheDir: string = CACHE_DIR
): Promise<void> {
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }

  const cache: LastRunCache = {
    url,
    timestamp: new Date().toISOString(),
    issues,
  };

  const cachePath = join(cacheDir, CACHE_FILE);
  writeFileSync(cachePath, JSON.stringify(cache, null, 2));
}

/**
 * Gets the last run from cache
 * Returns null if no cache exists or cache is invalid
 */
export async function getLastRun(cacheDir: string = CACHE_DIR): Promise<LastRunCache | null> {
  const cachePath = join(cacheDir, CACHE_FILE);

  if (!existsSync(cachePath)) {
    return null;
  }

  try {
    const content = JSON.parse(readFileSync(cachePath, "utf-8"));
    // Basic validation
    if (!content.url || !content.timestamp || !Array.isArray(content.issues)) {
      return null;
    }
    return content as LastRunCache;
  } catch {
    return null;
  }
}

/**
 * Clears cache files older than the given threshold
 */
export async function clearOldCache(maxAgeMs: number, cacheDir: string = CACHE_DIR): Promise<void> {
  if (!existsSync(cacheDir)) {
    return;
  }

  const cachePath = join(cacheDir, CACHE_FILE);
  if (!existsSync(cachePath)) {
    return;
  }

  const stat = statSync(cachePath);
  const age = Date.now() - stat.mtimeMs;

  if (age > maxAgeMs) {
    rmSync(cachePath);
  }
}
