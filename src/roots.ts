import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { log } from './utils.js';

export interface Root {
  uri: string;
  name?: string;
  path: string;
}

let allowedRoots: Root[] = [];

export function setRoots(roots: Root[]): void {
  allowedRoots = roots.map((r) => ({
    ...r,
    path: normalizeRootPath(r.uri),
  }));
  log('info', `Roots updated: ${allowedRoots.map((r) => r.path).join(', ')}`);
}

export function getRoots(): Root[] {
  return allowedRoots;
}

export function initializeFallbackRoot(): void {
  if (allowedRoots.length === 0) {
    const cwd = process.cwd();
    allowedRoots = [{ uri: `file://${cwd}`, name: 'cwd', path: cwd }];
    log('info', `No roots provided; falling back to cwd: ${cwd}`);
  }
}

function normalizeRootPath(uri: string): string {
  if (uri.startsWith('file://')) {
    return fileURLToPath(uri);
  }
  return path.resolve(uri);
}

export function isPathAllowed(targetPath: string): boolean {
  const resolved = path.resolve(targetPath);
  if (allowedRoots.length === 0) return false;
  return allowedRoots.some((root) => {
    const relative = path.relative(root.path, resolved);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  });
}

export function makeAllowedPath(inputPath: string): string | null {
  const resolved = path.resolve(inputPath);
  if (!isPathAllowed(resolved)) return null;
  return resolved;
}

export function relativizeToRoot(targetPath: string): { root: Root; relative: string } | null {
  const resolved = path.resolve(targetPath);
  for (const root of allowedRoots) {
    const relative = path.relative(root.path, resolved);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      return { root, relative };
    }
  }
  return null;
}
