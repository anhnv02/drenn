import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadProjectInstructions,
  loadGitContext,
  buildSystemPrompt,
} from '../../../main/agent/systemPrompt';
import { refreshProjectAgents } from '../../../main/agent/subagent/projectStore';

describe('project instructions', () => {
  it('loads CLAUDE.md into the system prompt after loadProjectInstructions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'drenn-sp-'));
    writeFileSync(join(dir, 'CLAUDE.md'), 'Always use tabs in this project.');
    await loadProjectInstructions(dir);
    const prompt = buildSystemPrompt(dir);
    expect(prompt).toContain('Always use tabs in this project.');
    expect(prompt).toContain(join(dir, 'CLAUDE.md'));
    expect(prompt).toContain('override default behavior');
    expect(prompt).toContain(`Working directory: ${dir}`);
    expect(prompt).toContain('# Tone and style');
    expect(prompt).toContain('# Tool usage policy');
  });

  it('includes AGENTS.md and CLAUDE.local.md as separate sections', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'drenn-sp-'));
    writeFileSync(join(dir, 'AGENTS.md'), 'Agents guidance here.');
    writeFileSync(join(dir, 'CLAUDE.local.md'), 'Local-only guidance.');
    await loadProjectInstructions(dir);
    const prompt = buildSystemPrompt(dir);
    expect(prompt).toContain('Agents guidance here.');
    expect(prompt).toContain('Local-only guidance.');
  });

  it('keeps the summary section when instructions are present', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'drenn-sp-'));
    writeFileSync(join(dir, 'CLAUDE.md'), 'Project rule.');
    await loadProjectInstructions(dir);
    const prompt = buildSystemPrompt(dir, undefined, 'Earlier we discussed X.');
    expect(prompt).toContain('Project rule.');
    expect(prompt).toContain('# Previous conversation summary');
    expect(prompt).toContain('Earlier we discussed X.');
  });
});

describe('project sub-agents in the system prompt', () => {
  it('lists project agents (.claude/agents) once refreshed, and omits the section when there are none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'drenn-sp-'));
    expect(buildSystemPrompt(dir)).not.toContain('# Project sub-agents');

    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    writeFileSync(
      join(dir, '.claude', 'agents', 'reviewer.md'),
      `---\ndescription: Reviews code for quality issues.\ntools: Read, Grep\n---\nBe thorough.`,
    );
    await refreshProjectAgents(dir);

    const prompt = buildSystemPrompt(dir);
    expect(prompt).toContain('# Project sub-agents');
    expect(prompt).toContain('- reviewer: Reviews code for quality issues.');
  });
});

describe('git context', () => {
  it('reports non-repo directories without a gitStatus section', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'drenn-sp-'));
    await loadGitContext(dir);
    const prompt = buildSystemPrompt(dir);
    expect(prompt).toContain('Is directory a git repo: No');
    expect(prompt).not.toContain('# gitStatus');
  });

  it('renders branch, status, and recent commits for a repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'drenn-sp-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
    git('init', '-b', 'main');
    git(
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '--allow-empty',
      '-m',
      'first commit',
    );
    writeFileSync(join(dir, 'new.txt'), 'x');

    await loadGitContext(dir);
    const prompt = buildSystemPrompt(dir);
    expect(prompt).toContain('Is directory a git repo: Yes');
    expect(prompt).toContain('# gitStatus');
    expect(prompt).toContain('Current branch: main');
    expect(prompt).toContain('?? new.txt');
    expect(prompt).toContain('first commit');
  });
});
