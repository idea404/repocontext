import path from 'node:path';
import { getRoots, relativizeToRoot } from './roots.js';
import { listFiles } from './search.js';
import { parseFile } from './parser.js';

interface TestFile {
  path: string;
  relative: string;
  likelyTarget?: string;
  framework?: string;
  testSymbols: string[];
}

export async function discoverTests(options: {
  target?: string;
  limit?: number;
}): Promise<{ text: string }> {
  const roots = getRoots();
  if (roots.length === 0) return { text: 'No roots configured' };
  const rootPath = roots[0].path;
  const limit = options.limit ?? 20;
  const target = options.target ? path.resolve(rootPath, options.target) : null;

  const allFiles = await listFiles('**/*', {
    limit: 5000,
    exclude: ['node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'target', '__pycache__', '.venv', 'venv'],
  });

  const testFiles: TestFile[] = [];
  for (const f of allFiles) {
    const rel = f.relativePath;
    const lang = path.extname(f.absolutePath).slice(1);
    const testInfo = isTestFile(rel, lang);
    if (!testInfo.isTest) continue;

    const parsed = await parseFile(f.absolutePath);
    const symbols = parsed?.structure.map((s) => s.name) ?? [];

    let likelyTarget: string | undefined;
    if (target) {
      const targetRel = relativizeToRoot(target)?.relative;
      if (targetRel) {
        const baseName = path.basename(targetRel, path.extname(targetRel));
        if (rel.toLowerCase().includes(baseName.toLowerCase())) likelyTarget = targetRel;
      }
    } else {
      likelyTarget = inferSourceTarget(rel, lang);
    }

    testFiles.push({
      path: f.absolutePath,
      relative: rel,
      framework: testInfo.framework,
      likelyTarget,
      testSymbols: symbols,
    });

    if (testFiles.length >= limit) break;
  }

  if (target) {
    const targetRel = relativizeToRoot(target)?.relative ?? options.target ?? '';
    const targetBase = path.basename(targetRel ?? '', path.extname(targetRel ?? '')).toLowerCase();
    const matching = testFiles.filter((t) => t.likelyTarget === targetRel || (targetBase && t.relative.toLowerCase().includes(targetBase)));

    if (matching.length === 0) {
      return { text: `No test files found for "${targetRel}".` };
    }

    const lines: string[] = [`# Tests for ${targetRel}`];
    for (const t of matching) {
      lines.push(`- ${t.relative} (${t.framework ?? 'unknown'})`);
      const symbols = t.testSymbols.slice(0, 5);
      if (symbols.length > 0) lines.push(`  symbols: ${symbols.join(', ')}`);
    }
    return { text: lines.join('\n') };
  }

  // Overall coverage
  const frameworkCounts: Record<string, number> = {};
  const targetSet = new Set<string>();
  for (const t of testFiles) {
    frameworkCounts[t.framework ?? 'unknown'] = (frameworkCounts[t.framework ?? 'unknown'] ?? 0) + 1;
    if (t.likelyTarget) targetSet.add(t.likelyTarget);
  }

  const lines: string[] = ['# Test coverage'];
  lines.push(`- Test files found: ${testFiles.length}`);
  lines.push(`- Frameworks: ${Object.entries(frameworkCounts).map(([f, c]) => `${f} (${c})`).join(', ') || 'N/A'}`);
  lines.push(`- Source files with tests: ${targetSet.size}`);

  if (testFiles.length > 0) {
    lines.push('\n## Test files');
    for (const t of testFiles.slice(0, limit)) {
      const targetInfo = t.likelyTarget ? ` → ${t.likelyTarget}` : '';
      lines.push(`- ${t.relative}${targetInfo} (${t.framework ?? 'unknown'})`);
    }
  }

  return { text: lines.join('\n') };
}

function isTestFile(relativePath: string, ext: string): { isTest: boolean; framework?: string } {
  const base = path.basename(relativePath);
  const dir = path.dirname(relativePath);
  const lower = base.toLowerCase();

  // General naming conventions
  if (lower.includes('.test.') || lower.includes('.spec.') || lower.includes('_test.') || lower.includes('_spec.')) {
    return { isTest: true, framework: inferFramework(ext, relativePath) };
  }

  // Language-specific directories
  const testDirs = ['test', 'tests', '__tests__', 'spec', 'specs', 'e2e', 'integration', 'unit'];
  if (testDirs.some((d) => dir.toLowerCase().split('/').includes(d))) {
    // But only if it looks like code, not data
    if (['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'rb', 'kt', 'swift', 'scala', 'php', 'cs'].includes(ext)) {
      return { isTest: true, framework: inferFramework(ext, relativePath) };
    }
  }

  // Go: _test.go
  if (base.endsWith('_test.go')) return { isTest: true, framework: 'testing' };
  // Rust inline modules often in same file; skip
  // Python pytest
  if (base.startsWith('test_') && ext === 'py') return { isTest: true, framework: 'pytest/unittest' };

  return { isTest: false };
}

function inferFramework(ext: string, relativePath: string): string | undefined {
  const lower = relativePath.toLowerCase();
  if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx') {
    if (lower.includes('vitest') || lower.includes('.test.ts')) return 'vitest';
    if (lower.includes('jest')) return 'jest';
    if (lower.includes('mocha')) return 'mocha';
    if (lower.includes('playwright')) return 'playwright';
    if (lower.includes('cypress')) return 'cypress';
    if (lower.includes('ava')) return 'ava';
    if (lower.includes('jasmine')) return 'jasmine';
    return 'node-test';
  }
  if (ext === 'py') return 'pytest/unittest';
  if (ext === 'go') return 'testing';
  if (ext === 'rs') return 'cargo test';
  if (ext === 'java') return 'junit';
  if (ext === 'rb') return 'rspec/minitest';
  if (ext === 'php') return 'phpunit';
  if (ext === 'cs') return 'xunit/nunit';
  return undefined;
}

function inferSourceTarget(testRelative: string, _ext: string): string | undefined {
  const base = path.basename(testRelative);
  let sourceName = base;

  if (sourceName.includes('.test.')) sourceName = sourceName.replace('.test.', '.');
  else if (sourceName.includes('.spec.')) sourceName = sourceName.replace('.spec.', '.');
  else if (sourceName.includes('_test.')) sourceName = sourceName.replace('_test.', '.');
  else if (sourceName.includes('_spec.')) sourceName = sourceName.replace('_spec.', '.');
  else if (sourceName.startsWith('test_') && sourceName.endsWith('.py')) sourceName = sourceName.replace(/^test_/, '');
  else if (sourceName.endsWith('_test.go')) sourceName = sourceName.replace(/_test\.go$/, '.go');

  if (sourceName === base) return undefined;
  return path.join(path.dirname(testRelative), sourceName);
}
