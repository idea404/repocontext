import { describe, it, expect } from 'vitest';
import { parseFile, detectLanguageForPath } from '../src/parser.js';
import path from 'node:path';
import { setRoots } from '../src/roots.js';

const fixtureRoot = path.resolve('tests/fixtures/sample-repo');
setRoots([{ uri: `file://${fixtureRoot}` }]);

describe('parser', () => {
  it('detects TypeScript from path', () => {
    expect(detectLanguageForPath(path.join(fixtureRoot, 'src/example.ts'))).toBe('typescript');
  });

  it('parses a TypeScript file and extracts structure', async () => {
    const result = await parseFile(path.join(fixtureRoot, 'src/example.ts'));
    expect(result).not.toBeNull();

    const names = result?.structure?.map((s) => s.name).filter(Boolean);
    expect(names).toContain('add');
    expect(names).toContain('Calculator');
  });

  it('extracts imports and exports', async () => {
    const result = await parseFile(path.join(fixtureRoot, 'src/example.ts'));
    expect(result?.imports?.some((i) => i.source?.includes('helper'))).toBe(true);
    expect(result?.exports?.some((e) => e.name === 'add')).toBe(true);
  });
});
