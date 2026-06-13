import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const DEFAULT_SNIPPET_MAX_LINES = 50;
export const DEFAULT_SEARCH_LIMIT = 25;
export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024; // 1 MB
export const DEFAULT_PARSER_CACHE_SIZE = 200;
export const DEFAULT_SCAN_TIMEOUT_MS = 5000;

export function log(level: 'debug' | 'info' | 'warning' | 'error', message: string): void {
  // Use stderr for logging so stdout stays clean for MCP messages.
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] [${level.toUpperCase()}] @idea404/repocontext: ${message}`);
}

export function okResult(text: string, extra?: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    ...extra,
  };
}

export function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

export function clamp(num: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, num));
}

export function linesAround(
  allLines: string[],
  targetLineOneIndexed: number,
  contextLines: number,
): { start: number; end: number; lines: string[] } {
  const start = clamp(targetLineOneIndexed - contextLines - 1, 0, allLines.length);
  const end = clamp(targetLineOneIndexed + contextLines, 0, allLines.length);
  return {
    start: start + 1,
    end,
    lines: allLines.slice(start, end),
  };
}

export function getLines(source: string, startOneIndexed: number, endOneIndexed: number): string[] {
  const lines = source.split('\n');
  const start = clamp(startOneIndexed - 1, 0, lines.length);
  const end = clamp(endOneIndexed, 0, lines.length);
  return lines.slice(start, end);
}

export function formatLines(lines: string[], startLine: number): string {
  const width = String(startLine + lines.length).length;
  return lines
    .map((line, idx) => `${String(startLine + idx).padStart(width, ' ')}: ${line}`)
    .join('\n');
}
