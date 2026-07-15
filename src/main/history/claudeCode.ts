import { readdir, readFile, stat } from 'node:fs/promises';
import { join, basename, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import type {
  EditOp,
  FileChange,
  Session,
  Transcript,
  TranscriptBlock,
  TranscriptStep,
} from '../../shared/types';
import { countLineDiff, accumulate, toFileChanges, type FileChangeAcc } from './changeUtils';
import { parseJsonSafe } from '../../shared/utils/json';

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

const fileIndex = new Map<string, string>();
const cwdIndex = new Map<string, string>();

async function listJsonlFiles(): Promise<string[]> {
  let projectDirs: string[];
  try {
    projectDirs = (await readdir(PROJECTS_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(PROJECTS_DIR, entry.name));
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const dir of projectDirs) {
    let entries: string[];
    try {
      entries = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of entries) files.push(join(dir, f));
  }
  return files;
}

interface SessionMeta {
  cwd: string | null;
  aiTitle: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  added: number;
  removed: number;
}

const metaCache = new Map<string, { mtimeMs: number; size: number; meta: SessionMeta }>();

async function scanMeta(filePath: string): Promise<SessionMeta> {
  const meta: SessionMeta = {
    cwd: null,
    aiTitle: null,
    createdAt: null,
    updatedAt: null,
    added: 0,
    removed: 0,
  };
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    return meta;
  }
  for (const line of content.split('\n')) {
    if (!line) continue;
    if (!meta.cwd) {
      const cwdMatch = line.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
      if (cwdMatch) meta.cwd = cwdMatch[1];
    }
    const tsMatch = line.match(/"timestamp":"([^"]+)"/);
    if (tsMatch) {
      if (!meta.createdAt) meta.createdAt = tsMatch[1];
      meta.updatedAt = tsMatch[1];
    }
    const titleMatch = line.match(/"aiTitle":"((?:[^"\\]|\\.)*)"/);
    if (titleMatch) meta.aiTitle = titleMatch[1];

    if (
      line.includes('"tool_use"') &&
      (line.includes('"name":"Edit"') || line.includes('"name":"Write"'))
    ) {
      const entry = parseJsonSafe(line);
      if (entry && typeof entry === 'object') {
        const blocks = (entry as any).message?.content;
        if (Array.isArray(blocks)) {
          for (const block of blocks) {
            if (block.type !== 'tool_use') continue;
            if (
              block.name === 'Edit' &&
              typeof block.input?.old_string === 'string' &&
              typeof block.input?.new_string === 'string'
            ) {
              const diff = countLineDiff(block.input.old_string, block.input.new_string);
              meta.added += diff.added;
              meta.removed += diff.removed;
            } else if (block.name === 'Write' && typeof block.input?.content === 'string') {
              meta.added += block.input.content.split('\n').length;
            }
          }
        }
      }
    }
  }
  return meta;
}

function unescape(text: string): string {
  const parsed = parseJsonSafe(`"${text}"`);
  return typeof parsed === 'string' ? parsed : text;
}

let listInFlight: Promise<Session[]> | null = null;

export function listClaudeCodeSessions(): Promise<Session[]> {
  listInFlight ??= runListPass().finally(() => {
    listInFlight = null;
  });
  return listInFlight;
}

async function runListPass(): Promise<Session[]> {
  const files = await listJsonlFiles();
  const scanned = await Promise.all(
    files.map(async (filePath) => {
      let st;
      try {
        st = await stat(filePath);
      } catch {
        return null;
      }
      let cached = metaCache.get(filePath);
      if (!cached || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size) {
        cached = { mtimeMs: st.mtimeMs, size: st.size, meta: await scanMeta(filePath) };
        metaCache.set(filePath, cached);
      }
      return { filePath, cached };
    }),
  );

  const newFileIndex = new Map<string, string>();
  const newCwdIndex = new Map<string, string>();
  const sessions: Session[] = [];
  const seen = new Set<string>();
  for (const entry of scanned) {
    if (!entry) continue;
    const { filePath, cached } = entry;
    seen.add(filePath);
    const id = basename(filePath, '.jsonl');
    newFileIndex.set(id, filePath);

    const meta = cached.meta;
    if (!meta.cwd && !meta.createdAt) continue;

    if (meta.cwd) newCwdIndex.set(`claude:${id}`, meta.cwd);

    sessions.push({
      id: `claude:${id}`,
      title: meta.aiTitle ? unescape(meta.aiTitle) : 'New session',
      projectName: basename(meta.cwd ?? 'unknown'),
      added: meta.added,
      removed: meta.removed,
      updatedAt: meta.updatedAt ?? new Date(cached.mtimeMs).toISOString(),
      source: 'claude',
    });
  }

  for (const key of metaCache.keys()) {
    if (!seen.has(key)) metaCache.delete(key);
  }

  fileIndex.clear();
  for (const [k, v] of newFileIndex) fileIndex.set(k, v);
  cwdIndex.clear();
  for (const [k, v] of newCwdIndex) cwdIndex.set(k, v);

  return sessions;
}

export async function getClaudeCodeCwd(rawId: string): Promise<string | null> {
  let cwd = cwdIndex.get(rawId);
  if (cwd === undefined) {
    await listClaudeCodeSessions();
    cwd = cwdIndex.get(rawId);
  }
  return cwd ?? null;
}

export async function getClaudeCodeChanges(rawId: string): Promise<FileChange[]> {
  const id = rawId.replace(/^claude:/, '');
  let filePath = fileIndex.get(id);
  if (!filePath) {
    await listClaudeCodeSessions();
    filePath = fileIndex.get(id);
  }
  if (!filePath) return [];

  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    return [];
  }

  const byPath = new Map<string, FileChangeAcc>();
  for (const line of content.split('\n')) {
    if (!line) continue;
    if (
      !line.includes('"tool_use"') ||
      !(line.includes('"name":"Edit"') || line.includes('"name":"Write"'))
    )
      continue;
    const entry = parseJsonSafe(line);
    if (!entry || typeof entry !== 'object') continue;
    const blocks = (entry as any).message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block.type !== 'tool_use' || typeof block.input?.file_path !== 'string') continue;
      if (
        block.name === 'Edit' &&
        typeof block.input.old_string === 'string' &&
        typeof block.input.new_string === 'string'
      ) {
        const diff = countLineDiff(block.input.old_string, block.input.new_string);
        accumulate(byPath, block.input.file_path, diff.added, diff.removed, false);
      } else if (block.name === 'Write' && typeof block.input.content === 'string') {
        accumulate(byPath, block.input.file_path, block.input.content.split('\n').length, 0, true);
      }
    }
  }

  return toFileChanges(byPath, cwdIndex.get(rawId) ?? null);
}

export async function getClaudeCodeFileOps(rawId: string, path: string): Promise<EditOp[] | null> {
  const id = rawId.replace(/^claude:/, '');
  let filePath = fileIndex.get(id);
  if (!filePath) {
    await listClaudeCodeSessions();
    filePath = fileIndex.get(id);
  }
  if (!filePath) return null;

  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }

  const cwd = cwdIndex.get(rawId) ?? null;
  const abs = isAbsolute(path) ? path : cwd ? join(cwd, path) : path;

  const ops: EditOp[] = [];
  for (const line of content.split('\n')) {
    if (!line) continue;
    if (
      !line.includes('"tool_use"') ||
      !(line.includes('"name":"Edit"') || line.includes('"name":"Write"'))
    )
      continue;
    const entry = parseJsonSafe(line);
    if (!entry || typeof entry !== 'object') continue;
    const blocks = (entry as any).message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block.type !== 'tool_use' || typeof block.input?.file_path !== 'string') continue;
      if (block.input.file_path !== abs && block.input.file_path !== path) continue;
      if (
        block.name === 'Edit' &&
        typeof block.input.old_string === 'string' &&
        typeof block.input.new_string === 'string'
      ) {
        ops.push({ before: block.input.old_string, after: block.input.new_string });
      } else if (block.name === 'Write' && typeof block.input.content === 'string') {
        ops.push({ before: '', after: block.input.content });
      }
    }
  }
  return ops.length ? ops : null;
}

const MAX_STEPS = 200;
const MAX_BLOCK_CHARS = 4000;

function truncate(text: string): string {
  return text.length > MAX_BLOCK_CHARS ? text.slice(0, MAX_BLOCK_CHARS) + '\n… (truncated)' : text;
}

function isSyntheticUserText(text: string): boolean {
  return /^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)/.test(
    text.trim(),
  );
}

function summarizeTool(name: string, input: any): string {
  if (name === 'Bash' && typeof input?.command === 'string') return `Ran ${input.command}`;
  if (name === 'Read' && typeof input?.file_path === 'string') return `Read ${input.file_path}`;
  if (name === 'Write' && typeof input?.file_path === 'string') return `Wrote ${input.file_path}`;
  if (name === 'Edit' && typeof input?.file_path === 'string') return `Edited ${input.file_path}`;
  if (name === 'ToolSearch' && typeof input?.query === 'string') return `Searched ${input.query}`;
  if (name === 'WebSearch' && typeof input?.query === 'string')
    return `Searched the web for ${input.query}`;
  return name;
}

export async function getClaudeCodeTranscript(rawId: string): Promise<Transcript> {
  const id = rawId.replace(/^claude:/, '');
  let filePath = fileIndex.get(id);
  if (!filePath) {
    await listClaudeCodeSessions();
    filePath = fileIndex.get(id);
  }
  if (!filePath) return { sessionId: rawId, steps: [] };

  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    return { sessionId: rawId, steps: [] };
  }

  const steps: TranscriptStep[] = [];
  let stepCounter = 0;

  for (const line of content.split('\n')) {
    if (!line) continue;
    const entry = parseJsonSafe(line);
    if (!entry || typeof entry !== 'object') continue;
    if ((entry as any).isMeta) continue;
    if ((entry as any).origin?.kind === 'task-notification') continue;

    if ((entry as any).type === 'user') {
      const content_ = (entry as any).message?.content;
      const blocks: TranscriptBlock[] = [];
      if (typeof content_ === 'string') {
        if (content_.trim() && !isSyntheticUserText(content_))
          blocks.push({ kind: 'text', content: truncate(content_) });
      } else if (Array.isArray(content_)) {
        for (const block of content_) {
          if (block.type === 'text' && block.text?.trim() && !isSyntheticUserText(block.text)) {
            blocks.push({ kind: 'text', content: truncate(block.text) });
          }
        }
      }
      if (blocks.length) {
        steps.push({
          id: (entry as any).uuid ?? `u-${stepCounter++}`,
          heading: 'You',
          finished: true,
          blocks,
        });
      }
    } else if ((entry as any).type === 'assistant') {
      const content_ = (entry as any).message?.content;
      const blocks: TranscriptBlock[] = [];
      if (Array.isArray(content_)) {
        for (const block of content_) {
          if (block.type === 'text' && block.text?.trim()) {
            blocks.push({ kind: 'text', content: truncate(block.text) });
          } else if (block.type === 'tool_use') {
            blocks.push({ kind: 'tool', content: summarizeTool(block.name, block.input) });
          }
        }
      }
      if (blocks.length) {
        steps.push({
          id: (entry as any).uuid ?? `a-${stepCounter++}`,
          heading: 'Claude',
          finished: true,
          blocks,
        });
      }
    }
  }

  return { sessionId: rawId, steps: steps.slice(-MAX_STEPS) };
}
