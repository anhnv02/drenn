import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadProjectAgentConfigs,
  refreshProjectAgents,
  getProjectAgent,
  listProjectAgents,
  getProjectAgentsPromptSection,
} from '../../../../main/agent/subagent/projectStore';

function makeProjectDir(): string {
  return mkdtempSync(join(tmpdir(), 'drenn-pa-'));
}

describe('loadProjectAgentConfigs', () => {
  it('returns an empty array when neither project directory exists', async () => {
    const dir = makeProjectDir();
    expect(await loadProjectAgentConfigs(dir)).toEqual([]);
  });

  it('parses a Claude Code .claude/agents/*.md file, mapping tools and model', async () => {
    const dir = makeProjectDir();
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    writeFileSync(
      join(dir, '.claude', 'agents', 'reviewer.md'),
      `---
description: Reviews code for quality and security issues.
tools: Read, Grep, Bash
model: sonnet
---

You are a meticulous code reviewer.`,
    );

    const configs = await loadProjectAgentConfigs(dir);
    expect(configs).toHaveLength(1);
    const [config] = configs;
    expect(config.name).toBe('reviewer');
    expect(config.mode).toBe('subagent');
    expect(config.description).toBe('Reviews code for quality and security issues.');
    expect(config.model).toBe('sonnet');
    expect(config.prompt).toBe('You are a meticulous code reviewer.');
    expect(config.scope).toBe('project');
    expect(config.origin).toBe('.claude/agents/reviewer.md');
    expect(config.permission).toEqual({ '*': 'deny', view: 'allow', grep: 'allow', bash: 'allow' });
  });

  it('leaves permission unset when tools is omitted (Claude Code: all tools)', async () => {
    const dir = makeProjectDir();
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    writeFileSync(
      join(dir, '.claude', 'agents', 'helper.md'),
      `---
description: General helper agent.
---
Body prompt.`,
    );

    const [config] = await loadProjectAgentConfigs(dir);
    expect(config.permission).toBeUndefined();
  });

  it('parses a .drenn/agent/*.md file with the full global schema', async () => {
    const dir = makeProjectDir();
    mkdirSync(join(dir, '.drenn', 'agent'), { recursive: true });
    writeFileSync(
      join(dir, '.drenn', 'agent', 'test-writer.md'),
      `---
description: Writes unit tests for changed files.
mode: subagent
temperature: 0.2
permission:
  write: allow
  bash: ask
---

Write focused unit tests.`,
    );

    const [config] = await loadProjectAgentConfigs(dir);
    expect(config.name).toBe('test-writer');
    expect(config.temperature).toBe(0.2);
    expect(config.permission).toEqual({ write: 'allow', bash: 'ask' });
    expect(config.scope).toBe('project');
    expect(config.origin).toBe('.drenn/agent/test-writer.md');
  });

  it('prefers .drenn/agent over .claude/agents on a name collision', async () => {
    const dir = makeProjectDir();
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    mkdirSync(join(dir, '.drenn', 'agent'), { recursive: true });
    writeFileSync(
      join(dir, '.claude', 'agents', 'shared.md'),
      `---\ndescription: From Claude Code format.\n---\nClaude prompt.`,
    );
    writeFileSync(
      join(dir, '.drenn', 'agent', 'shared.md'),
      `---\ndescription: From drenn format.\nmode: subagent\n---\nDrenn prompt.`,
    );

    const configs = await loadProjectAgentConfigs(dir);
    expect(configs).toHaveLength(1);
    expect(configs[0].description).toBe('From drenn format.');
    expect(configs[0].origin).toBe('.drenn/agent/shared.md');
  });
});

describe('project agent TTL cache', () => {
  it('refreshes, exposes agents via getProjectAgent/listProjectAgents, and builds a prompt section', async () => {
    const dir = makeProjectDir();
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    writeFileSync(
      join(dir, '.claude', 'agents', 'reviewer.md'),
      `---\ndescription: Reviews code.\n---\nBody.`,
    );

    await refreshProjectAgents(dir);
    expect(getProjectAgent('reviewer', dir)?.config.name).toBe('reviewer');
    expect(getProjectAgent('nonexistent', dir)).toBeUndefined();
    expect(listProjectAgents(dir).map((a) => a.config.name)).toEqual(['reviewer']);
    expect(getProjectAgentsPromptSection(dir)).toContain('- reviewer: Reviews code.');
  });

  it('serves the cached result within the TTL window even if the directory changes underneath it', async () => {
    const dir = makeProjectDir();
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    writeFileSync(
      join(dir, '.claude', 'agents', 'reviewer.md'),
      `---\ndescription: Reviews code.\n---\nBody.`,
    );

    await refreshProjectAgents(dir);
    expect(listProjectAgents(dir)).toHaveLength(1);

    rmSync(join(dir, '.claude'), { recursive: true, force: true });
    await refreshProjectAgents(dir);
    expect(listProjectAgents(dir)).toHaveLength(1);
  });

  it('returns an empty prompt section for a cwd with no cached agents', () => {
    const dir = makeProjectDir();
    expect(getProjectAgentsPromptSection(dir)).toBe('');
    expect(listProjectAgents(dir)).toEqual([]);
  });
});
