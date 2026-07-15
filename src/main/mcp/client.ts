import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import type { MCPServer, MCPTool, MCPToolCall, MCPToolResult } from './types';
import { parseJsonSafe } from '../../shared/utils/json';

export class MCPClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private connected = false;
  private nextId = 1;
  private handlers = new Map<
    number,
    { resolve: (value: any) => void; reject: (reason: any) => void }
  >();
  private buffer = '';

  constructor(private config: MCPServer) {
    super();
  }

  async connect(): Promise<void> {
    if (this.config.type === 'stdio') {
      await this.connectStdio();
    } else if (this.config.type === 'sse') {
      await this.connectSSE();
    }
  }

  private async connectStdio(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.process = spawn(this.config.command, this.config.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...Object.fromEntries(
            this.config.env.map((e) => {
              const i = e.indexOf('=');
              return i > 0 ? [e.slice(0, i), e.slice(i + 1)] : [e, ''];
            }),
          ),
        },
      });

      this.process.stdout?.on('data', (data) => {
        this.buffer += data.toString();
        this.processMessages();
      });

      this.process.stdin?.on('error', (err) => {
        if ((err as any).code !== 'EPIPE') {
          console.error('MCP stdin error:', err);
        }
      });

      this.process.on('error', reject);
      this.process.on('exit', () => {
        this.connected = false;
        this.rejectAllPending('MCP process exited');
        this.emit('disconnect');
      });

      this.connected = true;
      resolve();
    });
  }

  private async connectSSE(): Promise<void> {
    // SSE connection would be implemented here
    throw new Error('SSE connection not yet implemented');
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'drenn',
        version: '0.0.1',
      },
    });

    await this.notify('notifications/initialized', {});
  }

  async listTools(): Promise<MCPTool[]> {
    const result = await this.request('tools/list', {});
    return result.tools;
  }

  async callTool(tool: MCPToolCall): Promise<MCPToolResult> {
    return await this.request('tools/call', tool);
  }

  async close(): Promise<void> {
    this.connected = false;
    this.rejectAllPending('MCP client closed');
    this.process?.kill();
    this.process = null;
  }

  private async request(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const message = {
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
    const message = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.send(message);
  }

  private send(message: any): void {
    if (!this.connected || !this.process?.stdin) return;
    try {
      const content = JSON.stringify(message);
      const header = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n`;
      this.process.stdin.write(header + content);
    } catch (err) {
      if ((err as any)?.code !== 'EPIPE') {
        console.error('MCP send error:', err);
      }
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [, handler] of this.handlers) {
      handler.reject(new Error(reason));
    }
    this.handlers.clear();
  }

  private processMessages(): void {
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const header = this.buffer.slice(0, headerEnd);
      const contentLengthMatch = header.match(/Content-Length: (\d+)/);
      if (!contentLengthMatch) break;

      const contentLength = parseInt(contentLengthMatch[1], 10);
      const messageStart = headerEnd + 4;

      if (this.buffer.length < messageStart + contentLength) break;

      const content = this.buffer.slice(messageStart, messageStart + contentLength);
      this.buffer = this.buffer.slice(messageStart + contentLength);

      try {
        const message = parseJsonSafe(content);
        if (message && typeof message === 'object') {
          if ((message as any).id !== undefined) {
            const handler = this.handlers.get((message as any).id);
            if (handler) {
              this.handlers.delete((message as any).id);
              if ((message as any).error) {
                handler.reject(new Error((message as any).error.message));
              } else {
                handler.resolve((message as any).result);
              }
            }
          } else {
            this.emit('notification', message);
          }
        } else {
          console.error('[MCP] Failed to parse message');
        }
      } catch (err) {
        console.error('Failed to parse MCP message:', err);
      }
    }
  }
}
