import type {
  AgentInfo,
  AgentMode,
  CustomCommand,
  DiffContent,
  DiffScope,
  FileChange,
  MCPServer,
  ModelChoice,
  PermissionPatternRule,
  PermissionRule,
  ProjectGroup,
  Provider,
  SelectedModel,
  Session,
  SkillInfo,
  Transcript,
} from './types';

export const IPC = {
  getSessions: 'sessions:get',
  createSession: 'sessions:create',
  deleteSession: 'sessions:delete',
  getChanges: 'changes:get',
  getFiles: 'files:get',
  getTranscript: 'transcript:get',
  clearTranscript: 'transcript:clear',
  getDiff: 'diff:get',
  syncChanges: 'changes:sync',
  markAsDone: 'session:markAsDone',
  checkpointsGet: 'checkpoints:get',
  checkpointsRevert: 'checkpoints:revert',
  getProviders: 'providers:get',
  saveProviders: 'providers:save',
  getMCPServers: 'mcp:get',
  saveMCPServers: 'mcp:save',
  terminalCreate: 'terminal:create',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalDispose: 'terminal:dispose',
  terminalData: 'terminal:data',
  terminalExit: 'terminal:exit',
  agentRun: 'agent:run',
  agentCancel: 'agent:cancel',
  agentEnqueue: 'agent:enqueue',
  agentEvent: 'agent:event',
  agentModeGet: 'agent:mode:get',
  agentModeSet: 'agent:mode:set',
  agentsGet: 'agents:get',
  agentGenerate: 'agents:generate',
  agentUpdate: 'agents:update',
  agentDelete: 'agents:delete',
  modelsGet: 'models:get',
  modelSelect: 'models:select',
  xiaomiApiKeyGet: 'xiaomi:apiKey:get',
  xiaomiApiKeySave: 'xiaomi:apiKey:save',
  xiaomiModelsFetch: 'xiaomi:models:fetch',
  permissionRequest: 'permission:request',
  permissionResponse: 'permission:response',
  permissionClearSession: 'permission:clear-session',
  permissionRulesGet: 'permission:rules:get',
  permissionRuleDelete: 'permission:rules:delete',
  permissionPatternsGet: 'permission:patterns:get',
  permissionPatternsSave: 'permission:patterns:save',
  commandsGet: 'commands:get',
  commandRun: 'command:run',
  editorOpen: 'editor:open',
  editorGetAvailable: 'editor:getAvailable',
  questionRequest: 'question:request',
  questionResponse: 'question:response',
  skillsGet: 'skills:get',
  skillsRun: 'skills:run',
  backgroundJobEvent: 'background:job',
  sessionCwd: 'session:cwd',
  dialogOpenDirectory: 'dialog:openDirectory',
} as const;

export interface SessionsResponse {
  projects: ProjectGroup[];
  activeSessionId: string;
}

export interface ChangesResponse {
  files: FileChange[];
  totals: { added: number; removed: number };
  current: FileChange[];
  currentTotals: { added: number; removed: number };
}

export interface ProvidersResponse {
  providers: Provider[];
}

export interface XiaomiModelsResponse {
  models: { id: string; name: string }[];
  error?: string;
}

export interface TerminalCreateResponse {
  id: string;
  cwd: string;
}

export interface BackgroundJobPush {
  sessionId: string;
  jobId: string;
  status: 'completed' | 'error' | 'cancelled';
  error?: string;
}

export interface TerminalDataPush {
  id: string;
  data: string;
}

export interface TerminalExitPush {
  id: string;
  exitCode: number;
}

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

export interface AgentEventPayload {
  type: AgentEventType;
  sessionId: string;
  messageId: string;
  content?: string;
  toolCall?: {
    id: string;
    name: string;
    input: string;
  };
  toolResult?: {
    content: string;
    isError: boolean;
    metadata?: Record<string, any>;
  };
  error?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  title?: string;
  mode?: AgentMode;
}

export interface AgentRunRequest {
  sessionId: string;
  text: string;
  cwd: string;
}

export interface PermissionRequestPayload {
  id: string;
  sessionId: string;
  messageId: string;
  toolName: string;
  action: string;
  path?: string;
  description: string;
  params?: Record<string, any>;
  diff?: string;
  resource: string;
  cwd: string;
  external?: boolean;
}

export interface PermissionResponsePayload {
  requestId: string;
  approved: boolean;
  remember: boolean;
  rememberPrefix?: string;
  feedback?: string;
  updatedMode?: 'default' | 'acceptEdits';
}

export interface ModelsResponse {
  models: ModelChoice[];
  selected: SelectedModel | null;
}

export interface CheckpointInfo {
  id: string;
  filePath: string;
  tool: string;
  createdAt: number;
  existed: boolean;
}

export interface RevertReportEntry {
  filePath: string;
  action: 'restored' | 'deleted' | 'failed';
  error?: string;
}

export interface AgentWindowApi {
  getSessions(): Promise<SessionsResponse>;
  createSession(projectName: string, sourceSessionId: string, cwd?: string): Promise<Session>;
  deleteSession(sessionId: string): Promise<void>;
  getChanges(sessionId: string | null): Promise<ChangesResponse>;
  getFiles(sessionId: string | null): Promise<{ files: FileChange[] }>;
  getTranscript(sessionId: string): Promise<Transcript>;
  clearTranscript(sessionId: string): Promise<void>;
  getDiff(sessionId: string | null, path: string, scope?: DiffScope): Promise<DiffContent>;
  syncChanges(): Promise<void>;
  markAsDone(): Promise<void>;
  getCheckpoints(sessionId: string): Promise<{ checkpoints: CheckpointInfo[] }>;
  revertSessionChanges(sessionId: string): Promise<{ report: RevertReportEntry[] }>;
  getProviders(): Promise<ProvidersResponse>;
  saveProviders(providers: Provider[]): Promise<ProvidersResponse>;
  getMCPServers(): Promise<{ servers: Record<string, MCPServer> }>;
  saveMCPServers(servers: Record<string, MCPServer>): Promise<void>;
  createTerminal(
    sessionId: string | null,
    cols: number,
    rows: number,
  ): Promise<TerminalCreateResponse>;
  writeTerminal(id: string, data: string): void;
  resizeTerminal(id: string, cols: number, rows: number): void;
  disposeTerminal(id: string): void;
  onTerminalData(handler: (payload: TerminalDataPush) => void): () => void;
  onTerminalExit(handler: (payload: TerminalExitPush) => void): () => void;
  runAgent(sessionId: string, text: string, images?: string[]): Promise<void>;
  cancelAgent(sessionId: string): Promise<void>;
  enqueueInput(sessionId: string, text: string, delivery: 'steer' | 'queue'): Promise<void>;
  onAgentEvent(handler: (event: AgentEventPayload) => void): () => void;
  getAgentMode(sessionId: string): Promise<AgentMode>;
  setAgentMode(sessionId: string, mode: AgentMode): Promise<void>;
  getAgents(sessionId?: string): Promise<{ agents: AgentInfo[] }>;
  generateAgent(description: string): Promise<AgentInfo>;
  updateAgent(name: string, patch: Partial<AgentInfo>, sessionId?: string): Promise<AgentInfo>;
  deleteAgent(name: string, sessionId?: string): Promise<void>;
  getModels(): Promise<ModelsResponse>;
  selectModel(selected: SelectedModel | null): Promise<void>;
  getXiaomiApiKey(): Promise<string>;
  saveXiaomiApiKey(apiKey: string): Promise<void>;
  fetchXiaomiModels(): Promise<XiaomiModelsResponse>;
  respondPermission(response: PermissionResponsePayload): void;
  onPermissionRequest(handler: (request: PermissionRequestPayload) => void): () => void;
  onPermissionClearSession(handler: (payload: { sessionId: string }) => void): () => void;
  getPermissionRules(): Promise<{ rules: PermissionRule[] }>;
  deletePermissionRule(key: string): Promise<void>;
  getPermissionPatterns(): Promise<{ patterns: PermissionPatternRule[] }>;
  savePermissionPatterns(patterns: PermissionPatternRule[]): Promise<void>;
  respondQuestion(questionId: string, answers: string[]): Promise<void>;
  onQuestionRequest(handler: (request: any) => void): () => void;
  onBackgroundJob(handler: (payload: BackgroundJobPush) => void): () => void;
  getCommands(sessionId: string): Promise<{ commands: CustomCommand[] }>;
  runCommand(sessionId: string, commandId: string, args?: Record<string, string>): Promise<void>;
  getSessionCwd(sessionId: string): Promise<string>;
  openDirectory(): Promise<{ path: string; cancelled: boolean }>;
  getSkills(sessionId: string): Promise<{ skills: SkillInfo[] }>;
  runSkill(sessionId: string, skillName: string, args?: string): Promise<void>;
  openEditor(initialContent?: string): Promise<{ content: string; cancelled: boolean }>;
  getAvailableEditor(): Promise<{ editor: string | null }>;
}
