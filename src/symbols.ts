import { searchFiles, fuzzyFindFiles, type SearchMatch } from './search.js';
import { parseFile, detectLanguageForPath } from './parser.js';
import { safeReadFile } from './files.js';
import { linesAround, DEFAULT_SEARCH_LIMIT, formatLines } from './utils.js';

export interface SymbolMatch {
  name: string;
  kind: string;
  file: string;
  startLine: number;
  endLine: number;
  docComment?: string;
}

export async function findSymbols(
  query: string,
  options: {
    kind?: string;
    language?: string;
    glob?: string;
    limit?: number;
  } = {},
): Promise<SymbolMatch[]> {
  const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
  const results: SymbolMatch[] = [];
  const seen = new Set<string>();

  async function collectFromFile(filePath: string): Promise<void> {
    if (results.length >= limit) return;
    if (options.language) {
      const lang = detectLanguageForPath(filePath);
      if (lang !== options.language) return;
    }

    const parsed = await parseFile(filePath);
    if (!parsed?.structure) return;

    for (const item of parsed.structure) {
      if (!item.name) continue;
      if (options.kind && !item.kind.toLowerCase().includes(options.kind.toLowerCase())) continue;
      if (!item.name.toLowerCase().includes(query.toLowerCase())) continue;

      const key = `${filePath}:${item.name}:${item.startLine}`;
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({
        name: item.name,
        kind: item.kind,
        file: filePath,
        startLine: item.startLine,
        endLine: item.endLine,
        docComment: item.docComment,
      });

      if (results.length >= limit) break;
    }
  }

  // First, try fuzzy file name matches for short, identifier-like queries.
  if (/^[a-zA-Z0-9_]+$/.test(query)) {
    const fileMatches = await fuzzyFindFiles(query, { limit: limit * 2 });
    for (const file of fileMatches) {
      await collectFromFile(file.absolutePath);
      if (results.length >= limit) return results;
    }
  }

  // Then search code content, prioritizing definition-classified matches.
  const matches = await searchFiles(query, {
    mode: 'plain',
    glob: options.glob,
    limit: 200,
  });

  const definitionFiles = matches
    .filter((m) => m.isDefinition)
    .map((m) => m.absolutePath);
  const otherFiles = matches
    .filter((m) => !m.isDefinition)
    .map((m) => m.absolutePath);

  for (const filePath of [...new Set([...definitionFiles, ...otherFiles])]) {
    await collectFromFile(filePath);
    if (results.length >= limit) return results;
  }

  return results;
}

export async function traceSymbol(
  name: string,
  options: { kind?: string; path?: string } = {},
): Promise<{
  definition: SymbolMatch | null;
  references: Array<SearchMatch & { snippet: string }>;
}> {
  let definition: SymbolMatch | null = null;
  if (options.path) {
    const parsed = await parseFile(options.path);
    if (parsed?.structure) {
      const item = parsed.structure.find(
        (s) =>
          s.name === name &&
          (!options.kind || s.kind.toLowerCase().includes(options.kind.toLowerCase())),
      );
      if (item) {
        definition = {
          name: item.name,
          kind: item.kind,
          file: options.path,
          startLine: item.startLine,
          endLine: item.endLine,
          docComment: item.docComment,
        };
      }
    }
  }

  if (!definition) {
    const candidates = await findSymbols(name, { kind: options.kind, limit: 10 });
    definition = candidates[0] ?? null;
  }

  const refs = await searchFiles(name, { mode: 'plain', limit: 50 });
  const references: Array<SearchMatch & { snippet: string }> = [];

  for (const ref of refs) {
    if (definition && ref.absolutePath === definition.file && ref.lineNumber === definition.startLine) {
      continue;
    }

    const buffer = await safeReadFile(ref.absolutePath);
    if (!buffer) continue;
    const source = buffer.toString('utf-8');
    const allLines = source.split('\n');
    const around = linesAround(allLines, ref.lineNumber, 2);

    references.push({
      ...ref,
      snippet: formatLines(around.lines, around.start),
    });
  }

  return { definition, references: references.slice(0, DEFAULT_SEARCH_LIMIT) };
}

export async function getImports(
  filePath: string,
): Promise<Array<{ source: string; items: string[]; isWildcard: boolean }> | null> {
  const parsed = await parseFile(filePath);
  if (!parsed) return null;
  return (
    parsed.imports?.map((imp) => ({
      source: imp.source ?? '',
      items: imp.items ?? [],
      isWildcard: imp.isWildcard ?? false,
    })) ?? []
  );
}

export async function getExports(filePath: string): Promise<Array<{ name: string; kind: string }> | null> {
  const parsed = await parseFile(filePath);
  if (!parsed) return null;
  return (
    parsed.exports?.map((exp) => ({
      name: exp.name ?? '',
      kind: exp.kind ?? '',
    })) ?? []
  );
}
