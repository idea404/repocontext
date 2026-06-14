import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { makeAllowedPath, getRoots } from './roots.js';
import { parseFile, detectLanguageForPath } from './parser.js';
import { searchFiles, listFiles } from './search.js';
import { readSnippet } from './files.js';
import { okResult, errorResult } from './utils.js';

const DOC_EXCLUDES = ['node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'target', '__pycache__', '.venv', 'venv'];

function isExcluded(filePath: string): boolean {
  return DOC_EXCLUDES.some((e) => filePath.includes(`/${e}/`) || filePath.includes(`\\${e}\\`));
}

async function readTextFile(filePath: string, maxChars = 10000): Promise<string | null> {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return null;
    const buffer = await fs.promises.readFile(filePath, 'utf-8');
    return buffer.slice(0, maxChars);
  } catch {
    return null;
  }
}

function truncate(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 3) + '...';
}

// ── repo_brief ──────────────────────────────────────────────────────────────

export const repoBriefSchema = z.object({
  detail: z.enum(['compact', 'standard', 'full']).optional().describe('Level of detail (default: standard)'),
});

export async function repoBriefHandler(args: z.infer<typeof repoBriefSchema>) {
  const roots = getRoots();
  if (roots.length === 0) return errorResult('No roots configured');

  const rootPath = roots[0].path;
  const detail = args.detail ?? 'standard';

  const files = await listFiles('**/*', { limit: 5000, exclude: DOC_EXCLUDES });
  const topLevelDirs = new Set<string>();
  const languageCounts: Record<string, number> = {};
  const entryPoints: string[] = [];
  const configFiles: string[] = [];

  const ENTRY_NAMES = new Set([
    'main.ts', 'main.js', 'main.py', 'main.rs', 'main.go', 'main.java', 'main.c', 'main.cpp',
    'index.ts', 'index.js', 'index.py', 'app.ts', 'app.js', 'app.py',
    'cli.ts', 'cli.js', 'server.ts', 'server.js', 'api.ts', 'api.py',
  ]);

  const CONFIG_NAMES = new Set([
    'package.json', 'tsconfig.json', 'Cargo.toml', 'go.mod', 'pyproject.toml',
    'Makefile', 'Dockerfile', 'docker-compose.yml', '.env', 'README.md', 'AGENTS.md',
  ]);

  for (const f of files) {
    const rel = f.relativePath;
    const parts = rel.split('/');
    if (parts.length > 1) topLevelDirs.add(parts[0]);

    const lang = detectLanguageForPath(f.absolutePath);
    if (lang) languageCounts[lang] = (languageCounts[lang] ?? 0) + 1;

    const fileName = parts[parts.length - 1];
    if (ENTRY_NAMES.has(fileName)) entryPoints.push(rel);
    if (CONFIG_NAMES.has(fileName)) configFiles.push(rel);
  }

  // Read README and package.json for purpose
  let purpose = '';
  const readmePath = path.join(rootPath, 'README.md');
  const readmeText = await readTextFile(readmePath, 3000);
  if (readmeText) {
    purpose = readmeText.split('\n').slice(0, 8).join('\n').replace(/#{1,6}\s*/g, '').trim();
  }

  let techStack: string[] = [];
  const pkgPath = path.join(rootPath, 'package.json');
  const pkgText = await readTextFile(pkgPath, 5000);
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText);
      const deps = Object.keys(pkg.dependencies ?? {});
      const devDeps = Object.keys(pkg.devDependencies ?? {});
      techStack = [...new Set([...deps, ...devDeps])].slice(0, 15);
    } catch { /* ignore */ }
  }

  const summaryLines: string[] = [];
  summaryLines.push(`# Repo Brief: ${path.basename(rootPath)}`);
  summaryLines.push('');

  if (purpose) {
    summaryLines.push('## Purpose');
    summaryLines.push(truncate(purpose, 80));
    summaryLines.push('');
  }

  summaryLines.push('## Overview');
  summaryLines.push(`- Files: ${files.length}`);
  summaryLines.push(`- Top-level directories: ${[...topLevelDirs].sort().join(', ')}`);
  summaryLines.push(`- Languages: ${Object.entries(languageCounts).sort((a, b) => b[1] - a[1]).map(([l, c]) => `${l} (${c})`).join(', ')}`);
  summaryLines.push('');

  if (detail !== 'compact') {
    summaryLines.push('## Tech Stack (sample)');
    summaryLines.push(techStack.join(', ') || 'N/A');
    summaryLines.push('');

    summaryLines.push('## Entry Points');
    summaryLines.push(entryPoints.slice(0, 15).join('\n') || 'None detected');
    summaryLines.push('');

    summaryLines.push('## Key Config Files');
    summaryLines.push(configFiles.slice(0, 15).join('\n') || 'None detected');
    summaryLines.push('');
  }

  if (detail === 'full') {
    summaryLines.push('## Directory Structure');
    const dirCounts = new Map<string, number>();
    for (const f of files) {
      const parts = f.relativePath.split('/');
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join('/');
        dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
      }
    }
    const sorted = [...dirCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
    for (const [dir, count] of sorted) {
      summaryLines.push(`- ${dir}/ (${count} files)`);
    }
  }

  return okResult(summaryLines.join('\n'));
}

// ── query_repo ──────────────────────────────────────────────────────────────

export const queryRepoSchema = z.object({
  question: z.string().describe('A natural-language question about the codebase, e.g. "how does authentication work?"'),
  max_files: z.number().int().min(1).max(20).optional().describe('Max files to inspect (default: 5)'),
  max_symbols_per_file: z.number().int().min(1).max(20).optional().describe('Max symbols to include per file (default: 5)'),
});

export async function queryRepoHandler(args: z.infer<typeof queryRepoSchema>) {
  const roots = getRoots();
  if (roots.length === 0) return errorResult('No roots configured');

  const question = args.question.toLowerCase();
  const maxFiles = args.max_files ?? 5;
  const maxSymbols = args.max_symbols_per_file ?? 5;

  // Extract likely keywords from the question
  const stopWords = new Set(['how', 'does', 'what', 'where', 'when', 'why', 'the', 'and', 'for', 'with', 'from', 'this', 'that', 'use', 'using', 'does', 'work']);
  const keywords = question
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));

  // Build keyword variants with simple stemming
  const keywordVariants = new Set<string>();
  for (const kw of keywords) {
    keywordVariants.add(kw);
    // Common suffix stripping
    if (kw.endsWith('ication')) keywordVariants.add(kw.replace(/ication$/, ''));
    if (kw.endsWith('ization')) keywordVariants.add(kw.replace(/ization$/, ''));
    if (kw.endsWith('ation')) keywordVariants.add(kw.replace(/ation$/, ''));
    if (kw.endsWith('ment')) keywordVariants.add(kw.replace(/ment$/, ''));
    if (kw.endsWith('ing')) keywordVariants.add(kw.replace(/ing$/, ''));
    if (kw.endsWith('er')) keywordVariants.add(kw.replace(/er$/, ''));
    if (kw.endsWith('ers')) keywordVariants.add(kw.replace(/ers$/, ''));
    if (kw.endsWith('ed')) keywordVariants.add(kw.replace(/ed$/, ''));
    if (kw.endsWith('s')) keywordVariants.add(kw.replace(/s$/, ''));
    // For long keywords, also add a short root prefix (e.g. authentication -> authe, authen)
    if (kw.length > 7) keywordVariants.add(kw.slice(0, 4));
    if (kw.length > 9) keywordVariants.add(kw.slice(0, 6));
  }

  // Common synonyms / concept roots
  const SYNONYMS: Record<string, string[]> = {
    authentication: ['auth'],
    authorization: ['auth'],
    authenticate: ['auth'],
    authorize: ['auth'],
    database: ['db'],
    configuration: ['config'],
    middleware: ['mw'],
  };
  for (const kw of keywords) {
    const syns = SYNONYMS[kw];
    if (syns) syns.forEach((s) => keywordVariants.add(s));
  }

  const keywordList = [...keywordVariants];

  const codeGlob = '**/*.{ts,tsx,js,jsx,py,go,rs,java,c,cpp,rb,swift,kt,ex,scala,php,cs,sh}';
  const docGlob = '**/*.md';

  const sortedKeywords = [...keywordList].sort((a, b) => a.length - b.length);
  const seenFiles = new Set<string>();

  // 1. Prioritize files whose paths or directories match the keywords
  for (const kw of sortedKeywords) {
    if (kw.length < 2) continue;
    const pathGlobs = [`**/*${kw}*`, `**/*${kw}*/**/*`, `**/${kw}/**/*`];
    for (const g of pathGlobs) {
      const pathMatches = await listFiles(g, { limit: maxFiles * 2, exclude: DOC_EXCLUDES });
      for (const f of pathMatches) {
        if (f.relativePath.match(/\.(ts|tsx|js|jsx|py|go|rs|java|c|cpp|rb|swift|kt|ex|scala|php|cs|sh)$/)) {
          seenFiles.add(f.absolutePath);
        }
      }
    }
  }

  // 2. Search content across code files
  for (const kw of sortedKeywords) {
    if (seenFiles.size >= maxFiles * 4) break;
    const batch = await searchFiles(kw, { mode: 'plain', glob: codeGlob, limit: maxFiles * 4, contextLines: 0 });
    for (const m of batch) {
      seenFiles.add(m.absolutePath);
    }
  }

  const codeFiles = [...seenFiles].slice(0, maxFiles);

  // Also grab a few docs as supporting references
  let docMatches = await searchFiles('auth', {
    mode: 'plain',
    glob: docGlob,
    limit: 5,
    contextLines: 0,
  });
  if (docMatches.length === 0) {
    for (const kw of sortedKeywords) {
      docMatches = await searchFiles(kw, { mode: 'plain', glob: docGlob, limit: 5, contextLines: 0 });
      if (docMatches.length > 0) break;
    }
  }
  const docFiles = [...new Set(docMatches.map((m) => m.absolutePath))].slice(0, 2);

  if (codeFiles.length === 0) {
    return okResult(`No relevant code files found for: "${args.question}"`);
  }

  // Build keyword set from variants
  const keywordSet = new Set<string>();
  for (const kw of keywordList) {
    keywordSet.add(kw);
    keywordSet.add(kw.replace(/s$/, '')); // plural singular
  }
  const allKeywords = [...keywordSet];

  const fileResults: string[] = [];

  for (const filePath of codeFiles) {
    const parsed = await parseFile(filePath);
    const relPath = path.relative(roots[0].path, filePath);

    const lines: string[] = [];
    lines.push(`## ${relPath}`);

    if (!parsed) {
      lines.push('Could not parse file.');
      fileResults.push(lines.join('\n'));
      continue;
    }

    lines.push(`Language: ${parsed.language} | Lines: ${parsed.metrics.totalLines} | Symbols: ${parsed.structure.length}`);

    // Prefer symbols matching keywords
    let symbols = parsed.structure
      .filter((s) => allKeywords.some((k) => s.name.toLowerCase().includes(k) || s.kind.toLowerCase().includes(k)))
      .slice(0, maxSymbols);

    if (symbols.length === 0) {
      symbols = parsed.structure.slice(0, maxSymbols);
    }

    for (const s of symbols) {
      lines.push(`- ${s.kind} ${s.name} (L${s.startLine}-${s.endLine})`);
    }

    // Snippet of the top relevant symbol
    if (symbols.length > 0) {
      const top = symbols[0];
      const snippet = await readSnippet(filePath, top.startLine, Math.min(top.endLine, top.startLine + 10));
      if (snippet) {
        lines.push(`\nSnippet of ${top.name}:`);
        lines.push(snippet.snippet);
      }
    }

    fileResults.push(lines.join('\n'));
  }

  const docLines: string[] = [];
  if (docFiles.length > 0) {
    docLines.push('\n## Related docs');
    for (const docPath of docFiles) {
      docLines.push(`- ${path.relative(roots[0].path, docPath)}`);
    }
  }

  const header = `Query: "${args.question}"\nRelevant files: ${codeFiles.length}\n`;
  return okResult(header + '\n' + fileResults.join('\n\n') + docLines.join('\n'));
}

// ── analyze_file ────────────────────────────────────────────────────────────

export const analyzeFileSchema = z.object({
  path: z.string().describe('Path to the source file'),
  detail: z.enum(['summary', 'symbols', 'imports', 'exports', 'full']).optional().describe('Level of detail (default: full)'),
});

export async function analyzeFileHandler(args: z.infer<typeof analyzeFileSchema>) {
  const resolved = makeAllowedPath(args.path);
  if (!resolved) return errorResult('Path is outside allowed roots');

  const parsed = await parseFile(resolved);
  if (!parsed) return errorResult('Could not parse file (unsupported or too large)');

  const detail = args.detail ?? 'full';
  const lines: string[] = [];

  lines.push(`File: ${resolved}`);
  lines.push(`Language: ${parsed.language} | Lines: ${parsed.metrics.totalLines} | Symbols: ${parsed.structure.length}`);

  if (detail === 'summary') {
    return okResult(lines.join('\n'));
  }

  if (detail === 'full' || detail === 'symbols') {
    if (parsed.structure.length > 0) {
      lines.push('\n## Symbols');
      for (const s of parsed.structure) {
        lines.push(`- ${s.kind} ${s.name} (L${s.startLine}-${s.endLine})`);
      }
    }
  }

  if (detail === 'full' || detail === 'imports') {
    if (parsed.imports.length > 0) {
      lines.push('\n## Imports');
      for (const imp of parsed.imports) {
        const items = imp.isWildcard ? '*' : imp.items.join(', ');
        lines.push(`- "${imp.source}" → ${items}`);
      }
    }
  }

  if (detail === 'full' || detail === 'exports') {
    if (parsed.exports.length > 0) {
      lines.push('\n## Exports');
      for (const exp of parsed.exports) {
        lines.push(`- ${exp.kind} ${exp.name}`);
      }
    }
  }

  return okResult(lines.join('\n'));
}

// ── import_graph ───────────────────────────────────────────────────────────

export const importGraphSchema = z.object({
  module: z.string().optional().describe('Module name to focus on. If omitted, returns top-level import summary.'),
  direction: z.enum(['imports', 'imported_by']).optional().describe('Show what this module imports, or what imports it (default: imports)'),
  max_results: z.number().int().min(1).max(100).optional().describe('Max results (default: 20)'),
});

export async function importGraphHandler(args: z.infer<typeof importGraphSchema>) {
  const roots = getRoots();
  if (roots.length === 0) return errorResult('No roots configured');

  const rootPath = roots[0].path;
  const direction = args.direction ?? 'imports';
  const maxResults = args.max_results ?? 20;

  if (!args.module) {
    // Summary: top imported modules across the project
    const moduleCounts: Record<string, { count: number; importers: string[] }> = {};
    const files = await listFiles('**/*.{ts,tsx,js,jsx,py,go,rs,java}', { limit: 500, exclude: DOC_EXCLUDES });

    for (const f of files) {
      const parsed = await parseFile(f.absolutePath);
      if (!parsed) continue;
      for (const imp of parsed.imports) {
        if (!imp.source) continue;
        if (!moduleCounts[imp.source]) moduleCounts[imp.source] = { count: 0, importers: [] };
        moduleCounts[imp.source].count++;
        const rel = path.relative(rootPath, f.absolutePath);
        if (!moduleCounts[imp.source].importers.includes(rel)) {
          moduleCounts[imp.source].importers.push(rel);
        }
      }
    }

    const sorted = Object.entries(moduleCounts)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, maxResults);

    const lines = sorted.map(([mod, info]) => `- "${mod}" imported ${info.count} time(s) by ${info.importers.slice(0, 5).join(', ')}${info.importers.length > 5 ? '...' : ''}`);
    return okResult(`## Top Imported Modules\n\n${lines.join('\n')}`);
  }

  const targetModule = args.module;

  if (direction === 'imports') {
    // Find files that import this module
    const files = await listFiles('**/*.{ts,tsx,js,jsx,py,go,rs,java}', { limit: 500, exclude: DOC_EXCLUDES });
    const results: string[] = [];

    for (const f of files) {
      const parsed = await parseFile(f.absolutePath);
      if (!parsed) continue;
      const imports = parsed.imports.filter((imp) => imp.source.includes(targetModule));
      if (imports.length === 0) continue;

      const rel = path.relative(rootPath, f.absolutePath);
      for (const imp of imports) {
        const items = imp.isWildcard ? '*' : imp.items.join(', ');
        results.push(`- ${rel} imports "${imp.source}" → ${items}`);
      }
      if (results.length >= maxResults) break;
    }

    return okResult(`## Files importing "${targetModule}"\n\n${results.join('\n') || 'No imports found.'}`);
  }

  // direction === 'imports' for a specific file path
  const resolved = makeAllowedPath(targetModule);
  if (!resolved) return errorResult('Path is outside allowed roots');

  const parsed = await parseFile(resolved);
  if (!parsed) return errorResult('Could not parse file');

  const lines: string[] = [`## Imports in ${targetModule}`];
  for (const imp of parsed.imports) {
    const items = imp.isWildcard ? '*' : imp.items.join(', ');
    lines.push(`- "${imp.source}" → ${items}`);
  }

  return okResult(lines.join('\n'));
}

// ── summarize_documentation ─────────────────────────────────────────────────

export const summarizeDocumentationSchema = z.object({
  query: z.string().optional().describe('Optional topic to focus the summary on'),
  max_length: z.number().int().min(50).max(5000).optional().describe('Max length in characters (default: 1500)'),
});

export async function summarizeDocumentationHandler(args: z.infer<typeof summarizeDocumentationSchema>) {
  const roots = getRoots();
  if (roots.length === 0) return errorResult('No roots configured');

  const maxLength = args.max_length ?? 1500;

  const docFiles = (
    await listFiles('**/*.md', { limit: 50, exclude: DOC_EXCLUDES })
  ).filter((f) => !isExcluded(f.absolutePath));

  // Prioritize README, AGENTS, ARCHITECTURE, then others. Root-level files win ties.
  const priorityNames = ['README.md', 'AGENTS.md', 'ARCHITECTURE.md', 'CLAUDE.md', 'CONTRIBUTING.md'];
  docFiles.sort((a, b) => {
    const ai = priorityNames.findIndex((n) => a.relativePath.endsWith(n));
    const bi = priorityNames.findIndex((n) => b.relativePath.endsWith(n));
    if (ai !== bi) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    // Root-level docs come before nested ones with same priority
    const aDepth = a.relativePath.split('/').length;
    const bDepth = b.relativePath.split('/').length;
    if (aDepth !== bDepth) return aDepth - bDepth;
    return a.relativePath.localeCompare(b.relativePath);
  });

  const targetFiles = docFiles.slice(0, 5);
  const sections: string[] = [];

  for (const f of targetFiles) {
    const text = await readTextFile(f.absolutePath, 8000);
    if (!text) continue;

    const lines = text.split('\n');
    const summaryLines: string[] = [];
    let tokens = 0;

    for (const line of lines) {
      if (tokens >= maxLength) break;
      summaryLines.push(line);
      tokens += line.length;
    }

    if (summaryLines.length > 0) {
      sections.push(`## ${f.relativePath}\n${summaryLines.join('\n')}`);
    }
  }

  if (sections.length === 0) {
    return okResult('No documentation files found.');
  }

  const combined = sections.join('\n\n');
  return okResult(combined.length > maxLength ? combined.slice(0, maxLength) + '...' : combined);
}
