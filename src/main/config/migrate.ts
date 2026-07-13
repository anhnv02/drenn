import { promises as fs } from 'fs';
import { join } from 'path';
import { DRENN_DIR, MCP_CONFIG_FILE, SETTINGS_FILE, PROVIDERS_FILE } from './paths';

export async function migrateAll(): Promise<void> {
  await fs.mkdir(DRENN_DIR, { recursive: true });

  await Promise.all([migrateMCP(), migrateSettings(), migrateProviders()]);
}

async function migrateMCP(): Promise<void> {
  try {
    await fs.access(MCP_CONFIG_FILE);
    return;
  } catch {
    // not yet
  }

  try {
    const settingsPath = join(
      process.env.HOME ?? '',
      'Library',
      'Application Support',
      'drenn',
      'settings.json',
    );
    const raw = await fs.readFile(settingsPath, 'utf8');
    const data = JSON.parse(raw);
    const servers = data.mcpServers ?? {};
    if (Object.keys(servers).length > 0) {
      await fs.writeFile(MCP_CONFIG_FILE, JSON.stringify(servers, null, 2), 'utf8');
      console.log(`Migrated MCP servers from electron-store to ${MCP_CONFIG_FILE}`);
    }
  } catch {
    // no legacy data — fine
  }
}

async function migrateSettings(): Promise<void> {
  try {
    await fs.access(SETTINGS_FILE);
    return;
  } catch {
    // not yet
  }

  try {
    const settingsPath = join(
      process.env.HOME ?? '',
      'Library',
      'Application Support',
      'drenn',
      'settings.json',
    );
    const raw = await fs.readFile(settingsPath, 'utf8');
    const data = JSON.parse(raw);
    const settings = {
      selectedModel: data.selectedModel ?? null,
      xiaomiApiKey: data.xiaomiApiKey ?? '',
      lsp: data.lsp ?? {},
      permissionPatterns: data.permissionPatterns ?? [],
      hooks: data.hooks ?? {},
    };
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
    console.log(`Migrated settings from electron-store to ${SETTINGS_FILE}`);
  } catch {
    // no legacy data
  }
}

async function migrateProviders(): Promise<void> {
  try {
    await fs.access(PROVIDERS_FILE);
    return;
  } catch {
    // not yet
  }

  try {
    const providersPath = join(
      process.env.HOME ?? '',
      'Library',
      'Application Support',
      'drenn',
      'providers.json',
    );
    const raw = await fs.readFile(providersPath, 'utf8');
    const data = JSON.parse(raw);
    const providers = data.providers ?? [];
    await fs.writeFile(PROVIDERS_FILE, JSON.stringify(providers, null, 2), 'utf8');
    console.log(`Migrated providers from electron-store to ${PROVIDERS_FILE}`);
  } catch {
    // no legacy data
  }
}
