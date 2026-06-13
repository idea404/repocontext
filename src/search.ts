import { FileFinder } from '@ff-labs/fff-node';
import type {
  GrepMatch,
  FileItem,
  GrepOptions,
  SearchOptions,
} from '@ff-labs/fff-node';
import { getRoots } from './roots.js';
import { DEFAULT_SCAN_TIMEOUT_MS, log } from './utils.js';
import path from 'node:path';

const finders = new Map<string, FileFinder>();

const DEFAULT_EXCLUDES = ['node_modules', '.git', 'dist', 'build', '.next', '.turbo'];

export interface SearchMatch {
  relativePath: string;
  absolutePath: string;
  lineNumber: number;
  column: number;
  lineContent: string;
  matchRanges: Array<[number, number]>;
  isDefinition?: boolean;
}

function isExcluded(relativePath: string, extraExcludes?: string[]): boolean {
  const segments = relativePath.split(path.sep);
  const allExcludes = [...DEFAULT_EXCLUDES, ...(extraExcludes ?? [])];
  return segments.some((segment) => allExcludes.includes(segment));
}

export async function getFinder(rootPath: string): Promise<FileFinder | null> {
  const existing = finders.get(rootPath);
  if (existing) return existing;

  const created = FileFinder.create({ basePath: rootPath, aiMode: true });
  if (!created.ok) {
    log('error', `Failed to create FileFinder for ${rootPath}: ${created.error}`);
    return null;
  }

  const finder = created.value;
  await finder.waitForScan(DEFAULT_SCAN_TIMEOUT_MS);
  finders.set(rootPath, finder);
  return finder;
}

export async function searchFiles(
  pattern: string,
  options: {
    mode?: 'plain' | 'regex' | 'fuzzy';
    glob?: string;
    exclude?: string[];
    limit?: number;
    contextLines?: number;
  } = {},
): Promise<SearchMatch[]> {
  const roots = getRoots();
  const limit = options.limit ?? 25;
  const results: SearchMatch[] = [];

  const query = [options.glob, pattern].filter(Boolean).join(' ');

  for (const root of roots) {
    const finder = await getFinder(root.path);
    if (!finder) continue;

    const grepOptions: GrepOptions = {
      mode: options.mode ?? 'plain',
      smartCase: true,
      maxMatchesPerFile: 20,
      pageSize: limit,
      beforeContext: options.contextLines ?? 0,
      afterContext: options.contextLines ?? 0,
      classifyDefinitions: true,
    };

    const grepResult = finder.grep(query, grepOptions);

    if (!grepResult.ok) {
      log('warning', `grep failed for ${root.path}: ${grepResult.error}`);
      continue;
    }

    for (const item of grepResult.value.items) {
      if (results.length >= limit) break;
      if (isExcluded(item.relativePath, options.exclude)) continue;
      results.push(toSearchMatch(item, root.path));
    }

    if (results.length >= limit) break;
  }

  return results;
}

function toSearchMatch(item: GrepMatch, rootPath: string): SearchMatch {
  return {
    relativePath: item.relativePath,
    absolutePath: path.join(rootPath, item.relativePath),
    lineNumber: item.lineNumber,
    column: item.col,
    lineContent: item.lineContent,
    matchRanges: item.matchRanges,
    isDefinition: item.isDefinition,
  };
}

export async function listFiles(
  glob: string,
  options: { exclude?: string[]; limit?: number } = {},
): Promise<Array<{ relativePath: string; absolutePath: string }>> {
  const roots = getRoots();
  const limit = options.limit ?? 100;
  const results: Array<{ relativePath: string; absolutePath: string }> = [];

  for (const root of roots) {
    const finder = await getFinder(root.path);
    if (!finder) continue;

    const globResult = finder.glob(glob, { pageSize: limit });
    if (!globResult.ok) {
      log('warning', `glob failed for ${root.path}: ${globResult.error}`);
      continue;
    }

    for (const item of globResult.value.items) {
      if (results.length >= limit) break;
      if (isExcluded(item.relativePath, options.exclude)) continue;
      results.push(toFileEntry(item, root.path));
    }

    if (results.length >= limit) break;
  }

  return results;
}

function toFileEntry(item: FileItem, rootPath: string): { relativePath: string; absolutePath: string } {
  return {
    relativePath: item.relativePath,
    absolutePath: path.join(rootPath, item.relativePath),
  };
}

export async function fuzzyFindFiles(
  query: string,
  options: { limit?: number } = {},
): Promise<Array<{ relativePath: string; absolutePath: string }>> {
  const roots = getRoots();
  const limit = options.limit ?? 25;
  const results: Array<{ relativePath: string; absolutePath: string }> = [];

  for (const root of roots) {
    const finder = await getFinder(root.path);
    if (!finder) continue;

    const searchOptions: SearchOptions = { pageSize: limit };
    const searchResult = finder.fileSearch(query, searchOptions);
    if (!searchResult.ok) {
      log('warning', `fileSearch failed for ${root.path}: ${searchResult.error}`);
      continue;
    }

    for (const item of searchResult.value.items) {
      if (results.length >= limit) break;
      if (isExcluded(item.relativePath)) continue;
      results.push(toFileEntry(item, root.path));
    }

    if (results.length >= limit) break;
  }

  return results;
}

export async function closeFinders(): Promise<void> {
  for (const finder of finders.values()) {
    finder.destroy();
  }
  finders.clear();
}
