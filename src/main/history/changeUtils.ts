import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { FileChange, FileStatus } from '../../shared/types';
import { parseJsonSafe } from '../../shared/utils/json';

export function countLineDiff(oldStr: string, newStr: string): { added: number; removed: number } {
  const oldLines = oldStr.length ? oldStr.split('\n') : [];
  const newLines = newStr.length ? newStr.split('\n') : [];
  const n = oldLines.length;
  const m = newLines.length;
  if (n * m > 4_000_000) {
    return { added: m, removed: n };
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lcs = dp[0][0];
  return { added: m - lcs, removed: n - lcs };
}

export interface FileChangeAcc {
  added: number;
  removed: number;
  created: boolean;
}

export function accumulate(
  byPath: Map<string, FileChangeAcc>,
  path: string,
  added: number,
  removed: number,
  created: boolean,
): void {
  const rec = byPath.get(path);
  if (rec) {
    rec.added += added;
    rec.removed += removed;
  } else {
    byPath.set(path, { added, removed, created });
  }
}

export interface StepEditEntry {
  filePath: string;
  tool: 'edit' | 'write';
  oldString?: string;
  newString?: string;
  content?: string;
}

export function parseStepEditEntries(fileContent: string): StepEditEntry[] {
  const entries: StepEditEntry[] = [];
  for (const line of fileContent.split('\n')) {
    if (!line || !line.includes('"heading":"ToolCall"')) continue;
    const entry = parseJsonSafe(line);
    if (!entry || typeof entry !== 'object') continue;

    const blocks = (entry as any).blocks;
    if (!Array.isArray(blocks) || blocks.length === 0) continue;
    const block = blocks[0];
    if (block.kind !== 'tool' || typeof block.content !== 'string') continue;

    const toolCall = parseJsonSafe(block.content);
    if (!toolCall || typeof toolCall !== 'object') continue;

    const name =
      typeof (toolCall as any).name === 'string' ? (toolCall as any).name.toLowerCase() : '';
    if (name !== 'edit' && name !== 'write') continue;

    let input: any;
    const rawInput = (toolCall as any).input;
    input = typeof rawInput === 'string' ? parseJsonSafe(rawInput) : rawInput;
    if (!input || typeof input.file_path !== 'string') continue;

    if ((toolCall as any).result?.isError) continue;

    if (
      name === 'edit' &&
      typeof input.old_string === 'string' &&
      typeof input.new_string === 'string'
    ) {
      entries.push({
        filePath: input.file_path,
        tool: 'edit',
        oldString: input.old_string,
        newString: input.new_string,
      });
    } else if (name === 'write' && typeof input.content === 'string') {
      entries.push({ filePath: input.file_path, tool: 'write', content: input.content });
    }
  }
  return entries;
}

export function sumEditCounts(entries: StepEditEntry[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const e of entries) {
    if (e.tool === 'edit' && e.oldString !== undefined && e.newString !== undefined) {
      const diff = countLineDiff(e.oldString, e.newString);
      added += diff.added;
      removed += diff.removed;
    } else if (e.tool === 'write' && e.content !== undefined) {
      added += e.content.split('\n').length;
    }
  }
  return { added, removed };
}

export function toFileChanges(
  byPath: Map<string, FileChangeAcc>,
  cwd: string | null,
): FileChange[] {
  const files: FileChange[] = [];
  for (const [rawPath, rec] of byPath) {
    const abs = isAbsolute(rawPath) ? rawPath : cwd ? join(cwd, rawPath) : rawPath;
    if (rec.created && !existsSync(abs)) continue;

    const path = cwd && rawPath.startsWith(cwd + '/') ? rawPath.slice(cwd.length + 1) : rawPath;
    const slash = path.lastIndexOf('/');
    const dir = slash === -1 ? '' : path.slice(0, slash);
    const name = slash === -1 ? path : path.slice(slash + 1);
    const status: FileStatus = rec.created ? 'A' : 'M';
    files.push({ path, dir, name, added: rec.added, removed: rec.removed, status });
  }
  return files;
}
