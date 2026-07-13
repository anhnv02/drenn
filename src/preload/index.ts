import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type AgentWindowApi,
  type TerminalDataPush,
  type TerminalExitPush,
  type AgentEventPayload,
  type PermissionRequestPayload,
  type BackgroundJobPush,
} from '../shared/ipc';

const api: AgentWindowApi = {
  getSessions: () => ipcRenderer.invoke(IPC.getSessions),
  createSession: (projectName, sourceSessionId) =>
    ipcRenderer.invoke(IPC.createSession, projectName, sourceSessionId),
  deleteSession: (sessionId) => ipcRenderer.invoke(IPC.deleteSession, sessionId),
  getChanges: (sessionId) => ipcRenderer.invoke(IPC.getChanges, sessionId),
  getFiles: (sessionId) => ipcRenderer.invoke(IPC.getFiles, sessionId),
  getTranscript: (sessionId) => ipcRenderer.invoke(IPC.getTranscript, sessionId),
  clearTranscript: (sessionId) => ipcRenderer.invoke(IPC.clearTranscript, sessionId),
  getDiff: (sessionId, path, scope) => ipcRenderer.invoke(IPC.getDiff, sessionId, path, scope),
  syncChanges: () => ipcRenderer.invoke(IPC.syncChanges),
  markAsDone: () => ipcRenderer.invoke(IPC.markAsDone),
  getCheckpoints: (sessionId) => ipcRenderer.invoke(IPC.checkpointsGet, sessionId),
  revertSessionChanges: (sessionId) => ipcRenderer.invoke(IPC.checkpointsRevert, sessionId),
  getProviders: () => ipcRenderer.invoke(IPC.getProviders),
  saveProviders: (providers) => ipcRenderer.invoke(IPC.saveProviders, providers),
  getMCPServers: () => ipcRenderer.invoke(IPC.getMCPServers),
  saveMCPServers: (servers) => ipcRenderer.invoke(IPC.saveMCPServers, servers),
  createTerminal: (sessionId, cols, rows) =>
    ipcRenderer.invoke(IPC.terminalCreate, sessionId, cols, rows),
  writeTerminal: (id, data) => ipcRenderer.send(IPC.terminalWrite, id, data),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send(IPC.terminalResize, id, cols, rows),
  disposeTerminal: (id) => ipcRenderer.send(IPC.terminalDispose, id),
  onTerminalData: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: TerminalDataPush) =>
      handler(payload);
    ipcRenderer.on(IPC.terminalData, listener);
    return () => ipcRenderer.removeListener(IPC.terminalData, listener);
  },
  onTerminalExit: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: TerminalExitPush) =>
      handler(payload);
    ipcRenderer.on(IPC.terminalExit, listener);
    return () => ipcRenderer.removeListener(IPC.terminalExit, listener);
  },
  // Agent
  runAgent: (sessionId, text, images) => ipcRenderer.invoke(IPC.agentRun, sessionId, text, images),
  cancelAgent: (sessionId) => ipcRenderer.invoke(IPC.agentCancel, sessionId),
  enqueueInput: (sessionId, text, delivery) =>
    ipcRenderer.invoke(IPC.agentEnqueue, sessionId, text, delivery),
  getAgentMode: (sessionId) => ipcRenderer.invoke(IPC.agentModeGet, sessionId),
  setAgentMode: (sessionId, mode) => ipcRenderer.invoke(IPC.agentModeSet, sessionId, mode),
  getAgents: (sessionId) => ipcRenderer.invoke(IPC.agentsGet, sessionId),
  generateAgent: (description) => ipcRenderer.invoke(IPC.agentGenerate, description),
  updateAgent: (name, patch, sessionId) =>
    ipcRenderer.invoke(IPC.agentUpdate, name, patch, sessionId),
  deleteAgent: (name, sessionId) => ipcRenderer.invoke(IPC.agentDelete, name, sessionId),
  // Model selection
  getModels: () => ipcRenderer.invoke(IPC.modelsGet),
  selectModel: (selected) => ipcRenderer.invoke(IPC.modelSelect, selected),
  // Xiaomi API key
  getXiaomiApiKey: () => ipcRenderer.invoke(IPC.xiaomiApiKeyGet),
  saveXiaomiApiKey: (apiKey) => ipcRenderer.invoke(IPC.xiaomiApiKeySave, apiKey),
  fetchXiaomiModels: () => ipcRenderer.invoke(IPC.xiaomiModelsFetch),
  onAgentEvent: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, event: AgentEventPayload) =>
      handler(event);
    ipcRenderer.on(IPC.agentEvent, listener);
    return () => ipcRenderer.removeListener(IPC.agentEvent, listener);
  },
  // Permission
  respondPermission: (response) => {
    ipcRenderer.send(IPC.permissionResponse, response);
  },
  onPermissionRequest: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, request: PermissionRequestPayload) =>
      handler(request);
    ipcRenderer.on(IPC.permissionRequest, listener);
    return () => ipcRenderer.removeListener(IPC.permissionRequest, listener);
  },
  onPermissionClearSession: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { sessionId: string }) =>
      handler(payload);
    ipcRenderer.on(IPC.permissionClearSession, listener);
    return () => ipcRenderer.removeListener(IPC.permissionClearSession, listener);
  },
  getPermissionRules: () => ipcRenderer.invoke(IPC.permissionRulesGet),
  deletePermissionRule: (key) => ipcRenderer.invoke(IPC.permissionRuleDelete, key),
  getPermissionPatterns: () => ipcRenderer.invoke(IPC.permissionPatternsGet),
  savePermissionPatterns: (patterns) => ipcRenderer.invoke(IPC.permissionPatternsSave, patterns),
  // Question
  respondQuestion: (questionId, answers) => {
    ipcRenderer.send(IPC.questionResponse, questionId, answers);
    return Promise.resolve();
  },
  onQuestionRequest: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, request: any) => handler(request);
    ipcRenderer.on(IPC.questionRequest, listener);
    return () => ipcRenderer.removeListener(IPC.questionRequest, listener);
  },
  // Commands
  getCommands: (sessionId) => ipcRenderer.invoke(IPC.commandsGet, sessionId),
  runCommand: (sessionId, commandId, args) =>
    ipcRenderer.invoke(IPC.commandRun, sessionId, commandId, args),
  // Session cwd
  getSessionCwd: (sessionId) => ipcRenderer.invoke(IPC.sessionCwd, sessionId),
  // Skills
  getSkills: (sessionId) => ipcRenderer.invoke(IPC.skillsGet, sessionId),
  runSkill: (sessionId, skillName, args) =>
    ipcRenderer.invoke(IPC.skillsRun, sessionId, skillName, args),
  // External Editor
  openEditor: (initialContent) => ipcRenderer.invoke(IPC.editorOpen, initialContent),
  getAvailableEditor: () => ipcRenderer.invoke(IPC.editorGetAvailable),
  // Background sub-agent jobs
  onBackgroundJob: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: BackgroundJobPush) =>
      handler(payload);
    ipcRenderer.on(IPC.backgroundJobEvent, listener);
    return () => ipcRenderer.removeListener(IPC.backgroundJobEvent, listener);
  },
};

contextBridge.exposeInMainWorld('api', api);
