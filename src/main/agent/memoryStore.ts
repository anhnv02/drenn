import { promises as fs } from 'fs';
import { join, resolve, sep } from 'path';
import { MEMORY_DIR } from '../config/paths';

const MEMORY_TTL_MS = 15_000;
const MAX_MEMORY_LENGTH = 8_000;
const MEMORY_INDEX_FILE = 'MEMORY.md';

const memoryCache = new Map<string, { content: string; loadedAt: number }>();

export function cwdToProjectKey(cwd: string): string {
  const resolved = resolve(cwd);
  return resolved.split(sep).join('-').replace(/:/g, '') || '-';
}

export function projectMemoryDir(cwd: string): string {
  return join(MEMORY_DIR, cwdToProjectKey(cwd));
}

export async function loadProjectMemory(cwd: string): Promise<string> {
  const cached = memoryCache.get(cwd);
  if (cached && Date.now() - cached.loadedAt < MEMORY_TTL_MS) {
    return cached.content;
  }

  let content = '';
  try {
    const text = (await fs.readFile(join(projectMemoryDir(cwd), MEMORY_INDEX_FILE), 'utf8')).trim();
    content =
      text.length > MAX_MEMORY_LENGTH
        ? text.slice(0, MAX_MEMORY_LENGTH) + '\n... [truncated]'
        : text;
  } catch {
    content = '';
  }

  memoryCache.set(cwd, { content, loadedAt: Date.now() });
  return content;
}

export function getCachedMemory(cwd: string): string {
  return memoryCache.get(cwd)?.content ?? '';
}

export function invalidateProjectMemory(cwd: string): void {
  memoryCache.delete(cwd);
}
