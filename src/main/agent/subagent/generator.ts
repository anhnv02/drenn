import type { SubAgentConfig } from './types';
import type { PermissionConfig } from '../../permission/ruleset';
import type { ChatMessage } from '../types';
import type { LLMProvider } from '../../llm/openaiClient';
import { resolveConfiguredProvider } from '../../llm/openaiClient';
import { readProviders } from '../../config/providerStore';
import { readSelectedModel, readXiaomiApiKey } from '../../config/settingsStore';
import { registerAgent, getAgentNames } from './registry';
import { saveAgent } from './store';
import { parseJsonSafe } from '../../../shared/utils/json';

const AVAILABLE_TOOLS = [
  'view',
  'glob',
  'grep',
  'ls',
  'edit',
  'write',
  'bash',
  'fetch',
  'apply_patch',
  'todowrite',
  'question',
  'diagnostics',
  'sourcegraph',
  'task',
] as const;

const GENERATION_PROMPT = `You are configuring a new AI coding sub-agent. Based on the user's description, produce a JSON object with these fields:

- "name": a unique identifier, lowercase, words separated by single hyphens, no spaces (e.g. "test-writer").
- "description": one sentence describing when to use this agent. This is shown to the orchestrating agent to decide when to delegate.
- "mode": either "primary" or "subagent". Use "subagent" unless the user clearly wants a top-level mode.
- "temperature": a number between 0 and 1. Use a low value (0.1-0.3) for focused/deterministic work, higher for creative work.
- "permission": an object mapping tool names to permission actions ("allow", "ask", or "deny"). Use "deny" to disable tools. For read-only/research agents, deny editing tools (edit, write, apply_patch, bash). You can also use nested objects for pattern-based rules, e.g. { "bash": { "git *": "allow", "*": "deny" } }.
- "prompt": a concise system prompt (2-5 sentences) giving the agent its role and instructions.

Available tools: ${AVAILABLE_TOOLS.join(', ')}.

Return ONLY the raw JSON object. Do not wrap it in markdown code fences or add any commentary.`;

/**
 * Ask the configured LLM to design a sub-agent from a natural-language
 * description, then validate, sanitize, register, and return the config.
 *
 * @param description   What the agent should do.
 * @param existingNames Names that must not be reused. Merged with names already
 *                      in the registry so the generated agent is always unique.
 */
export async function generateAgent(
  description: string,
  existingNames: string[] = [],
): Promise<SubAgentConfig> {
  const provider = resolveConfiguredProvider(
    readProviders(),
    readSelectedModel(),
    readXiaomiApiKey(),
  );

  const taken = new Set<string>([...existingNames, ...getAgentNames()]);

  const userPrompt = `${GENERATION_PROMPT}

Description: "${description}"

Names that CANNOT be used: ${[...taken].join(', ') || '(none)'}

Generate the agent configuration:`;

  const raw = await complete(provider, userPrompt);
  const parsed = extractJson(raw);
  if (!parsed) {
    throw new Error(
      `Agent generation failed: model did not return valid JSON. Response was:\n${raw}`,
    );
  }

  const config = normalizeConfig(parsed, description, taken);
  await saveAgent(config);
  registerAgent(config);
  return config;
}

/**
 * Names of every agent currently in the registry (including built-ins and any
 * previously generated agents). Used to avoid name collisions.
 */
export function getExistingAgentNames(): string[] {
  return getAgentNames();
}

async function complete(provider: LLMProvider, userPrompt: string): Promise<string> {
  const messages: ChatMessage[] = [{ role: 'user', content: userPrompt }];
  const controller = new AbortController();

  let out = '';
  for await (const event of provider.streamChat(messages, [], controller.signal)) {
    if (event.type === 'content' && event.content) {
      out += event.content;
    } else if (event.type === 'error') {
      throw event.error ?? new Error('LLM request failed during agent generation');
    }
  }
  return out;
}

function extractJson(text: string): Record<string, unknown> | null {
  const candidates: string[] = [];

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  candidates.push(text);

  for (const candidate of candidates) {
    const value = parseJsonSafe(candidate.trim());
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return null;
}

function normalizeConfig(
  parsed: Record<string, unknown>,
  description: string,
  taken: Set<string>,
): SubAgentConfig {
  const name = uniqueName(sanitizeName(parsed.name) || sanitizeName(description) || 'agent', taken);

  const mode: SubAgentConfig['mode'] =
    parsed.mode === 'primary' || parsed.mode === 'all' ? parsed.mode : 'subagent';

  const config: SubAgentConfig = {
    name,
    description:
      typeof parsed.description === 'string' && parsed.description.trim()
        ? parsed.description.trim()
        : description,
    mode,
  };

  const temperature = Number(parsed.temperature);
  if (Number.isFinite(temperature)) {
    config.temperature = Math.min(1, Math.max(0, temperature));
  }

  const topP = Number(parsed.top_p ?? parsed.topP);
  if (Number.isFinite(topP)) {
    config.topP = Math.min(1, Math.max(0, topP));
  }

  const steps = Number(parsed.steps);
  if (Number.isFinite(steps) && steps > 0) {
    config.steps = Math.min(100, Math.max(1, Math.round(steps)));
  }

  if (
    parsed.permission &&
    typeof parsed.permission === 'object' &&
    !Array.isArray(parsed.permission)
  ) {
    const permission = normalizePermission(parsed.permission);
    if (permission) config.permission = permission;
  } else if (parsed.tools && typeof parsed.tools === 'object' && !Array.isArray(parsed.tools)) {
    const permission = normalizeTools(parsed.tools);
    if (permission) config.permission = permission;
  }

  if (typeof parsed.prompt === 'string' && parsed.prompt.trim()) {
    config.prompt = parsed.prompt.trim();
  }

  return config;
}

function normalizePermission(value: unknown): PermissionConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const permission: PermissionConfig = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (typeof val === 'string' && (val === 'allow' || val === 'ask' || val === 'deny')) {
      permission[key] = val;
    } else if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
      // Nested pattern map: { "git *": "allow", "*": "deny" }
      const patternMap: Record<string, 'allow' | 'ask' | 'deny'> = {};
      for (const [pattern, action] of Object.entries(val as Record<string, unknown>)) {
        if (
          typeof action === 'string' &&
          (action === 'allow' || action === 'ask' || action === 'deny')
        ) {
          patternMap[pattern] = action;
        }
      }
      if (Object.keys(patternMap).length > 0) {
        permission[key] = patternMap;
      }
    }
  }
  return Object.keys(permission).length > 0 ? permission : undefined;
}

function normalizeTools(value: unknown): PermissionConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const known = new Set<string>(AVAILABLE_TOOLS);
  const permission: PermissionConfig = {};
  for (const [key, enabled] of Object.entries(value as Record<string, unknown>)) {
    if (known.has(key) && typeof enabled === 'boolean') {
      permission[key] = enabled ? 'allow' : 'deny';
    }
  }
  return Object.keys(permission).length > 0 ? permission : undefined;
}

function sanitizeName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/g, '');
}

function uniqueName(base: string, taken: Set<string>): string {
  const root = base || 'agent';
  if (!taken.has(root)) return root;
  for (let i = 2; ; i++) {
    const candidate = `${root}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
