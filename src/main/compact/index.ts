import type { ChatMessage } from '../agent/types';
import type { LLMProvider } from '../llm/openaiClient';
import { buildSystemPrompt } from '../agent/systemPrompt';
import { DEFAULT_CONTEXT_WINDOW } from '../../shared/types';

const SUMMARIZER_SYSTEM_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions. This summary will replace the older messages, and the conversation will continue from it — so it must be thorough enough that work can resume without losing context.

Structure the summary with these sections:

## Primary Request and Intent
All of the user's explicit requests and intents, in detail.

## Key Technical Concepts
Technologies, frameworks, and technical decisions that were discussed or relied on.

## Files and Code Sections
Specific files examined, modified, or created. Include file paths, why each file matters, and (for edits) a brief note of the change made. Include short code snippets only where they are essential to continue.

## Errors and Fixes
Errors encountered and how they were fixed — including any user feedback on the fixes.

## Pending Tasks
Tasks the user explicitly asked for that are not yet done.

## Current Work
Precisely what was being worked on in the most recent messages, with file names and code where relevant.

## Next Step
The immediate next step, only if it is directly in line with the user's explicit requests. Quote the most recent instruction verbatim if it helps.

Be factual: include only information that appeared in the conversation.`;

const CONTEXT_USAGE_THRESHOLD = 0.95;
const TOOL_OUTPUT_MAX_CHARS = 2000;
const KEEP_RECENT_MESSAGES = 10;

export interface CompactResult {
  summary: string;
  recent: ChatMessage[];
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export async function shouldCompact(messages: ChatMessage[], maxTokens: number): Promise<boolean> {
  const estimatedTokens = estimateTokenCount(messages);
  return estimatedTokens > maxTokens * CONTEXT_USAGE_THRESHOLD;
}

function selectMessagesForCompaction(messages: ChatMessage[]): {
  head: ChatMessage[];
  recent: ChatMessage[];
} {
  const otherMessages = messages.filter((m) => m.role !== 'system');

  const recentCount = Math.min(KEEP_RECENT_MESSAGES, otherMessages.length);
  let splitIndex = otherMessages.length - recentCount;

  while (splitIndex < otherMessages.length && otherMessages[splitIndex].role === 'tool') {
    splitIndex++;
  }

  return {
    head: otherMessages.slice(0, splitIndex),
    recent: otherMessages.slice(splitIndex),
  };
}

function serializeMessage(msg: ChatMessage): string {
  const parts: string[] = [];

  let text = '';
  if (typeof msg.content === 'string') {
    text = msg.content;
  } else if (Array.isArray(msg.content)) {
    text = msg.content.map((p) => (p.type === 'text' ? p.text : '[image]')).join(' ');
  }
  if (text.length > TOOL_OUTPUT_MAX_CHARS) {
    text = `[truncated from ${text.length} chars] ${text.slice(0, TOOL_OUTPUT_MAX_CHARS)}...`;
  }
  if (text) parts.push(text);

  if (msg.role === 'assistant' && msg.tool_calls?.length) {
    for (const tc of msg.tool_calls) {
      const args =
        tc.function.arguments.length > 500
          ? `${tc.function.arguments.slice(0, 500)}…`
          : tc.function.arguments;
      parts.push(`[called ${tc.function.name}: ${args}]`);
    }
  }

  if (parts.length === 0) return '';
  const label = msg.role === 'tool' ? 'tool result' : msg.role;
  return `${label}: ${parts.join('\n')}`;
}

export async function compactConversation(
  messages: ChatMessage[],
  provider: LLMProvider,
): Promise<CompactResult> {
  const { head, recent } = selectMessagesForCompaction(messages);

  const contextForSummary = head.map(serializeMessage).filter(Boolean).join('\n\n');

  const summarizerMessages: ChatMessage[] = [
    { role: 'system', content: SUMMARIZER_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Please summarize this conversation, preserving all important context needed to continue:\n\n${contextForSummary}`,
    },
  ];

  let summary = '';
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const event of provider.streamChat(
    summarizerMessages,
    [],
    new AbortController().signal,
  )) {
    if (event.type === 'content' && event.content) {
      summary += event.content;
    } else if (event.type === 'complete' && event.usage) {
      inputTokens = event.usage.inputTokens;
      outputTokens = event.usage.outputTokens;
    }
  }

  return {
    summary,
    recent,
    tokenUsage: { inputTokens, outputTokens },
  };
}

function estimateTokenCount(messages: ChatMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += Math.ceil(msg.content.length / 4);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        const text = part.type === 'text' ? part.text : part.image_url.url;
        total += Math.ceil(text.length / 4);
      }
    }
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        total += Math.ceil((tc.function.name.length + tc.function.arguments.length) / 4);
      }
    }
  }
  return total;
}

export function estimateTokensWithTools(
  messages: ChatMessage[],
  toolDefinitions: Array<{ description?: string; parameters?: any }>,
): number {
  let total = estimateTokenCount(messages);

  for (const tool of toolDefinitions) {
    if (tool.description) {
      total += Math.ceil(tool.description.length / 4);
    }
    if (tool.parameters) {
      const paramStr = JSON.stringify(tool.parameters);
      total += Math.ceil(paramStr.length / 4);
    }
  }

  return total;
}

export async function compactIfNeeded(
  messages: ChatMessage[],
  provider: LLMProvider,
  maxTokens: number = DEFAULT_CONTEXT_WINDOW,
  toolDefinitions: Array<{ description?: string; parameters?: any }> = [],
  cwd: string = '',
  agentName?: string,
  onCompact?: () => Promise<void>,
): Promise<{ messages: ChatMessage[]; compacted: boolean; summary?: string }> {
  const estimatedTokens = estimateTokensWithTools(messages, toolDefinitions);

  if (estimatedTokens <= maxTokens * CONTEXT_USAGE_THRESHOLD) {
    return { messages, compacted: false };
  }

  try {
    await onCompact?.();
    const compactResult = await compactConversation(messages, provider);
    const compactedMessages = buildCompactSessionMessages(
      compactResult.summary,
      cwd,
      compactResult.recent,
      agentName,
    );
    return { messages: compactedMessages, compacted: true, summary: compactResult.summary };
  } catch {
    return { messages, compacted: false };
  }
}

export function buildCompactSessionMessages(
  summary: string,
  cwd: string,
  recent: ChatMessage[] = [],
  agentName?: string,
): ChatMessage[] {
  return [{ role: 'system', content: buildSystemPrompt(cwd, agentName, summary) }, ...recent];
}
