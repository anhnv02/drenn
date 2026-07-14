import { dialog, ipcMain, type BrowserWindow } from 'electron';
import { IPC, type PermissionResponsePayload } from '../shared/ipc';
import type {
  AgentInfo,
  AgentMode,
  DiffScope,
  FileChange,
  MCPServer,
  ModelChoice,
  PermissionPatternRule,
  Provider,
  SelectedModel,
  TranscriptStep,
} from '../shared/types';
import { buildSessionDiff } from '../shared/sessionDiff';
import {
  getProjects,
  getTranscript,
  getSessionCwd,
  getSessionChanges,
  getSessionFileOps,
} from './history';
import {
  createLocalSession,
  deleteLocalSession,
  clearLocalTranscript,
  addLocalTranscriptStep,
  updateLocalSessionTitle,
} from './session/localSessions';
import {
  addContinuationStep,
  deleteContinuation,
  isContinuableSession,
} from './session/continuations';
import { getDiffFor, getUncommittedChanges, languageFor, listFilesFor } from './git';
import { readProviders, writeProviders } from './config/providerStore';
import { getTodos } from './tools/todowrite';
import {
  readSelectedModel,
  writeSelectedModel,
  readXiaomiApiKey,
  writeXiaomiApiKey,
  readMCPServers,
  writeMCPServers,
  readPermissionPatterns,
  writePermissionPatterns,
} from './config/settingsStore';
import { createTerminal, writeTerminal, resizeTerminal, disposeTerminal } from './terminal';
import { listCheckpoints, revertSessionChanges } from './checkpoints';
import { agentService, setAgentWindow } from './agent';
import {
  listAgents,
  generateAgent,
  backgroundJobService,
  getAgent,
  registerAgent,
  saveAgent,
  deleteAgent,
  refreshProjectAgents,
  listProjectAgents,
} from './agent/subagent';
import type { SubAgentConfig, BackgroundJob } from './agent/subagent';
import {
  BUILTIN_MODELS,
  BUILTIN_PROVIDER_ID,
  BUILTIN_PROVIDER_NAME,
  XIAOMI_MODELS,
  XIAOMI_PROVIDER_ID,
  XIAOMI_PROVIDER_NAME,
} from './llm/openaiClient';
import { permissionService } from './permission';
import type { PermissionConfig } from './permission/ruleset';
import {
  handleQuestionResponse,
  setQuestionWindow,
  cancelPendingQuestions,
} from './tools/question';
import { loadCustomCommands, resolveCommandArgs } from './commands';
import { openExternalEditor, getAvailableEditor } from './editor';
import { refreshProjectSkills, listProjectSkills, getSkill, loadSkillContent } from './skills';

let mainWindow: BrowserWindow | null = null;

function sendToRenderer(channel: string, ...args: any[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
}

export function setMainWindow(window: BrowserWindow): void {
  mainWindow = window;
  setAgentWindow(window);
  setQuestionWindow(window);
}

const CACHE_TTL_MS = 10_000;
const cache = new Map<string, { at: number; value: Promise<unknown> }>();

function cached<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as Promise<T>;
  const value = compute();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}

function invalidateCache(prefix: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

let cachedXiaomiModels: { id: string; name: string }[] = [];

const XIAOMI_MODEL_NAMES: Record<string, string> = {
  'mimo-v2.5-pro': 'MiMo v2.5 Pro',
  'mimo-v2.5': 'MiMo v2.5',
  'mimo-v2.5-asr': 'MiMo v2.5 ASR',
  'mimo-v2.5-tts': 'MiMo v2.5 TTS',
};

async function refreshXiaomiModels(apiKey: string): Promise<{ id: string; name: string }[]> {
  if (!apiKey) {
    cachedXiaomiModels = [];
    return [];
  }
  try {
    const resp = await fetch('https://api.xiaomimimo.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!resp.ok) return cachedXiaomiModels;
    const data = (await resp.json()) as { data?: { id: string }[] };
    cachedXiaomiModels = (data.data ?? [])
      .filter((m) => m.id.startsWith('mimo-'))
      .map((m) => ({ id: m.id, name: XIAOMI_MODEL_NAMES[m.id] ?? m.id }));
    return cachedXiaomiModels;
  } catch {
    return cachedXiaomiModels;
  }
}

function transcriptWriter(sessionId: string): ((step: TranscriptStep) => void) | null {
  if (sessionId.startsWith('local:')) return (step) => addLocalTranscriptStep(sessionId, step);
  if (isContinuableSession(sessionId)) return (step) => addContinuationStep(sessionId, step);
  return null;
}

function runAgentTurn(sessionId: string, text: string, cwd: string, images?: string[]): void {
  const persistStep = transcriptWriter(sessionId);
  if (persistStep) {
    persistStep({
      id: `local-${Date.now()}`,
      heading: 'You',
      finished: true,
      blocks: [
        { kind: 'text', content: text },
        ...(images ?? []).map((url) => ({ kind: 'image' as const, content: url })),
      ],
    });
    invalidateCache(`transcript:${sessionId}`);
    invalidateCache('sessions');
  }

  const agentName = agentService.getMode(sessionId) === 'plan' ? 'plan' : 'build';

  let accumulatedContent = '';
  (async () => {
    try {
      for await (const event of agentService.run(sessionId, text, cwd, agentName, images)) {
        sendToRenderer(IPC.agentEvent, {
          ...event,
          error: event.error?.message,
        });

        if (persistStep) {
          if (event.type === 'content' && event.content) {
            accumulatedContent += event.content;
          } else if (event.type === 'complete' && accumulatedContent) {
            persistStep({
              id: `agent-${Date.now()}`,
              heading: 'Assistant',
              finished: true,
              blocks: [{ kind: 'text', content: accumulatedContent }],
            });
            accumulatedContent = '';
            invalidateCache(`transcript:${sessionId}`);
          } else if (event.type === 'error') {
            persistStep({
              id: `agent-error-${Date.now()}`,
              heading: 'Error',
              finished: true,
              blocks: [{ kind: 'text', content: event.error?.message || 'Something went wrong.' }],
            });
            accumulatedContent = '';
            invalidateCache(`transcript:${sessionId}`);
          } else if (event.type === 'title' && event.title) {
            if (sessionId.startsWith('local:')) {
              updateLocalSessionTitle(sessionId, event.title);
              invalidateCache('sessions');
            }
          } else if (event.type === 'system' && event.content) {
            persistStep({
              id: `system-${Date.now()}`,
              heading: 'System',
              finished: true,
              blocks: [{ kind: 'text', content: event.content }],
            });
            invalidateCache(`transcript:${sessionId}`);
          } else if (event.type === 'user_turn' && event.content) {
            persistStep({
              id: `local-${Date.now()}`,
              heading: 'You',
              finished: true,
              blocks: [{ kind: 'text', content: event.content }],
            });
            invalidateCache(`transcript:${sessionId}`);
          } else if (event.type === 'tool_result' && event.toolCall && event.toolResult) {
            persistStep({
              id: `toolcall-${event.toolCall.id}`,
              heading: 'ToolCall',
              finished: true,
              blocks: [
                {
                  kind: 'tool',
                  content: JSON.stringify({
                    id: event.toolCall.id,
                    name: event.toolCall.name,
                    input: event.toolCall.input,
                    result: event.toolResult,
                  }),
                },
              ],
            });
            invalidateCache(`transcript:${sessionId}`);
            invalidateCache(`changes:${sessionId}`);
            invalidateCache(`files:${sessionId}`);
          }
        }
      }
    } catch (err) {
      console.error('Agent run failed:', err);
      sendToRenderer(IPC.agentEvent, {
        type: 'error',
        sessionId,
        messageId: '',
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      invalidateCache('sessions');
      sendToRenderer(IPC.agentEvent, {
        type: 'done',
        sessionId,
        messageId: '',
      });
    }
  })();
}

function serializeAgent(config: SubAgentConfig): AgentInfo {
  const disabledTools: string[] = [];
  if (config.permission) {
    for (const [tool, action] of Object.entries(config.permission)) {
      if (tool === '*') continue;
      if (action === 'deny') disabledTools.push(tool);
      if (typeof action === 'object') {
        const allDenied = Object.values(action).every((v) => v === 'deny');
        if (allDenied) disabledTools.push(tool);
      }
    }
  }
  return {
    name: config.name,
    description: config.description,
    mode: config.mode,
    temperature: config.temperature,
    topP: config.topP,
    steps: config.steps,
    color: config.color,
    disabledTools: disabledTools.length > 0 ? disabledTools : undefined,
    prompt: config.prompt,
    native: config.native,
    scope: config.scope,
    origin: config.origin,
  };
}

async function isProjectAgent(name: string, sessionId?: string): Promise<boolean> {
  if (!sessionId) return false;
  const cwd = await getSessionCwd(sessionId);
  if (!cwd) return false;
  await refreshProjectAgents(cwd);
  return listProjectAgents(cwd).some((a) => a.config.name === name);
}

export function registerIpcHandlers(): void {
  backgroundJobService.on('settled', (job: BackgroundJob) => {
    if (!job.background) return;
    sendToRenderer(IPC.backgroundJobEvent, {
      sessionId: job.sessionId,
      jobId: job.id,
      status: job.status,
      error: job.error,
    });
  });

  ipcMain.handle(IPC.getSessions, () => cached('sessions', () => getProjects()));

  ipcMain.handle(
    IPC.createSession,
    async (_event, projectName: string, sourceSessionId: string, cwd?: string) => {
      const resolvedCwd = cwd ?? (await getSessionCwd(sourceSessionId)) ?? process.cwd();
      const session = createLocalSession(projectName, resolvedCwd);
      invalidateCache('sessions');
      return session;
    },
  );

  ipcMain.handle(IPC.deleteSession, async (_event, sessionId: string) => {
    if (sessionId.startsWith('local:')) {
      await deleteLocalSession(sessionId);
      agentService.clearHistory(sessionId);
      invalidateCache(`transcript:${sessionId}`);
      invalidateCache(`changes:${sessionId}`);
      invalidateCache(`files:${sessionId}`);
      invalidateCache('sessions');
    }
  });

  ipcMain.handle(IPC.getChanges, (_event, sessionId: string | null) =>
    cached(`changes:${sessionId}`, async () => {
      const sum = (list: FileChange[]) =>
        list.reduce(
          (acc, f) => ({ added: acc.added + f.added, removed: acc.removed + f.removed }),
          { added: 0, removed: 0 },
        );

      const [files, cwd] = await Promise.all([
        sessionId ? getSessionChanges(sessionId) : Promise.resolve([]),
        sessionId ? getSessionCwd(sessionId) : Promise.resolve(null),
      ]);
      const current = await getUncommittedChanges(cwd);
      return { files, totals: sum(files), current, currentTotals: sum(current) };
    }),
  );

  ipcMain.handle(IPC.getFiles, (_event, sessionId: string | null) =>
    cached(`files:${sessionId}`, async () => {
      const cwd = sessionId ? await getSessionCwd(sessionId) : null;
      return { files: await listFilesFor(cwd) };
    }),
  );

  ipcMain.handle(IPC.getTranscript, (_event, sessionId: string) =>
    cached(`transcript:${sessionId}`, () => getTranscript(sessionId)),
  );

  ipcMain.handle(
    IPC.getDiff,
    async (_event, sessionId: string | null, path: string, scope?: DiffScope) => {
      if (scope === 'session' && sessionId) {
        const ops = await getSessionFileOps(sessionId, path);
        const stitched = ops && buildSessionDiff(ops);
        if (ops && stitched)
          return { path, ...stitched, language: languageFor(path), source: 'session' };
      }
      const cwd = sessionId ? await getSessionCwd(sessionId) : null;
      if (!cwd) return { path, before: '', after: '', language: 'plaintext', source: 'disk' };
      return getDiffFor(cwd, path);
    },
  );

  ipcMain.handle(IPC.syncChanges, () => {
    // stub - no backend wired up yet in this UI-prototype phase
  });

  ipcMain.handle(IPC.markAsDone, () => {
    // stub
  });

  ipcMain.handle(IPC.clearTranscript, async (_event, sessionId: string) => {
    if (sessionId.startsWith('local:')) {
      await clearLocalTranscript(sessionId);
    } else if (isContinuableSession(sessionId)) {
      await deleteContinuation(sessionId);
    }
    agentService.clearHistory(sessionId);
    invalidateCache(`transcript:${sessionId}`);
    invalidateCache(`changes:${sessionId}`);
    invalidateCache(`files:${sessionId}`);
  });

  ipcMain.handle(IPC.checkpointsGet, async (_event, sessionId: string) => ({
    checkpoints: await listCheckpoints(sessionId),
  }));

  ipcMain.handle(IPC.checkpointsRevert, async (_event, sessionId: string) => {
    const report = await revertSessionChanges(sessionId);
    invalidateCache(`changes:${sessionId}`);
    invalidateCache(`files:${sessionId}`);
    invalidateCache(`diff:${sessionId}`);
    return { report };
  });

  ipcMain.handle(IPC.getProviders, () => ({ providers: readProviders() }));

  ipcMain.handle(IPC.saveProviders, (_event, providers: Provider[]) => ({
    providers: writeProviders(providers),
  }));

  ipcMain.handle(IPC.getMCPServers, async () => ({ servers: await readMCPServers() }));

  ipcMain.handle(IPC.saveMCPServers, async (_event, servers: Record<string, MCPServer>) => {
    await writeMCPServers(servers);
    void agentService.loadMCPToolsFromConfig(servers).catch((err) => {
      console.error('MCP tools reload failed:', err);
    });
  });

  ipcMain.handle(
    IPC.terminalCreate,
    (_event, sessionId: string | null, cols: number, rows: number) => {
      if (!mainWindow) throw new Error('No main window');
      return createTerminal(mainWindow, sessionId, cols, rows);
    },
  );

  ipcMain.on(IPC.terminalWrite, (_event, id: string, data: string) => {
    writeTerminal(id, data);
  });

  ipcMain.on(IPC.terminalResize, (_event, id: string, cols: number, rows: number) => {
    resizeTerminal(id, cols, rows);
  });

  ipcMain.on(IPC.terminalDispose, (_event, id: string) => {
    disposeTerminal(id);
  });

  ipcMain.handle(
    IPC.agentRun,
    async (_event, sessionId: string, text: string, images?: string[]) => {
      if (agentService.isBusy(sessionId)) {
        sendToRenderer(IPC.agentEvent, {
          type: 'error',
          sessionId,
          messageId: '',
          error: 'Session is already busy',
        });
        return;
      }
      const cwd = await getSessionCwd(sessionId);
      if (!cwd) {
        sendToRenderer(IPC.agentEvent, {
          type: 'error',
          sessionId,
          messageId: '',
          error: 'Could not determine the working directory for this session',
        });
        return;
      }
      runAgentTurn(sessionId, text, cwd, images);
    },
  );

  ipcMain.handle(IPC.agentCancel, async (_event, sessionId: string) => {
    agentService.cancel(sessionId);

    permissionService.cancelPendingPermissions(sessionId);
    cancelPendingQuestions(sessionId);

    const persistStep = transcriptWriter(sessionId);
    if (persistStep) {
      persistStep({
        id: `stopped-${Date.now()}`,
        heading: 'Stopped',
        finished: true,
        blocks: [{ kind: 'text', content: 'Cancelled by user.' }],
      });
      invalidateCache(`transcript:${sessionId}`);
      invalidateCache('sessions');
    }
  });

  ipcMain.handle(
    IPC.agentEnqueue,
    (_event, sessionId: string, text: string, delivery: 'steer' | 'queue') => {
      agentService.enqueueInput(sessionId, text, delivery);
    },
  );

  ipcMain.handle(IPC.agentModeGet, (_event, sessionId: string) => agentService.getMode(sessionId));

  ipcMain.handle(IPC.agentModeSet, (_event, sessionId: string, mode: AgentMode) => {
    agentService.setMode(sessionId, mode);
  });

  ipcMain.handle(IPC.agentsGet, async (_event, sessionId?: string) => {
    const globalAgents = listAgents().map((a) => serializeAgent(a.config));
    if (!sessionId) return { agents: globalAgents };

    const cwd = await getSessionCwd(sessionId);
    if (!cwd) return { agents: globalAgents };

    await refreshProjectAgents(cwd);
    const projectAgents = listProjectAgents(cwd).map((a) => serializeAgent(a.config));
    const projectNames = new Set(projectAgents.map((a) => a.name));
    return { agents: [...globalAgents.filter((a) => !projectNames.has(a.name)), ...projectAgents] };
  });

  ipcMain.handle(IPC.agentGenerate, async (_event, description: string) => {
    const config = await generateAgent(description);
    return serializeAgent(config);
  });

  ipcMain.handle(
    IPC.agentUpdate,
    async (_event, name: string, patch: Partial<AgentInfo>, sessionId?: string) => {
      if (await isProjectAgent(name, sessionId)) {
        throw new Error('Project agents are read-only in the app — edit the file directly');
      }
      const existing = getAgent(name);
      if (!existing) throw new Error(`Agent not found: ${name}`);
      if (existing.config.native) throw new Error('Built-in agents cannot be edited');

      const permission: PermissionConfig = { '*': 'allow' };
      for (const tool of patch.disabledTools ?? []) permission[tool] = 'deny';

      const config: SubAgentConfig = {
        ...existing.config,
        description: patch.description ?? existing.config.description,
        prompt: patch.prompt ?? existing.config.prompt,
        temperature: patch.temperature,
        topP: patch.topP,
        steps: patch.steps,
        permission,
      };

      await saveAgent(config);
      registerAgent(config);
      return serializeAgent(config);
    },
  );

  ipcMain.handle(IPC.agentDelete, async (_event, name: string, sessionId?: string) => {
    if (await isProjectAgent(name, sessionId)) {
      throw new Error('Project agents are read-only in the app — delete the file directly');
    }
    const existing = getAgent(name);
    if (!existing) return;
    if (existing.config.native) throw new Error('Built-in agents cannot be deleted');
    await deleteAgent(name);
  });

  ipcMain.handle(IPC.modelsGet, () => {
    const builtin: ModelChoice[] = BUILTIN_MODELS.map((m) => ({
      providerId: BUILTIN_PROVIDER_ID,
      providerName: BUILTIN_PROVIDER_NAME,
      modelId: m.id,
      modelName: m.name,
      vision: false,
    }));
    const xiaomiKey = readXiaomiApiKey();
    const xiaomiModels =
      xiaomiKey && cachedXiaomiModels.length > 0
        ? cachedXiaomiModels
        : xiaomiKey
          ? XIAOMI_MODELS
          : [];
    const xiaomi: ModelChoice[] = xiaomiModels.map((m) => ({
      providerId: XIAOMI_PROVIDER_ID,
      providerName: XIAOMI_PROVIDER_NAME,
      modelId: m.id,
      modelName: m.name,
      vision: false,
    }));
    const configured: ModelChoice[] = readProviders().flatMap((provider) =>
      provider.apiType !== 'chat-completions'
        ? []
        : provider.models
            .filter((m) => m.toolCalling)
            .map((m) => ({
              providerId: provider.id,
              providerName: provider.name,
              modelId: m.id,
              modelName: m.name || m.id,
              vision: m.vision,
            })),
    );
    return { models: [...builtin, ...xiaomi, ...configured], selected: readSelectedModel() };
  });

  ipcMain.handle(IPC.modelSelect, (_event, selected: SelectedModel | null) => {
    writeSelectedModel(selected);
  });

  ipcMain.handle(IPC.xiaomiApiKeyGet, () => readXiaomiApiKey());
  ipcMain.handle(IPC.xiaomiApiKeySave, async (_event, apiKey: string) => {
    writeXiaomiApiKey(apiKey);
    await refreshXiaomiModels(apiKey);
  });
  ipcMain.handle(IPC.xiaomiModelsFetch, async () => {
    const apiKey = readXiaomiApiKey();
    if (!apiKey) return { models: [], error: 'No API key configured' };
    const models = await refreshXiaomiModels(apiKey);
    return { models };
  });

  ipcMain.on(IPC.permissionResponse, (_event, response: PermissionResponsePayload) => {
    permissionService.handleResponse(response);
  });

  ipcMain.handle(IPC.permissionRulesGet, () => ({ rules: permissionService.listRules() }));

  ipcMain.handle(IPC.permissionRuleDelete, (_event, key: string) => {
    permissionService.deleteRule(key);
  });

  ipcMain.handle(IPC.permissionPatternsGet, () => ({
    patterns: readPermissionPatterns(),
  }));

  ipcMain.handle(IPC.permissionPatternsSave, (_event, patterns: PermissionPatternRule[]) => {
    writePermissionPatterns(patterns);
    permissionService.loadPatternRules(patterns);
  });

  ipcMain.on(IPC.questionResponse, (_event, questionId: string, answers: string[]) => {
    handleQuestionResponse(questionId, answers);
  });

  ipcMain.handle(IPC.commandsGet, async (_event, sessionId: string) => {
    const cwd = (await getSessionCwd(sessionId)) ?? process.cwd();
    return { commands: await loadCustomCommands(cwd) };
  });

  ipcMain.handle(
    IPC.commandRun,
    async (_event, sessionId: string, commandId: string, args?: Record<string, string>) => {
      const cwd = await getSessionCwd(sessionId);
      if (!cwd) {
        sendToRenderer(IPC.agentEvent, {
          type: 'error',
          sessionId,
          messageId: '',
          error: 'Could not determine the working directory for this session',
        });
        return;
      }
      const commands = await loadCustomCommands(cwd);
      const command = commands.find((c) => c.id === commandId);
      if (!command) {
        sendToRenderer(IPC.agentEvent, {
          type: 'error',
          sessionId,
          messageId: '',
          error: `Custom command not found: ${commandId}`,
        });
        return;
      }
      const text = resolveCommandArgs(command.content, args || {});
      runAgentTurn(sessionId, text, cwd);
    },
  );

  ipcMain.handle(IPC.skillsGet, async (_event, sessionId: string) => {
    const cwd = (await getSessionCwd(sessionId)) ?? process.cwd();
    await refreshProjectSkills(cwd);
    return {
      skills: listProjectSkills(cwd).map((s) => ({
        name: s.name,
        description: s.description,
        scope: s.scope,
      })),
    };
  });

  ipcMain.handle(
    IPC.skillsRun,
    async (_event, sessionId: string, skillName: string, args?: string) => {
      const cwd = await getSessionCwd(sessionId);
      if (!cwd) {
        sendToRenderer(IPC.agentEvent, {
          type: 'error',
          sessionId,
          messageId: '',
          error: 'Could not determine the working directory for this session',
        });
        return;
      }
      await refreshProjectSkills(cwd);
      const skill = getSkill(skillName, cwd);
      if (!skill) {
        sendToRenderer(IPC.agentEvent, {
          type: 'error',
          sessionId,
          messageId: '',
          error: `Skill not found: ${skillName}`,
        });
        return;
      }
      const body = await loadSkillContent(skill, cwd);
      if (body === null) {
        sendToRenderer(IPC.agentEvent, {
          type: 'error',
          sessionId,
          messageId: '',
          error: `Failed to load skill content: ${skillName}`,
        });
        return;
      }
      const skillPrompt = args
        ? `<skill name="${skillName}">\n${body}\n\nUser request: ${args}\n</skill>`
        : `<skill name="${skillName}">\n${body}\n</skill>`;
      runAgentTurn(sessionId, skillPrompt, cwd);
    },
  );

  ipcMain.handle(IPC.sessionCwd, async (_event, sessionId: string) => {
    const cwd = await getSessionCwd(sessionId);
    return cwd ?? '';
  });

  ipcMain.handle(IPC.editorOpen, (_event, initialContent?: string) =>
    openExternalEditor(initialContent),
  );

  ipcMain.handle(IPC.editorGetAvailable, () => ({ editor: getAvailableEditor() }));

  ipcMain.handle(IPC.dialogOpenDirectory, async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Project Directory',
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { path: '', cancelled: true };
    }
    return { path: result.filePaths[0], cancelled: false };
  });

  ipcMain.handle(IPC.todosGet, (_event, sessionId: string) => ({ todos: getTodos(sessionId) }));
}
