import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  RootsListChangedNotificationSchema,
  type ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { setRoots, initializeFallbackRoot, getRoots, makeAllowedPath } from './roots.js';
import { readSnippet, fileExists } from './files.js';
import { parseFile, detectLanguageForPath } from './parser.js';
import { searchFiles, listFiles } from './search.js';
import { findSymbols, traceSymbol, getImports } from './symbols.js';
import { gitLog, gitBlame } from './git.js';
import {
  repoBriefSchema,
  repoBriefHandler,
  queryRepoSchema,
  queryRepoHandler,
  analyzeFileSchema,
  analyzeFileHandler,
  importGraphSchema,
  importGraphHandler,
  summarizeDocumentationSchema,
  summarizeDocumentationHandler,
} from './repo-tools.js';
import { errorResult, okResult, log, DEFAULT_SEARCH_LIMIT } from './utils.js';
import fs from 'node:fs';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
const VERSION = pkg.version as string;

const readOnly: ToolAnnotations = { readOnlyHint: true };

// ─── Tool schemas ───────────────────────────────────────────────────────────

const listDirectorySchema = z.object({
  path: z.string().describe('Directory path relative to project root'),
  depth: z.number().int().min(1).max(3).optional().describe('How many levels deep to recurse (default: 1)'),
  limit: z.number().int().min(1).max(200).optional().describe('Maximum entries to return'),
});

const globFilesSchema = z.object({
  pattern: z.string().describe('Glob pattern (e.g. "**/*.ts", "src/**/*.py")'),
  limit: z.number().int().min(1).max(200).optional().describe('Maximum file paths to return'),
});

const getFileOutlineSchema = z.object({
  path: z.string().describe('Path to the source file'),
});

const readFileSchema = z.object({
  path: z.string().describe('Path to the file'),
  start_line: z.number().int().optional().describe('First line to read (1-indexed, default: 1)'),
  end_line: z.number().int().optional().describe('Last line to read (1-indexed, default: end of file)'),
  symbol_name: z.string().optional().describe('Name of a symbol to read its definition body (overrides start_line/end_line)'),
});

const findSymbolsSchema = z.object({
  query: z.string().describe('Symbol name or substring to search for'),
  kind: z.string().optional().describe('Filter by kind, e.g. function, class, method'),
  language: z.string().optional().describe('Filter by language name'),
  glob: z.string().optional().describe('Glob pattern to scope files'),
  limit: z.number().int().min(1).max(100).optional(),
});

const findImportsSchema = z.object({
  path: z.string().describe('Path to the source file'),
  module: z.string().optional().describe('Filter imports by source module'),
  symbol: z.string().optional().describe('Filter imports by symbol name'),
});

const traceSymbolSchema = z.object({
  name: z.string().describe('Symbol name'),
  kind: z.string().optional().describe('Kind hint, e.g. function'),
  path: z.string().optional().describe('File where the symbol is defined, if known'),
});

const searchCodeSchema = z.object({
  pattern: z.string().describe('Pattern to search for'),
  mode: z.enum(['plain', 'regex', 'fuzzy']).optional().describe('Search mode'),
  glob: z.string().optional().describe('Glob pattern to scope files'),
  case_sensitive: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  context_lines: z.number().int().min(0).max(5).optional().describe('Context lines around each match'),
});

const detectLanguageSchema = z.object({
  path: z.string().describe('File path'),
});

const getProjectOverviewSchema = z.object({
  path: z.string().optional().describe('Optional sub-path within roots'),
});

const listRootsSchema = z.object({});

// ─── Server start ───────────────────────────────────────────────────────────

export async function startServer(): Promise<void> {
  const server = new McpServer(
    { name: '@idea404/repocontext', version: VERSION },
    { capabilities: {} },
  );

  // ── list_directory ──────────────────────────────────────────────────────
  server.registerTool(
    'list_directory',
    {
      description: 'List files and subdirectories in a directory. Bounded, root-safe.',
      inputSchema: listDirectorySchema,
      annotations: readOnly,
    },
    async (args) => {
      const resolved = makeAllowedPath(args.path);
      if (!resolved) return errorResult('Path is outside allowed roots');

      const depth = Math.max(1, Math.min(3, args.depth ?? 1));
      const limit = args.limit ?? 100;
      const prefix = depth === 1 ? '*' : `${'*/'.repeat(depth - 1)}*`;
      const glob = path.posix.join(resolved.replace(/\\/g, '/'), prefix);

      const entries = await listFiles(glob, { limit });
      const lines = entries.map((e) => {
        const rel = path.relative(resolved, e.absolutePath);
        const isDir = fs.statSync(e.absolutePath, { throwIfNoEntry: false })?.isDirectory();
        return isDir ? `📁 ${rel}/` : `📄 ${rel}`;
      });

      return okResult(lines.length > 0
        ? lines.join('\n')
        : 'Directory is empty or no readable files found.');
    },
  );

  // ── glob_files ──────────────────────────────────────────────────────────
  server.registerTool(
    'glob_files',
    {
      description: 'Find files matching a glob pattern across the project. Returns file paths.',
      inputSchema: globFilesSchema,
      annotations: readOnly,
    },
    async (args) => {
      const limit = args.limit ?? 100;
      const entries = await listFiles(args.pattern, { limit });
      if (entries.length === 0) return okResult('No files matched.');

      const lines = entries.map((e) => `- ${e.relativePath}`);
      return okResult(lines.join('\n'));
    },
  );

  // ── get_file_outline ────────────────────────────────────────────────────
  server.registerTool(
    'get_file_outline',
    {
      description: 'Parse a source file and return its structure: functions, classes, imports, exports. Token-efficient alternative to reading the whole file.',
      inputSchema: getFileOutlineSchema,
      annotations: readOnly,
    },
    async (args) => {
      const resolved = makeAllowedPath(args.path);
      if (!resolved) return errorResult('Path is outside allowed roots');
      if (!(await fileExists(resolved))) return errorResult('File not found');

      const parsed = await parseFile(resolved);
      if (!parsed) return errorResult('Could not parse file (unsupported or too large)');

      return okResult(JSON.stringify({
        path: resolved,
        language: parsed.language,
        metrics: parsed.metrics,
        structure: parsed.structure?.map((s) => ({
          kind: s.kind,
          name: s.name,
          start_line: s.startLine,
          end_line: s.endLine,
        })),
        imports: parsed.imports?.map((i) => ({
          source: i.source,
          items: i.items,
          is_wildcard: i.isWildcard,
        })),
        exports: parsed.exports?.map((e) => ({
          name: e.name,
          kind: e.kind,
        })),
      }, null, 2));
    },
  );

  // ── read_file ───────────────────────────────────────────────────────────
  server.registerTool(
    'read_file',
    {
      description: 'Read a file or a range of lines. Line-range reading is token-efficient for large files.',
      inputSchema: readFileSchema,
      annotations: readOnly,
    },
    async (args) => {
      const resolved = makeAllowedPath(args.path);
      if (!resolved) return errorResult('Path is outside allowed roots');

      let start = args.start_line;
      let end = args.end_line;

      if (args.symbol_name) {
        const parsed = await parseFile(resolved);
        const symbol = parsed?.structure?.find((s) => s.name === args.symbol_name);
        if (!symbol) return errorResult(`Symbol "${args.symbol_name}" not found in ${resolved}`);
        start = symbol.startLine;
        end = symbol.endLine;
      }

      const snippet = await readSnippet(resolved, start, end);
      if (!snippet) return errorResult('Could not read snippet');

      return okResult(
        `File: ${snippet.path}\nLanguage: ${snippet.language}\nLines ${snippet.startLine}-${snippet.endLine} of ${snippet.totalLines}:\n\n${snippet.snippet}`,
      );
    },
  );

  // ── find_symbols ────────────────────────────────────────────────────────
  server.registerTool(
    'find_symbols',
    {
      description: 'Search for symbol definitions across the project. Token-efficient: returns only names, kinds, and locations — not file contents.',
      inputSchema: findSymbolsSchema,
      annotations: readOnly,
    },
    async (args) => {
      const symbols = await findSymbols(args.query, {
        kind: args.kind,
        language: args.language,
        glob: args.glob,
        limit: args.limit ?? DEFAULT_SEARCH_LIMIT,
      });

      if (symbols.length === 0) return okResult('No symbols found.');

      const lines = symbols.map(
        (s) => `${s.kind} ${s.name} in ${s.file}:${s.startLine}-${s.endLine}`,
      );
      return okResult(lines.join('\n'));
    },
  );

  // ── find_imports ────────────────────────────────────────────────────────
  server.registerTool(
    'find_imports',
    {
      description: 'List imports in a file, optionally filtered by module or symbol.',
      inputSchema: findImportsSchema,
      annotations: readOnly,
    },
    async (args) => {
      const resolved = makeAllowedPath(args.path);
      if (!resolved) return errorResult('Path is outside allowed roots');

      const imports = await getImports(resolved);
      if (!imports) return errorResult('Could not parse file');

      let filtered = imports;
      if (args.module) {
        filtered = filtered.filter((i) => i.source.includes(args.module!));
      }
      if (args.symbol) {
        filtered = filtered.filter((i) => i.items.includes(args.symbol!) || i.isWildcard);
      }

      if (filtered.length === 0) return okResult('No matching imports found.');

      const lines = filtered.map((i) => {
        const items = i.isWildcard ? '*' : i.items.join(', ');
        return `- from "${i.source}" import ${items}`;
      });
      return okResult(lines.join('\n'));
    },
  );

  // ── trace_symbol ────────────────────────────────────────────────────────
  server.registerTool(
    'trace_symbol',
    {
      description: 'Find where a symbol is defined and where it is referenced throughout the project.',
      inputSchema: traceSymbolSchema,
      annotations: readOnly,
    },
    async (args) => {
      const result = await traceSymbol(args.name, { kind: args.kind, path: args.path });

      const parts: string[] = [];
      if (result.definition) {
        const d = result.definition;
        parts.push(`Definition: ${d.kind} ${d.name} at ${d.file}:${d.startLine}-${d.endLine}`);
        if (d.docComment) parts.push(`Docstring: ${d.docComment.slice(0, 200)}`);
      } else {
        parts.push('Definition: not found');
      }

      if (result.references.length > 0) {
        parts.push(`\nReferences (${result.references.length}):`);
        for (const ref of result.references) {
          parts.push(`\n${ref.absolutePath}:${ref.lineNumber}\n${ref.snippet}\n`);
        }
      } else {
        parts.push('\nReferences: none found');
      }

      return okResult(parts.join('\n'));
    },
  );

  // ── search_code ─────────────────────────────────────────────────────────
  server.registerTool(
    'search_code',
    {
      description: 'Search code across project files with plain text, regex, or fuzzy matching. Returns file paths + matched lines with context.',
      inputSchema: searchCodeSchema,
      annotations: readOnly,
    },
    async (args) => {
      const matches = await searchFiles(args.pattern, {
        mode: args.mode ?? 'plain',
        glob: args.glob,
        limit: args.limit ?? DEFAULT_SEARCH_LIMIT,
        contextLines: args.context_lines ?? 1,
      });

      if (matches.length === 0) return okResult('No matches found.');

      const contextLines = args.context_lines ?? 1;
      const parts: string[] = [`Found ${matches.length} match(es):\n`];

      for (const m of matches) {
        const buffer = await readSnippet(
          m.absolutePath,
          m.lineNumber - contextLines,
          m.lineNumber + contextLines,
        );
        parts.push(`${m.absolutePath}:${m.lineNumber}`);
        if (buffer) parts.push(buffer.snippet);
        parts.push('');
      }

      return okResult(parts.join('\n'));
    },
  );

  // ── detect_language ─────────────────────────────────────────────────────
  server.registerTool(
    'detect_language',
    {
      description: 'Detect what programming language a file is written in based on its extension.',
      inputSchema: detectLanguageSchema,
      annotations: readOnly,
    },
    async (args) => {
      const resolved = makeAllowedPath(args.path);
      if (!resolved) return errorResult('Path is outside allowed roots');
      const language = detectLanguageForPath(resolved);
      return okResult(JSON.stringify(
        { path: resolved, language, extension: path.extname(resolved).slice(1) },
        null, 2,
      ));
    },
  );

  // ── git_log ─────────────────────────────────────────────────────────────
  server.registerTool(
    'git_log',
    {
      description: 'Show recent commits affecting a file. Lightweight git history for understanding why code changed.',
      inputSchema: z.object({
        path: z.string().describe('Path to the file'),
        max_count: z.number().int().min(1).max(50).optional().describe('Max commits to return (default: 10)'),
      }),
      annotations: readOnly,
    },
    async (args) => {
      const resolved = makeAllowedPath(args.path);
      if (!resolved) return errorResult('Path is outside allowed roots');

      const result = await gitLog(resolved, args.max_count ?? 10);
      if (!result.isGitRepo) return okResult('Not a git repository or git not available.');
      if (result.entries.length === 0) return okResult('No commits found for this file.');

      const lines = result.entries.map((e) =>
        `${e.commit} | ${e.author} | ${e.date.slice(0, 10)} | ${e.message}`,
      );
      return okResult(`Git log for ${resolved}:\n\n${lines.join('\n')}`);
    },
  );

  // ── git_blame ───────────────────────────────────────────────────────────
  server.registerTool(
    'git_blame',
    {
      description: 'Show who last modified each line of a file (git blame). Useful for understanding context around specific code.',
      inputSchema: z.object({
        path: z.string().describe('Path to the file'),
        start_line: z.number().int().optional().describe('Starting line (1-indexed)'),
        end_line: z.number().int().optional().describe('Ending line (1-indexed)'),
      }),
      annotations: readOnly,
    },
    async (args) => {
      const resolved = makeAllowedPath(args.path);
      if (!resolved) return errorResult('Path is outside allowed roots');

      const result = await gitBlame(resolved, args.start_line, args.end_line);
      if (!result.isGitRepo) return okResult('Not a git repository or git not available.');
      if (result.lines.length === 0) return okResult('No blame info available.');

      const maxLine = result.lines[result.lines.length - 1].lineNumber;
      const width = String(maxLine).length;
      const lines = result.lines.map((l) => {
        const date = l.authorTime ? new Date(parseInt(l.authorTime, 10) * 1000).toISOString().slice(0, 10) : '';
        return `${String(l.lineNumber).padStart(width)} | ${l.commit} | ${l.author.padEnd(16)} | ${date} | ${l.content}`;
      });
      return okResult(`Git blame for ${resolved}:\n\n${lines.join('\n')}`);
    },
  );

  // ── find_documentation ──────────────────────────────────────────────────
  server.registerTool(
    'find_documentation',
    {
      description: 'Search project documentation and code comments for a topic. Searches README, markdown files, docs directories, and code comments/docstrings. The go-to tool when you need to understand how to use something, not just where it is defined.',
      inputSchema: z.object({
        query: z.string().describe('Topic or term to find documentation about'),
        scope: z.enum(['all', 'docs', 'code']).optional().describe('Scope to documentation files only or code comments only (default: all)'),
        glob: z.string().optional().describe('Optional glob to narrow search within specific files'),
        limit: z.number().int().min(1).max(30).optional().describe('Max results (default: 10)'),
      }),
      annotations: readOnly,
    },
    async (args) => {
      const limit = args.limit ?? 10;
      const results: string[] = [];

      // 1. Search markdown documentation files
      if (args.scope !== 'code') {
        const docGlob = args.glob ?? '**/*.md';
        const docMatches = await searchFiles(args.query, {
          mode: 'plain',
          glob: docGlob,
          limit,
          contextLines: 2,
        });
        for (const m of docMatches.slice(0, limit)) {
          const snippet = await readSnippet(m.absolutePath, m.lineNumber - 2, m.lineNumber + 2);
          if (snippet) {
            results.push(`📝 ${m.relativePath}:${m.lineNumber}\n${snippet.snippet}\n`);
          }
        }
      }

      // 2. Search code comments: look for comment-like patterns near the query
      if (args.scope !== 'docs' && results.length < limit) {
        const commentPattern = args.query;
        const codeMatches = await searchFiles(commentPattern, {
          mode: 'plain',
          glob: args.glob ?? '**/*.{ts,js,py,rs,go,java,c,cpp,rb,swift,kt,ex,hs,scala,php,cs,sh}',
          limit: limit - results.length,
          contextLines: 3,
        });
        for (const m of codeMatches.slice(0, limit - results.length)) {
          const snippet = await readSnippet(m.absolutePath, m.lineNumber - 3, m.lineNumber + 3);
          if (snippet && results.length < limit) {
            const isComment = snippet.snippet.includes('//') || snippet.snippet.includes('#')
              || snippet.snippet.includes('/*') || snippet.snippet.includes('"""')
              || snippet.snippet.includes("'''");
            if (isComment) {
              results.push(`💬 ${m.relativePath}:${m.lineNumber}\n${snippet.snippet}\n`);
            }
          }
        }
      }

      if (results.length === 0) return okResult('No documentation found for this topic.');

      return okResult(
        `Found ${results.length} documentation reference(s) about "${args.query}":\n\n${results.join('\n').slice(0, 10000)}`,
      );
    },
  );

  // ── get_project_overview ────────────────────────────────────────────────
  server.registerTool(
    'get_project_overview',
    {
      description: 'Get a rich project overview in one call: language breakdown, file counts, entry points, config files, and top-level directory structure. The ideal starting point for understanding a new codebase.',
      inputSchema: getProjectOverviewSchema,
      annotations: readOnly,
    },
    async () => {
      const roots = getRoots();
      const languages: Record<string, number> = {};
      let totalFiles = 0;
      let totalLines = 0;
      const entryPoints: string[] = [];
      const configFiles: string[] = [];
      const dirTree: Record<string, { fileCount: number; dirCount: number }> = {};

      const ENTRY_POINT_NAMES = new Set([
        'main.ts', 'main.js', 'main.py', 'main.rs', 'main.go', 'main.java', 'main.c', 'main.cpp',
        'index.ts', 'index.js', 'index.py',
        'app.ts', 'app.js', 'app.py',
        'cli.ts', 'cli.js', 'cli.py',
        'server.ts', 'server.js', 'server.py',
        'api.ts', 'api.js', 'api.py',
        '__main__.py', '__init__.py',
      ]);

      const CONFIG_FILE_NAMES = new Set([
        'package.json', 'tsconfig.json', 'tsconfig.build.json',
        'Cargo.toml', 'Cargo.lock',
        'go.mod', 'go.sum',
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

      const entries = await listFiles('**/*', {
        limit: 5000,
        exclude: ['node_modules/', '.git/', 'dist/', 'build/', '.next/', '.turbo/', 'target/', '__pycache__/', 'vendor/', '.venv/', 'venv/'],
      });

      for (const e of entries) {
        const lang = detectLanguageForPath(e.absolutePath);
        if (lang) languages[lang] = (languages[lang] ?? 0) + 1;
        totalFiles++;

        try {
          const content = await fs.promises.readFile(e.absolutePath, 'utf-8');
          totalLines += content.split('\n').length;
        } catch { /* skip binary/unreadable */ }

        const rel = e.relativePath;
        const parts = rel.split('/');

        if (parts.length >= 1) {
          for (let i = 0; i < Math.min(parts.length - 1, 2); i++) {
            const dir = parts.slice(0, i + 1).join('/');
            if (!dirTree[dir]) dirTree[dir] = { fileCount: 0, dirCount: 0 };
            dirTree[dir].fileCount++;
          }
        }

        const fileName = parts[parts.length - 1];

        if (ENTRY_POINT_NAMES.has(fileName)) {
          entryPoints.push(rel);
        }

        if (CONFIG_FILE_NAMES.has(fileName) || CONFIG_FILE_NAMES.has(`${fileName}/`)) {
          configFiles.push(rel);
        }
      }

      // Sort directory tree topologically
      const sortedDirs = Object.entries(dirTree)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([d, counts]) => ({
          path: d,
          fileCount: counts.fileCount,
        }));

      return okResult(JSON.stringify({
        roots: roots.map((r) => ({ path: r.path, uri: r.uri })),
        totalFiles,
        totalLines,
        languages,
        entryPoints: [...new Set(entryPoints)].slice(0, 20),
        configFiles: [...new Set(configFiles)].slice(0, 30),
        directoryStructure: sortedDirs.slice(0, 50),
      }, null, 2));
    },
  );

  // ── repo_brief ───────────────────────────────────────────────────────────
  server.registerTool(
    'repo_brief',
    {
      description: 'One-call repo overview: purpose, tech stack, languages, entry points, config files, and directory structure. Optimized for minimal tokens and a single tool call.',
      inputSchema: repoBriefSchema,
      annotations: readOnly,
    },
    async (args) => repoBriefHandler(args),
  );

  // ── query_repo ───────────────────────────────────────────────────────────
  server.registerTool(
    'query_repo',
    {
      description: 'Ask a natural-language question about the codebase and get back relevant files, symbols, and a snippet. Combines search, symbol extraction, and snippet reading into one call.',
      inputSchema: queryRepoSchema,
      annotations: readOnly,
    },
    async (args) => queryRepoHandler(args),
  );

  // ── analyze_file ─────────────────────────────────────────────────────────
  server.registerTool(
    'analyze_file',
    {
      description: 'Analyze a source file in one call: summary, symbols, imports, exports, or full analysis. Replaces multiple granular file tools.',
      inputSchema: analyzeFileSchema,
      annotations: readOnly,
    },
    async (args) => analyzeFileHandler(args),
  );

  // ── import_graph ─────────────────────────────────────────────────────────
  server.registerTool(
    'import_graph',
    {
      description: 'View module dependencies across the project. Without a module, returns top imported modules. With a module, shows what imports it or what it imports.',
      inputSchema: importGraphSchema,
      annotations: readOnly,
    },
    async (args) => importGraphHandler(args),
  );

  // ── summarize_documentation ──────────────────────────────────────────────
  server.registerTool(
    'summarize_documentation',
    {
      description: 'Read README, AGENTS.md, and other documentation files and return a concise summary.',
      inputSchema: summarizeDocumentationSchema,
      annotations: readOnly,
    },
    async (args) => summarizeDocumentationHandler(args),
  );

  // ── list_roots ──────────────────────────────────────────────────────────
  server.registerTool(
    'list_roots',
    {
      description: 'Show the currently allowed filesystem roots.',
      inputSchema: listRootsSchema,
      annotations: readOnly,
    },
    async () => {
      const roots = getRoots();
      return okResult(JSON.stringify(
        roots.map((r) => ({ uri: r.uri, name: r.name, path: r.path })),
        null, 2,
      ));
    },
  );

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
    log('info', 'Roots changed notification received');
    await refreshRoots(server.server);
  });

  initializeFallbackRoot();

  server.server.oninitialized = async () => {
    await refreshRoots(server.server);
  };

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('info', '@idea404/repocontext MCP server connected via stdio');
}

async function refreshRoots(server: McpServer['server']): Promise<void> {
  try {
    const clientCapabilities = server.getClientCapabilities();
    if (!clientCapabilities?.roots) {
      initializeFallbackRoot();
      return;
    }
    const rootsResult = await server.listRoots({}, { timeout: 5000 });
    if (rootsResult.roots && rootsResult.roots.length > 0) {
      setRoots(
        rootsResult.roots.map((r) => ({
          uri: r.uri,
          name: r.name,
          path: '',
        })),
      );
    } else {
      initializeFallbackRoot();
    }
  } catch (err) {
    log('warning', `Failed to fetch roots: ${err}`);
    initializeFallbackRoot();
  }
}
