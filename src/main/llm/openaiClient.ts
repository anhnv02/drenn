import type { ChatMessage, AgentEvent, TokenUsage } from '../agent/types';
import type { BaseTool } from '../tools/types';
import type { Provider, SelectedModel } from '../../shared/types';

export interface SamplingOptions {
  topP?: number;
  temperature?: number;
  maxTokens?: number;
}

export interface LLMProvider {
  streamChat(
    messages: ChatMessage[],
    tools?: BaseTool[],
    signal?: AbortSignal,
    sampling?: SamplingOptions,
  ): AsyncGenerator<AgentEvent>;
  contextWindow?: number;
}

function extractErrorMessage(body: string): string {
  const trimmed = body.trim();
  try {
    const parsed = JSON.parse(trimmed);
    const inner = parsed?.error ?? parsed;
    if (typeof inner === 'string' && inner) return inner;
    if (typeof inner?.message === 'string' && inner.message) return inner.message;
  } catch {
    // not JSON
  }
  return trimmed;
}

const STREAM_IDLE_TIMEOUT_MS = 180_000;

export class ApiError extends Error {
  status: number;
  retryAfterMs?: number;
  constructor(status: number, body: string, retryAfterHeader: string | null) {
    super(extractErrorMessage(body) || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    const seconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
    this.retryAfterMs = Number.isFinite(seconds) ? seconds * 1000 : undefined;
  }
}

interface StreamChunk {
  choices: Array<{
    delta: {
      content?: string;
      reasoning_content?: string;
      reasoning?: string;
      tool_calls?: Array<{
        id: string;
        index: number;
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_tokens_details?: {
      cached_tokens: number;
    };
  };
}

export class OpenAICompatibleProvider implements LLMProvider {
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private extraHeaders: Record<string, string>;
  private maxTokens: number | undefined;
  private temperature: number | undefined;
  private topP: number | undefined;
  private streaming: boolean;

  constructor(
    baseUrl: string,
    apiKey: string,
    model: string,
    extraHeaders: Record<string, string> = {},
    maxTokens?: number,
    temperature?: number,
    topP?: number,
    streaming?: boolean,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.model = model;
    this.extraHeaders = extraHeaders;
    this.maxTokens = maxTokens;
    this.temperature = temperature;
    this.topP = topP;
    this.streaming = streaming ?? true;
  }

  async *streamChat(
    messages: ChatMessage[],
    tools?: BaseTool[],
    signal?: AbortSignal,
    sampling?: SamplingOptions,
  ): AsyncGenerator<AgentEvent> {
    const toolDefinitions = tools?.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.info().name,
        description: tool.info().description,
        parameters: tool.info().parameters,
      },
    }));

    let response: Response;
    try {
      const body: Record<string, unknown> = {
        model: this.model,
        messages,
        tools: toolDefinitions && toolDefinitions.length > 0 ? toolDefinitions : undefined,
        stream: this.streaming,
      };
      const temperature = sampling?.temperature ?? this.temperature;
      const topP = sampling?.topP ?? this.topP;
      const maxTokens = sampling?.maxTokens ?? this.maxTokens;
      if (temperature !== undefined) body.temperature = temperature;
      if (topP !== undefined) body.top_p = topP;
      if (maxTokens !== undefined) body.max_tokens = maxTokens;

      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          ...this.extraHeaders,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      yield {
        type: 'error',
        sessionId: '',
        messageId: '',
        error: error instanceof Error ? error : new Error(String(error)),
      };
      return;
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      yield {
        type: 'error',
        sessionId: '',
        messageId: '',
        error: new ApiError(response.status, errorBody, response.headers.get('retry-after')),
      };
      return;
    }

    if (!this.streaming) {
      const raw = (await response.json()) as Record<string, unknown>;
      const data = raw as {
        choices?: Array<{
          message?: {
            content?: string;
            tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
          };
        }>;
        error?: { message?: string; type?: string; code?: string | number };
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const msgId = `msg-${Date.now()}`;
      if (data.error) {
        yield {
          type: 'error',
          sessionId: '',
          messageId: msgId,
          error: new Error(
            `Provider stream error: ${data.error.message || data.error.type || JSON.stringify(data.error)}`,
          ),
        };
        return;
      }
      const choice = data.choices?.[0];
      if (choice?.message?.content) {
        yield {
          type: 'content',
          sessionId: '',
          messageId: msgId,
          content: choice.message.content,
        };
      }
      if (choice?.message?.tool_calls) {
        for (const tc of choice.message.tool_calls) {
          yield {
            type: 'tool_use',
            sessionId: '',
            messageId: msgId,
            toolCall: { id: tc.id, name: tc.function.name, input: tc.function.arguments },
          };
        }
      }
      yield {
        type: 'complete',
        sessionId: '',
        messageId: msgId,
        usage: {
          inputTokens: data.usage?.prompt_tokens ?? 0,
          outputTokens: data.usage?.completion_tokens ?? 0,
        },
      };
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      yield {
        type: 'error',
        sessionId: '',
        messageId: '',
        error: new Error('No response body'),
      };
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let messageId = '';
    const toolCallBuffers = new Map<number, { id: string; name: string; arguments: string }>();
    let completed = false;

    while (true) {
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const read = await Promise.race([
        reader.read(),
        new Promise<'idle-timeout'>((resolve) => {
          idleTimer = setTimeout(() => resolve('idle-timeout'), STREAM_IDLE_TIMEOUT_MS);
        }),
      ]).finally(() => clearTimeout(idleTimer));

      if (read === 'idle-timeout') {
        reader.cancel().catch(() => {});
        yield {
          type: 'error',
          sessionId: '',
          messageId,
          error: new Error(
            `Provider stream stalled: no data received for ${STREAM_IDLE_TIMEOUT_MS / 1000}s`,
          ),
        };
        return;
      }

      const { done, value } = read;
      if (done) break;

      const decoded = decoder.decode(value, { stream: true });
      buffer += decoded;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();

        if (data === '[DONE]') {
          // Check for cached tokens
          return;
        }

        try {
          const parsed: StreamChunk & {
            error?: { message?: string; type?: string; code?: string | number };
          } = JSON.parse(data);

          if (parsed.error) {
            yield {
              type: 'error',
              sessionId: '',
              messageId,
              error: new Error(
                String(
                  parsed.error.message ||
                    parsed.error.code ||
                    parsed.error.type ||
                    JSON.stringify(parsed.error),
                ),
              ),
            };
            return;
          }

          const choice = parsed.choices[0];

          if (!choice) continue;

          const reasoningDelta = choice.delta.reasoning_content ?? choice.delta.reasoning;
          if (reasoningDelta) {
            if (!messageId) messageId = `msg-${Date.now()}`;
            yield {
              type: 'thinking',
              sessionId: '',
              messageId,
              content: reasoningDelta,
            };
          }

          // Handle content
          if (choice.delta.content) {
            if (!messageId) messageId = `msg-${Date.now()}`;
            yield {
              type: 'content',
              sessionId: '',
              messageId,
              content: choice.delta.content,
            };
          }

          // Handle tool calls
          if (choice.delta.tool_calls) {
            for (const toolCall of choice.delta.tool_calls) {
              const index = toolCall.index;

              if (!toolCallBuffers.has(index)) {
                toolCallBuffers.set(index, {
                  id: toolCall.id || `tc-${Date.now()}-${index}`,
                  name: '',
                  arguments: '',
                });
              }

              const buffer = toolCallBuffers.get(index)!;
              if (toolCall.id) buffer.id = toolCall.id;
              if (toolCall.function.name) buffer.name = toolCall.function.name;
              if (toolCall.function.arguments) buffer.arguments += toolCall.function.arguments;

              // Emit partial tool use event
              if (!messageId) messageId = `msg-${Date.now()}`;
              yield {
                type: 'tool_use',
                sessionId: '',
                messageId,
                toolCall: {
                  id: buffer.id,
                  name: buffer.name,
                  input: buffer.arguments,
                },
              };
            }
          }

          // Handle completion
          if (choice.finish_reason && !completed) {
            completed = true;
            const usage: TokenUsage = {
              inputTokens: parsed.usage?.prompt_tokens || 0,
              outputTokens: parsed.usage?.completion_tokens || 0,
              cacheReadTokens: parsed.usage?.prompt_tokens_details?.cached_tokens,
            };

            yield {
              type: 'complete',
              sessionId: '',
              messageId,
              usage,
            };
          }
        } catch {
          // Skip invalid JSON lines
        }
      }
    }
  }
}

const ZEN_BASE_URL = 'https://opencode.ai/zen/v1';
export const BUILTIN_PROVIDER_ID = '__builtin__';
export const BUILTIN_PROVIDER_NAME = 'opencode zen';
export const BUILTIN_MODELS = [
  { id: 'mimo-v2.5-free', name: 'MiMo v2.5 (free)' },
  { id: 'deepseek-v4-flash-free', name: 'DeepSeek v4 Flash (free)' },
] as const;

const XIAOMI_BASE_URL = 'https://api.xiaomimimo.com/v1';
export const XIAOMI_PROVIDER_ID = '__xiaomi__';
export const XIAOMI_PROVIDER_NAME = 'Xiaomi MiMo';
export const XIAOMI_MODELS = [
  { id: 'mimo-v2.5-pro', name: 'MiMo v2.5 Pro' },
  { id: 'mimo-v2.5', name: 'MiMo v2.5' },
] as const;

export const DEFAULT_PROVIDER = new OpenAICompatibleProvider(ZEN_BASE_URL, '', 'mimo-v2.5-free');

export function createProviderFromConfig(config: {
  baseUrl: string;
  apiKey: string;
  model: string;
  headers?: Record<string, string>;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  streaming?: boolean;
}): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider(
    config.baseUrl,
    config.apiKey,
    config.model,
    config.headers,
    config.maxTokens,
    config.temperature,
    config.topP,
    config.streaming,
  );
}

function stripChatCompletionsPath(url: string): string {
  return url.replace(/\/chat\/completions\/?$/, '');
}

export function resolveConfiguredProvider(
  providers: Provider[],
  selected?: SelectedModel | null,
  xiaomiApiKey?: string,
): OpenAICompatibleProvider {
  if (selected?.providerId === BUILTIN_PROVIDER_ID) {
    if (BUILTIN_MODELS.some((m) => m.id === selected.modelId)) {
      return new OpenAICompatibleProvider(ZEN_BASE_URL, '', selected.modelId);
    }
  } else if (selected?.providerId === XIAOMI_PROVIDER_ID) {
    if (XIAOMI_MODELS.some((m) => m.id === selected.modelId) && xiaomiApiKey) {
      return new OpenAICompatibleProvider(XIAOMI_BASE_URL, xiaomiApiKey, selected.modelId);
    }
  } else if (selected) {
    const provider = providers.find((p) => p.id === selected.providerId);
    const model = provider?.models.find((m) => m.id === selected.modelId);
    if (provider && provider.apiType === 'chat-completions' && model?.toolCalling) {
      return createProviderFromConfig({
        baseUrl: stripChatCompletionsPath(model.url),
        apiKey: provider.apiKey,
        model: model.id,
        headers: model.requestHeaders,
        maxTokens: model.maxTokens,
        temperature: model.temperature,
        topP: model.topP,
        streaming: model.streaming,
      });
    }
  }
  for (const provider of providers) {
    if (provider.apiType !== 'chat-completions') continue;
    const model = provider.models.find((m) => m.toolCalling);
    if (!model) continue;
    return createProviderFromConfig({
      baseUrl: stripChatCompletionsPath(model.url),
      apiKey: provider.apiKey,
      model: model.id,
      headers: model.requestHeaders,
      maxTokens: model.maxTokens,
      temperature: model.temperature,
      topP: model.topP,
      streaming: model.streaming,
    });
  }
  return DEFAULT_PROVIDER;
}

export function resolveProviderForModel(
  modelId: string,
  providers: Provider[],
  selected?: SelectedModel | null,
  xiaomiApiKey?: string,
): OpenAICompatibleProvider {
  if (selected?.modelId === modelId) {
    return resolveConfiguredProvider(providers, selected, xiaomiApiKey);
  }
  for (const provider of providers) {
    if (provider.apiType !== 'chat-completions') continue;
    const model = provider.models.find((m) => m.id === modelId && m.toolCalling);
    if (model) {
      return createProviderFromConfig({
        baseUrl: stripChatCompletionsPath(model.url),
        apiKey: provider.apiKey,
        model: model.id,
        headers: model.requestHeaders,
        maxTokens: model.maxTokens,
        temperature: model.temperature,
        topP: model.topP,
        streaming: model.streaming,
      });
    }
  }
  if (BUILTIN_MODELS.some((m) => m.id === modelId)) {
    return new OpenAICompatibleProvider(ZEN_BASE_URL, '', modelId);
  }
  if (XIAOMI_MODELS.some((m) => m.id === modelId) && xiaomiApiKey) {
    return new OpenAICompatibleProvider(XIAOMI_BASE_URL, xiaomiApiKey, modelId);
  }
  return resolveConfiguredProvider(providers, selected, xiaomiApiKey);
}
