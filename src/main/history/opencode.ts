import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, stat } from 'node:fs/promises';
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

const DB_PATH = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function query<T = any>(sql: string): Promise<T[]> {
  if (!existsSync(DB_PATH)) return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile(
      'sqlite3',
      ['-readonly', '-json', '-cmd', '.timeout 3000', DB_PATH, sql],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 15_000 },
      (error, stdout) => {
        if (error || !stdout.trim()) return resolve([]);
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve([]);
        }
      },
    );
  });
}

interface SessionRow {
  id: string;
  title: string;
  worktree: string;
  updatedAt: number;
}

let statsCache: { key: string; stats: Map<string, { added: number; removed: number }> } | null =
  null;

async function dbStateKey(): Promise<string> {
  const parts: string[] = [];
  for (const path of [DB_PATH, `${DB_PATH}-wal`]) {
    try {
      const st = await stat(path);
      parts.push(`${st.mtimeMs}:${st.size}`);
    } catch {
      parts.push('absent');
    }
  }
  return parts.join('|');
}

async function getOpencodeSessionStats(): Promise<Map<string, { added: number; removed: number }>> {
  const key = await dbStateKey();
  if (statsCache && statsCache.key === key) return statsCache.stats;

  const rows = await query<EditPartRow & { session_id: string }>(`
    select part.session_id as session_id,
           json_extract(data, '$.tool') as tool,
           json_extract(data, '$.state.status') as status,
           json_extract(data, '$.state.input.filePath') as filePath,
           json_extract(data, '$.state.input.oldString') as oldString,
           json_extract(data, '$.state.input.newString') as newString,
           json_extract(data, '$.state.input.content') as content
    from part
    join session on session.id = part.session_id
    where session.parent_id is null
      and json_extract(data, '$.type') = 'tool'
      and json_extract(data, '$.tool') in ('edit', 'write')
    order by part.time_created;
  `);

  const byPathBySession = new Map<string, Map<string, FileChangeAcc>>();
  for (const row of rows) {
    if (row.status !== 'completed' || typeof row.filePath !== 'string') continue;
    let byPath = byPathBySession.get(row.session_id);
    if (!byPath) byPathBySession.set(row.session_id, (byPath = new Map()));
    if (
      row.tool === 'edit' &&
      typeof row.oldString === 'string' &&
      typeof row.newString === 'string'
    ) {
      const diff = countLineDiff(row.oldString, row.newString);
      accumulate(byPath, row.filePath, diff.added, diff.removed, false);
    } else if (row.tool === 'write' && typeof row.content === 'string') {
      accumulate(byPath, row.filePath, row.content.split('\n').length, 0, true);
    }
  }

  const stats = new Map<string, { added: number; removed: number }>();
  for (const [sessionId, byPath] of byPathBySession) {
    let added = 0;
    let removed = 0;
    for (const acc of byPath.values()) {
      added += acc.added;
      removed += acc.removed;
    }
    stats.set(sessionId, { added, removed });
  }
  statsCache = { key, stats };
  return stats;
}

export async function listOpencodeSessions(): Promise<Session[]> {
  const [rows, stats] = await Promise.all([
    query<SessionRow>(`
      select s.id as id, s.title as title, p.worktree as worktree,
             s.time_updated as updatedAt
      from session s
      join project p on p.id = s.project_id
      where p.worktree != '/' and s.parent_id is null
      order by s.time_updated desc;
    `),
    getOpencodeSessionStats(),
  ]);

  return rows.map((row) => ({
    id: `opencode:${row.id}`,
    title: row.title || 'New session',
    projectName: basename(row.worktree),
    added: stats.get(row.id)?.added ?? 0,
    removed: stats.get(row.id)?.removed ?? 0,
    updatedAt: new Date(row.updatedAt).toISOString(),
    source: 'opencode',
  }));
}

export async function getOpencodeCwd(rawId: string): Promise<string | null> {
  const id = rawId.replace(/^opencode:/, '');
  const rows = await query<{ worktree: string; directory: string }>(
    `select p.worktree as worktree, s.directory as directory
     from session s join project p on p.id = s.project_id
     where s.id = ${sqlString(id)} limit 1;`,
  );
  if (!rows[0]) return null;
  const { worktree, directory } = rows[0];
  // worktree is often a symlink that becomes stale; fall back to directory
  const candidates = [worktree, directory].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // doesn't exist on disk, try next
    }
  }
  return null;
}

const MAX_STEPS = 200;
const MAX_BLOCK_CHARS = 4000;

function summarizeTool(tool: string, summary: string): string {
  if (!summary) return tool;
  if (tool === 'bash') return `Ran ${summary}`;
  if (tool === 'read') return `Read ${summary}`;
  if (tool === 'write') return `Wrote ${summary}`;
  if (tool === 'edit') return `Edited ${summary}`;
  return `${tool}: ${summary}`;
}

interface MessageRow {
  id: string;
  role: string | null;
  agent: string | null;
}

interface PartRow {
  message_id: string;
  type: string;
  text: string;
  tool: string | null;
  summary: string;
}

export async function getOpencodeTranscript(rawId: string): Promise<Transcript> {
  const id = rawId.replace(/^opencode:/, '');
  const [messages, parts] = await Promise.all([
    query<MessageRow>(
      `select id,
              json_extract(data, '$.role') as role,
              json_extract(data, '$.agent') as agent
       from message where session_id = ${sqlString(id)} order by time_created;`,
    ),
    query<PartRow>(
      `select message_id,
              json_extract(data, '$.type') as type,
              substr(coalesce(json_extract(data, '$.text'), ''), 1, ${MAX_BLOCK_CHARS + 1}) as text,
              json_extract(data, '$.tool') as tool,
              substr(coalesce(json_extract(data, '$.state.input.command'),
                              json_extract(data, '$.state.input.filePath'),
                              json_extract(data, '$.state.input.description'),
                              ''), 1, 300) as summary
       from part
       where session_id = ${sqlString(id)}
         and json_extract(data, '$.type') in ('text', 'tool')
       order by time_created;`,
    ),
  ]);
  if (!messages.length) return { sessionId: rawId, steps: [] };

  const partsByMessage = new Map<string, PartRow[]>();
  for (const part of parts) {
    const list = partsByMessage.get(part.message_id) ?? [];
    list.push(part);
    partsByMessage.set(part.message_id, list);
  }

  const steps: TranscriptStep[] = [];
  for (const message of messages) {
    const blocks: TranscriptBlock[] = [];
    for (const part of partsByMessage.get(message.id) ?? []) {
      if (part.type === 'text' && part.text.trim()) {
        const text =
          part.text.length > MAX_BLOCK_CHARS
            ? part.text.slice(0, MAX_BLOCK_CHARS) + '\n… (truncated)'
            : part.text;
        blocks.push({ kind: 'text', content: text });
      } else if (part.type === 'tool' && part.tool) {
        blocks.push({ kind: 'tool', content: summarizeTool(part.tool, part.summary) });
      }
    }
    if (blocks.length) {
      const heading = message.role === 'user' ? 'You' : (message.agent ?? 'Assistant');
      steps.push({ id: message.id, heading, finished: true, blocks });
    }
  }

  return { sessionId: rawId, steps: steps.slice(-MAX_STEPS) };
}

interface EditPartRow {
  tool: string;
  status: string | null;
  filePath: string | null;
  oldString: string | null;
  newString: string | null;
  content: string | null;
}

export async function getOpencodeChanges(rawId: string): Promise<FileChange[]> {
  const id = rawId.replace(/^opencode:/, '');
  const [parts, cwd] = await Promise.all([
    query<EditPartRow>(
      `select json_extract(data, '$.tool') as tool,
              json_extract(data, '$.state.status') as status,
              json_extract(data, '$.state.input.filePath') as filePath,
              json_extract(data, '$.state.input.oldString') as oldString,
              json_extract(data, '$.state.input.newString') as newString,
              json_extract(data, '$.state.input.content') as content
       from part
       where session_id = ${sqlString(id)}
         and json_extract(data, '$.type') = 'tool'
         and json_extract(data, '$.tool') in ('edit', 'write')
       order by time_created;`,
    ),
    getOpencodeCwd(rawId),
  ]);

  const byPath = new Map<string, FileChangeAcc>();
  for (const part of parts) {
    if (part.status !== 'completed' || typeof part.filePath !== 'string') continue;
    if (
      part.tool === 'edit' &&
      typeof part.oldString === 'string' &&
      typeof part.newString === 'string'
    ) {
      const diff = countLineDiff(part.oldString, part.newString);
      accumulate(byPath, part.filePath, diff.added, diff.removed, false);
    } else if (part.tool === 'write' && typeof part.content === 'string') {
      accumulate(byPath, part.filePath, part.content.split('\n').length, 0, true);
    }
  }

  return toFileChanges(byPath, cwd);
}

export async function getOpencodeFileOps(rawId: string, path: string): Promise<EditOp[] | null> {
  const id = rawId.replace(/^opencode:/, '');
  const cwd = await getOpencodeCwd(rawId);
  const abs = isAbsolute(path) ? path : cwd ? join(cwd, path) : path;

  const parts = await query<EditPartRow>(
    `select json_extract(data, '$.tool') as tool,
            json_extract(data, '$.state.status') as status,
            json_extract(data, '$.state.input.filePath') as filePath,
            json_extract(data, '$.state.input.oldString') as oldString,
            json_extract(data, '$.state.input.newString') as newString,
            json_extract(data, '$.state.input.content') as content
     from part
     where session_id = ${sqlString(id)}
       and json_extract(data, '$.type') = 'tool'
       and json_extract(data, '$.tool') in ('edit', 'write')
       and json_extract(data, '$.state.input.filePath') in (${sqlString(path)}, ${sqlString(abs)})
     order by time_created;`,
  );

  const ops: EditOp[] = [];
  for (const part of parts) {
    if (part.status !== 'completed') continue;
    if (
      part.tool === 'edit' &&
      typeof part.oldString === 'string' &&
      typeof part.newString === 'string'
    ) {
      ops.push({ before: part.oldString, after: part.newString });
    } else if (part.tool === 'write' && typeof part.content === 'string') {
      ops.push({ before: '', after: part.content });
    }
  }
  return ops.length ? ops : null;
}
