import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { getRoots } from './roots.js';

const execAsync = promisify(exec);

export interface CommitInfo {
  hash: string;
  author: string;
  date: string;
  message: string;
}

export interface ChangeSummary {
  ok: boolean;
  error?: string;
  commitCount: number;
  uniqueAuthors: Set<string>;
  fileChangeCounts: Map<string, number>;
  commits: CommitInfo[];
}

export async function recentChanges(options: {
  maxCommits: number;
  hotFiles: number;
  sinceDays: number;
}): Promise<ChangeSummary> {
  const roots = getRoots();
  if (roots.length === 0) return { ok: false, error: 'No roots configured', commitCount: 0, uniqueAuthors: new Set(), fileChangeCounts: new Map(), commits: [] };

  const rootPath = roots[0].path;

  try {
    const { stdout } = await execAsync(
      `git log --format="%H|%an|%aI|%s" --name-only --since="${options.sinceDays} days ago" -n ${options.maxCommits}`,
      { cwd: rootPath, timeout: 15000, maxBuffer: 1024 * 1024 * 2 },
    );

    const commits: CommitInfo[] = [];
    const fileChangeCounts = new Map<string, number>();
    const uniqueAuthors = new Set<string>();

    const blocks = stdout.split('\n\n');
    for (const block of blocks) {
      const lines = block.trim().split('\n');
      const header = lines[0];
      if (!header) continue;

      const [hash, author, date, ...msgParts] = header.split('|');
      if (!hash || !author || !date) continue;

      commits.push({
        hash,
        author,
        date,
        message: msgParts.join('|').trim(),
      });
      uniqueAuthors.add(author);

      for (let i = 1; i < lines.length; i++) {
        const file = lines[i].trim();
        if (!file) continue;
        fileChangeCounts.set(file, (fileChangeCounts.get(file) ?? 0) + 1);
      }
    }

    return {
      ok: true,
      commitCount: commits.length,
      uniqueAuthors,
      fileChangeCounts,
      commits,
    };
  } catch {
    return { ok: false, error: 'Not a git repository or git not available.', commitCount: 0, uniqueAuthors: new Set(), fileChangeCounts: new Map(), commits: [] };
  }
}
