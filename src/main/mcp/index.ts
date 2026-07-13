export { MCPClient } from './client';
export { MCPToolWrapper } from './mcpTool';
export type { MCPServer, MCPTool, MCPToolCall, MCPToolResult } from './types';

import type { BaseTool } from '../tools/types';
import type { PermissionService } from '../permission';
import type { MCPServer } from './types';
import { MCPClient } from './client';
import { MCPToolWrapper } from './mcpTool';

export async function loadMCPTools(
  servers: Record<string, MCPServer>,
  permissions: PermissionService,
): Promise<BaseTool[]> {
  const tools: BaseTool[] = [];

  for (const [name, config] of Object.entries(servers)) {
    try {
      const client = new MCPClient(config);
      await client.connect();
      await client.initialize();

      const mcpTools = await client.listTools();
      for (const tool of mcpTools) {
        tools.push(new MCPToolWrapper(tool, name, config, permissions));
      }

      await client.close();
    } catch (error) {
      console.error(`Failed to load MCP tools from ${name}:`, error);
    }
  }

  return tools;
}
