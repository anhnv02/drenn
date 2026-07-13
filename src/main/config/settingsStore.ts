import { promises as fs } from 'fs';
import type { SelectedModel, PermissionPatternRule } from '../../shared/types';
import type { MCPServer } from '../mcp/types';
import { SETTINGS_FILE, MCP_CONFIG_FILE, DRENN_DIR } from './paths';

export interface LSPServerConfig {
  command: string;
  args?: string[];
  disabled?: boolean;
}

// Lifecycle hook definitions (see src/main/hooks/index.ts for semantics).
export interface HookDefConfig {
  matcher?: string;
  command: string;
  timeout?: number;
}

export interface SettingsData {
  selectedModel: SelectedModel | null;
  xiaomiApiKey: string;
  lsp: Record<string, LSPServerConfig>;
  permissionPatterns: PermissionPatternRule[];
  hooks: Record<string, HookDefConfig[]>;
}

const DEFAULT_SETTINGS: SettingsData = {
  selectedModel: null,
  xiaomiApiKey: '',
  permissionPatterns: [],
  hooks: {},
  lsp: {
    typescript: {
      command: 'typescript-language-server',
      args: ['--stdio'],
      disabled: false,
    },
    javascript: {
      command: 'typescript-language-server',
      args: ['--stdio'],
      disabled: false,
    },
    go: {
      command: 'gopls',
      args: [],
      disabled: false,
    },
    python: {
      command: 'pylsp',
      args: [],
      disabled: false,
    },
    rust: {
      command: 'rust-analyzer',
      args: [],
      disabled: false,
    },
  },
};

// ── Plain-JSON read/write helpers ──

let settingsCache: SettingsData | undefined;

async function readSettingsFile(): Promise<SettingsData> {
  if (settingsCache) return settingsCache;
  try {
    const raw = await fs.readFile(SETTINGS_FILE, 'utf8');
    settingsCache = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    settingsCache = { ...DEFAULT_SETTINGS };
  }
  return settingsCache!;
}

function readSettingsFileSync(): SettingsData {
  if (settingsCache) return settingsCache;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fsSync = require('fs');
    const raw = fsSync.readFileSync(SETTINGS_FILE, 'utf8');
    settingsCache = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    settingsCache = { ...DEFAULT_SETTINGS };
  }
  return settingsCache!;
}

async function writeSettingsFile(data: SettingsData): Promise<void> {
  await fs.mkdir(DRENN_DIR, { recursive: true });
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf8');
  settingsCache = data;
}

function writeSettingsFileSync(data: SettingsData): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsSync = require('fs');
  fsSync.mkdirSync(DRENN_DIR, { recursive: true });
  fsSync.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf8');
  settingsCache = data;
}

// ── Individual settings accessors ──

export function readSelectedModel(): SelectedModel | null {
  return readSettingsFileSync().selectedModel;
}

export function writeSelectedModel(selected: SelectedModel | null): void {
  const data = readSettingsFileSync();
  data.selectedModel = selected;
  writeSettingsFileSync(data);
}

export function readXiaomiApiKey(): string {
  return readSettingsFileSync().xiaomiApiKey;
}

export function writeXiaomiApiKey(apiKey: string): void {
  const data = readSettingsFileSync();
  data.xiaomiApiKey = apiKey;
  writeSettingsFileSync(data);
}

export function readLSPConfig(): Record<string, LSPServerConfig> {
  return readSettingsFileSync().lsp;
}

export function writeLSPConfig(lsp: Record<string, LSPServerConfig>): void {
  const data = readSettingsFileSync();
  data.lsp = lsp;
  writeSettingsFileSync(data);
}

export function getLSPConfigForLanguage(language: string): LSPServerConfig | null {
  const lsp = readLSPConfig();
  const config = lsp[language];
  if (config && !config.disabled) {
    return config;
  }
  return null;
}

export function readHooks(): Record<string, HookDefConfig[]> {
  return readSettingsFileSync().hooks;
}

export function writeHooks(hooks: Record<string, HookDefConfig[]>): void {
  const data = readSettingsFileSync();
  data.hooks = hooks;
  writeSettingsFileSync(data);
}

export function readPermissionPatterns(): PermissionPatternRule[] {
  return readSettingsFileSync().permissionPatterns;
}

export function writePermissionPatterns(patterns: PermissionPatternRule[]): void {
  const data = readSettingsFileSync();
  data.permissionPatterns = patterns;
  writeSettingsFileSync(data);
}

// ── MCP servers (stored in separate file ~/.config/drenn/mcp.json) ──

let mcpConfigCache: Record<string, MCPServer> | undefined;

export async function readMCPServers(): Promise<Record<string, MCPServer>> {
  if (mcpConfigCache !== undefined) return mcpConfigCache;
  try {
    const raw = await fs.readFile(MCP_CONFIG_FILE, 'utf8');
    mcpConfigCache = JSON.parse(raw) as Record<string, MCPServer>;
  } catch {
    mcpConfigCache = {};
  }
  return mcpConfigCache;
}

export async function writeMCPServers(servers: Record<string, MCPServer>): Promise<void> {
  await fs.mkdir(DRENN_DIR, { recursive: true });
  await fs.writeFile(MCP_CONFIG_FILE, JSON.stringify(servers, null, 2), 'utf8');
  mcpConfigCache = servers;
}
