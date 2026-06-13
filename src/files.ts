import fs from 'node:fs';
import path from 'node:path';
import { makeAllowedPath, isPathAllowed } from './roots.js';
import { DEFAULT_MAX_FILE_BYTES, getLines, formatLines } from './utils.js';

export interface SnippetResult {
  path: string;
  language: string | null;
  startLine: number;
  endLine: number;
  snippet: string;
  totalLines: number;
}

export async function safeReadFile(filePath: string): Promise<Buffer | null> {
  const allowed = makeAllowedPath(filePath);
  if (!allowed) return null;
  try {
    const stat = await fs.promises.stat(allowed);
    if (!stat.isFile()) return null;
    if (stat.size > DEFAULT_MAX_FILE_BYTES) {
      throw new Error(`File exceeds max size (${DEFAULT_MAX_FILE_BYTES} bytes)`);
    }
    return fs.promises.readFile(allowed);
  } catch {
    return null;
  }
}

export async function readSnippet(
  filePath: string,
  startLine?: number,
  endLine?: number,
): Promise<SnippetResult | null> {
  const allowed = makeAllowedPath(filePath);
  if (!allowed) return null;

  const buffer = await safeReadFile(allowed);
  if (!buffer) return null;

  const source = buffer.toString('utf-8');
  const allLines = source.split('\n');
  const totalLines = allLines.length;

  let start = startLine ?? 1;
  let end = endLine ?? totalLines;
  if (start < 1) start = 1;
  if (end > totalLines) end = totalLines;
  if (start > end) return null;

  const lines = getLines(source, start, end);
  const extension = path.extname(allowed).slice(1) || null;

  return {
    path: allowed,
    language: extension,
    startLine: start,
    endLine: end,
    snippet: formatLines(lines, start),
    totalLines,
  };
}

export async function statFile(filePath: string): Promise<fs.Stats | null> {
  const allowed = makeAllowedPath(filePath);
  if (!allowed) return null;
  try {
    return await fs.promises.stat(allowed);
  } catch {
    return null;
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  const stat = await statFile(filePath);
  return stat?.isFile() ?? false;
}

export function pathIsAllowed(filePath: string): boolean {
  return isPathAllowed(filePath);
}
