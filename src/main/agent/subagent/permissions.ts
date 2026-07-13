import type { PermissionRuleset } from '../../permission/ruleset';
import { merge, fromConfig } from '../../permission/ruleset';
import type { SubAgentConfig } from './types';
import type { AgentMode } from '../../../shared/types';

const PLAN_MODE_DENIES = ['edit', 'write', 'apply_patch'];

export function modeToPermissionRuleset(mode: AgentMode): PermissionRuleset {
  if (mode !== 'plan') return [];
  return PLAN_MODE_DENIES.map((permission) => ({
    permission,
    pattern: '*',
    action: 'deny' as const,
  }));
}

export interface SubAgentPermissionInput {
  parentSessionPermission: PermissionRuleset;
  subagent: SubAgentConfig;
}

export function deriveSubagentSessionPermission(input: SubAgentPermissionInput): PermissionRuleset {
  const subagentPermission = input.subagent.permission ? fromConfig(input.subagent.permission) : [];

  const parentDenyRules = input.parentSessionPermission.filter(
    (rule) => rule.action === 'deny' || rule.permission === 'external_directory',
  );

  const defaultDenies: PermissionRuleset = [];
  if (!input.subagent.permission?.todowrite) {
    defaultDenies.push({
      permission: 'todowrite',
      pattern: '*',
      action: 'deny',
    });
  }
  if (!input.subagent.permission?.task) {
    defaultDenies.push({
      permission: 'task',
      pattern: '*',
      action: 'deny',
    });
  }

  const filteredDefaultDenies = defaultDenies.filter(
    (deny) =>
      !parentDenyRules.some(
        (rule) =>
          rule.permission === deny.permission &&
          rule.pattern === deny.pattern &&
          rule.action === deny.action,
      ),
  );

  return merge(subagentPermission, filteredDefaultDenies, parentDenyRules);
}
