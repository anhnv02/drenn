import { promises as fs } from 'fs';
import { join } from 'path';
import type { SubAgentConfig, SubAgent } from './types';
import type { PermissionConfig } from '../../permission/ruleset';
import { parseAgentMarkdown, splitFrontmatter } from './store';

const PROJECT_AGENTS_TTL_MS = 15_000;
const projectAgentsCache = new Map<
  string,
  { agents: Map<string, SubAgentConfig>; loadedAt: number }
>();

const CLAUDE_TOOL_ALIASES: Record<string, string> = {
  Read: 'view',
  Edit: 'edit',
  Write: 'write',
  Bash: 'bash',
  Glob: 'glob',
  Grep: 'grep',
  WebFetch: 'fetch',
  WebSearch: 'websearch',
  Task: 'task',
  TodoWrite: 'todowrite',
};

async function readDirSafe(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

function parseClaudeCodeAgentMarkdown(name: string, text: string): SubAgentConfig | null {
  const { data, body } = splitFrontmatter(text);
  if (typeof data.description !== 'string' || !data.description.trim()) return null;

  const config: SubAgentConfig = {
    name,
    description: data.description.trim(),
    mode: 'subagent',
  };

  if (typeof data.model === 'string' && data.model.trim()) config.model = data.model.trim();

  if (typeof data.tools === 'string' && data.tools.trim()) {
    const permission: PermissionConfig = { '*': 'deny' };
    for (const rawTool of data.tools.split(',')) {
      const tool = CLAUDE_TOOL_ALIASES[rawTool.trim()];
      if (tool) permission[tool] = 'allow';
    }
    config.permission = permission;
  }

  const prompt = body.trim();
  if (prompt) config.prompt = prompt;

  return config;
}

async function loadDirWithParser(
  dir: string,
  origin: string,
  parse: (name: string, text: string) => SubAgentConfig | null,
): Promise<SubAgentConfig[]> {
  const entries = await readDirSafe(dir);
  const configs: SubAgentConfig[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const name = entry.slice(0, -3);
    try {
      const text = await fs.readFile(join(dir, entry), 'utf8');
      const config = parse(name, text);
      if (config) {
        config.scope = 'project';
        config.origin = `${origin}/${entry}`;
        configs.push(config);
      }
    } catch {
      // skip unreadable/malformed files rather than failing the whole load
    }
  }
  return configs;
}

export async function loadProjectAgentConfigs(cwd: string): Promise<SubAgentConfig[]> {
  const [claudeAgents, drennAgents] = await Promise.all([
    loadDirWithParser(
      join(cwd, '.claude', 'agents'),
      '.claude/agents',
      parseClaudeCodeAgentMarkdown,
    ),
    loadDirWithParser(join(cwd, '.drenn', 'agent'), '.drenn/agent', parseAgentMarkdown),
  ]);

  const byName = new Map<string, SubAgentConfig>();
  for (const config of claudeAgents) byName.set(config.name, config);
  for (const config of drennAgents) byName.set(config.name, config);
  return Array.from(byName.values());
}

export async function refreshProjectAgents(cwd: string): Promise<void> {
  const cached = projectAgentsCache.get(cwd);
  if (cached && Date.now() - cached.loadedAt < PROJECT_AGENTS_TTL_MS) return;

  const configs = await loadProjectAgentConfigs(cwd);
  const agents = new Map<string, SubAgentConfig>();
  for (const config of configs) agents.set(config.name, config);
  projectAgentsCache.set(cwd, { agents, loadedAt: Date.now() });
}

export function getProjectAgent(name: string, cwd: string): SubAgent | undefined {
  const config = projectAgentsCache.get(cwd)?.agents.get(name);
  return config ? { config } : undefined;
}

export function listProjectAgents(cwd: string): SubAgent[] {
  const agents = projectAgentsCache.get(cwd)?.agents;
  if (!agents) return [];
  return Array.from(agents.values()).map((config) => ({ config }));
}

export function getProjectAgentsPromptSection(cwd: string): string {
  const agents = listProjectAgents(cwd);
  if (agents.length === 0) return '';
  const lines = agents.map((a) => `- ${a.config.name}: ${a.config.description}`);
  return `These additional sub-agent types are available via the task tool for this project:\n${lines.join('\n')}`;
}
