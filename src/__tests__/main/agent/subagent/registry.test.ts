import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  initRegistry,
  registerAgent,
  unregisterAgent,
  getAgent,
  getAgentNames,
  listAgents,
  listSubAgents,
  listPrimaryAgents,
  getAgentPermission,
} from '../../../../main/agent/subagent/registry';
import { refreshProjectAgents } from '../../../../main/agent/subagent/projectStore';
import type { SubAgentConfig } from '../../../../main/agent/subagent/types';
import { DEFAULT_SUBAGENTS } from '../../../../main/agent/subagent/types';

describe('registry', () => {
  beforeEach(() => {
    initRegistry();
  });

  it('initializes with default agents', () => {
    const names = getAgentNames();
    expect(names.length).toBeGreaterThanOrEqual(DEFAULT_SUBAGENTS.length);
    expect(names).toContain('build');
    expect(names).toContain('plan');
    expect(names).toContain('general');
    expect(names).toContain('explore');
  });

  it('registers a new agent', () => {
    const config: SubAgentConfig = {
      name: 'custom',
      description: 'Custom agent',
      mode: 'subagent',
    };
    registerAgent(config);
    expect(getAgent('custom')).toBeDefined();
    expect(getAgent('custom')!.config.name).toBe('custom');
  });

  it('unregisters an agent', () => {
    expect(unregisterAgent('build')).toBe(true);
    expect(getAgent('build')).toBeUndefined();
  });

  it('returns false when unregistering non-existent agent', () => {
    expect(unregisterAgent('nonexistent')).toBe(false);
  });

  it('returns undefined for non-existent agent', () => {
    expect(getAgent('nonexistent')).toBeUndefined();
  });

  it('lists sub-agents', () => {
    const subagents = listSubAgents();
    expect(subagents.every((a) => a.config.mode === 'subagent' || a.config.mode === 'all')).toBe(
      true,
    );
    expect(subagents.some((a) => a.config.name === 'general')).toBe(true);
    expect(subagents.some((a) => a.config.name === 'explore')).toBe(true);
    expect(subagents.some((a) => a.config.name === 'plan')).toBe(true);
  });

  it('lists primary agents', () => {
    const primary = listPrimaryAgents();
    expect(primary.every((a) => a.config.mode === 'primary' || a.config.mode === 'all')).toBe(true);
    expect(primary.some((a) => a.config.name === 'build')).toBe(true);
    expect(primary.some((a) => a.config.name === 'plan')).toBe(true);
  });

  it('excludes hidden agents from listAgents', () => {
    const agents = listAgents();
    expect(agents.every((a) => !a.config.hidden)).toBe(true);
  });

  it('filters by mode in listAgents, including mode-all agents in both', () => {
    const primary = listAgents('primary');
    expect(primary.every((a) => a.config.mode === 'primary' || a.config.mode === 'all')).toBe(true);
    const sub = listAgents('subagent');
    expect(sub.every((a) => a.config.mode === 'subagent' || a.config.mode === 'all')).toBe(true);
    expect(primary.some((a) => a.config.mode === 'all')).toBe(true);
    expect(sub.some((a) => a.config.mode === 'all')).toBe(true);
  });

  it('gets agent permission config', () => {
    const perm = getAgentPermission('build');
    expect(perm).toBeDefined();
    expect(perm!['*']).toBe('allow');
  });

  it('returns undefined permission for non-existent agent', () => {
    expect(getAgentPermission('nonexistent')).toBeUndefined();
  });

  it('prefers a project-scoped agent over a global one of the same name when cwd is given', async () => {
    registerAgent({ name: 'reviewer', description: 'Global reviewer', mode: 'subagent' });

    const dir = mkdtempSync(join(tmpdir(), 'drenn-reg-'));
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    writeFileSync(
      join(dir, '.claude', 'agents', 'reviewer.md'),
      `---\ndescription: Project reviewer.\n---\nBody.`,
    );
    await refreshProjectAgents(dir);

    expect(getAgent('reviewer')!.config.description).toBe('Global reviewer');
    expect(getAgent('reviewer', dir)!.config.description).toBe('Project reviewer.');
    expect(getAgent('reviewer', '/no/such/project')!.config.description).toBe('Global reviewer');
  });
});
