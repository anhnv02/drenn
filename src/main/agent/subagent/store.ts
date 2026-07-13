import { promises as fs } from 'fs';
import { join } from 'path';
import type { SubAgentConfig } from './types';
import type { PermissionConfig } from '../../permission/ruleset';
import { registerAgent, unregisterAgent } from './registry';
import { AGENT_DIR } from '../../config/paths';

export async function initPersistedAgents(): Promise<void> {
  const configs = await loadPersistedAgents();
  for (const config of configs) {
    registerAgent(config);
  }
}

export async function loadPersistedAgents(): Promise<SubAgentConfig[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(AGENT_DIR);
  } catch {
    return [];
  }

  const configs: SubAgentConfig[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const name = entry.slice(0, -3);
    try {
      const text = await fs.readFile(join(AGENT_DIR, entry), 'utf8');
      const config = parseAgentMarkdown(name, text);
      if (config) configs.push(config);
    } catch {
      // skip unreadable/malformed files rather than failing the whole load
    }
  }
  return configs;
}

export async function saveAgent(config: SubAgentConfig): Promise<string> {
  await fs.mkdir(AGENT_DIR, { recursive: true });
  const file = join(AGENT_DIR, `${config.name}.md`);
  await fs.writeFile(file, serializeAgentMarkdown(config), 'utf8');
  return file;
}

export async function deleteAgent(name: string): Promise<void> {
  await fs.rm(join(AGENT_DIR, `${name}.md`), { force: true });
  unregisterAgent(name);
}

export function parseAgentMarkdown(name: string, text: string): SubAgentConfig | null {
  const { data, body } = splitFrontmatter(text);

  const mode: SubAgentConfig['mode'] =
    data.mode === 'primary' || data.mode === 'all' ? data.mode : 'subagent';

  const config: SubAgentConfig = {
    name,
    description: typeof data.description === 'string' ? data.description : '',
    mode,
  };

  if (typeof data.model === 'string') config.model = data.model;
  if (typeof data.temperature === 'number') config.temperature = data.temperature;
  if (typeof data.topP === 'number') config.topP = data.topP;
  if (typeof data.steps === 'number') config.steps = data.steps;
  if (typeof data.color === 'string') config.color = data.color;
  if (typeof data.variant === 'string') config.variant = data.variant;

  if (data.permission && typeof data.permission === 'object' && !Array.isArray(data.permission)) {
    config.permission = data.permission as PermissionConfig;
  }

  if (
    !config.permission &&
    data.tools &&
    typeof data.tools === 'object' &&
    !Array.isArray(data.tools)
  ) {
    const permission: PermissionConfig = {};
    for (const [k, v] of Object.entries(data.tools as Record<string, unknown>)) {
      if (typeof v === 'boolean') {
        permission[k] = v ? 'allow' : 'deny';
      }
    }
    if (Object.keys(permission).length > 0) config.permission = permission;
  }

  const prompt = body.trim();
  if (prompt) config.prompt = prompt;

  return config;
}

function serializeAgentMarkdown(config: SubAgentConfig): string {
  const lines: string[] = ['---'];
  if (config.description) lines.push(`description: ${yamlScalar(config.description)}`);
  lines.push(`mode: ${config.mode}`);
  if (config.model) lines.push(`model: ${yamlScalar(config.model)}`);
  if (config.temperature !== undefined) lines.push(`temperature: ${config.temperature}`);
  if (config.topP !== undefined) lines.push(`topP: ${config.topP}`);
  if (config.steps !== undefined) lines.push(`steps: ${config.steps}`);
  if (config.color) lines.push(`color: ${yamlScalar(config.color)}`);
  if (config.variant) lines.push(`variant: ${yamlScalar(config.variant)}`);

  if (config.permission && Object.keys(config.permission).length > 0) {
    lines.push('permission:');
    for (const [k, v] of Object.entries(config.permission)) {
      if (typeof v === 'string') {
        lines.push(`  ${k}: ${v}`);
      } else if (typeof v === 'object') {
        lines.push(`  ${k}:`);
        for (const [pattern, action] of Object.entries(v)) {
          lines.push(`    ${pattern}: ${action}`);
        }
      }
    }
  }

  lines.push('---', '');
  if (config.prompt) lines.push(config.prompt.trim(), '');
  return lines.join('\n');
}

export function splitFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { data: {}, body: normalized };
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: normalized };
  const raw = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^[^\n]*\n?/, '');
  return { data: parseYamlish(raw), body };
}

function parseYamlish(raw: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const lines = raw.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    i++;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (/^\s/.test(line)) continue;
    const m = line.match(/^([A-Za-z0-9_.*?]+):\s*(.*)$/);
    if (!m) continue;
    const [, key, rest] = m;
    if (rest === '') {
      const nested: Record<string, unknown> = {};
      while (i < lines.length && /^\s+\S/.test(lines[i])) {
        const nm = lines[i].trim().match(/^([A-Za-z0-9_.*?]+):\s*(.*)$/);
        i++;
        if (nm) {
          if (nm[2] === '') {
            const subNested: Record<string, unknown> = {};
            while (i < lines.length && /^\s+\S/.test(lines[i])) {
              const subLine = lines[i].trim().match(/^([A-Za-z0-9_.*?]+):\s*(.*)$/);
              i++;
              if (subLine) subNested[subLine[1]] = coerce(subLine[2]);
            }
            nested[nm[1]] = Object.keys(subNested).length > 0 ? subNested : '';
          } else {
            nested[nm[1]] = coerce(nm[2]);
          }
        }
      }
      if (Object.keys(nested).length > 0) data[key] = nested;
    } else {
      data[key] = coerce(rest);
    }
  }
  return data;
}

function coerce(value: string): unknown {
  const v = value.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (v !== '' && !Number.isNaN(Number(v))) return Number(v);
  if (v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  return v;
}

function yamlScalar(s: string): string {
  if (/[:#\n"']/.test(s) || /^\s|\s$/.test(s)) return JSON.stringify(s);
  return s;
}
