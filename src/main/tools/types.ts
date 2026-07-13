import type { PermissionService } from '../permission';
import type { AgentMode } from '../../shared/types';

export interface ToolInfo {
  name: string;
  description: string;
  parameters: Record<string, any>;
  required: string[];
}

export interface ToolCall {
  id: string;
  name: string;
  input: string;
}

export interface ToolResponse {
  content: string;
  isError: boolean;
  metadata?: Record<string, any>;
}

export interface ExecutionContext {
  sessionId: string;
  messageId: string;
  cwd: string;
  permissions: PermissionService;
  mode: AgentMode;
  abortSignal?: AbortSignal;
}

export interface BaseTool {
  info(): ToolInfo;
  run(ctx: ExecutionContext, call: ToolCall): Promise<ToolResponse>;
}
