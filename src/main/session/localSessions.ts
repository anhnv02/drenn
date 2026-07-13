import { readdirSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { appendFile, readFile, writeFile, unlink } from 'node:fs/promises';
import { isAbsolute, join, basename } from 'node:path';
import type {
  EditOp,
  FileChange,
  Session,
  TranscriptBlock,
  TranscriptStep,
} from '../../shared/types';
import {
  countLineDiff,
  accumulate,
  toFileChanges,
  parseStepEditEntries,
  sumEditCounts,
  type FileChangeAcc,
  type StepEditEntry,
} from '../history/changeUtils';
import { LOCAL_SESSIONS_DIR as LOCAL_DIR } from '../config/paths';

const fileIndex = new Map<string, string>();
const cwdIndex = new Map<string, string>();

interface LocalMeta {
  cwd: string;
  title: string;
  updatedAt: string | null;
}

function scanMeta(filePath: string): LocalMeta {
  const meta: LocalMeta = { cwd: '', title: 'New session', updatedAt: null };
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return meta;
  }
  for (const line of content.split('\n')) {
    if (!line) continue;
    const tsMatch = line.match(/"updatedAt":"([^"]+)"/);
    if (tsMatch) meta.updatedAt = tsMatch[1];
    if (line.includes('"type":"meta"')) {
      try {
        const entry = JSON.parse(line);
        if (entry.cwd) meta.cwd = entry.cwd;
        if (entry.title) meta.title = entry.title;
      } catch {
        // skip malformed line
      }
    }
  }
  return meta;
}

function ensureDir(): void {
  try {
    readdirSync(LOCAL_DIR);
  } catch {
    mkdirSync(LOCAL_DIR, { recursive: true });
  }
}

export function listLocalSessions(): Session[] {
  fileIndex.clear();
  cwdIndex.clear();
  ensureDir();

  let files: string[];
  try {
    files = readdirSync(LOCAL_DIR).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }

  const sessions: Session[] = [];
  for (const file of files) {
    const id = basename(file, '.jsonl');
    const filePath = join(LOCAL_DIR, file);
    fileIndex.set(id, filePath);

    const meta = scanMeta(filePath);
    if (!meta.cwd) continue;

    cwdIndex.set(`local:${id}`, meta.cwd);

    let updatedAt = meta.updatedAt;
    if (!updatedAt) {
      try {
        updatedAt = statSync(filePath).mtime.toISOString();
      } catch {
        updatedAt = new Date(0).toISOString();
      }
    }

    const { added, removed } = sumEditCounts(parseLocalEditEntries(`local:${id}`));

    sessions.push({
      id: `local:${id}`,
      title: meta.title,
      projectName: basename(meta.cwd),
      added,
      removed,
      updatedAt,
      source: 'local',
    });
  }
  return sessions;
}

export function getLocalSessions(): Session[] {
  return listLocalSessions();
}

export function getLocalSessionCwd(sessionId: string): string | null {
  let cwd = cwdIndex.get(sessionId);
  if (cwd === undefined) {
    listLocalSessions();
    cwd = cwdIndex.get(sessionId);
  }
  return cwd ?? null;
}

const MAX_STEPS = 200;
const MAX_BLOCK_CHARS = 4000;

function truncate(text: string): string {
  return text.length > MAX_BLOCK_CHARS ? text.slice(0, MAX_BLOCK_CHARS) + '\n… (truncated)' : text;
}

export async function getLocalTranscript(sessionId: string): Promise<TranscriptStep[]> {
  const rawId = sessionId.replace(/^local:/, '');
  let filePath = fileIndex.get(rawId);
  if (!filePath) {
    listLocalSessions();
    filePath = fileIndex.get(rawId);
  }
  if (!filePath) return [];

  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    return [];
  }

  const steps: TranscriptStep[] = [];
  for (const line of content.split('\n')) {
    if (!line) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === 'meta') continue;

    const blocks = entry.blocks;
    if (!Array.isArray(blocks)) continue;

    const truncatedBlocks: TranscriptBlock[] = blocks.map((b: any) => ({
      kind: (b.kind ?? 'text') as TranscriptBlock['kind'],
      content: b.kind === 'image' ? String(b.content ?? '') : truncate(String(b.content ?? '')),
      ...(b.lang ? { lang: b.lang } : {}),
    }));

    steps.push({
      id: entry.id ?? `step-${steps.length}`,
      heading: entry.heading ?? 'Assistant',
      finished: entry.finished ?? true,
      blocks: truncatedBlocks,
    });
  }

  return steps.slice(-MAX_STEPS);
}

export function createLocalSession(projectName: string, cwd: string): Session {
  ensureDir();
  const rawId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const id = `local:${rawId}`;
  const filePath = join(LOCAL_DIR, `${rawId}.jsonl`);
  const now = new Date().toISOString();

  const meta = JSON.stringify({ type: 'meta', cwd, title: 'New session', updatedAt: now });
  writeFileSync(filePath, meta + '\n', 'utf8');

  fileIndex.set(rawId, filePath);
  cwdIndex.set(id, cwd);

  const session: Session = {
    id,
    title: 'New session',
    projectName,
    added: 0,
    removed: 0,
    updatedAt: now,
    source: 'local',
  };
  return session;
}

export function addLocalTranscriptStep(sessionId: string, step: TranscriptStep): void {
  const rawId = sessionId.replace(/^local:/, '');
  const filePath = fileIndex.get(rawId);
  if (!filePath) return;

  const line = JSON.stringify({
    type: 'step',
    id: step.id,
    heading: step.heading,
    finished: step.finished,
    blocks: step.blocks,
  });

  appendFile(filePath, line + '\n', 'utf8')
    .then(() => {
      readFile(filePath, 'utf8')
        .then((content) => {
          const lines = content.split('\n');
          if (lines.length === 0) return;
          try {
            const meta = JSON.parse(lines[0]);
            meta.updatedAt = new Date().toISOString();
            lines[0] = JSON.stringify(meta);
            return writeFile(filePath, lines.join('\n'), 'utf8');
          } catch {
            // malformed meta — skip
          }
        })
        .catch(() => {});
    })
    .catch(() => {});
}

export function updateLocalSessionTitle(sessionId: string, title: string): void {
  const rawId = sessionId.replace(/^local:/, '');
  const filePath = fileIndex.get(rawId);
  if (!filePath) return;

  readFile(filePath, 'utf8')
    .then((content) => {
      const lines = content.split('\n');
      if (lines.length === 0) return;
      const meta = JSON.parse(lines[0]);
      meta.title = title;
      meta.updatedAt = new Date().toISOString();
      lines[0] = JSON.stringify(meta);
      return writeFile(filePath, lines.join('\n'), 'utf8');
    })
    .catch(() => {});
}

export async function clearLocalTranscript(sessionId: string): Promise<void> {
  const rawId = sessionId.replace(/^local:/, '');
  let filePath = fileIndex.get(rawId);
  if (!filePath) {
    listLocalSessions();
    filePath = fileIndex.get(rawId);
  }
  if (!filePath) return;

  try {
    const content = await readFile(filePath, 'utf8');
    const metaLine = content.split('\n')[0];
    if (!metaLine) return;
    await writeFile(filePath, metaLine + '\n', 'utf8');
  } catch {
    // file missing or unreadable — nothing to clear
  }
}

export async function deleteLocalSession(sessionId: string): Promise<void> {
  const rawId = sessionId.replace(/^local:/, '');
  let filePath = fileIndex.get(rawId);
  if (!filePath) {
    listLocalSessions();
    filePath = fileIndex.get(rawId);
  }
  if (!filePath) return;

  await unlink(filePath);
  fileIndex.delete(rawId);
  cwdIndex.delete(sessionId);
}

function parseLocalEditEntries(sessionId: string): StepEditEntry[] {
  const rawId = sessionId.replace(/^local:/, '');
  let path = fileIndex.get(rawId);
  if (!path) {
    listLocalSessions();
    path = fileIndex.get(rawId);
  }
  if (!path) return [];

  let fileContent: string;
  try {
    fileContent = readFileSync(path, 'utf8');
  } catch {
    return [];
  }

  return parseStepEditEntries(fileContent);
}

export async function getLocalChanges(sessionId: string): Promise<FileChange[]> {
  const entries = parseLocalEditEntries(sessionId);
  const cwd = cwdIndex.get(sessionId) ?? null;
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

export async function getLocalFileOps(sessionId: string, path: string): Promise<EditOp[] | null> {
  const entries = parseLocalEditEntries(sessionId);
  const cwd = cwdIndex.get(sessionId) ?? null;
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
