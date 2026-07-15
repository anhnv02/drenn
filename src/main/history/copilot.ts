import { readdir, readFile, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type {
  FileChange,
  Session,
  Transcript,
  TranscriptBlock,
  TranscriptStep,
} from '../../shared/types';
import { accumulate, toFileChanges, type FileChangeAcc } from './changeUtils';
import { parseJsonSafe } from '../../shared/utils/json';

function codeUserDir(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Code', 'User');
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Code', 'User');
  }
  return join(homedir(), '.config', 'Code', 'User');
}

const WORKSPACE_STORAGE_DIR = join(codeUserDir(), 'workspaceStorage');

const fileIndex = new Map<string, string>();
const cwdIndex = new Map<string, string>();

interface WorkspaceEntry {
  storageDir: string;
  folderPath: string | null;
}

async function listWorkspaces(): Promise<WorkspaceEntry[]> {
  let dirs: string[];
  try {
    dirs = (await readdir(WORKSPACE_STORAGE_DIR, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => join(WORKSPACE_STORAGE_DIR, e.name));
  } catch {
    return [];
  }
  const workspaces: WorkspaceEntry[] = [];
  for (const storageDir of dirs) {
    let folderPath: string | null = null;
    try {
      const raw = await readFile(join(storageDir, 'workspace.json'), 'utf8');
      const meta = parseJsonSafe(raw);
      if (meta && typeof meta === 'object' && typeof (meta as any).folder === 'string') {
        folderPath = fileURLToPath((meta as any).folder);
      }
    } catch {
      // no workspace.json (e.g. an empty window) — skip project attribution
    }
    workspaces.push({ storageDir, folderPath });
  }
  return workspaces;
}

function replayEvents(lines: any[]): any {
  let state: any = {};
  for (const event of lines) {
    const path: (string | number)[] = event.k ?? [];
    if (event.kind === 0 || path.length === 0) {
      state = event.v;
      continue;
    }
    let obj = state;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i];
      if (obj[key] === undefined) obj[key] = typeof path[i + 1] === 'number' ? [] : {};
      obj = obj[key];
    }
    const lastKey = path[path.length - 1];
    if (event.kind === 2) {
      if (!Array.isArray(obj[lastKey])) obj[lastKey] = [];
      obj[lastKey].push(...event.v);
    } else {
      obj[lastKey] = event.v;
    }
  }
  return state;
}

async function loadSessionState(filePath: string): Promise<any | null> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  const lines = content
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => parseJsonSafe(l))
    .filter((e) => e !== null);
  if (!lines.length) return null;
  return replayEvents(lines);
}

const sessionCache = new Map<string, { mtimeMs: number; size: number; session: Session | null }>();

async function buildSession(
  filePath: string,
  id: string,
  updatedAt: string,
  folderPath: string,
): Promise<Session | null> {
  const state = await loadSessionState(filePath);
  if (!state) return null;
  const requests = Array.isArray(state.requests) ? state.requests : [];
  if (!requests.length) return null;

  let added = 0;
  let removed = 0;
  for (const acc of accumulateChangesFromState(state).values()) {
    added += acc.added;
    removed += acc.removed;
  }

  return {
    id: `copilot:${id}`,
    title: state.customTitle?.trim() || requests[0]?.message?.text?.trim() || 'New session',
    projectName: basename(folderPath),
    added,
    removed,
    updatedAt,
    source: 'copilot',
  };
}

let listInFlight: Promise<Session[]> | null = null;

export function listCopilotSessions(): Promise<Session[]> {
  listInFlight ??= runListPass().finally(() => {
    listInFlight = null;
  });
  return listInFlight;
}

async function runListPass(): Promise<Session[]> {
  const newFileIndex = new Map<string, string>();
  const newCwdIndex = new Map<string, string>();
  const sessions: Session[] = [];
  const seen = new Set<string>();

  for (const workspace of await listWorkspaces()) {
    if (!workspace.folderPath) continue;
    const folderPath = workspace.folderPath;
    const chatSessionsDir = join(workspace.storageDir, 'chatSessions');
    let files: string[];
    try {
      files = (await readdir(chatSessionsDir)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    const scanned = await Promise.all(
      files.map(async (file) => {
        const filePath = join(chatSessionsDir, file);
        const id = basename(file, '.jsonl');

        let st: Stats;
        try {
          st = await stat(filePath);
        } catch {
          return null;
        }
        let cached = sessionCache.get(filePath);
        if (!cached || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size) {
          cached = {
            mtimeMs: st.mtimeMs,
            size: st.size,
            session: await buildSession(filePath, id, st.mtime.toISOString(), folderPath),
          };
          sessionCache.set(filePath, cached);
        }
        return { filePath, id, session: cached.session };
      }),
    );

    for (const entry of scanned) {
      if (!entry) continue;
      seen.add(entry.filePath);
      if (!entry.session) continue;

      newFileIndex.set(entry.id, entry.filePath);
      newCwdIndex.set(`copilot:${entry.id}`, folderPath);
      sessions.push({ ...entry.session });
    }
  }

  for (const key of sessionCache.keys()) {
    if (!seen.has(key)) sessionCache.delete(key);
  }

  fileIndex.clear();
  for (const [k, v] of newFileIndex) fileIndex.set(k, v);
  cwdIndex.clear();
  for (const [k, v] of newCwdIndex) cwdIndex.set(k, v);

  return sessions;
}

export async function getCopilotCwd(rawId: string): Promise<string | null> {
  let cwd = cwdIndex.get(rawId);
  if (cwd === undefined) {
    await listCopilotSessions();
    cwd = cwdIndex.get(rawId);
  }
  return cwd ?? null;
}

const MAX_STEPS = 200;
const MAX_BLOCK_CHARS = 4000;

function truncate(text: string): string {
  return text.length > MAX_BLOCK_CHARS ? text.slice(0, MAX_BLOCK_CHARS) + '\n… (truncated)' : text;
}

function resolveEmptyFileLinks(text: string): string {
  return text.replace(/\[\]\((file:\/\/[^)\s]+)\)/g, (match, uri) => {
    try {
      return fileURLToPath(uri);
    } catch {
      return match;
    }
  });
}

function inlineReferenceLabel(item: any): string | null {
  const ref = item.inlineReference;
  const name = item.name ?? ref?.name;
  if (typeof name === 'string' && name.trim()) return name;
  const fsPath = ref?.fsPath ?? ref?.location?.uri?.fsPath;
  return typeof fsPath === 'string' ? fsPath : null;
}

function stripEmptyCodeFences(text: string): string {
  return text.replace(/```[a-zA-Z]*\n\s*```/g, '');
}

export async function getCopilotTranscript(rawId: string): Promise<Transcript> {
  const id = rawId.replace(/^copilot:/, '');
  let filePath = fileIndex.get(id);
  if (!filePath) {
    await listCopilotSessions();
    filePath = fileIndex.get(id);
  }
  if (!filePath) return { sessionId: rawId, steps: [] };

  const state = await loadSessionState(filePath);
  const requests = Array.isArray(state?.requests) ? state.requests : [];

  const steps: TranscriptStep[] = [];
  requests.forEach((request: any, i: number) => {
    const userText = request?.message?.text?.trim();
    if (userText) {
      steps.push({
        id: `${id}-u-${i}`,
        heading: 'You',
        finished: true,
        blocks: [{ kind: 'text', content: truncate(userText) }],
      });
    }

    const responseItems = Array.isArray(request?.response) ? request.response : [];
    const blocks: TranscriptBlock[] = [];
    let markdown = '';
    for (const item of responseItems) {
      if (!item.kind && typeof item.value === 'string') {
        markdown += resolveEmptyFileLinks(item.value);
      } else if (
        item.kind === 'toolInvocationSerialized' &&
        typeof item.invocationMessage?.value === 'string'
      ) {
        const text = stripEmptyCodeFences(markdown);
        if (text.trim()) blocks.push({ kind: 'text', content: truncate(text) });
        markdown = '';
        blocks.push({ kind: 'tool', content: resolveEmptyFileLinks(item.invocationMessage.value) });
      } else if (item.kind === 'inlineReference') {
        markdown += inlineReferenceLabel(item) ?? '';
      }
    }
    const finalText = stripEmptyCodeFences(markdown);
    if (finalText.trim()) blocks.push({ kind: 'text', content: truncate(finalText) });
    if (blocks.length) {
      steps.push({ id: `${id}-a-${i}`, heading: 'Copilot', finished: true, blocks });
    }
  });

  return { sessionId: rawId, steps: steps.slice(-MAX_STEPS) };
}

interface TextEditRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

function lineDiffForEdit(text: string, range: TextEditRange): { added: number; removed: number } {
  const added = text === '' ? 0 : text.split('\n').length;
  const isInsertionPoint =
    range.startLineNumber === range.endLineNumber && range.startColumn === range.endColumn;
  const removed = isInsertionPoint ? 0 : range.endLineNumber - range.startLineNumber + 1;
  return { added, removed };
}

function accumulateChangesFromState(state: any): Map<string, FileChangeAcc> {
  const requests = Array.isArray(state?.requests) ? state.requests : [];
  const byPath = new Map<string, FileChangeAcc>();
  const created = new Set<string>();

  for (const request of requests) {
    const responseItems = Array.isArray(request?.response) ? request.response : [];
    for (const item of responseItems) {
      if (item?.kind === 'toolInvocationSerialized' && item.toolId === 'copilot_createFile') {
        for (const uri of Object.values<any>(item.invocationMessage?.uris ?? {})) {
          if (typeof uri?.path === 'string') created.add(uri.path);
        }
      } else if (item?.kind === 'textEditGroup' && typeof item.uri?.path === 'string') {
        const path = item.uri.path as string;
        for (const group of item.edits ?? []) {
          for (const edit of group ?? []) {
            if (typeof edit?.text !== 'string' || !edit.range) continue;
            const diff = lineDiffForEdit(edit.text, edit.range);
            accumulate(byPath, path, diff.added, diff.removed, created.has(path));
          }
        }
      }
    }
  }

  return byPath;
}

export async function getCopilotChanges(rawId: string): Promise<FileChange[]> {
  const id = rawId.replace(/^copilot:/, '');
  let filePath = fileIndex.get(id);
  if (!filePath) {
    await listCopilotSessions();
    filePath = fileIndex.get(id);
  }
  if (!filePath) return [];

  const state = await loadSessionState(filePath);
  return toFileChanges(accumulateChangesFromState(state), cwdIndex.get(rawId) ?? null);
}
