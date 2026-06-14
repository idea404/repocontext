import fs from 'node:fs';
import { createRequire } from 'node:module';
import * as Parser from 'web-tree-sitter';
import { makeAllowedPath } from './roots.js';
import { DEFAULT_MAX_FILE_BYTES, DEFAULT_PARSER_CACHE_SIZE, log } from './utils.js';
import type { ParseResult } from './types.js';

const require = createRequire(import.meta.url);

let parserInitPromise: Promise<void> | null = null;

async function ensureParserInit(): Promise<void> {
  if (!parserInitPromise) {
    parserInitPromise = Parser.Parser.init();
  }
  return parserInitPromise;
}

const wasmNameByLanguage: Record<string, string> = {
  typescript: 'tree-sitter-typescript',
  tsx: 'tree-sitter-tsx',
  javascript: 'tree-sitter-javascript',
  python: 'tree-sitter-python',
  go: 'tree-sitter-go',
  rust: 'tree-sitter-rust',
  java: 'tree-sitter-java',
  c: 'tree-sitter-c',
  cpp: 'tree-sitter-cpp',
  bash: 'tree-sitter-bash',
  ruby: 'tree-sitter-ruby',
  swift: 'tree-sitter-swift',
  kotlin: 'tree-sitter-kotlin',
  elixir: 'tree-sitter-elixir',
  scala: 'tree-sitter-scala',
  json: 'tree-sitter-json',
  html: 'tree-sitter-html',
  php: 'tree-sitter-php',
  ocaml: 'tree-sitter-ocaml',
  csharp: 'tree-sitter-c_sharp',
  css: 'tree-sitter-css',
  lua: 'tree-sitter-lua',
  dart: 'tree-sitter-dart',
  zig: 'tree-sitter-zig',
  yaml: 'tree-sitter-yaml',
  toml: 'tree-sitter-toml',
  vue: 'tree-sitter-vue',
  elm: 'tree-sitter-elm',
  elisp: 'tree-sitter-elisp',
  objc: 'tree-sitter-objc',
};

const extensionToLanguage: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cxx: 'cpp',
  sh: 'bash',
  bash: 'bash',
  rb: 'ruby',
  swift: 'swift',
  kt: 'kotlin',
  kts: 'kotlin',
  ex: 'elixir',
  exs: 'elixir',
  scala: 'scala',
  sc: 'scala',
  json: 'json',
  html: 'html',
  htm: 'html',
  php: 'php',
  ml: 'ocaml',
  mli: 'ocaml',
  cs: 'csharp',
  css: 'css',
  lua: 'lua',
  dart: 'dart',
  zig: 'zig',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  vue: 'vue',
  elm: 'elm',
  el: 'elisp',
  m: 'objc',
};

interface CacheEntry {
  result: ParseResult;
  mtimeMs: number;
  size: number;
}

const cache = new Map<string, CacheEntry>();
const parsers = new Map<string, Parser.Parser>();
const languageObjects = new Map<string, Parser.Language>();

function resolveWasmPath(language: string): string | null {
  const wasmName = wasmNameByLanguage[language];
  if (!wasmName) return null;
  try {
    return require.resolve(`tree-sitter-wasms/out/${wasmName}.wasm`);
  } catch (err) {
    log('warning', `Could not resolve WASM for ${language}: ${err}`);
    return null;
  }
}

async function getLanguage(language: string): Promise<Parser.Language | null> {
  const cached = languageObjects.get(language);
  if (cached) return cached;

  const wasmPath = resolveWasmPath(language);
  if (!wasmPath) return null;

  try {
    await ensureParserInit();
    const lang = await Parser.Language.load(wasmPath);
    if (lang) languageObjects.set(language, lang);
    return lang ?? null;
  } catch (err) {
    log('warning', `Failed to load language ${language}: ${err}`);
    return null;
  }
}

async function getParser(language: string): Promise<Parser.Parser | null> {
  const existing = parsers.get(language);
  if (existing) return existing;

  const lang = await getLanguage(language);
  if (!lang) return null;

  const parser = new Parser.Parser();
  parser.setLanguage(lang);
  parsers.set(language, parser);
  return parser;
}

function evictIfNeeded(): void {
  while (cache.size > DEFAULT_PARSER_CACHE_SIZE) {
    const firstKey = cache.keys().next().value;
    if (firstKey) {
      cache.delete(firstKey);
    }
  }
}

export function detectLanguageForPath(filePath: string): string | null {
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (!ext) return null;
  return extensionToLanguage[ext] ?? null;
}

export async function parseFile(filePath: string): Promise<ParseResult | null> {
  const allowed = makeAllowedPath(filePath);
  if (!allowed) return null;

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(allowed);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (stat.size > DEFAULT_MAX_FILE_BYTES) {
    log('warning', `Skipping ${allowed}: exceeds ${DEFAULT_MAX_FILE_BYTES} bytes`);
    return null;
  }

  const language = detectLanguageForPath(allowed);
  if (!language) return null;

  const cacheKey = `${allowed}|${stat.mtimeMs}|${stat.size}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached.result;

  let source: string;
  try {
    source = await fs.promises.readFile(allowed, 'utf-8');
  } catch {
    return null;
  }

  const parser = await getParser(language);
  if (!parser) return null;

  const langObj = languageObjects.get(language) ?? null;

  try {
    const tree = parser.parse(source);
    if (!tree) return null;
    const result = extractResult(tree, language, source, stat.size, langObj);
    evictIfNeeded();
    cache.set(cacheKey, { result, mtimeMs: stat.mtimeMs, size: stat.size });
    return result;
  } catch (err) {
    log('warning', `Failed to parse ${allowed}: ${err}`);
    return null;
  }
}

function extractResult(
  tree: Parser.Tree,
  language: string,
  fileSource: string,
  totalBytes: number,
  langObj: Parser.Language | null,
): ParseResult {
  const lines = fileSource.split('\n');
  const totalLines = lines.length;
  const blankLines = lines.filter((l: string) => l.trim().length === 0).length;
  const commentLines = 0;
  const codeLines = totalLines - blankLines - commentLines;

  const structure = extractStructure(tree, language, fileSource, langObj);
  const imports = extractImports(tree, language, langObj);
  const exports = extractExports(tree, language, structure, langObj);

  return {
    language,
    metrics: {
      totalLines,
      codeLines,
      commentLines,
      blankLines,
      totalBytes,
      nodeCount: countNodes(tree.rootNode),
      errorCount: countErrors(tree.rootNode),
      maxDepth: maxDepth(tree.rootNode),
    },
    structure,
    imports,
    exports,
  };
}

function extractStructure(
  tree: Parser.Tree,
  language: string,
  fileSource: string,
  langObj: Parser.Language | null,
): ParseResult['structure'] {
  const result: ParseResult['structure'] = [];

  const queries: Record<string, string> = {
    typescript: `
      [
        (function_declaration name: (identifier) @name) @decl
        (class_declaration name: (type_identifier) @name) @decl
        (method_definition name: (property_identifier) @name) @decl
        (interface_declaration name: (type_identifier) @name) @decl
        (type_alias_declaration name: (type_identifier) @name) @decl
      ]
    `,
    tsx: `
      [
        (function_declaration name: (identifier) @name) @decl
        (class_declaration name: (type_identifier) @name) @decl
        (method_definition name: (property_identifier) @name) @decl
        (interface_declaration name: (type_identifier) @name) @decl
      ]
    `,
    javascript: `
      [
        (function_declaration name: (identifier) @name) @decl
        (class_declaration name: (identifier) @name) @decl
        (method_definition name: (property_identifier) @name) @decl
      ]
    `,
    python: `
      [
        (function_definition name: (identifier) @name) @decl
        (class_definition name: (identifier) @name) @decl
      ]
    `,
    go: `
      [
        (function_declaration name: (identifier) @name) @decl
        (method_declaration name: (field_identifier) @name) @decl
        (type_declaration (type_spec name: (type_identifier) @name)) @decl
      ]
    `,
    rust: `
      [
        (function_item name: (identifier) @name) @decl
        (struct_item name: (type_identifier) @name) @decl
        (impl_item type: (type_identifier) @name) @decl
        (trait_item name: (type_identifier) @name) @decl
      ]
    `,
    java: `
      [
        (method_declaration name: (identifier) @name) @decl
        (class_declaration name: (identifier) @name) @decl
        (interface_declaration name: (identifier) @name) @decl
      ]
    `,
    c: `
      [
        (function_definition declarator: (function_declarator declarator: (identifier) @name)) @decl
        (struct_specifier name: (type_identifier) @name) @decl
      ]
    `,
    cpp: `
      [
        (function_definition declarator: (function_declarator declarator: (identifier) @name)) @decl
        (class_specifier name: (type_identifier) @name) @decl
        (struct_specifier name: (type_identifier) @name) @decl
      ]
    `,
    bash: `
      (function_definition name: (word) @name) @decl
    `,
    ruby: `
      [
        (method name: (identifier) @name) @decl
        (class name: (constant) @name) @decl
        (module name: (constant) @name) @decl
      ]
    `,
    swift: `
      [
        (class_declaration name: (type_identifier) @name) @decl
        (struct_declaration name: (type_identifier) @name) @decl
        (enum_declaration name: (type_identifier) @name) @decl
        (protocol_declaration name: (type_identifier) @name) @decl
        (function_declaration name: (simple_identifier) @name) @decl
      ]
    `,
    kotlin: `
      [
        (class_declaration name: (simple_identifier) @name) @decl
        (function_declaration name: (simple_identifier) @name) @decl
        (object_declaration name: (simple_identifier) @name) @decl
      ]
    `,
    scala: `
      [
        (class_definition name: (identifier) @name) @decl
        (trait_definition name: (identifier) @name) @decl
        (object_definition name: (identifier) @name) @decl
        (function_definition name: (identifier) @name) @decl
      ]
    `,
    elixir: `
      [
        (call
          function: (identifier) @name
          arguments: (arguments (call target: (identifier) @name)))
      ]
    `,
    csharp: `
      [
        (class_declaration name: (identifier) @name) @decl
        (struct_declaration name: (identifier) @name) @decl
        (interface_declaration name: (identifier) @name) @decl
        (method_declaration name: (identifier) @name) @decl
      ]
    `,
    php: `
      [
        (function_definition name: (name) @name) @decl
        (class_declaration name: (name) @name) @decl
        (interface_declaration name: (name) @name) @decl
        (trait_declaration name: (name) @name) @decl
      ]
    `,
    ocaml: `
      [
        (value_definition name: (value_name) @name) @decl
        (let_binding name: (value_name) @name) @decl
      ]
    `,
    css: '',
    html: '',
    json: '',
    lua: '',
    dart: '',
    zig: '',
    yaml: '',
    toml: '',
    vue: '',
    elm: '',
    elisp: '',
    objc: '',
  };

  const queryText = queries[language];
  if (!queryText || !langObj) return result;

  try {
    const query = new Parser.Query(langObj, queryText);
    const matches = query.matches(tree.rootNode);

    for (const match of matches) {
      const declCapture = match.captures.find((c) => c.name === 'decl');
      const nameCapture = match.captures.find((c) => c.name === 'name');
      if (!declCapture || !nameCapture) continue;

      const node = declCapture.node;
      const name = nameCapture.node.text;
      const kind = kindFromNode(node.type, language);

      result.push({
        kind,
        name,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        signature: fileSource.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + 200)),
      });
    }
  } catch (err) {
    log('warning', `Structure query failed for ${language}: ${err}`);
  }

  return result;
}

function kindFromNode(type: string, _language: string): string {
  if (type.includes('class')) return 'class';
  if (type.includes('interface')) return 'interface';
  if (type.includes('function')) return 'function';
  if (type.includes('method')) return 'method';
  if (type.includes('struct')) return 'struct';
  if (type.includes('trait')) return 'trait';
  if (type.includes('impl')) return 'impl';
  if (type.includes('type')) return 'type_alias';
  if (type.includes('module')) return 'module';
  if (type.includes('package')) return 'package';
  if (type.includes('protocol')) return 'protocol';
  if (type.includes('enum')) return 'enum';
  if (type.includes('object')) return 'object';
  if (type.includes('data')) return 'data';
  if (type.includes('instance')) return 'instance';
  if (type.includes('subroutine')) return 'function';
  if (type.includes('value')) return 'value';
  if (type.includes('let')) return 'value';
  return type;
}

function extractImports(tree: Parser.Tree, language: string, langObj: Parser.Language | null): ParseResult['imports'] {
  const result: ParseResult['imports'] = [];

  const queries: Record<string, string> = {
    typescript: '(import_statement source: (string) @source) @import',
    tsx: '(import_statement source: (string) @source) @import',
    javascript: '(import_statement source: (string) @source) @import',
    python: `
      [
        (import_statement name: (dotted_name) @source) @import
        (import_from_statement module_name: (dotted_name) @source) @import
      ]
    `,
    go: '(import_spec path: (interpreted_string_literal) @source) @import',
    rust: '(use_declaration argument: (_) @source) @import',
    java: '(import_declaration (_) @source) @import',
    ruby: `
      [
        (call method: (identifier) @source) @import
      ]
    `,
    php: `
      [
        (include_expression (string) @source) @import
        (include_once_expression (string) @source) @import
        (require_expression (string) @source) @import
        (require_once_expression (string) @source) @import
      ]
    `,
    scala: '(import_export_path path: (identifier) @source) @import',
    swift: '(import_declaration path: (identifier) @source) @import',
    csharp: '(using_directive name: (identifier) @source) @import',
    bash: '',
    c: '',
    cpp: '',
    kotlin: '',
    elixir: '',
    ocaml: '',
    css: '',
    html: '',
    json: '',
    lua: '',
    dart: '',
    zig: '',
    yaml: '',
    toml: '',
    vue: '',
    elm: '',
    elisp: '',
    objc: '',
  };

  const queryText = queries[language];
  if (!queryText || !langObj) return result;

  try {
    const query = new Parser.Query(langObj, queryText);
    const matches = query.matches(tree.rootNode);

    for (const match of matches) {
      const decl = match.captures.find((c) => c.name === 'import')?.node;
      const sourceNode = match.captures.find((c) => c.name === 'source')?.node;
      if (!decl || !sourceNode) continue;

      let source = sourceNode.text;
      source = source.replace(/^["']|["']$/g, '');

      const items: string[] = [];
      let isWildcard = false;

      if (language === 'python') {
        isWildcard = decl.text.includes('*');
      } else if (['typescript', 'tsx', 'javascript'].includes(language)) {
        const specifierQuery = new Parser.Query(
          langObj,
          '(import_specifier name: (identifier) @item)',
        );
        const specMatches = specifierQuery.matches(decl);
        for (const sm of specMatches) {
          const item = sm.captures.find((c) => c.name === 'item')?.node.text;
          if (item) items.push(item);
        }
        isWildcard = decl.text.includes('*');
      }

      result.push({ source, items, isWildcard });
    }
  } catch (err) {
    log('warning', `Import query failed for ${language}: ${err}`);
  }

  return result;
}

function extractExports(
  tree: Parser.Tree,
  language: string,
  structure: ParseResult['structure'],
  langObj: Parser.Language | null,
): ParseResult['exports'] {
  if (!['typescript', 'tsx', 'javascript', 'python', 'rust', 'go', 'swift', 'elixir', 'php'].includes(language)) {
    return [];
  }

  const result: ParseResult['exports'] = [];

  const queries: Record<string, string> = {
    typescript: '(export_statement (function_declaration name: (identifier) @name)) @export',
    tsx: '(export_statement (function_declaration name: (identifier) @name)) @export',
    javascript: '(export_statement (function_declaration name: (identifier) @name)) @export',
    python: '(expression_statement (assignment left: (identifier) @name)) @export',
    rust: '(visibility_modifier) @export',
    go: '(function_declaration name: (identifier) @name) @export',
    swift: '(function_declaration name: (simple_identifier) @name) @export',
    php: '(function_definition name: (name) @name) @export',
  };

  const queryText = queries[language];
  if (!queryText || !langObj) return result;

  try {
    const query = new Parser.Query(langObj, queryText);
    const matches = query.matches(tree.rootNode);

    for (const match of matches) {
      const name = match.captures.find((c) => c.name === 'name')?.node.text;
      if (!name) continue;
      result.push({ name, kind: 'export' });
    }
  } catch (err) {
    log('warning', `Export query failed for ${language}: ${err}`);
  }

  for (const s of structure) {
    if (!result.some((e) => e.name === s.name)) {
      result.push({ name: s.name, kind: s.kind });
    }
  }

  return result;
}

function countNodes(node: Parser.Node): number {
  let count = 1;
  for (const child of node.children) {
    if (child) count += countNodes(child);
  }
  return count;
}

function countErrors(node: Parser.Node): number {
  let count = node.type === 'ERROR' ? 1 : 0;
  for (const child of node.children) {
    if (child) count += countErrors(child);
  }
  return count;
}

function maxDepth(node: Parser.Node, current = 0): number {
  let max = current;
  for (const child of node.children) {
    if (child) max = Math.max(max, maxDepth(child, current + 1));
  }
  return max;
}

export function clearParserCache(): void {
  cache.clear();
}
