import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { makeAllowedPath, getRoots, relativizeToRoot } from './roots.js';
import { parseFile, detectLanguageForPath } from './parser.js';
import { searchFiles, listFiles, fuzzyFindFiles } from './search.js';
import { readSnippet, fileExists } from './files.js';
import { findSymbols, traceSymbol, getImports } from './symbols.js';
import { gitLog, gitBlame } from './git.js';
import { analyzeDependencies } from './deps.js';
import { discoverTests } from './tests.js';
import { recentChanges } from './changes.js';
import { okResult, errorResult, clamp } from './utils.js';

const DOC_EXCLUDES = ['node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'target', '__pycache__', '.venv', 'venv'];

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

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 3) + '...';
}

// ── Schemas ─────────────────────────────────────────────────────────────────

export const repoOverviewSchema = z.object({
  detail: z.enum(['compact', 'standard', 'full']).optional().describe('Level of detail (default: standard)'),
});

export const findSchema = z.object({
  query: z.string().describe('Search query: file path fragment, symbol name, or code pattern'),
  mode: z.enum(['files', 'symbols', 'code', 'all']).optional().describe("'files' = paths; 'symbols' = definitions; 'code' = contents; 'all' = summarize all modes (default: all)"),
  glob: z.string().optional().describe('Restrict to files matching a glob pattern'),
  language: z.string().optional().describe('Filter by language (for symbol/code mode)'),
  limit: z.number().int().min(1).max(100).optional().describe('Max results (default: 20)'),
});

export const readSchema = z.object({
  path: z.string().describe('Path to the file'),
  type: z.enum(['lines', 'outline', 'symbol']).optional().describe("'lines' = line range; 'outline' = symbols/imports/exports; 'symbol' = body of named symbol (default: lines)"),
  start_line: z.number().int().optional().describe('For type=lines: first line (1-indexed)'),
  end_line: z.number().int().optional().describe('For type=lines: last line (1-indexed)'),
  symbol_name: z.string().optional().describe("For type=symbol: name of symbol to read"),
  max_lines: z.number().int().min(1).max(200).optional().describe('Max lines when reading body or lines (default: 100)'),
});

export const querySchema = z.object({
  question: z.string().describe('Natural-language question about the codebase'),
  max_files: z.number().int().min(1).max(15).optional().describe('Max code files to inspect (default: 5)'),
  max_symbols_per_file: z.number().int().min(1).max(10).optional().describe('Max symbols per file (default: 5)'),
  include_docs: z.boolean().optional().describe('Include documentation matches (default: true)'),
});

export const traceSchema = z.object({
  name: z.string().describe('Symbol name to trace'),
  path: z.string().optional().describe('Known file path of the symbol definition'),
  kind: z.string().optional().describe('Kind hint, e.g. function, class'),
  include_git: z.boolean().optional().describe('Include recent commits and blame (default: true)'),
  max_refs: z.number().int().min(1).max(50).optional().describe('Max reference snippets (default: 15)'),
});

export const depsSchema = z.object({
  target: z.string().optional().describe('Specific module/file to focus on. Omit for project-wide dependency summary.'),
  direction: z.enum(['imports', 'imported_by']).optional().describe('For target: what it imports vs what imports it (default: imports)'),
  limit: z.number().int().min(1).max(100).optional().describe('Max results (default: 20)'),
});

export const testsSchema = z.object({
  target: z.string().optional().describe('Source file or directory to find tests for. Omit for overall test coverage.'),
  limit: z.number().int().min(1).max(50).optional().describe('Max test files (default: 20)'),
});

export const changesSchema = z.object({
  max_commits: z.number().int().min(1).max(100).optional().describe('Max commits to scan (default: 30)'),
  hot_files: z.number().int().min(0).max(30).optional().describe('Return top N recently changed files (default: 10)'),
  since_days: z.number().int().min(1).max(365).optional().describe('Limit to last N days (default: 14)'),
});

export const docsSchema = z.object({
  topic: z.string().describe('Topic or question to find documentation about'),
  scope: z.enum(['docs', 'code', 'all']).optional().describe("'docs' = markdown only; 'code' = comments only; 'all' = both (default: all)"),
  max_results: z.number().int().min(1).max(30).optional().describe('Max results (default: 10)'),
});

export const analyzeSchema = z.object({
  path: z.string().describe('Path to the source file'),
  include_refs: z.boolean().optional().describe('Include references from other files (default: true)'),
  include_git: z.boolean().optional().describe('Include blame/line authors (default: false)'),
  max_refs: z.number().int().min(1).max(50).optional().describe('Max refs to include (default: 10)'),
});

export const rootsSchema = z.object({});

// ── repo_overview ────────────────────────────────────────────────────────────

export async function repoOverviewHandler(args: z.infer<typeof repoOverviewSchema>) {
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
    'index.ts', 'index.js', 'index.py', 'index.rs', 'index.go',
    'app.ts', 'app.js', 'app.py', 'app.rs', 'app.go',
    'cli.ts', 'cli.js', 'cli.py', 'cli.rs', 'cli.go',
    'server.ts', 'server.js', 'server.py', 'server.rs', 'server.go',
    'api.ts', 'api.js', 'api.py', 'api.rs', 'api.go',
    '__main__.py', '__init__.py',
  ]);

  const CONFIG_NAMES = new Set([
    'package.json', 'tsconfig.json', 'tsconfig.build.json', 'jsconfig.json',
    'Cargo.toml', 'Cargo.lock', 'go.mod', 'go.sum',
    'pyproject.toml', 'setup.py', 'setup.cfg', 'Pipfile', 'requirements.txt',
    'Makefile', 'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
    '.env', '.env.example', '.gitignore', '.gitattributes',
    '.eslintrc', '.eslintrc.json', '.eslintrc.js', '.eslintrc.yaml',
    '.prettierrc', '.prettierrc.json', '.prettierrc.js',
    'renovate.json', '.github/', '.gitlab-ci.yml',
    'Gemfile', 'Rakefile', 'Podfile',
    'build.gradle', 'pom.xml', 'gradlew',
    'CMakeLists.txt', 'configure.ac',
    'composer.json', 'Cask', 'Project.toml',
  ]);

  let totalLines = 0;

  for (const f of files) {
    const rel = f.relativePath;
    const parts = rel.split('/');
    if (parts.length > 1) topLevelDirs.add(parts[0]);

    const lang = detectLanguageForPath(f.absolutePath);
    if (lang) languageCounts[lang] = (languageCounts[lang] ?? 0) + 1;

    try {
      const content = await fs.promises.readFile(f.absolutePath, 'utf-8');
      totalLines += content.split('\n').length;
    } catch { /* skip binary */ }

    const fileName = parts[parts.length - 1];
    if (ENTRY_NAMES.has(fileName)) entryPoints.push(rel);
    if (CONFIG_NAMES.has(fileName) || CONFIG_NAMES.has(`${fileName}/`)) configFiles.push(rel);
  }

  const langs = Object.entries(languageCounts).sort((a, b) => b[1] - a[1]);

  let purpose = '';
  const readmeText = await readTextFile(path.join(rootPath, 'README.md'), 3000);
  if (readmeText) {
    purpose = readmeText.split('\n').slice(0, 8).join('\n').replace(/#{1,6}\s*/g, '').trim();
  }

  const agentsText = await readTextFile(path.join(rootPath, 'AGENTS.md'), 2000);
  const stack: string[] = [];
  const pkgText = await readTextFile(path.join(rootPath, 'package.json'), 5000);
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText);
      stack.push(...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {}));
    } catch { /* ignore */ }
  }
  const cargoText = await readTextFile(path.join(rootPath, 'Cargo.toml'), 3000);
  if (cargoText) {
    try {
      const cargo = parseToml(cargoText);
      stack.push(...Object.keys(cargo.dependencies ?? {}), ...Object.keys(cargo['dev-dependencies'] ?? {}));
    } catch { /* ignore */ }
  }
  const pyText = await readTextFile(path.join(rootPath, 'pyproject.toml'), 3000);
  if (pyText) {
    try {
      const py = parseToml(pyText);
      stack.push(...Object.keys(py.dependencies ?? {}), ...Object.keys(py['dev-dependencies'] ?? {}));
    } catch { /* ignore */ }
  }

  const lines: string[] = [];
  lines.push(`# ${path.basename(rootPath)}`);
  lines.push('');

  if (purpose) {
    lines.push('## Purpose');
    lines.push(truncate(purpose, 600));
    lines.push('');
  }

  lines.push('## Overview');
  lines.push(`- Files: ${files.length.toLocaleString()} | Lines: ${totalLines.toLocaleString()}`);
  lines.push(`- Languages: ${langs.map(([l, c]) => `${l} (${c})`).join(', ') || 'N/A'}`);
  lines.push(`- Top-level dirs: ${[...topLevelDirs].sort().join(', ') || 'N/A'}`);
  lines.push('');

  if (detail !== 'compact') {
    lines.push('## Entry Points');
    lines.push(entryPoints.slice(0, 15).join('\n') || 'None detected');
    lines.push('');

    lines.push('## Key Config Files');
    lines.push(configFiles.slice(0, 15).join('\n') || 'None detected');
    lines.push('');

    lines.push('## Tech Stack (sample)');
    lines.push([...new Set(stack)].slice(0, 20).join(', ') || 'N/A');
    lines.push('');

    if (agentsText) {
      lines.push('## Agent Notes (AGENTS.md)');
      lines.push(truncate(agentsText, 500));
      lines.push('');
    }
  }

  if (detail === 'full') {
    lines.push('## Directory Structure');
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
      lines.push(`- ${dir}/ (${count})`);
    }
  }

  return okResult(lines.join('\n'));
}

function parseToml(text: string): Record<string, any> {
  const result: Record<string, any> = {};
  let section: string | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1);
      if (section && !result[section]) result[section] = {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('{')) continue;
    value = value.replace(/^["']|["']$/g, '');
    if (section) {
      result[section][key] = value;
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ── find ─────────────────────────────────────────────────────────────────────

export async function findHandler(args: z.infer<typeof findSchema>) {
  const roots = getRoots();
  if (roots.length === 0) return errorResult('No roots configured');
  const limit = args.limit ?? 20;
  const mode = args.mode ?? 'all';
  const out: string[] = [];

  const includeFiles = mode === 'all' || mode === 'files';
  const includeSymbols = mode === 'all' || mode === 'symbols';
  const includeCode = mode === 'all' || mode === 'code';

  const fileIcon = '📄';
  const symbolIcon = '🔷';
  const codeIcon = '🔍';

  if (includeFiles) {
    const fuzzy = await fuzzyFindFiles(args.query, { limit });
    const globQuery = args.query.includes('*') ? args.query : `**/*${args.query}*`;
    const globbed = await listFiles(args.glob ?? globQuery, { limit: limit + 10, exclude: DOC_EXCLUDES });
    const seen = new Set<string>();
    const merged = [...fuzzy, ...globbed].filter((f) => {
      if (seen.has(f.absolutePath)) return false;
      seen.add(f.absolutePath);
      return true;
    });

    const sliced = merged.slice(0, limit);
    if (sliced.length > 0) {
      out.push(`## Files (${sliced.length})`);
      for (const f of sliced) {
        out.push(`${fileIcon} ${f.relativePath}`);
      }
      out.push('');
    }
  }

  if (includeSymbols) {
    const symbols = await findSymbols(args.query, {
      kind: undefined,
      language: args.language,
      glob: args.glob,
      limit,
    });
    if (symbols.length > 0) {
      out.push(`## Symbols (${symbols.length})`);
      for (const s of symbols.slice(0, limit)) {
        out.push(`${symbolIcon} ${s.kind} ${s.name} in ${relativizeToRoot(s.file)?.relative ?? s.file}:${s.startLine}-${s.endLine}`);
      }
      out.push('');
    }
  }

  if (includeCode) {
    const matches = await searchFiles(args.query, {
      mode: 'plain',
      glob: args.glob,
      limit,
      contextLines: 2,
    });
    if (matches.length > 0) {
      out.push(`## Code matches (${matches.length})`);
      for (const m of matches.slice(0, limit)) {
        const rel = relativizeToRoot(m.absolutePath)?.relative ?? m.absolutePath;
        out.push(`${codeIcon} ${rel}:${m.lineNumber} ${m.lineContent.slice(0, 120)}`);
      }
      out.push('');
    }
  }

  if (out.length === 0) return okResult(`No matches found for "${args.query}".`);
  return okResult(out.join('\n'));
}

// ── read ─────────────────────────────────────────────────────────────────────

export async function readHandler(args: z.infer<typeof readSchema>) {
  const resolved = makeAllowedPath(args.path);
  if (!resolved) return errorResult('Path is outside allowed roots');
  if (!(await fileExists(resolved))) return errorResult('File not found');

  const rel = relativizeToRoot(resolved)?.relative ?? args.path;
  const maxLines = clamp(args.max_lines ?? 100, 1, 200);
  const type = args.type ?? 'lines';

  const parsed = await parseFile(resolved);

  if (type === 'outline') {
    if (!parsed) return errorResult('Could not parse file (unsupported or too large)');
    const imports = await getImports(resolved);
    const lines: string[] = [`# ${rel} | ${parsed.language} | ${parsed.metrics.totalLines} lines`];
    if (parsed.structure.length > 0) {
      lines.push('\n## Symbols');
      for (const s of parsed.structure) {
        lines.push(`- ${s.kind} ${s.name} (L${s.startLine}-${s.endLine})`);
      }
    }
    if (imports && imports.length > 0) {
      lines.push('\n## Imports');
      for (const imp of imports) {
        const items = imp.isWildcard ? '*' : imp.items.join(', ');
        lines.push(`- "${imp.source}" → ${items}`);
      }
    }
    return okResult(lines.join('\n'));
  }

  if (type === 'symbol') {
    if (!args.symbol_name) return errorResult('symbol_name is required when type=symbol');
    if (!parsed) return errorResult('Could not parse file (unsupported or too large)');
    const symbol = parsed.structure.find((s) => s.name === args.symbol_name);
    if (!symbol) return errorResult(`Symbol "${args.symbol_name}" not found in ${rel}`);

    const end = Math.min(symbol.endLine, symbol.startLine + maxLines - 1);
    const snippet = await readSnippet(resolved, symbol.startLine, end);
    if (!snippet) return errorResult('Could not read symbol body');
    return okResult(
      `${symbol.kind} ${symbol.name} in ${rel} (L${symbol.startLine}-${symbol.endLine} of ${snippet.totalLines}):\n\n${snippet.snippet}`,
    );
  }

  const totalLines = parsed?.metrics.totalLines ?? 0;
  const effectiveStart = args.start_line ?? 1;
  const effectiveEnd = Math.min(args.end_line ?? (effectiveStart + maxLines - 1), effectiveStart + maxLines - 1, totalLines || Infinity);
  const snippet = await readSnippet(resolved, effectiveStart, effectiveEnd);
  if (!snippet) return errorResult('Could not read file');
  return okResult(
    `File: ${rel}\nLanguage: ${parsed?.language ?? detectLanguageForPath(resolved) ?? 'unknown'}\nLines ${snippet.startLine}-${snippet.endLine} of ${snippet.totalLines}:\n\n${snippet.snippet}`,
  );
}

// ── query ────────────────────────────────────────────────────────────────────

export async function queryHandler(args: z.infer<typeof querySchema>) {
  const roots = getRoots();
  if (roots.length === 0) return errorResult('No roots configured');
  const rootPath = roots[0].path;
  const question = args.question.toLowerCase();
  const maxFiles = args.max_files ?? 5;
  const maxSymbols = args.max_symbols_per_file ?? 5;

  const stopWords = new Set([
    'how', 'does', 'what', 'where', 'when', 'why', 'the', 'and', 'for', 'with',
    'from', 'this', 'that', 'use', 'using', 'does', 'work', 'is', 'are', 'do', 'a', 'an',
    'to', 'in', 'of', 'on', 'it', 'its', 'be', 'by', 'or', 'as', 'can', 'has', 'have',
  ]);
  const keywords = question
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));

  const keywordVariants = new Set<string>();
  for (const kw of keywords) {
    keywordVariants.add(kw);
    if (kw.endsWith('ication')) keywordVariants.add(kw.replace(/ication$/, ''));
    if (kw.endsWith('ization')) keywordVariants.add(kw.replace(/ization$/, ''));
    if (kw.endsWith('ation')) keywordVariants.add(kw.replace(/ation$/, ''));
    if (kw.endsWith('ment')) keywordVariants.add(kw.replace(/ment$/, ''));
    if (kw.endsWith('ing')) keywordVariants.add(kw.replace(/ing$/, ''));
    if (kw.endsWith('ers')) keywordVariants.add(kw.replace(/ers$/, ''));
    if (kw.endsWith('er')) keywordVariants.add(kw.replace(/er$/, ''));
    if (kw.endsWith('ed')) keywordVariants.add(kw.replace(/ed$/, ''));
    if (kw.endsWith('s')) keywordVariants.add(kw.replace(/s$/, ''));
    if (kw.length > 7) keywordVariants.add(kw.slice(0, 4));
    if (kw.length > 9) keywordVariants.add(kw.slice(0, 6));
  }

  const synonyms: Record<string, string[]> = {
    authentication: ['auth'],
    authorization: ['auth'],
    authenticate: ['auth'],
    authorize: ['auth'],
    database: ['db'],
    configuration: ['config', 'configure'],
    middleware: ['mw'],
  };
  for (const kw of keywords) {
    (synonyms[kw] ?? []).forEach((s) => keywordVariants.add(s));
  }

  const keywordList = [...keywordVariants].filter((k) => k.length >= 2).sort((a, b) => a.length - b.length);

  const codeGlob = '**/*.{ts,tsx,js,jsx,py,go,rs,java,c,cpp,rb,swift,kt,ex,scala,php,cs,sh}';
  const seenFiles = new Set<string>();

  for (const kw of keywordList) {
    if (seenFiles.size >= maxFiles * 4) break;
    const pathGlobs = [`**/*${kw}*`, `**/*${kw}*/**/*`];
    for (const g of pathGlobs) {
      const matches = await listFiles(g, { limit: maxFiles * 2, exclude: DOC_EXCLUDES });
      for (const f of matches) {
        if (/\.(ts|tsx|js|jsx|py|go|rs|java|c|cpp|rb|swift|kt|ex|scala|php|cs|sh)$/.test(f.relativePath)) {
          seenFiles.add(f.absolutePath);
        }
      }
    }
  }

  for (const kw of keywordList) {
    if (seenFiles.size >= maxFiles * 4) break;
    const batch = await searchFiles(kw, { mode: 'plain', glob: codeGlob, limit: maxFiles * 4, contextLines: 0 });
    for (const m of batch) seenFiles.add(m.absolutePath);
  }

  const codeFiles = [...seenFiles].slice(0, maxFiles);

  let docMatches: Awaited<ReturnType<typeof searchFiles>> = [];
  if (args.include_docs !== false) {
    for (const kw of keywordList) {
      docMatches = await searchFiles(kw, { mode: 'plain', glob: '**/*.md', limit: 5, contextLines: 0 });
      if (docMatches.length > 0) break;
    }
  }
  const docFiles = [...new Set(docMatches.map((m) => m.absolutePath))].slice(0, 2);

  if (codeFiles.length === 0) {
    return okResult(`No relevant code found for: "${args.question}"`);
  }

  const keywordSet = new Set<string>();
  for (const kw of keywordList) {
    keywordSet.add(kw);
    keywordSet.add(kw.replace(/s$/, ''));
  }
  const allKeywords = [...keywordSet];

  const fileResults: string[] = [];
  for (const filePath of codeFiles) {
    const parsed = await parseFile(filePath);
    const relPath = path.relative(rootPath, filePath);
    const lines: string[] = [`## ${relPath}`];

    if (!parsed) {
      lines.push('Could not parse file.');
      fileResults.push(lines.join('\n'));
      continue;
    }

    lines.push(`Language: ${parsed.language} | Lines: ${parsed.metrics.totalLines} | Symbols: ${parsed.structure.length}`);

    let symbols = parsed.structure
      .filter((s) => allKeywords.some((k) => s.name.toLowerCase().includes(k) || s.kind.toLowerCase().includes(k)))
      .slice(0, maxSymbols);
    if (symbols.length === 0) symbols = parsed.structure.slice(0, maxSymbols);

    for (const s of symbols) {
      lines.push(`- ${s.kind} ${s.name} (L${s.startLine}-${s.endLine})`);
    }

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
      docLines.push(`- ${path.relative(rootPath, docPath)}`);
    }
  }

  const header = `Question: "${args.question}"\nRelevant files: ${codeFiles.length}\n`;
  return okResult(header + '\n' + fileResults.join('\n\n') + docLines.join('\n'));
}

// ── trace ────────────────────────────────────────────────────────────────────

export async function traceHandler(args: z.infer<typeof traceSchema>) {
  const roots = getRoots();
  if (roots.length === 0) return errorResult('No roots configured');
  const includeGit = args.include_git ?? true;
  const maxRefs = args.max_refs ?? 15;

  const result = await traceSymbol(args.name, { kind: args.kind, path: args.path });

  const lines: string[] = [];
  if (result.definition) {
    const d = result.definition;
    const rel = relativizeToRoot(d.file)?.relative ?? d.file;
    lines.push(`Definition: ${d.kind} ${d.name} at ${rel}:${d.startLine}-${d.endLine}`);
    if (d.docComment) lines.push(`Docstring: ${d.docComment.slice(0, 200)}`);
  } else {
    lines.push('Definition: not found');
  }

  if (result.references.length > 0) {
    lines.push(`\nReferences (${result.references.length}):`);
    for (const ref of result.references.slice(0, maxRefs)) {
      const rel = relativizeToRoot(ref.absolutePath)?.relative ?? ref.absolutePath;
      lines.push(`\n${rel}:${ref.lineNumber}\n${ref.snippet}\n`);
    }
  } else {
    lines.push('\nReferences: none found');
  }

  if (includeGit && result.definition) {
    const log = await gitLog(result.definition.file, 5);
    if (log.isGitRepo && log.entries.length > 0) {
      lines.push('\n## Recent commits');
      for (const e of log.entries.slice(0, 5)) {
        lines.push(`${e.commit.slice(0, 8)} | ${e.author} | ${e.date.slice(0, 10)} | ${e.message}`);
      }
    }

    const blame = await gitBlame(result.definition.file, result.definition.startLine, result.definition.endLine);
    if (blame.isGitRepo && blame.lines.length > 0) {
      lines.push('\n## Blame for definition');
      for (const l of blame.lines.slice(0, 8)) {
        const blameDate = l.authorTime ? new Date(parseInt(l.authorTime, 10) * 1000).toISOString().slice(0, 10) : '';
      lines.push(`${l.commit} ${l.author.padEnd(14)} ${blameDate} | ${l.content.slice(0, 80)}`);
      }
    }
  }

  return okResult(lines.join('\n'));
}

// ── deps ─────────────────────────────────────────────────────────────────────

export async function depsHandler(args: z.infer<typeof depsSchema>) {
  const roots = getRoots();
  if (roots.length === 0) return errorResult('No roots configured');
  const limit = args.limit ?? 20;

  const analysis = await analyzeDependencies({ target: args.target, direction: args.direction, limit });
  if (analysis.error) return errorResult(analysis.error);

  return okResult(analysis.text);
}

// ── tests ────────────────────────────────────────────────────────────────────

export async function testsHandler(args: z.infer<typeof testsSchema>) {
  const roots = getRoots();
  if (roots.length === 0) return errorResult('No roots configured');
  const limit = args.limit ?? 20;

  const result = await discoverTests({ target: args.target, limit });
  return okResult(result.text);
}

// ── changes ──────────────────────────────────────────────────────────────────

export async function changesHandler(args: z.infer<typeof changesSchema>) {
  const roots = getRoots();
  if (roots.length === 0) return errorResult('No roots configured');

  const maxCommits = args.max_commits ?? 30;
  const hotFiles = args.hot_files ?? 10;
  const sinceDays = args.since_days ?? 14;

  const summary = await recentChanges({ maxCommits, hotFiles, sinceDays });
  if (!summary.ok) return okResult(summary.error || 'No git history available.');

  const lines: string[] = [];
  lines.push(`# Recent activity (last ${sinceDays} days)`);
  lines.push(`- Total commits: ${summary.commitCount}`);
  lines.push(`- Unique authors: ${summary.uniqueAuthors.size}`);
  lines.push(`- Files changed: ${summary.fileChangeCounts.size}`);
  lines.push('');

  if (summary.commits.length > 0) {
    lines.push('## Latest commits');
    for (const c of summary.commits.slice(0, 15)) {
      lines.push(`${c.hash.slice(0, 8)} | ${c.date.slice(0, 10)} | ${c.author} | ${c.message}`);
    }
    lines.push('');
  }

  if (hotFiles > 0 && summary.fileChangeCounts.size > 0) {
    lines.push('## Hot files (most changed)');
    const sorted = [...summary.fileChangeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, hotFiles);
    for (const [file, count] of sorted) {
      lines.push(`- ${file} (${count})`);
    }
  }

  return okResult(lines.join('\n'));
}

// ── docs ─────────────────────────────────────────────────────────────────────

export async function docsHandler(args: z.infer<typeof docsSchema>) {
  const roots = getRoots();
  if (roots.length === 0) return errorResult('No roots configured');
  const limit = args.max_results ?? 10;
  const scope = args.scope ?? 'all';
  const results: string[] = [];

  if (scope !== 'code') {
    const docMatches = await searchFiles(args.topic, {
      mode: 'plain',
      glob: '**/*.md',
      limit,
      contextLines: 2,
    });
    for (const m of docMatches) {
      if (results.length >= limit) break;
      const snippet = await readSnippet(m.absolutePath, m.lineNumber - 2, m.lineNumber + 2);
      if (snippet) {
        const rel = relativizeToRoot(m.absolutePath)?.relative ?? m.relativePath;
        results.push(`📝 ${rel}:${m.lineNumber}\n${snippet.snippet}\n`);
      }
    }
  }

  if (scope !== 'docs' && results.length < limit) {
    const codeMatches = await searchFiles(args.topic, {
      mode: 'plain',
      glob: '**/*.{ts,js,py,go,rs,java,c,cpp,rb,swift,kt,ex,scala,php,cs,sh}',
      limit: limit - results.length,
      contextLines: 3,
    });
    for (const m of codeMatches) {
      if (results.length >= limit) break;
      const snippet = await readSnippet(m.absolutePath, m.lineNumber - 3, m.lineNumber + 3);
      if (snippet && /\/\/|\/\*|#|"""|'''/.test(snippet.snippet)) {
        const rel = relativizeToRoot(m.absolutePath)?.relative ?? m.relativePath;
        results.push(`💬 ${rel}:${m.lineNumber}\n${snippet.snippet}\n`);
      }
    }
  }

  if (results.length === 0) return okResult(`No documentation found for "${args.topic}".`);
  return okResult(`Found ${results.length} reference(s) for "${args.topic}":\n\n${results.join('\n').slice(0, 10000)}`);
}

// ── analyze ──────────────────────────────────────────────────────────────────

export async function analyzeHandler(args: z.infer<typeof analyzeSchema>) {
  const resolved = makeAllowedPath(args.path);
  if (!resolved) return errorResult('Path is outside allowed roots');
  if (!(await fileExists(resolved))) return errorResult('File not found');

  const rel = relativizeToRoot(resolved)?.relative ?? args.path;
  const parsed = await parseFile(resolved);
  if (!parsed) return errorResult('Could not parse file (unsupported or too large)');

  const includeRefs = args.include_refs ?? true;
  const includeGit = args.include_git ?? false;
  const maxRefs = args.max_refs ?? 10;

  const lines: string[] = [];
  lines.push(`# ${rel}`);
  lines.push(`Language: ${parsed.language} | Lines: ${parsed.metrics.totalLines} | Symbols: ${parsed.structure.length}`);

  if (parsed.structure.length > 0) {
    lines.push('\n## Symbols');
    for (const s of parsed.structure) {
      lines.push(`- ${s.kind} ${s.name} (L${s.startLine}-${s.endLine})`);
    }
  }

  if (parsed.imports.length > 0) {
    lines.push('\n## Imports');
    for (const imp of parsed.imports.slice(0, 30)) {
      const items = imp.isWildcard ? '*' : imp.items.join(', ');
      lines.push(`- "${imp.source}" → ${items}`);
    }
  }

  if (parsed.exports.length > 0) {
    lines.push('\n## Exports');
    for (const exp of parsed.exports.slice(0, 30)) {
      lines.push(`- ${exp.kind} ${exp.name}`);
    }
  }

  if (includeRefs && parsed.exports.length > 0) {
    lines.push('\n## External references');
    for (const exp of parsed.exports.slice(0, maxRefs)) {
      const refs = await searchFiles(exp.name, { mode: 'plain', limit: 8, contextLines: 0 });
      const external = refs.filter((r) => r.absolutePath !== resolved).slice(0, 3);
      if (external.length > 0) {
        const locations = external.map((r) => `${relativizeToRoot(r.absolutePath)?.relative ?? r.absolutePath}:${r.lineNumber}`);
        lines.push(`- ${exp.name}: ${locations.join(', ')}`);
      }
    }
  }

  if (includeGit) {
    const blame = await gitBlame(resolved, 1, Math.min(parsed.metrics.totalLines, 50));
    if (blame.isGitRepo && blame.lines.length > 0) {
      lines.push('\n## Recent authors (first 50 lines)');
      const authorCounts = new Map<string, number>();
      for (const l of blame.lines) {
        authorCounts.set(l.author, (authorCounts.get(l.author) ?? 0) + 1);
      }
      for (const [author, count] of [...authorCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
        lines.push(`- ${author}: ${count} line(s)`);
      }
    }

    const log = await gitLog(resolved, 5);
    if (log.isGitRepo && log.entries.length > 0) {
      lines.push('\n## Recent commits');
      for (const e of log.entries.slice(0, 5)) {
        lines.push(`${e.commit.slice(0, 8)} | ${e.date.slice(0, 10)} | ${e.author} | ${e.message}`);
      }
    }
  }

  return okResult(lines.join('\n'));
}

// ── roots ────────────────────────────────────────────────────────────────────

export async function rootsHandler() {
  const roots = getRoots();
  return okResult(JSON.stringify(
    roots.map((r) => ({ uri: r.uri, name: r.name, path: r.path })),
    null, 2,
  ));
}

