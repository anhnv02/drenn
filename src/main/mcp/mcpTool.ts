import type { BaseTool, ExecutionContext, ToolCall, ToolInfo, ToolResponse } from '../tools/types';
import { MCPClient } from './client';
import type { MCPTool, MCPServer } from './types';
import { deniedToolResult, type PermissionService } from '../permission';
import { parseToolInput } from '../../shared/utils/json';

export class MCPToolWrapper implements BaseTool {
  private client: MCPClient;
  private tool: MCPTool;
  private serverConfig: MCPServer;
  private permissions: PermissionService;
  private connected = false;

  constructor(
    tool: MCPTool,
    serverName: string,
    serverConfig: MCPServer,
    permissions: PermissionService,
  ) {
    this.tool = tool;
    this.serverConfig = serverConfig;
    this.permissions = permissions;
    this.client = new MCPClient(serverConfig);
  }

  private async ensureConnected(): Promise<void> {
    if (!this.connected) {
      await this.client.connect();
      await this.client.initialize();
      this.connected = true;
    }
  }

  info(): ToolInfo {
    const required = this.tool.inputSchema.required || [];
    return {
      name: `mcp_${this.tool.name}`,
      description: this.tool.description,
      parameters: this.tool.inputSchema.properties,
      required,
    };
  }

  async run(ctx: ExecutionContext, call: ToolCall): Promise<ToolResponse> {
    const sessionID = ctx.sessionId;
    const messageID = ctx.messageId;

    // Request permission ('bypassPermissions' auto-approves MCP calls)
    if (ctx.mode !== 'bypassPermissions') {
      const permissionDescription = `execute ${this.info().name} with the following parameters: ${call.input}`;
      const decision = await this.permissions.request({
        id: call.id,
        sessionId: sessionID,
        messageId: messageID,
        toolName: this.info().name,
        action: 'execute',
        description: permissionDescription,
        params: parseToolInput(call.input),
        resource: '',
        cwd: ctx.cwd,
      });

      if (!decision.approved) {
        return { content: deniedToolResult(decision.feedback), isError: true };
      }
    }

    try {
      await this.ensureConnected();

      const args = parseToolInput(call.input) as Record<string, unknown>;
      const result = await this.client.callTool({
        name: this.tool.name,
        arguments: args,
      });

      const output = result.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');

      return { content: output, isError: result.isError || false };
    } catch (error) {
      // Reset connection state on error so next call reconnects
      this.connected = false;
      return {
        content: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
