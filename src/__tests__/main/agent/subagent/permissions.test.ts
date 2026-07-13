import { describe, it, expect } from 'vitest';
import {
  modeToPermissionRuleset,
  deriveSubagentSessionPermission,
} from '../../../../main/agent/subagent/permissions';
import { DEFAULT_SUBAGENTS } from '../../../../main/agent/subagent/types';
import { evaluatePermission } from '../../../../main/permission/ruleset';

describe('modeToPermissionRuleset', () => {
  it('returns empty ruleset for default mode', () => {
    expect(modeToPermissionRuleset('default')).toEqual([]);
  });

  it('returns empty ruleset for acceptEdits mode', () => {
    expect(modeToPermissionRuleset('acceptEdits')).toEqual([]);
  });

  it('returns deny rules for plan mode', () => {
    const rules = modeToPermissionRuleset('plan');
    expect(rules.length).toBeGreaterThan(0);
    const ruleNames = rules.map((r) => r.permission);
    expect(ruleNames).toContain('edit');
    expect(ruleNames).toContain('write');
    expect(ruleNames).toContain('apply_patch');
    expect(ruleNames).not.toContain('bash');
    expect(rules.every((r) => r.action === 'deny')).toBe(true);
  });
});

describe('deriveSubagentSessionPermission', () => {
  it('derives permission for explore agent', () => {
    const explore = DEFAULT_SUBAGENTS.find((a) => a.name === 'explore')!;
    const rules = deriveSubagentSessionPermission({
      parentSessionPermission: [],
      subagent: explore,
    });
    expect(evaluatePermission(rules, 'grep', 'pattern')).toBe('allow');
    expect(evaluatePermission(rules, 'glob', '*.ts')).toBe('allow');
    expect(evaluatePermission(rules, 'ls', '/path')).toBe('allow');
    expect(evaluatePermission(rules, 'view', '/file')).toBe('allow');
  });

  it('inherits parent deny rules', () => {
    const explore = DEFAULT_SUBAGENTS.find((a) => a.name === 'explore')!;
    const parentDenies = modeToPermissionRuleset('plan');
    const rules = deriveSubagentSessionPermission({
      parentSessionPermission: parentDenies,
      subagent: explore,
    });
    expect(evaluatePermission(rules, 'edit', 'file.ts')).toBe('deny');
    expect(evaluatePermission(rules, 'write', 'file.ts')).toBe('deny');
    expect(evaluatePermission(rules, 'bash', 'git log')).toBe('allow');
  });

  it('adds default denies for todowrite and task when not explicitly allowed', () => {
    const config = {
      name: 'test',
      description: 'Test agent',
      mode: 'subagent' as const,
      permission: { '*': 'allow' },
    };
    const rules = deriveSubagentSessionPermission({
      parentSessionPermission: [],
      subagent: config,
    });
    expect(evaluatePermission(rules, 'todowrite', '*')).toBe('deny');
    expect(evaluatePermission(rules, 'task', '*')).toBe('deny');
  });

  it('does not add default deny when explicitly allowed', () => {
    const config = {
      name: 'test',
      description: 'Test agent',
      mode: 'subagent' as const,
      permission: { '*': 'allow', todowrite: 'allow', task: 'allow' },
    };
    const rules = deriveSubagentSessionPermission({
      parentSessionPermission: [],
      subagent: config,
    });
    expect(evaluatePermission(rules, 'todowrite', '*')).toBe('allow');
    expect(evaluatePermission(rules, 'task', '*')).toBe('allow');
  });

  it('handles agent with no permission config', () => {
    const config = {
      name: 'minimal',
      description: 'Minimal agent',
      mode: 'subagent' as const,
    };
    const rules = deriveSubagentSessionPermission({
      parentSessionPermission: [],
      subagent: config,
    });
    expect(evaluatePermission(rules, 'todowrite', '*')).toBe('deny');
    expect(evaluatePermission(rules, 'task', '*')).toBe('deny');
  });
});
