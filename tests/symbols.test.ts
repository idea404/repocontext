import { describe, it, expect, beforeAll } from 'vitest';
import { setRoots } from '../src/roots.js';
import { findSymbols, traceSymbol, getImports } from '../src/symbols.js';
import path from 'node:path';

const fixtureRoot = path.resolve('tests/fixtures/sample-repo');

describe('symbols', () => {
  beforeAll(() => {
    setRoots([{ uri: `file://${fixtureRoot}` }]);
  });

  it('finds symbol definitions', async () => {
    const symbols = await findSymbols('add', { limit: 10 });
    expect(symbols.some((s) => s.name === 'add')).toBe(true);
  });

  it('traces a symbol to its definition and references', async () => {
    const result = await traceSymbol('helper');
    expect(result.definition).not.toBeNull();
    expect(result.definition?.name).toBe('helper');
    expect(result.references.length).toBeGreaterThan(0);
  });

  it('gets imports from a file', async () => {
    const imports = await getImports(path.join(fixtureRoot, 'src/example.ts'));
    expect(imports).not.toBeNull();
    expect(imports?.some((i) => i.source.includes('helper'))).toBe(true);
  });
});
