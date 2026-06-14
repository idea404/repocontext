import fs from 'node:fs';
import path from 'node:path';
import { getRoots, relativizeToRoot } from './roots.js';
import { parseFile, detectLanguageForPath } from './parser.js';
import { listFiles } from './search.js';

interface DepInfo {
  source: string;
  isExternal: boolean;
  importers: string[];
}

interface ProjectDeps {
  external: Record<string, { version?: string; source: string; runtime?: boolean }>;
  internal: Record<string, DepInfo>;
}

export async function analyzeDependencies(options: {
  target?: string;
  direction?: 'imports' | 'imported_by';
  limit?: number;
}): Promise<{ text: string; error?: string }> {
  const roots = getRoots();
  if (roots.length === 0) return { text: '', error: 'No roots configured' };
  const rootPath = roots[0].path;
  const limit = options.limit ?? 20;

  const projectDeps = await collectProjectDeps(rootPath);
  const target = options.target;
  const direction = options.direction ?? 'imports';

  // If no target, return project-wide dependency summary
  if (!target) {
    const ext = Object.entries(projectDeps.external)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(0, limit);
    const internal = Object.entries(projectDeps.internal)
      .sort((a, b) => b[1].importers.length - a[1].importers.length)
      .slice(0, limit);

    const lines: string[] = ['# Dependency summary'];

    lines.push('\n## External dependencies');
    for (const [name, info] of ext) {
      const version = info.version ? ` @ ${info.version}` : '';
      lines.push(`- ${name}${version} (${info.source})${info.runtime === false ? ' [dev]' : ''}`);
    }
    if (ext.length === 0) lines.push('- None detected');

    lines.push('\n## Top internal modules');
    for (const [name, info] of internal) {
      const importers = info.importers.slice(0, 5);
      const suffix = info.importers.length > 5 ? ` ... +${info.importers.length - 5} more` : '';
      lines.push(`- "${name}" imported by ${importers.length} file(s): ${importers.join(', ')}${suffix}`);
    }
    if (internal.length === 0) lines.push('- None detected');

    return { text: lines.join('\n') };
  }

  // target provided — treat as module path or module name
  const resolvedTarget = path.resolve(rootPath, target);
  const asFile = fs.existsSync(resolvedTarget) ? resolvedTarget : null;

  if (direction === 'imports') {
    // What does target import?
    const files = await listFiles('**/*.{ts,tsx,js,jsx,py,go,rs,java,c,cpp,rb,swift,kt,ex,scala,php,cs,sh}', {
      limit: 500,
      exclude: ['node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'target', '__pycache__', '.venv', 'venv'],
    });

    const matches: string[] = [];
    for (const f of files) {
      if (matches.length >= limit) break;
      const parsed = await parseFile(f.absolutePath);
      if (!parsed) continue;
      for (const imp of parsed.imports) {
        const isTarget = asFile
          ? imp.source.includes(target.replace(/\.[^.]+$/, '')) || imp.source.includes(path.basename(target))
          : imp.source === target || imp.source.includes(target);
        if (isTarget) {
          const rel = relativizeToRoot(f.absolutePath)?.relative ?? f.relativePath;
          const items = imp.isWildcard ? '*' : imp.items.join(', ');
          matches.push(`- ${rel} imports "${imp.source}" → ${items}`);
          break;
        }
      }
    }

    return {
      text: matches.length
        ? `## Files importing "${target}"\n\n${matches.join('\n')}`
        : `No files found importing "${target}".`,
    };
  }

  // direction === 'imported_by': what imports target?
  if (asFile) {
    const parsed = await parseFile(asFile);
    if (!parsed) return { text: '', error: `Could not parse ${target}` };

    const lines: string[] = [`# Imports in ${target}`];
    for (const imp of parsed.imports.slice(0, limit)) {
      const items = imp.isWildcard ? '*' : imp.items.join(', ');
      const isExternal = projectDeps.external[imp.source] !== undefined || imp.source.startsWith('node:') || (!imp.source.startsWith('.') && !imp.source.startsWith('/'));
      lines.push(`- "${imp.source}"${isExternal ? ' [external]' : ' [internal]'} → ${items}`);
    }
    return { text: lines.join('\n') };
  }

  // target is a module name and we want what it imports (direction imported_by)
  const files = await listFiles('**/*.{ts,tsx,js,jsx,py,go,rs,java,c,cpp,rb,swift,kt,ex,scala,php,cs,sh}', {
    limit: 500,
    exclude: ['node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'target', '__pycache__', '.venv', 'venv'],
  });

  const matches: string[] = [];
  for (const f of files) {
    if (matches.length >= limit) break;
    const parsed = await parseFile(f.absolutePath);
    if (!parsed) continue;
    for (const imp of parsed.imports) {
      if (imp.source.includes(target)) {
        const rel = relativizeToRoot(f.absolutePath)?.relative ?? f.relativePath;
        const items = imp.isWildcard ? '*' : imp.items.join(', ');
        matches.push(`- ${rel} imports "${imp.source}" → ${items}`);
        break;
      }
    }
  }

  return {
    text: matches.length
      ? `## Files importing "${target}"\n\n${matches.join('\n')}`
      : `No files found importing "${target}".`,
  };
}

async function collectProjectDeps(rootPath: string): Promise<ProjectDeps> {
  const result: ProjectDeps = { external: {}, internal: {} };

  // Parse package.json
  const pkgPath = path.join(rootPath, 'package.json');
  try {
    const pkg = JSON.parse(await fs.promises.readFile(pkgPath, 'utf-8'));
    for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
      result.external[name] = { version: String(version), source: 'package.json', runtime: true };
    }
    for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
      if (!result.external[name]) {
        result.external[name] = { version: String(version), source: 'package.json', runtime: false };
      }
    }
    for (const [name, version] of Object.entries(pkg.peerDependencies ?? {})) {
      if (!result.external[name]) {
        result.external[name] = { version: String(version), source: 'package.json', runtime: true };
      }
    }
  } catch { /* no package.json */ }

  // Parse requirements.txt
  const reqPath = path.join(rootPath, 'requirements.txt');
  try {
    const text = await fs.promises.readFile(reqPath, 'utf-8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^([a-zA-Z0-9_.-]+)/);
      if (match) {
        const name = match[1];
        const version = trimmed.includes('==') ? trimmed.split('==')[1]?.split(/[\s,#]/)[0] : undefined;
        result.external[name] = { version, source: 'requirements.txt', runtime: true };
      }
    }
  } catch { /* no requirements.txt */ }

  // Parse Cargo.toml
  const cargoPath = path.join(rootPath, 'Cargo.toml');
  try {
    const text = await fs.promises.readFile(cargoPath, 'utf-8');
    const cargo = parseToml(text);
    for (const section of ['dependencies', 'dev-dependencies', 'build-dependencies']) {
      for (const [name, value] of Object.entries(cargo[section] ?? {})) {
        if (typeof value === 'string') {
          result.external[name] = { version: value, source: 'Cargo.toml', runtime: section === 'dependencies' };
        } else if (typeof value === 'object' && value) {
          const v = value as Record<string, string>;
          result.external[name] = { version: v.version, source: 'Cargo.toml', runtime: section === 'dependencies' && !v.path };
        }
      }
    }
  } catch { /* no Cargo.toml */ }

  // Parse pyproject.toml
  const pyprojectPath = path.join(rootPath, 'pyproject.toml');
  try {
    const text = await fs.promises.readFile(pyprojectPath, 'utf-8');
    const py = parseToml(text);
    const deps = py.project?.dependencies ?? py.dependencies ?? {};
    for (const [name, value] of Object.entries(deps)) {
      result.external[name] = { version: String(value), source: 'pyproject.toml', runtime: true };
    }
    for (const group of Object.values(py['project']?.['optional-dependencies'] ?? {})) {
      if (typeof group === 'object' && group) {
        for (const [name, value] of Object.entries(group)) {
          result.external[name] = { version: String(value), source: 'pyproject.toml', runtime: false };
        }
      }
    }
  } catch { /* no pyproject.toml */ }

  // Collect internal imports
  const files = await listFiles('**/*.{ts,tsx,js,jsx,py,go,rs,java,c,cpp,rb,swift,kt,ex,scala,php,cs,sh}', {
    limit: 1000,
    exclude: ['node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'target', '__pycache__', '.venv', 'venv'],
  });

  for (const f of files) {
    const parsed = await parseFile(f.absolutePath);
    if (!parsed) continue;
    const lang = detectLanguageForPath(f.absolutePath);
    for (const imp of parsed.imports) {
      if (isExternalImport(imp.source, lang)) continue;
      if (!result.internal[imp.source]) {
        result.internal[imp.source] = { source: imp.source, isExternal: false, importers: [] };
      }
      const rel = relativizeToRoot(f.absolutePath)?.relative ?? f.relativePath;
      if (!result.internal[imp.source].importers.includes(rel)) {
        result.internal[imp.source].importers.push(rel);
      }
    }
  }

  return result;
}

function isExternalImport(source: string, language: string | null): boolean {
  if (source.startsWith('node:')) return true;
  if (source.startsWith('.')) return false;
  if (source.startsWith('/')) return false;
  if (language === 'go' && !source.includes('/')) return true; // stdlib
  if (language === 'python' && !source.startsWith('.')) return true;
  if (language === 'rust' && !source.startsWith('.')) return true;
  return true;
}

function parseToml(text: string): Record<string, any> {
  const result: Record<string, any> = {};
  let section: string | null = null;
  let subsection: string | null = null;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('[')) {
      const inner = line.slice(1, -1);
      if (!inner) continue;
      if (line.startsWith('[[')) {
        // array of tables — skip
        section = null;
        subsection = null;
        continue;
      }
      if (inner.includes('.')) {
        const parts = inner.split('.');
        section = parts[0];
        subsection = parts.slice(1).join('.');
        if (!result[section]) result[section] = {};
        if (subsection && !result[section][subsection]) result[section][subsection] = {};
      } else {
        section = inner;
        subsection = null;
        if (!result[section]) result[section] = {};
      }
      continue;
    }

    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('{')) {
      value = value.slice(1, -1);
      const obj: Record<string, string> = {};
      for (const part of value.split(',')) {
        const [k, v] = part.split('=').map((s) => s.trim());
        if (k && v) obj[k.replace(/"/g, '')] = v.replace(/"/g, '');
      }
      value = obj as any;
    } else {
      value = value.replace(/^["']|["']$/g, '');
    }

    if (section) {
      if (subsection) {
        result[section][subsection][key] = value;
      } else {
        result[section][key] = value;
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}
