import { describe, it, expect, beforeEach } from 'vitest';
import { setRoots, getRoots, isPathAllowed, makeAllowedPath, initializeFallbackRoot } from '../src/roots.js';
import path from 'node:path';

describe('roots', () => {
  beforeEach(() => {
    setRoots([]);
  });

  it('normalizes file:// URIs to absolute paths', () => {
    const dir = path.resolve('/tmp/project');
    setRoots([{ uri: `file://${dir}`, name: 'project' }]);
    expect(getRoots()[0].path).toBe(dir);
  });

  it('allows paths inside roots and rejects paths outside', () => {
    const root = path.resolve('tests/fixtures/sample-repo');
    setRoots([{ uri: `file://${root}` }]);

    expect(isPathAllowed(path.join(root, 'src', 'example.ts'))).toBe(true);
    expect(isPathAllowed('/etc/passwd')).toBe(false);
  });

  it('falls back to cwd when no roots are set', () => {
    initializeFallbackRoot();
    expect(getRoots().length).toBe(1);
    expect(getRoots()[0].path).toBe(process.cwd());
  });
});
