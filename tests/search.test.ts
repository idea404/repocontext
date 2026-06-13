import { describe, it, expect } from 'vitest';
import { setRoots } from '../src/roots.js';
import { searchFiles, listFiles, fuzzyFindFiles, closeFinders } from '../src/search.js';
import path from 'node:path';

const fixtureRoot = path.resolve('tests/fixtures/sample-repo');
setRoots([{ uri: `file://${fixtureRoot}` }]);

describe('search', () => {
  it('lists files matching a glob', async () => {
    const files = await listFiles('**/*.ts', { limit: 10 });
    const names = files.map((f) => path.basename(f.absolutePath));
    expect(names).toContain('example.ts');
    expect(names).toContain('helper.ts');
  });

  it('searches file contents', async () => {
    const matches = await searchFiles('add', { mode: 'plain', limit: 10 });
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].lineContent.toLowerCase()).toContain('add');
  });

  it('fuzzy finds files', async () => {
    const files = await fuzzyFindFiles('example', { limit: 10 });
    expect(files.some((f) => f.relativePath.includes('example.ts'))).toBe(true);
  });
});
