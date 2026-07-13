import { LSPClient } from './client';
import { getLSPConfigForLanguage, type LSPServerConfig } from '../config/settingsStore';

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.go': 'go',
  '.py': 'python',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.scala': 'scala',
  '.hs': 'haskell',
  '.lua': 'lua',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'zsh',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.xml': 'xml',
  '.html': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.md': 'markdown',
};

export class LSPManager {
  private clients = new Map<string, LSPClient>();
  private starting = new Map<string, Promise<LSPClient | null>>();
  private workspaceDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  async setWorkspaceDir(workspaceDir: string): Promise<boolean> {
    if (this.workspaceDir === workspaceDir) return false;
    this.workspaceDir = workspaceDir;
    await this.closeAll();
    return true;
  }

  getLanguageFromFilePath(filePath: string): string | null {
    const ext = '.' + filePath.split('.').pop()?.toLowerCase();
    return EXTENSION_TO_LANGUAGE[ext] || null;
  }

  async getClientForFile(filePath: string): Promise<LSPClient | null> {
    const language = this.getLanguageFromFilePath(filePath);
    if (!language) {
      return null;
    }

    return this.getClientForLanguage(language);
  }

  async getClientForLanguage(language: string): Promise<LSPClient | null> {
    if (this.clients.has(language)) {
      return this.clients.get(language)!;
    }

    if (this.starting.has(language)) {
      return this.starting.get(language)!;
    }

    const config = getLSPConfigForLanguage(language);
    if (!config) {
      return null;
    }

    return this.startClient(language, config);
  }

  private async startClient(language: string, config: LSPServerConfig): Promise<LSPClient | null> {
    const startPromise = this.doStartClient(language, config);
    this.starting.set(language, startPromise);

    try {
      const client = await startPromise;
      this.starting.delete(language);
      return client;
    } catch (err) {
      this.starting.delete(language);
      console.error(`Failed to start LSP for ${language}:`, err);
      return null;
    }
  }

  private async doStartClient(language: string, config: LSPServerConfig): Promise<LSPClient> {
    const client = new LSPClient(config.command, config.args || []);

    await client.start();

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`LSP server ${language} failed to start within 10s`));
      }, 10000);

      client.once('ready', () => {
        clearTimeout(timeout);
        resolve();
      });

      client.once('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      if (client['process'] && !client['process'].killed) {
        clearTimeout(timeout);
        resolve();
      }
    });

    await client.initialize(this.workspaceDir);
    this.clients.set(language, client);

    console.log(`LSP server started: ${language} (${config.command})`);
    return client;
  }

  getAllClients(): Map<string, LSPClient> {
    return this.clients;
  }

  async closeAll(): Promise<void> {
    for (const [language, client] of this.clients) {
      try {
        await client.shutdown();
        console.log(`LSP server closed: ${language}`);
      } catch (err) {
        console.error(`Error closing LSP ${language}:`, err);
      }
    }
    this.clients.clear();
  }
}
