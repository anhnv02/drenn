import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { CHECKPOINT_DIR } from '../config/paths';
import { parseJsonOrDefault } from '../../shared/utils/json';

const MAX_ENTRIES_PER_SESSION = 500;

export interface CheckpointEntry {
  id: string;
  filePath: string;
  before: string | null;
  tool: string;
  createdAt: number;
}

const bySession = new Map<string, CheckpointEntry[]>();
let nextId = 1;

function sessionFile(sessionId: string): string {
  return join(CHECKPOINT_DIR, `${encodeURIComponent(sessionId)}.json`);
}

async function persist(sessionId: string): Promise<void> {
  const entries = bySession.get(sessionId) ?? [];
  try {
    await fs.mkdir(CHECKPOINT_DIR, { recursive: true });
    await fs.writeFile(sessionFile(sessionId), JSON.stringify(entries), 'utf8');
  } catch {
    // Checkpointing must never break the edit itself
  }
}

async function loadSession(sessionId: string): Promise<CheckpointEntry[]> {
  const inMemory = bySession.get(sessionId);
  if (inMemory) return inMemory;
  try {
    const raw = await fs.readFile(sessionFile(sessionId), 'utf8');
    const entries = parseJsonOrDefault<CheckpointEntry[]>(raw, []);
    bySession.set(sessionId, entries);
    return entries;
  } catch {
    const empty: CheckpointEntry[] = [];
    bySession.set(sessionId, empty);
    return empty;
  }
}

let writeChain: Promise<unknown> = Promise.resolve();

export function recordCheckpoint(
  sessionId: string,
  tool: string,
  filePath: string,
  before: string | null,
): void {
  writeChain = writeChain
    .then(async () => {
      const entries = await loadSession(sessionId);
      entries.push({
        id: `cp_${nextId++}`,
        filePath,
        before,
        tool,
        createdAt: Date.now(),
      });
      if (entries.length > MAX_ENTRIES_PER_SESSION) {
        entries.splice(0, entries.length - MAX_ENTRIES_PER_SESSION);
      }
      await persist(sessionId);
    })
    .catch(() => {});
}

export async function listCheckpoints(
  sessionId: string,
): Promise<Array<Omit<CheckpointEntry, 'before'> & { existed: boolean }>> {
  await writeChain;
  const entries = await loadSession(sessionId);
  return entries.map(({ before, ...rest }) => ({ ...rest, existed: before !== null }));
}

export async function revertSessionChanges(
  sessionId: string,
): Promise<Array<{ filePath: string; action: 'restored' | 'deleted' | 'failed'; error?: string }>> {
  await writeChain;
  const entries = await loadSession(sessionId);

  const firstByFile = new Map<string, CheckpointEntry>();
  for (const entry of entries) {
    if (!firstByFile.has(entry.filePath)) firstByFile.set(entry.filePath, entry);
  }

  const report: Array<{
    filePath: string;
    action: 'restored' | 'deleted' | 'failed';
    error?: string;
  }> = [];
  for (const [filePath, entry] of firstByFile) {
    try {
      if (entry.before === null) {
        await fs.rm(filePath, { force: true });
        report.push({ filePath, action: 'deleted' });
      } else {
        await fs.mkdir(dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, entry.before, 'utf8');
        report.push({ filePath, action: 'restored' });
      }
    } catch (error) {
      report.push({
        filePath,
        action: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!report.some((r) => r.action === 'failed')) {
    bySession.set(sessionId, []);
    await persist(sessionId);
  }
  return report;
}
