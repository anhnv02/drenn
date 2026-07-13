export type { SubAgentConfig, SubAgent, TaskParams } from './types';
export { DEFAULT_SUBAGENTS } from './types';
export {
  initRegistry,
  registerAgent,
  unregisterAgent,
  getAgent,
  listAgents,
  listSubAgents,
  listPrimaryAgents,
  getAgentPermission,
  getAgentNames,
} from './registry';
export { deriveSubagentSessionPermission, modeToPermissionRuleset } from './permissions';
export type { SubAgentPermissionInput } from './permissions';
export { BackgroundJobService, backgroundJobService } from './background';
export type { BackgroundJob, BackgroundJobStatus, BackgroundJobResult } from './background';
export { SessionManager, sessionManager } from './sessions';
export type { AgentSession } from './sessions';
export { generateAgent, getExistingAgentNames } from './generator';
export { initPersistedAgents, loadPersistedAgents, saveAgent, deleteAgent } from './store';
export {
  refreshProjectAgents,
  listProjectAgents,
  getProjectAgentsPromptSection,
} from './projectStore';
