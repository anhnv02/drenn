import type { SubAgentConfig, SubAgent } from './types';
import { DEFAULT_SUBAGENTS } from './types';
import type { PermissionConfig } from '../../permission/ruleset';
import { getProjectAgent } from './projectStore';

const registry = new Map<string, SubAgent>();

export function initRegistry(): void {
  for (const config of DEFAULT_SUBAGENTS) {
    registerAgent(config);
  }
}

export function registerAgent(config: SubAgentConfig): void {
  registry.set(config.name, { config });
}

export function unregisterAgent(name: string): boolean {
  return registry.delete(name);
}

export function getAgent(name: string, cwd?: string): SubAgent | undefined {
  if (cwd) {
    const projectAgent = getProjectAgent(name, cwd);
    if (projectAgent) return projectAgent;
  }
  return registry.get(name);
}

export function getAgentNames(): string[] {
  return Array.from(registry.keys());
}

export function listAgents(mode?: 'primary' | 'subagent'): SubAgent[] {
  const agents = Array.from(registry.values());
  if (mode) {
    return agents.filter(
      (a) => (a.config.mode === mode || a.config.mode === 'all') && !a.config.hidden,
    );
  }
  return agents.filter((a) => !a.config.hidden);
}

export function listSubAgents(): SubAgent[] {
  return listAgents('subagent');
}

export function listPrimaryAgents(): SubAgent[] {
  return listAgents('primary');
}

export function getAgentPermission(agentName: string): PermissionConfig | undefined {
  const agent = getAgent(agentName);
  return agent?.config.permission;
}
