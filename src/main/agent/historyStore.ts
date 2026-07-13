import { promises as fs } from 'fs';
import { join } from 'path';
import type { ChatMessage } from './types';
import { HISTORY_DIR } from '../config/paths';

function isPersistable(sessionId: string): boolean {
  return !sessionId.includes(':sub:');
}

function historyFile(sessionId: string): string {
  return join(HISTORY_DIR, `${encodeURIComponent(sessionId)}.json`);
}

export async function saveMessageHistory(
  sessionId: string,
  messages: ChatMessage[],
): Promise<void> {
  if (!isPersistable(sessionId) || messages.length === 0) return;
  try {
    await fs.mkdir(HISTORY_DIR, { recursive: true });
    await fs.writeFile(historyFile(sessionId), JSON.stringify(messages), 'utf8');
  } catch {
    // Persistence must never break the run itself
  }
}

export async function loadMessageHistory(sessionId: string): Promise<ChatMessage[] | null> {
  if (!isPersistable(sessionId)) return null;
  try {
    const raw = await fs.readFile(historyFile(sessionId), 'utf8');
    const messages = JSON.parse(raw) as ChatMessage[];
    return Array.isArray(messages) && messages.length > 0 ? messages : null;
  } catch {
    return null;
  }
}

export async function deleteMessageHistory(sessionId: string): Promise<void> {
  try {
    await fs.rm(historyFile(sessionId), { force: true });
  } catch {
    // best-effort cleanup
  }
}
