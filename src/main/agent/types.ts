import type { ToolCall, ToolResponse } from '../tools/types';
import type { TokenUsage } from '../../shared/types';

export type AgentEventType =
  | 'thinking'
  | 'content'
  | 'tool_use'
  | 'tool_result'
  | 'error'
  | 'complete'
  | 'done'
  | 'title'
  | 'system'
  | 'user_turn'
  | 'mode';

export type AgentErrorType =
  | 'provider_error'
  | 'permission_denied'
  | 'tool_not_found'
  | 'tool_execution'
  | 'context_overflow'
  | 'max_iterations'
  | 'cancelled'
  | 'unknown';

export interface AgentError {
  type: AgentErrorType;
  message: string;
  originalError?: Error;
  toolName?: string;
  retryable?: boolean;
  status?: number;
  retryAfterMs?: number;
}

export interface AgentEvent {
  type: AgentEventType;
  sessionId: string;
  messageId: string;
  content?: string;
  toolCall?: ToolCall;
  toolResult?: ToolResponse;
  error?: Error | AgentError;
  usage?: TokenUsage;
  title?: string;
}

export interface WireToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export type ContentPart =
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | ContentPart[];
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}
