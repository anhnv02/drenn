import { promises as fs } from 'fs';
import { randomUUID } from 'node:crypto';
import type { Provider } from '../../shared/types';
import { PROVIDERS_FILE, DRENN_DIR } from './paths';
import { parseJsonSafe } from '../../shared/utils/json';

let providersCache: Provider[] | undefined;

function normalizeProviders(providers: Provider[]): Provider[] {
  return providers.map((p) => ({
    ...p,
    models: p.models.map((m) => ({
      ...m,
      maxTokens: m.maxTokens ?? (m as any).maxOutputTokens ?? (m as any).maxInputTokens ?? 8192,
    })),
  }));
}

async function readProvidersFile(): Promise<Provider[]> {
  if (providersCache) return providersCache;
  try {
    const raw = await fs.readFile(PROVIDERS_FILE, 'utf8');
    const parsed = parseJsonSafe(raw);
    providersCache = Array.isArray(parsed) ? normalizeProviders(parsed) : [];
  } catch {
    providersCache = [];
  }
  return providersCache;
}

function readProvidersFileSync(): Provider[] {
  if (providersCache) return providersCache;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fsSync = require('fs');
    const raw = fsSync.readFileSync(PROVIDERS_FILE, 'utf8');
    const parsed = parseJsonSafe(raw);
    providersCache = Array.isArray(parsed) ? normalizeProviders(parsed) : [];
  } catch {
    providersCache = [];
  }
  return providersCache;
}

function writeProvidersFileSync(providers: Provider[]): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsSync = require('fs');
  fsSync.mkdirSync(DRENN_DIR, { recursive: true });
  fsSync.writeFileSync(PROVIDERS_FILE, JSON.stringify(providers, null, 2), 'utf8');
  providersCache = providers;
}

export function readProviders(): Provider[] {
  return readProvidersFileSync();
}

export function writeProviders(providers: Provider[]): Provider[] {
  const withIds = providers.map((p) => ({ ...p, id: p.id || randomUUID() }));
  writeProvidersFileSync(withIds);
  return withIds;
}
