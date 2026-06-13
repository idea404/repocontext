import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execAsync = promisify(exec);

export interface GitLogEntry {
  commit: string;
  author: string;
  date: string;
  message: string;
}

export async function gitLog(
  filePath: string,
  maxCount = 10,
): Promise<{ entries: GitLogEntry[]; isGitRepo: boolean }> {
  const dir = path.dirname(filePath);
  try {
    const { stdout } = await execAsync(
      `git log --oneline --format="%H|%an|%aI|%s" --max-count=${maxCount} -- "${filePath}"`,
      { cwd: dir, timeout: 10000 },
    );
    const trimmed = stdout.trim();
    if (!trimmed) return { entries: [], isGitRepo: true };
    const entries = trimmed.split('\n').map((line) => {
      const pipeIdx = line.indexOf('|');
      const pipeIdx2 = line.indexOf('|', pipeIdx + 1);
      const pipeIdx3 = line.indexOf('|', pipeIdx2 + 1);
      return {
        commit: line.slice(0, pipeIdx),
        author: line.slice(pipeIdx + 1, pipeIdx2),
        date: line.slice(pipeIdx2 + 1, pipeIdx3),
        message: line.slice(pipeIdx3 + 1),
      };
    });
    return { entries, isGitRepo: true };
  } catch {
    return { entries: [], isGitRepo: false };
  }
}

export interface BlameLine {
  lineNumber: number;
  commit: string;
  author: string;
  authorTime: string;
  summary: string;
  content: string;
}

export async function gitBlame(
  filePath: string,
  startLine?: number,
  endLine?: number,
): Promise<{ lines: BlameLine[]; isGitRepo: boolean }> {
  const dir = path.dirname(filePath);
  try {
    let rangeArg = '';
    if (startLine) {
      const end = endLine ?? startLine;
      rangeArg = `-L ${startLine},${end}`;
    }
    const { stdout } = await execAsync(
      `git blame --line-porcelain ${rangeArg} -- "${filePath}"`,
      { cwd: dir, timeout: 15000, maxBuffer: 1024 * 1024 },
    );

    const lines: BlameLine[] = [];
    const blocks = stdout.split('\n\t');
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      // Guard: trim leading newline from subsequent blocks
      const trimmed = block.startsWith('\n') ? block.slice(1) : block;
      const headerEnd = trimmed.indexOf('\n');
      if (headerEnd === -1) continue;

      const headerLine = trimmed.slice(0, headerEnd);
      const parts = headerLine.split(' ');
      if (parts.length < 4) continue;

      const commit = parts[0];
      const finalLine = parseInt(parts[2], 10);

      // Parse metadata lines until we hit the content line
      const metaBlock = trimmed.slice(0, trimmed.lastIndexOf('\n'));
      const contentLine = trimmed.slice(trimmed.lastIndexOf('\n') + 1);

      let author = '';
      let authorTime = '';
      let summary = '';

      for (const metaLine of metaBlock.split('\n')) {
        if (metaLine.startsWith('author ')) author = metaLine.slice(7);
        else if (metaLine.startsWith('author-time ')) authorTime = metaLine.slice(12);
        else if (metaLine.startsWith('summary ')) summary = metaLine.slice(8);
      }

      if (!isNaN(finalLine) && commit.length >= 6) {
        lines.push({
          lineNumber: finalLine,
          commit: commit.slice(0, 8),
          author,
          authorTime,
          summary,
          content: contentLine.trimEnd(),
        });
      }
    }

    return { lines, isGitRepo: lines.length > 0 };
  } catch {
    return { lines: [], isGitRepo: false };
  }
}
