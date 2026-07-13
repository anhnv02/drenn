import type { BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc';
import type { ChatMessage, AgentEvent, AgentError, TokenUsage } from './types';
import type { BaseTool, ExecutionContext, ToolCall, ToolResponse } from '../tools/types';
import type { LLMProvider } from '../llm/openaiClient';
import { ApiError, resolveConfiguredProvider, resolveProviderForModel } from '../llm/openaiClient';
import {
  permissionService,
  setPermissionWindow,
  evaluatePermission,
  fromConfig,
} from '../permission';
import { createAllTools } from '../tools';
import { toolOutputStore } from '../tools/outputStore';
import { readProviders } from '../config/providerStore';
import { readSelectedModel, readXiaomiApiKey } from '../config/settingsStore';
import type { AgentMode } from '../../shared/types';
import type { LSPClient } from '../lsp/client';
import { LSPManager } from '../lsp/manager';
import type { MCPServer } from '../mcp/types';
import { loadMCPTools, MCPToolWrapper } from '../mcp';
import {
  compactConversation,
  buildCompactSessionMessages,
  compactIfNeeded,
  DEFAULT_CONTEXT_WINDOW,
} from '../compact';
import { clearFileReads } from '../tools/edit';
import { generateTitle } from './titleGenerator';
import { initRegistry, getAgent } from './subagent/registry';
import { sessionManager } from './subagent/sessions';
import { TextToolCallFilter } from './textToolCall';
import { buildSystemPrompt, loadProjectInstructions, loadGitContext } from './systemPrompt';
import { refreshProjectAgents } from './subagent';
import { loadProjectMemory } from './memoryStore';
import { refreshProjectSkills } from '../skills';
import { runHooks } from '../hooks';
import { saveMessageHistory, loadMessageHistory, deleteMessageHistory } from './historyStore';
import { importExternalHistory } from './externalImport';
import { isContinuableSession } from '../session/continuations';
import type { SubAgentConfig } from './subagent/types';
let mainWindow: BrowserWindow | null = null;
let lspManager: LSPManager | null = null;
const TOOL_ALIASES: Record<string, string> = {
  webfetch: 'fetch',
  web_fetch: 'fetch',
  read: 'view',
  read_file: 'view',
  list: 'ls',
  list_dir: 'ls',
  patch: 'applyPatch',
  apply_patch: 'applyPatch',
  todo_write: 'todowrite',
};
const MUTATING_TOOL_NAMES = new Set(['edit', 'write', 'applyPatch']);
function resolveTool(tools: BaseTool[], name: string): BaseTool | undefined {
  const lower = name.toLowerCase();
  return (
    tools.find((t) => t.info().name === name) ??
    tools.find((t) => t.info().name.toLowerCase() === lower) ??
    tools.find((t) => t.info().name === TOOL_ALIASES[lower])
  );
}
function matchesAny(text: string, ...patterns: string[]): boolean {
  return patterns.some((p) => text.includes(p));
}
type ErrorCategory =
  'rate_limit' | 'auth' | 'network' | 'context_overflow' | 'permission_denied' | 'tool_not_found';
function classifyErrorCategory(lowerMessage: string): ErrorCategory | undefined {
  if (matchesAny(lowerMessage, 'rate limit', '429')) return 'rate_limit';
  if (matchesAny(lowerMessage, 'unauthorized', '401', 'api key')) return 'auth';
  if (matchesAny(lowerMessage, 'timeout', 'network', 'fetch')) return 'network';
  if (
    matchesAny(
      lowerMessage,
      'context length',
      'context window',
      'context limit',
      'maximum context',
      'token limit',
      'too many tokens',
      'prompt is too long',
      'input is too long',
      'overflow',
    )
  ) {
    return 'context_overflow';
  }
  if (matchesAny(lowerMessage, 'permission', 'denied', 'blocked')) return 'permission_denied';
  if (matchesAny(lowerMessage, 'tool not found', 'unknown tool')) return 'tool_not_found';
  return undefined;
}
function classifyError(error: unknown, toolName?: string): AgentError {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const originalError = error instanceof Error ? error : undefined;
  if (error instanceof ApiError) {
    const { status, retryAfterMs } = error;
    if (status === 408 || status === 409 || status === 429 || status >= 500) {
      return {
        type: 'provider_error',
        message,
        originalError,
        retryable: true,
        status,
        retryAfterMs,
      };
    }
    if (status === 400 && classifyErrorCategory(lower) === 'context_overflow') {
      return { type: 'context_overflow', message, originalError, retryable: true, status };
    }
    return { type: 'provider_error', message, originalError, retryable: false, status };
  }
  const category = classifyErrorCategory(lower);
  switch (category) {
    case 'rate_limit':
      return { type: 'provider_error', message, originalError, retryable: true };
    case 'auth':
      return { type: 'provider_error', message, originalError, retryable: false };
    case 'network':
      return { type: 'provider_error', message, originalError, retryable: true };
    case 'context_overflow':
      return { type: 'context_overflow', message, originalError, retryable: true };
    case 'permission_denied':
      return { type: 'permission_denied', message, originalError, toolName, retryable: false };
    case 'tool_not_found':
      return { type: 'tool_not_found', message, originalError, toolName, retryable: false };
    default:
      if (toolName) {
        return { type: 'tool_execution', message, originalError, toolName, retryable: false };
      }
      return { type: 'unknown', message, originalError, retryable: false };
  }
}
function describeRetryError(error: AgentError): string {
  const detail = error.message.replace(/\s+/g, ' ').trim();
  const truncated = detail.length > 120 ? `${detail.slice(0, 120)}…` : detail;
  if (error.status !== undefined) {
    return truncated ? `${error.status} ${truncated}` : `${error.status}`;
  }
  if (!truncated || matchesAny(detail.toLowerCase(), 'fetch', 'network', 'timeout', 'socket')) {
    return 'Connection error.';
  }
  return truncated;
}
export function setAgentWindow(window: BrowserWindow): void {
  mainWindow = window;
  setPermissionWindow(window);
}
export function setLSPManager(manager: LSPManager): void {
  lspManager = manager;
}
export function getLSPManager(): LSPManager | null {
  return lspManager;
}
interface QueuedInput {
  prompt: string;
  delivery: 'steer' | 'queue';
  timestamp: number;
}
interface StreamResult {
  assistantContent: string;
  toolCalls: ToolCall[];
  shouldRetryAfterCompaction: boolean;
  retryableError?: AgentError;
  terminalError?: boolean;
  usage?: TokenUsage;
}
interface ToolExecResult {
  toolResults: Array<{ toolCall: ToolCall; result: ToolResponse }>;
  events: AgentEvent[];
}
interface CompactionResult {
  events: AgentEvent[];
  recovered: boolean;
  messages: ChatMessage[];
}
interface TurnContext {
  sessionId: string;
  messageId: string;
  cwd: string;
  agentName: string | undefined;
  provider: LLMProvider;
  agentConfig: SubAgentConfig | undefined;
  controller: AbortController;
  totalUsage: TokenUsage;
}
interface StreamState {
  assistantContent: string;
  toolCalls: ToolCall[];
  gotComplete: boolean;
  shouldRetryAfterCompaction: boolean;
  retryableError?: AgentError;
  usage?: TokenUsage;
}
export class AgentService {
  private readonly explicitProvider?: LLMProvider;
  private tools: BaseTool[];
  private readonly activeRequests = new Map<string, AbortController>();
  private readonly messageHistories = new Map<string, ChatMessage[]>();
  private readonly modes = new Map<string, AgentMode>();
  private mcpTools: BaseTool[] = [];
  private readonly sessionsWithMessages = new Set<string>();
  private readonly sessionStartFired = new Set<string>();
  private readonly subagentSessions = new Map<string, string>();
  private readonly sessionAgentNames = new Map<string, string | undefined>();
  private readonly sessionSummaries = new Map<string, string>();
  private readonly inputQueues = new Map<string, QueuedInput[]>();
  private readonly finishedSubagentOrder: string[] = [];
  private static readonly MAX_SUBAGENT_HISTORIES = 20;
  constructor(provider?: LLMProvider) {
    this.explicitProvider = provider;
    initRegistry();
    this.tools = createAllTools(permissionService, undefined, this);
  }
  private getLSPClients(): Map<string, LSPClient> {
    return lspManager?.getAllClients() || new Map();
  }
  private rebuildTools(): void {
    const lspClients = this.getLSPClients();
    this.tools = [...createAllTools(permissionService, lspClients, this), ...this.mcpTools];
  }
  async loadMCPToolsFromConfig(servers: Record<string, MCPServer>): Promise<void> {
    this.mcpTools = await loadMCPTools(servers, permissionService);
    this.rebuildTools();
  }
  async generateSessionTitle(sessionId: string, firstMessage: string): Promise<string> {
    const provider =
      this.explicitProvider ||
      resolveConfiguredProvider(readProviders(), readSelectedModel(), readXiaomiApiKey());
    return generateTitle(firstMessage, provider);
  }
  isSessionNew(sessionId: string): boolean {
    return !this.sessionsWithMessages.has(sessionId);
  }
  async *run(
    sessionId: string,
    prompt: string,
    cwd: string,
    agentName?: string,
    images?: string[],
  ): AsyncGenerator<AgentEvent> {
    if (this.activeRequests.has(sessionId)) {
      yield {
        type: 'error',
        sessionId,
        messageId: '',
        error: new Error('Session is already busy'),
      };
      return;
    }
    const controller = new AbortController();
    this.activeRequests.set(sessionId, controller);
    const messageId = `msg-${Date.now()}`;
    if (lspManager && (await lspManager.setWorkspaceDir(cwd))) {
      this.rebuildTools();
    }
    const agentConfig = agentName ? getAgent(agentName, cwd)?.config : undefined;
    const xiaomiApiKey = readXiaomiApiKey();
    const provider =
      this.explicitProvider ||
      (agentConfig?.model
        ? resolveProviderForModel(
            agentConfig.model,
            readProviders(),
            readSelectedModel(),
            xiaomiApiKey,
          )
        : resolveConfiguredProvider(readProviders(), readSelectedModel(), xiaomiApiKey));
    const maxSteps = agentConfig?.steps ?? 20;
    const ctx: TurnContext = {
      sessionId,
      messageId,
      cwd,
      agentName,
      provider,
      agentConfig,
      controller,
      totalUsage: { inputTokens: 0, outputTokens: 0 },
    };
    let wasAborted = false;
    try {
      await Promise.all([
        loadProjectInstructions(cwd),
        loadGitContext(cwd),
        refreshProjectAgents(cwd),
        refreshProjectSkills(cwd),
        loadProjectMemory(cwd),
      ]);
      const init = yield* this.prepareConversation(ctx, prompt, images);
      if (init.blockedByHook !== undefined) {
        yield {
          type: 'system',
          sessionId,
          messageId,
          content: `Prompt blocked by UserPromptSubmit hook: ${init.blockedByHook}`,
        };
        yield {
          type: 'complete',
          sessionId,
          messageId,
          usage: { inputTokens: 0, outputTokens: 0 },
        };
        return;
      }
      let messages = init.messages;
      let shouldRun = true;
      let stopHookBlocks = 0;
      while (shouldRun) {
        const inner = yield* this.runInnerLoop(
          ctx,
          maxSteps,
          prompt,
          init.isFirstMessage,
          messages,
        );
        if (inner.terminate) return;
        messages = inner.messages;
        const outer = yield* this.checkOuterContinuation(ctx, messages, stopHookBlocks);
        shouldRun = outer.shouldRun;
        messages = outer.messages;
        stopHookBlocks = outer.stopHookBlocks;
      }
      if (!controller.signal.aborted) {
        yield {
          type: 'complete',
          sessionId,
          messageId,
          usage: ctx.totalUsage,
        };
      }
    } catch (error) {
      yield {
        type: 'error',
        sessionId,
        messageId,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    } finally {
      wasAborted = controller.signal.aborted;
      controller.abort();
      if (this.activeRequests.get(sessionId) === controller) {
        this.activeRequests.delete(sessionId);
      }
      void saveMessageHistory(sessionId, this.messageHistories.get(sessionId) ?? []);
      this.evictOldSubagentState(sessionId);
    }
    if (!wasAborted) {
      yield {
        type: 'done',
        sessionId,
        messageId,
      };
    }
  }
  private async *prepareConversation(
    ctx: TurnContext,
    prompt: string,
    images: string[] | undefined,
  ): AsyncGenerator<
    AgentEvent,
    { messages: ChatMessage[]; isFirstMessage: boolean; blockedByHook?: string }
  > {
    const { sessionId, messageId, cwd, agentName, provider } = ctx;
    let messages = this.messageHistories.get(sessionId) || [];
    let restoredFromDisk = false;
    if (messages.length === 0) {
      const persisted = await loadMessageHistory(sessionId);
      if (persisted) {
        messages = persisted;
        restoredFromDisk = true;
        this.sessionsWithMessages.add(sessionId);
      }
    }
    if (messages.length === 0 && isContinuableSession(sessionId)) {
      const imported = await importExternalHistory(sessionId, prompt).catch(
        () => [] as ChatMessage[],
      );
      if (imported.length > 0) {
        messages = [{ role: 'system', content: buildSystemPrompt(cwd, agentName) }, ...imported];
        this.sessionsWithMessages.add(sessionId);
      }
    }
    let sessionStartContext: string | undefined;
    if (!this.sessionStartFired.has(sessionId) && !sessionId.includes(':sub:')) {
      this.sessionStartFired.add(sessionId);
      const start = await runHooks('SessionStart', {
        session_id: sessionId,
        cwd,
        source: restoredFromDisk ? 'resume' : 'startup',
      });
      sessionStartContext = start.context;
    }
    const submit = await runHooks('UserPromptSubmit', { session_id: sessionId, cwd, prompt });
    if (submit.blocked) {
      return { messages, isFirstMessage: false, blockedByHook: submit.feedback };
    }
    if (submit.context) {
      prompt = `${prompt}\n\n<hook_context>\n${submit.context}\n</hook_context>`;
    }
    if (messages.length === 0) {
      messages = [{ role: 'system', content: buildSystemPrompt(cwd, agentName) }];
    } else if (
      this.sessionAgentNames.get(sessionId) !== agentName &&
      messages[0]?.role === 'system'
    ) {
      messages[0] = {
        role: 'system',
        content: buildSystemPrompt(cwd, agentName, this.sessionSummaries.get(sessionId)),
      };
    }
    this.sessionAgentNames.set(sessionId, agentName);
    if (sessionStartContext && messages[0]?.role === 'system') {
      messages[0] = {
        role: 'system',
        content: `${messages[0].content}\n\n# SessionStart hook context\n${sessionStartContext}`,
      };
    }
    yield* this.drainPendingInputs(ctx, messages);
    messages.push({
      role: 'user',
      content: images?.length
        ? [
            { type: 'text' as const, text: prompt },
            ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
          ]
        : prompt,
    });
    this.messageHistories.set(sessionId, messages);
    const isFirstMessage = !this.sessionsWithMessages.has(sessionId);
    this.sessionsWithMessages.add(sessionId);
    return { messages, isFirstMessage };
  }
  private async *runInnerLoop(
    ctx: TurnContext,
    maxSteps: number,
    prompt: string,
    isFirstMessage: boolean,
    initialMessages: ChatMessage[],
  ): AsyncGenerator<AgentEvent, { terminate: boolean; messages: ChatMessage[] }> {
    let messages = initialMessages;
    let iterations = 0;
    while (iterations < maxSteps) {
      iterations++;
      const step = yield* this.runOneStep(
        ctx,
        maxSteps,
        iterations,
        prompt,
        isFirstMessage,
        messages,
      );
      messages = step.messages;
      if (step.kind === 'terminate') return { terminate: true, messages };
      if (step.kind === 'reset') iterations = 0;
    }
    return { terminate: false, messages };
  }
  private async *runOneStep(
    ctx: TurnContext,
    maxSteps: number,
    iteration: number,
    prompt: string,
    isFirstMessage: boolean,
    messages: ChatMessage[],
  ): AsyncGenerator<
    AgentEvent,
    { kind: 'terminate' | 'reset' | 'continue'; messages: ChatMessage[] }
  > {
    const { sessionId, messageId, cwd, agentName, provider, controller } = ctx;
    if (controller.signal.aborted) {
      yield {
        type: 'error',
        sessionId,
        messageId,
        error: new Error('Request cancelled'),
      };
      return { kind: 'terminate', messages };
    }
    const agentTools = this.filterToolsForSession(sessionId, agentName);
    const toolDefs = agentTools.map((t) => ({
      description: t.info().description,
      parameters: t.info().parameters,
    }));
    const contextWindow = provider.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    const compactCheck = await compactIfNeeded(
      messages,
      provider,
      contextWindow,
      toolDefs,
      cwd,
      agentName,
      async () => {
        await runHooks('PreCompact', { session_id: sessionId, cwd, trigger: 'auto' });
      },
    );
    messages = yield* this.applyProactiveCompaction(sessionId, messageId, messages, compactCheck);
    const isLastStep = iteration >= maxSteps;
    let streamResult = yield* this.streamLLMResponse(ctx, messages, agentTools, isLastStep);
    const MAX_RETRIES = 10;
    let retryCount = 0;
    while (streamResult.retryableError && retryCount < MAX_RETRIES && !controller.signal.aborted) {
      retryCount++;
      const retryError = streamResult.retryableError;
      const backoffMs = Math.min(1000 * 2 ** (retryCount - 1), 32000);
      const retryAfterMs = retryError.retryAfterMs;
      const delayMs =
        retryAfterMs !== undefined && retryAfterMs > 0 && retryAfterMs <= 60000
          ? retryAfterMs
          : backoffMs;
      yield {
        type: 'system',
        sessionId,
        messageId,
        content: `API Error (${describeRetryError(retryError)}) · Retrying in ${Math.max(1, Math.round(delayMs / 1000))} seconds… (attempt ${retryCount}/${MAX_RETRIES})`,
      };
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        controller.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      if (controller.signal.aborted) break;
      streamResult = yield* this.streamLLMResponse(ctx, messages, agentTools, isLastStep);
    }
    if (streamResult.usage) {
      ctx.totalUsage.inputTokens += streamResult.usage.inputTokens;
      ctx.totalUsage.outputTokens += streamResult.usage.outputTokens;
    }
    if (streamResult.retryableError) {
      yield {
        type: 'error',
        sessionId,
        messageId,
        error: streamResult.retryableError,
      };
      return { kind: 'terminate', messages };
    }
    if (streamResult.terminalError) {
      if (streamResult.assistantContent) {
        messages.push({ role: 'assistant', content: streamResult.assistantContent });
        this.messageHistories.set(sessionId, messages);
      }
      return { kind: 'terminate', messages };
    }
    if (streamResult.toolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: streamResult.assistantContent || null,
        tool_calls: streamResult.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.input },
        })),
      });
      yield* this.executeAndRecordToolCalls(ctx, messages, streamResult.toolCalls, agentTools);
    }
    if (streamResult.shouldRetryAfterCompaction) {
      const retry = yield* this.handleRetryAfterCompaction(ctx, messages);
      if (!retry.recovered) return { kind: 'terminate', messages };
      const injectedAfterRecovery = yield* this.drainPendingInputs(ctx, retry.messages);
      return { kind: injectedAfterRecovery ? 'reset' : 'continue', messages: retry.messages };
    }
    if (streamResult.toolCalls.length === 0) {
      const outcome = yield* this.handleNoToolCallsTurn(
        ctx,
        messages,
        streamResult.assistantContent,
        isFirstMessage,
        prompt,
      );
      return outcome.terminate ? { kind: 'terminate', messages } : { kind: 'reset', messages };
    }
    const injected = yield* this.drainPendingInputs(ctx, messages);
    return { kind: injected ? 'reset' : 'continue', messages };
  }

  private async *executeAndRecordToolCalls(
    ctx: TurnContext,
    messages: ChatMessage[],
    toolCalls: ToolCall[],
    agentTools: BaseTool[],
  ): AsyncGenerator<AgentEvent, void> {
    const { sessionId, messageId, controller, cwd } = ctx;
    const toolExecResult = await this.executeToolCalls(
      sessionId,
      messageId,
      toolCalls,
      agentTools,
      controller,
      cwd,
    );
    for (const e of toolExecResult.events) yield e;
    await this.addToolResultsToMessages(sessionId, messages, toolExecResult.toolResults);
  }
  private *applyProactiveCompaction(
    sessionId: string,
    messageId: string,
    messages: ChatMessage[],
    compactCheck: { messages: ChatMessage[]; compacted: boolean; summary?: string },
  ): Generator<AgentEvent, ChatMessage[]> {
    if (!compactCheck.compacted) return messages;
    if (compactCheck.summary) this.sessionSummaries.set(sessionId, compactCheck.summary);
    this.messageHistories.set(sessionId, compactCheck.messages);
    yield {
      type: 'system',
      sessionId,
      messageId,
      content: 'Context proactively compacted to prevent overflow',
    };
    return compactCheck.messages;
  }
  private async *handleNoToolCallsTurn(
    ctx: TurnContext,
    messages: ChatMessage[],
    assistantContent: string,
    isFirstMessage: boolean,
    prompt: string,
  ): AsyncGenerator<AgentEvent, { terminate: boolean }> {
    const { sessionId, messageId } = ctx;
    messages.push({ role: 'assistant', content: assistantContent });
    if (isFirstMessage) this.emitGeneratedTitle(sessionId, messageId, prompt);
    const injected = yield* this.drainPendingInputs(ctx, messages);
    if (injected) return { terminate: false };
    yield {
      type: 'complete',
      sessionId,
      messageId,
      usage: ctx.totalUsage,
    };
    return { terminate: true };
  }

  private async *drainPendingInputs(
    ctx: TurnContext,
    messages: ChatMessage[],
  ): AsyncGenerator<AgentEvent, boolean> {
    let injected = false;
    for (
      let input = this.getNextInput(ctx.sessionId);
      input;
      input = this.getNextInput(ctx.sessionId)
    ) {
      const submit = await runHooks('UserPromptSubmit', {
        session_id: ctx.sessionId,
        cwd: ctx.cwd,
        prompt: input.prompt,
      });
      if (submit.blocked) {
        yield {
          type: 'system',
          sessionId: ctx.sessionId,
          messageId: ctx.messageId,
          content: `Prompt blocked by UserPromptSubmit hook: ${submit.feedback}`,
        };
        continue;
      }
      const prompt = submit.context
        ? `${input.prompt}\n\n<hook_context>\n${submit.context}\n</hook_context>`
        : input.prompt;
      messages.push({ role: 'user', content: prompt });
      yield {
        type: 'user_turn',
        sessionId: ctx.sessionId,
        messageId: ctx.messageId,
        content: input.prompt,
      };
      injected = true;
    }
    if (injected) this.messageHistories.set(ctx.sessionId, messages);
    return injected;
  }
  private async *handleRetryAfterCompaction(
    ctx: TurnContext,
    messages: ChatMessage[],
  ): AsyncGenerator<AgentEvent, { recovered: boolean; messages: ChatMessage[] }> {
    const { sessionId, messageId, provider, cwd, agentName } = ctx;
    const recovery = await this.handleCompactionRecovery(
      sessionId,
      messageId,
      messages,
      provider,
      cwd,
      agentName,
    );
    for (const e of recovery.events) yield e;
    return recovery.recovered
      ? { recovered: true, messages: recovery.messages }
      : { recovered: false, messages };
  }

  private async *checkOuterContinuation(
    ctx: TurnContext,
    messages: ChatMessage[],
    stopHookBlocks: number,
  ): AsyncGenerator<
    AgentEvent,
    { shouldRun: boolean; messages: ChatMessage[]; stopHookBlocks: number }
  > {
    const { sessionId, messageId, cwd, controller } = ctx;
    let shouldRun = false;
    if (!controller.signal.aborted) {
      shouldRun = yield* this.drainPendingInputs(ctx, messages);
    }
    if (shouldRun === false && !controller.signal.aborted && stopHookBlocks < 2) {
      const event = sessionId.includes(':sub:') ? ('SubagentStop' as const) : ('Stop' as const);
      const stop = await runHooks(event, { session_id: sessionId, cwd, agent_name: ctx.agentName });
      if (stop.blocked && stop.feedback) {
        stopHookBlocks++;
        messages.push({ role: 'user', content: `[${event} hook]: ${stop.feedback}` });
        this.messageHistories.set(sessionId, messages);
        shouldRun = true;
        yield {
          type: 'user_turn',
          sessionId,
          messageId,
          content: `[${event} hook]: ${stop.feedback}`,
        };
      }
    }
    return { shouldRun, messages, stopHookBlocks };
  }
  private async *streamLLMResponse(
    ctx: TurnContext,
    messages: ChatMessage[],
    agentTools: BaseTool[],
    isLastStep: boolean,
  ): AsyncGenerator<AgentEvent, StreamResult> {
    const { sessionId, messageId, controller, provider, agentConfig } = ctx;
    const state: StreamState = {
      assistantContent: '',
      toolCalls: [],
      gotComplete: false,
      shouldRetryAfterCompaction: false,
    };
    const lastStepPrompt = isLastStep
      ? '\n\nIMPORTANT: This is your final step. Provide a comprehensive summary of what you did and what remains to be done. Do not use any tools.'
      : '';
    const toolsToSend = isLastStep ? [] : agentTools;
    const messagesToSend = isLastStep
      ? [...messages, { role: 'user' as const, content: lastStepPrompt.trim() }]
      : messages;
    const textCallFilter = new TextToolCallFilter();
    for await (const event of provider.streamChat(messagesToSend, toolsToSend, controller.signal, {
      topP: agentConfig?.topP,
      temperature: agentConfig?.temperature,
      maxTokens: agentConfig?.maxTokens,
    })) {
      if (controller.signal.aborted) break;
      const outcome = yield* this.handleStreamEvent(
        sessionId,
        messageId,
        event,
        state,
        textCallFilter,
      );
      if (outcome === 'stop-overflow') break;
      if (outcome === 'stop-retry') {
        return {
          assistantContent: state.assistantContent,
          toolCalls: state.toolCalls,
          shouldRetryAfterCompaction: state.shouldRetryAfterCompaction,
          retryableError: state.retryableError,
          usage: state.usage,
        };
      }
      if (outcome === 'stop-error') {
        return {
          assistantContent: state.assistantContent,
          toolCalls: state.toolCalls,
          shouldRetryAfterCompaction: state.shouldRetryAfterCompaction,
          terminalError: true,
          usage: state.usage,
        };
      }
    }
    if (!state.gotComplete && !controller.signal.aborted && !state.shouldRetryAfterCompaction) {
      yield* this.emitTextAndCalls(sessionId, messageId, textCallFilter.flush(), state);
      yield {
        type: 'complete',
        sessionId,
        messageId,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }
    return {
      assistantContent: state.assistantContent,
      toolCalls: state.toolCalls,
      shouldRetryAfterCompaction: state.shouldRetryAfterCompaction,
      retryableError: state.retryableError,
      usage: state.usage,
    };
  }
  private *handleStreamEvent(
    sessionId: string,
    messageId: string,
    event: AgentEvent,
    state: StreamState,
    textCallFilter: TextToolCallFilter,
  ): Generator<AgentEvent, 'continue' | 'stop-overflow' | 'stop-retry' | 'stop-error'> {
    if (event.type === 'thinking' && event.content) {
      yield { type: 'thinking', sessionId, messageId, content: event.content };
      return 'continue';
    }
    if (event.type === 'content' && event.content) {
      yield* this.emitTextAndCalls(sessionId, messageId, textCallFilter.push(event.content), state);
      return 'continue';
    }
    if (event.type === 'tool_use' && event.toolCall) {
      const existing = state.toolCalls.find((tc) => tc.id === event.toolCall!.id);
      if (existing) {
        existing.input = event.toolCall.input;
      } else {
        state.toolCalls.push(event.toolCall);
      }
      yield { type: 'tool_use', sessionId, messageId, toolCall: event.toolCall };
      return 'continue';
    }
    if (event.type === 'complete' && event.usage) {
      yield* this.emitTextAndCalls(sessionId, messageId, textCallFilter.flush(), state);
      state.gotComplete = true;
      state.usage = event.usage;
      yield { type: 'complete', sessionId, messageId, usage: event.usage };
      return 'continue';
    }
    if (event.type === 'error') {
      const error = event.error ?? new Error('LLM request failed');
      const classifiedError = classifyError(error);
      if (classifiedError.type === 'context_overflow' && !state.shouldRetryAfterCompaction) {
        state.shouldRetryAfterCompaction = true;
        yield {
          type: 'system',
          sessionId,
          messageId,
          content: 'Context overflow detected, will compact and retry',
        };
        return 'stop-overflow';
      }
      if (classifiedError.retryable && classifiedError.type === 'provider_error') {
        state.retryableError = classifiedError;
        return 'stop-retry';
      }
      yield { type: 'error', sessionId, messageId, error: classifiedError };
      return 'stop-error';
    }
    return 'continue';
  }
  private *emitTextAndCalls(
    sessionId: string,
    messageId: string,
    filtered: { text: string; calls: ToolCall[] },
    state: StreamState,
  ): Generator<AgentEvent, void> {
    if (filtered.text) {
      state.assistantContent += filtered.text;
      yield { type: 'content', sessionId, messageId, content: filtered.text };
    }
    for (const call of filtered.calls) {
      state.toolCalls.push(call);
      yield { type: 'tool_use', sessionId, messageId, toolCall: call };
    }
  }
  private async executeToolCalls(
    sessionId: string,
    messageId: string,
    toolCalls: ToolCall[],
    agentTools: BaseTool[],
    controller: AbortController,
    cwd: string,
  ): Promise<ToolExecResult> {
    const events: AgentEvent[] = [];
    const toolResults: Array<{ toolCall: ToolCall; result: ToolResponse }> = [];
    const pendingTools: Promise<{ toolCall: ToolCall; result: ToolResponse }>[] = [];
    let mutatingChain: Promise<unknown> = Promise.resolve();
    for (const toolCall of toolCalls) {
      if (controller.signal.aborted) {
        const result: ToolResponse = { content: 'Tool execution cancelled', isError: true };
        toolResults.push({ toolCall, result });
        events.push({ type: 'tool_result', sessionId, messageId, toolCall, toolResult: result });
        continue;
      }
      const tool = resolveTool(agentTools, toolCall.name);
      if (!tool) {
        const result: ToolResponse = {
          content: `Tool not found: ${toolCall.name}. Available tools: ${agentTools.map((t) => t.info().name).join(', ')}`,
          isError: true,
        };
        toolResults.push({ toolCall, result });
        events.push({ type: 'tool_result', sessionId, messageId, toolCall, toolResult: result });
        continue;
      }
      const ctx: ExecutionContext = {
        sessionId,
        messageId,
        cwd,
        permissions: permissionService,
        mode: this.getMode(sessionId),
        abortSignal: controller.signal,
      };
      const runTool = async () => {
        try {
          if (controller.signal.aborted) {
            return {
              toolCall,
              result: { content: 'Tool execution cancelled', isError: true } as ToolResponse,
            };
          }
          const hookPayload = {
            session_id: sessionId,
            cwd,
            tool_name: toolCall.name,
          };
          const pre = await runHooks('PreToolUse', hookPayload);
          if (pre.blocked) {
            return {
              toolCall,
              result: {
                content: `Tool call blocked by PreToolUse hook: ${pre.feedback}`,
                isError: true,
              } as ToolResponse,
            };
          }
          const result = await tool.run(ctx, toolCall);
          const post = await runHooks('PostToolUse', {
            session_id: sessionId,
            cwd,
            tool_name: toolCall.name,
            tool_response: { content: result.content, isError: result.isError ?? false },
          });
          if (post.blocked && post.feedback) {
            result.content += `\n\n[PostToolUse hook feedback]: ${post.feedback}`;
          }
          return { toolCall, result };
        } catch (error) {
          const classifiedError = classifyError(error, toolCall.name);
          return {
            toolCall,
            result: {
              content: classifiedError.message,
              isError: true,
              metadata: { errorType: classifiedError.type, retryable: classifiedError.retryable },
            },
          };
        }
      };
      const guarded = (p: Promise<{ toolCall: ToolCall; result: ToolResponse }>) =>
        p.catch((reason) => ({
          toolCall,
          result: { content: `Tool execution failed: ${reason}`, isError: true } as ToolResponse,
        }));
      let toolPromise: Promise<{ toolCall: ToolCall; result: ToolResponse }>;
      if (MUTATING_TOOL_NAMES.has(tool.info().name)) {
        toolPromise = guarded(mutatingChain.then(runTool));
        mutatingChain = toolPromise;
      } else {
        toolPromise = guarded(runTool());
      }
      pendingTools.push(toolPromise);
    }
    const results = await Promise.all(pendingTools);
    for (const { toolCall, result } of results) {
      toolResults.push({ toolCall, result });
      events.push({ type: 'tool_result', sessionId, messageId, toolCall, toolResult: result });
    }
    return { toolResults, events };
  }
  private emitGeneratedTitle(sessionId: string, messageId: string, prompt: string): void {
    this.generateSessionTitle(sessionId, prompt)
      .then((title) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.agentEvent, {
            type: 'title',
            sessionId,
            messageId,
            title,
          });
        }
      })
      .catch(() => {});
  }
  private async handleCompactionRecovery(
    sessionId: string,
    messageId: string,
    messages: ChatMessage[],
    provider: LLMProvider,
    cwd: string,
    agentName: string | undefined,
  ): Promise<CompactionResult> {
    try {
      await runHooks('PreCompact', { session_id: sessionId, cwd, trigger: 'error' });
      const compactResult = await compactConversation(messages, provider);
      this.sessionSummaries.set(sessionId, compactResult.summary);
      const newMessages = buildCompactSessionMessages(
        compactResult.summary,
        cwd,
        compactResult.recent,
        agentName,
      );
      this.messageHistories.set(sessionId, newMessages);
      return {
        events: [
          { type: 'system', sessionId, messageId, content: 'Context compacted, retrying...' },
        ],
        recovered: true,
        messages: newMessages,
      };
    } catch (compactError) {
      return {
        events: [
          {
            type: 'error',
            sessionId,
            messageId,
            error: compactError instanceof Error ? compactError : new Error(String(compactError)),
          },
        ],
        recovered: false,
        messages,
      };
    }
  }
  private async addToolResultsToMessages(
    sessionId: string,
    messages: ChatMessage[],
    toolResults: Array<{ toolCall: ToolCall; result: ToolResponse }>,
  ): Promise<void> {
    for (const { toolCall, result } of toolResults) {
      const { content: boundedContent } = await toolOutputStore.store(
        sessionId,
        toolCall.id,
        result.content,
      );
      messages.push({
        role: 'tool',
        content: boundedContent,
        tool_call_id: toolCall.id,
      });
    }
  }
  // =========================================================================
  //  Public / private utility methods
  // =========================================================================
  cancel(sessionId: string): void {
    const controller = this.activeRequests.get(sessionId);
    if (controller) {
      controller.abort();
      this.activeRequests.delete(sessionId);
    }
  }
  clearHistory(sessionId: string): void {
    this.releaseSessionState(sessionId);
    void deleteMessageHistory(sessionId);
  }
  private releaseSessionState(sessionId: string): void {
    this.messageHistories.delete(sessionId);
    this.modes.delete(sessionId);
    this.sessionsWithMessages.delete(sessionId);
    this.sessionStartFired.delete(sessionId);
    this.subagentSessions.delete(sessionId);
    this.sessionAgentNames.delete(sessionId);
    this.sessionSummaries.delete(sessionId);
    this.inputQueues.delete(sessionId);
    clearFileReads(sessionId);
  }
  private evictOldSubagentState(sessionId: string): void {
    if (!sessionId.includes(':sub:')) return;
    const idx = this.finishedSubagentOrder.indexOf(sessionId);
    if (idx !== -1) this.finishedSubagentOrder.splice(idx, 1);
    this.finishedSubagentOrder.push(sessionId);
    while (this.finishedSubagentOrder.length > AgentService.MAX_SUBAGENT_HISTORIES) {
      this.releaseSessionState(this.finishedSubagentOrder.shift()!);
    }
  }
  private filterToolsForSession(sessionId: string, agentName?: string): BaseTool[] {
    const derivedRuleset = sessionManager.getSession(sessionId)?.permission;
    let effectiveAgentName = agentName;
    if (!derivedRuleset?.length && (agentName === 'plan' || agentName === 'build')) {
      effectiveAgentName = this.getMode(sessionId) === 'plan' ? 'plan' : 'build';
    }
    const agentConfig = effectiveAgentName ? getAgent(effectiveAgentName)?.config : undefined;
    let ruleset;
    if (derivedRuleset?.length) {
      ruleset = derivedRuleset;
    } else if (agentConfig?.permission) {
      ruleset = fromConfig(agentConfig.permission);
    } else {
      ruleset = undefined;
    }
    if (!ruleset) return this.tools;
    return this.tools.filter(
      (tool) => evaluatePermission(ruleset, tool.info().name, '*') !== 'deny',
    );
  }
  getMode(sessionId: string): AgentMode {
    return this.modes.get(sessionId) ?? 'default';
  }
  setMode(sessionId: string, mode: AgentMode): void {
    this.modes.set(sessionId, mode);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.agentEvent, {
        type: 'mode',
        sessionId,
        messageId: '',
        mode,
      });
    }
  }
  async shutdownMCPClients(): Promise<void> {
    for (const tool of this.mcpTools) {
      if (tool instanceof MCPToolWrapper) {
        await tool.close().catch(() => {});
      }
    }
    this.mcpTools = [];
  }
  isBusy(sessionId: string): boolean {
    return this.activeRequests.has(sessionId);
  }
  setLSPClients(clients: Map<string, LSPClient>): void {
    this.rebuildTools();
  }
  enqueueInput(sessionId: string, prompt: string, delivery: 'steer' | 'queue' = 'queue'): void {
    const queue = this.inputQueues.get(sessionId) || [];
    queue.push({
      prompt,
      delivery,
      timestamp: Date.now(),
    });
    this.inputQueues.set(sessionId, queue);
  }
  hasPendingInputs(sessionId: string): boolean {
    const queue = this.inputQueues.get(sessionId);
    return queue ? queue.length > 0 : false;
  }
  getNextInput(sessionId: string): QueuedInput | undefined {
    return this.inputQueues.get(sessionId)?.shift();
  }
}
export const agentService = new AgentService();
