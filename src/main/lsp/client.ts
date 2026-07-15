import { spawn, ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import { EventEmitter } from 'events';
import type {
  DocumentUri,
  InitializeParams,
  InitializeResult,
  LSPMessage,
  PublishDiagnosticsParams,
  Diagnostic,
  DidOpenTextDocumentParams,
  DidChangeTextDocumentParams,
  DidCloseTextDocumentParams,
} from './protocol';
import { parseJsonSafe } from '../../shared/utils/json';

export type NotificationHandler = (params: any) => void;

export class LSPClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private readline: ReturnType<typeof createInterface> | null = null;
  private nextId = 1;
  private handlers = new Map<
    number,
    { resolve: (value: any) => void; reject: (reason: any) => void }
  >();
  private notificationHandlers = new Map<string, NotificationHandler>();
  private diagnostics = new Map<DocumentUri, Diagnostic[]>();
  private openFiles = new Map<string, number>();
  private serverCapabilities: InitializeResult['capabilities'] | null = null;
  private connected = false;

  constructor(
    private command: string,
    private args: string[] = [],
  ) {
    super();
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.process = spawn(this.command, this.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.readline = createInterface({
        input: this.process.stdout!,
      });

      this.readline.on('line', (line: string) => {
        this.handleMessage(line);
      });

      this.process.on('error', (err) => {
        reject(err);
      });

      this.process.on('exit', () => {
        this.connected = false;
        this.rejectAllPending('LSP process exited');
        this.emit('exit');
      });

      this.process.stderr!.on('data', (data) => {
        console.error(`LSP Server stderr: ${data}`);
      });

      this.process.stdin?.on('error', (err) => {
        if ((err as any).code !== 'EPIPE') {
          console.error('LSP stdin error:', err);
        }
      });

      // Emit ready when process starts successfully
      this.process.on('spawn', () => {
        this.connected = true;
        this.emit('ready');
        resolve();
      });
    });
  }

  async initialize(workspaceDir: string): Promise<InitializeResult> {
    const params: InitializeParams = {
      processId: process.pid,
      clientInfo: {
        name: 'drenn',
        version: '0.0.1',
      },
      rootUri: `file://${workspaceDir}`,
      workspaceFolders: [
        {
          uri: `file://${workspaceDir}`,
          name: workspaceDir,
        },
      ],
    };

    const result = await this.request('initialize', params);
    this.serverCapabilities = result.capabilities;

    await this.notify('initialized', {});

    return result;
  }

  async shutdown(): Promise<void> {
    if (!this.connected) return;
    try {
      await this.request('shutdown', null);
      await this.notify('exit', null);
    } catch {
      // Server may already be gone
    }
    this.connected = false;
    this.process?.kill();
  }

  registerNotificationHandler(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  async openFile(
    filePath: string,
    content: string,
    languageId: string = 'typescript',
  ): Promise<void> {
    const uri = `file://${filePath}`;

    if (this.openFiles.has(uri)) {
      return;
    }

    const params: DidOpenTextDocumentParams = {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text: content,
      },
    };

    await this.notify('textDocument/didOpen', params);
    this.openFiles.set(uri, 1);
  }

  async notifyChange(filePath: string, content: string): Promise<void> {
    const uri = `file://${filePath}`;

    if (!this.openFiles.has(uri)) {
      return;
    }

    const version = this.openFiles.get(uri)! + 1;

    const params: DidChangeTextDocumentParams = {
      textDocument: {
        uri,
        version,
      },
      contentChanges: [{ text: content }],
    };

    await this.notify('textDocument/didChange', params);
    this.openFiles.set(uri, version);
  }

  async closeFile(filePath: string): Promise<void> {
    const uri = `file://${filePath}`;

    if (!this.openFiles.has(uri)) {
      return;
    }

    const params: DidCloseTextDocumentParams = {
      textDocument: { uri },
    };

    await this.notify('textDocument/didClose', params);
    this.openFiles.delete(uri);
  }

  getDiagnostics(uri?: DocumentUri): Diagnostic[] | Map<DocumentUri, Diagnostic[]> {
    if (uri) {
      return this.diagnostics.get(uri) || [];
    }
    return this.diagnostics;
  }

  async waitForDiagnostics(filePath: string, timeoutMs: number = 5000): Promise<Diagnostic[]> {
    return new Promise((resolve) => {
      const uri = `file://${filePath}`;
      const timer = setTimeout(() => {
        resolve(this.diagnostics.get(uri) || []);
      }, timeoutMs);

      const handler = (params: PublishDiagnosticsParams) => {
        if (params.uri === uri) {
          clearTimeout(timer);
          this.notificationHandlers.delete('textDocument/publishDiagnostics');
          resolve(params.diagnostics);
        }
      };

      this.notificationHandlers.set('textDocument/publishDiagnostics', handler);
    });
  }

  private async request(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const message: LSPMessage = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      this.handlers.set(id, { resolve, reject });
      this.send(message);
    });
  }

  private async notify(method: string, params: any): Promise<void> {
    const message: LSPMessage = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.send(message);
  }

  private send(message: LSPMessage): void {
    if (!this.connected || !this.process?.stdin) return;
    try {
      const content = JSON.stringify(message);
      const header = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n`;
      this.process.stdin.write(header + content);
    } catch (err) {
      if ((err as any)?.code !== 'EPIPE') {
        console.error('LSP send error:', err);
      }
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [, handler] of this.handlers) {
      handler.reject(new Error(reason));
    }
    this.handlers.clear();
  }

  private handleMessage(line: string): void {
    if (line.startsWith('Content-Length:')) {
      const contentLength = parseInt(line.slice(16), 10);
      let buffer = '';

      const onData = (chunk: Buffer) => {
        buffer += chunk.toString();
        if (buffer.length >= contentLength) {
          this.process?.stdout?.removeListener('data', onData);
          const message = parseJsonSafe(buffer.slice(0, contentLength)) as LSPMessage | undefined;
          if (message) {
            this.processMessage(message);
          } else {
            console.error('[LSP] Failed to parse message');
          }
        }
      };

      this.process?.stdout?.on('data', onData);
    }
  }

  private processMessage(message: LSPMessage): void {
    if (message.id !== undefined) {
      const handler = this.handlers.get(message.id);
      if (handler) {
        this.handlers.delete(message.id);
        if (message.error) {
          handler.reject(new Error(message.error.message));
        } else {
          handler.resolve(message.result);
        }
      }
    } else if (message.method) {
      const handler = this.notificationHandlers.get(message.method);
      if (handler) {
        if (message.method === 'textDocument/publishDiagnostics') {
          const params = message.params as PublishDiagnosticsParams;
          this.diagnostics.set(params.uri, params.diagnostics);
        }
        handler(message.params);
      }
    }
  }
}
