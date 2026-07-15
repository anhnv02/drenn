import { appendFile, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { EditOp, FileChange, TranscriptBlock, TranscriptStep } from '../../shared/types';
import {
  countLineDiff,
  accumulate,
  toFileChanges,
  parseStepEditEntries,
  sumEditCounts,
  type FileChangeAcc,
} from '../history/changeUtils';
import { CONTINUATIONS_DIR as CONT_DIR } from '../config/paths';
import { parseJsonSafe } from '../../shared/utils/json';

const MAX_BLOCK_CHARS = 4000;

export function isContinuableSession(sessionId: string): boolean {
  return /^(claude|opencode|copilot):/.test(sessionId);
}

function continuationFile(sessionId: string): string {
  return join(CONT_DIR, `${encodeURIComponent(sessionId)}.jsonl`);
}

export function addContinuationStep(sessionId: string, step: TranscriptStep): void {
  try {
    mkdirSync(CONT_DIR, { recursive: true });
  } catch {
    return;
  }

  const line = JSON.stringify({
    type: 'step',
    id: step.id,
    heading: step.heading,
    finished: step.finished,
    blocks: step.blocks,
  });

  appendFile(continuationFile(sessionId), line + '\n', 'utf8').catch(() => {});
}

export async function deleteContinuation(sessionId: string): Promise<void> {
  try {
    await unlink(continuationFile(sessionId));
  } catch {
    // file doesn't exist — nothing to delete
  }
}

function truncate(text: string): string {
  return text.length > MAX_BLOCK_CHARS ? text.slice(0, MAX_BLOCK_CHARS) + '\n… (truncated)' : text;
}

export async function getContinuationSteps(sessionId: string): Promise<TranscriptStep[]> {
  let content: string;
  try {
    content = await readFile(continuationFile(sessionId), 'utf8');
  } catch {
    return [];
  }

  const steps: TranscriptStep[] = [];
  for (const line of content.split('\n')) {
    if (!line) continue;
    const entry = parseJsonSafe(line);
    if (!entry || typeof entry !== 'object') continue;

    const blocks = (entry as any).blocks;
    if (!Array.isArray(blocks)) continue;

    const truncatedBlocks: TranscriptBlock[] = blocks.map((b: any) => ({
      kind: (b.kind ?? 'text') as TranscriptBlock['kind'],
      content: b.kind === 'image' ? String(b.content ?? '') : truncate(String(b.content ?? '')),
      ...(b.lang ? { lang: b.lang } : {}),
    }));

    steps.push({
      id: (entry as any).id ?? `cont-${steps.length}`,
      heading: (entry as any).heading ?? 'Assistant',
      finished: (entry as any).finished ?? true,
      blocks: truncatedBlocks,
    });
  }

  return steps;
}

async function readEditEntries(sessionId: string) {
  try {
    const content = await readFile(continuationFile(sessionId), 'utf8');
    return parseStepEditEntries(content);
  } catch {
    return [];
  }
}

export interface ContinuationStats {
  added: number;
  removed: number;
  updatedAt: string;
}

export async function getContinuationStats(): Promise<Map<string, ContinuationStats>> {
  let files: string[];
  try {
    files = await readdir(CONT_DIR);
  } catch {
    return new Map();
  }

  const stats = new Map<string, ContinuationStats>();
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    const sessionId = decodeURIComponent(file.slice(0, -'.jsonl'.length));
    try {
      const path = join(CONT_DIR, file);
      const [content, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
      const { added, removed } = sumEditCounts(parseStepEditEntries(content));
      stats.set(sessionId, { added, removed, updatedAt: info.mtime.toISOString() });
    } catch {
      // unreadable overlay — skip it
    }
  }
  return stats;
}

export async function getContinuationChanges(
  sessionId: string,
  cwd: string | null,
): Promise<FileChange[]> {
  const entries = await readEditEntries(sessionId);
  const byPath = new Map<string, FileChangeAcc>();

  for (const e of entries) {
    if (e.tool === 'edit' && e.oldString !== undefined && e.newString !== undefined) {
      const diff = countLineDiff(e.oldString, e.newString);
      accumulate(byPath, e.filePath, diff.added, diff.removed, false);
    } else if (e.tool === 'write' && e.content !== undefined) {
      accumulate(byPath, e.filePath, e.content.split('\n').length, 0, true);
    }
  }

  return toFileChanges(byPath, cwd);
}

export async function getContinuationFileOps(
  sessionId: string,
  path: string,
  cwd: string | null,
): Promise<EditOp[] | null> {
  const entries = await readEditEntries(sessionId);
  const abs = isAbsolute(path) ? path : cwd ? join(cwd, path) : path;

  const ops: EditOp[] = [];
  for (const e of entries) {
    if (e.filePath !== abs && e.filePath !== path) continue;
    if (e.tool === 'edit' && e.oldString !== undefined && e.newString !== undefined) {
      ops.push({ before: e.oldString, after: e.newString });
    } else if (e.tool === 'write' && e.content !== undefined) {
      ops.push({ before: '', after: e.content });
    }
  }
  return ops.length ? ops : null;
}
