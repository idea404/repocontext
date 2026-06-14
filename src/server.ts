import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  RootsListChangedNotificationSchema,
  type ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';

import { setRoots, initializeFallbackRoot } from './roots.js';
import {
  repoOverviewSchema,
  repoOverviewHandler,
  findSchema,
  findHandler,
  readSchema,
  readHandler,
  querySchema,
  queryHandler,
  traceSchema,
  traceHandler,
  depsSchema,
  depsHandler,
  testsSchema,
  testsHandler,
  changesSchema,
  changesHandler,
  docsSchema,
  docsHandler,
  analyzeSchema,
  analyzeHandler,
  rootsSchema,
  rootsHandler,
} from './tools.js';
import { log } from './utils.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
const VERSION = pkg.version as string;

const readOnly: ToolAnnotations = { readOnlyHint: true };

export async function startServer(): Promise<void> {
  const server = new McpServer(
    { name: '@idea404/repocontext', version: VERSION },
    { capabilities: {} },
  );

  // 1. repo_overview — single-call repo brief
  server.registerTool(
    'repo_overview',
    {
      description: 'One-call repo overview: purpose (from README), tech stack, languages, entry points, config files, directory structure, and AGENTS.md notes if present. Start here when learning a new codebase.',
      inputSchema: repoOverviewSchema,
      annotations: readOnly,
    },
    async (args) => repoOverviewHandler(args),
  );

  // 2. find — unified search over files, symbols, and code
  server.registerTool(
    'find',
    {
      description: 'Universal search: find files, symbol definitions, or code content in one call. Returns concise paths and line numbers, not whole files.',
      inputSchema: findSchema,
      annotations: readOnly,
    },
    async (args) => findHandler(args),
  );

  // 3. read — read a file, symbol body, or structural outline
  server.registerTool(
    'read',
    {
      description: 'Read file contents: line range, full symbol body, or structural outline (symbols + imports + exports). Token-efficient alternative to reading whole files.',
      inputSchema: readSchema,
      annotations: readOnly,
    },
    async (args) => readHandler(args),
  );

  // 4. query — natural-language codebase question
  server.registerTool(
    'query',
    {
      description: 'Ask a natural-language question about the codebase and get relevant files, symbols, and a snippet in one call. Use this to understand "how does X work?" without multiple searches.',
      inputSchema: querySchema,
      annotations: readOnly,
    },
    async (args) => queryHandler(args),
  );

  // 5. trace — definition, references, and recent git history for a symbol
  server.registerTool(
    'trace',
    {
      description: 'Trace a symbol: definition, references, docstring, recent commits, and blame for the definition. Replaces git_log/git_blame per symbol.',
      inputSchema: traceSchema,
      annotations: readOnly,
    },
    async (args) => traceHandler(args),
  );

  // 6. deps — dependency map, internal and external
  server.registerTool(
    'deps',
    {
      description: 'Dependency analysis: external packages (from package.json/Cargo.toml/pyproject.toml/etc.) and internal module import graph. Ask project-wide or focus on a specific module.',
      inputSchema: depsSchema,
      annotations: readOnly,
    },
    async (args) => depsHandler(args),
  );

  // 7. tests — test discovery and source↔test mapping
  server.registerTool(
    'tests',
    {
      description: 'Discover test files, detect framework, and map tests to source files. Omit target for overall test coverage.',
      inputSchema: testsSchema,
      annotations: readOnly,
    },
    async (args) => testsHandler(args),
  );

  // 8. changes — recent repo activity
  server.registerTool(
    'changes',
    {
      description: 'Recent repo activity: latest commits, authors, and most-changed files. Use to understand what is actively changing.',
      inputSchema: changesSchema,
      annotations: readOnly,
    },
    async (args) => changesHandler(args),
  );

  // 9. docs — documentation and code-comment search
  server.registerTool(
    'docs',
    {
      description: 'Find documentation about a topic in README/markdown files and code comments. Use when you need to understand how something works.',
      inputSchema: docsSchema,
      annotations: readOnly,
    },
    async (args) => docsHandler(args),
  );

  // 10. analyze — deep file analysis with refs and optional git blame
  server.registerTool(
    'analyze',
    {
      description: 'Deep analysis of a source file: symbols, imports, exports, external references, and optional git blame.',
      inputSchema: analyzeSchema,
      annotations: readOnly,
    },
    async (args) => analyzeHandler(args),
  );

  // 11. roots — utility to list allowed roots
  server.registerTool(
    'roots',
    {
      description: 'Show the currently allowed filesystem roots.',
      inputSchema: rootsSchema,
      annotations: readOnly,
    },
    async () => rootsHandler(),
  );

  // Lifecycle
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
