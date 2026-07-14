export type SessionSource = 'claude' | 'opencode' | 'copilot' | 'local';

export interface Session {
  id: string;
  title: string;
  projectName: string;
  added: number;
  removed: number;
  updatedAt: string;
  source: SessionSource;
}

export interface ProjectGroup {
  name: string;
  sessions: Session[];
}

export type FileStatus = 'M' | 'A' | 'D';

export interface FileChange {
  path: string;
  dir: string;
  name: string;
  added: number;
  removed: number;
  status?: FileStatus;
  ignored?: boolean;
}

export type DiffScope = 'session' | 'disk';

export interface EditOp {
  before: string;
  after: string;
}

export interface DiffContent {
  path: string;
  before: string;
  after: string;
  language: string;
  source?: DiffScope;
}

export interface TranscriptBlock {
  kind: 'text' | 'code' | 'tool' | 'image' | 'file';
  content: string;
  lang?: string;
}

export interface TranscriptStep {
  id: string;
  heading: string;
  finished: boolean;
  blocks: TranscriptBlock[];
}

export interface Transcript {
  sessionId: string;
  steps: TranscriptStep[];
}

export type AgentMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

export interface PermissionRule {
  key: string;
  cwd: string;
  toolName: string;
  kind: 'exact' | 'prefix';
  value: string;
}

export interface PermissionPatternRule {
  pattern: string;
  action: 'allow' | 'ask' | 'deny';
}

export interface AgentInfo {
  name: string;
  description: string;
  mode: 'primary' | 'subagent' | 'all';
  temperature?: number;
  topP?: number;
  steps?: number;
  color?: string;
  disabledTools?: string[];
  prompt?: string;
  native?: boolean;
  scope?: 'project';
  origin?: string;
}

export interface SelectedModel {
  providerId: string;
  modelId: string;
}

export interface ModelChoice {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  contextWindow?: number;
  vision?: boolean;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
}

export const DEFAULT_CONTEXT_WINDOW = 128000;

export type ApiType = 'chat-completions' | 'responses';

export interface ProviderModel {
  id: string;
  name: string;
  url: string;
  toolCalling: boolean;
  streaming: boolean;
  maxTokens: number;
  requestHeaders: Record<string, string>;
  temperature?: number;
  topP?: number;
  vision?: boolean;
}

export interface Provider {
  id: string;
  name: string;
  vendor: string;
  apiKey: string;
  apiType: ApiType;
  models: ProviderModel[];
}

export interface CustomCommand {
  id: string;
  title: string;
  description: string;
  content: string;
  args?: CommandArg[];
}

export interface CommandArg {
  name: string;
  value?: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  scope: 'global' | 'project';
}

export type MCPType = 'stdio' | 'sse';

export interface MCPServer {
  command: string;
  env: string[];
  args: string[];
  type: MCPType;
  url: string;
  headers: Record<string, string>;
  enabled?: boolean;
}
