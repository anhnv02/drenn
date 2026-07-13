import * as fs from 'fs';
import * as path from 'path';
import type { CustomCommand } from './types';
import { COMMANDS_DIR } from '../config/paths';

const NAMED_ARG_PATTERN = /\$([A-Z][A-Z0-9_]*)/g;

export async function loadCustomCommands(projectDir: string): Promise<CustomCommand[]> {
  const commands: CustomCommand[] = [];

  const userCommands = await loadCommandsFromDir(COMMANDS_DIR, 'user:');
  commands.push(...userCommands);

  const projectCommandsDir = path.join(projectDir, '.drenn', 'commands');
  const projectCommands = await loadCommandsFromDir(projectCommandsDir, 'project:');
  commands.push(...projectCommands);

  return commands;
}

async function loadCommandsFromDir(dir: string, prefix: string): Promise<CustomCommand[]> {
  const commands: CustomCommand[] = [];

  if (!fs.existsSync(dir)) {
    return commands;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const subCommands = await loadCommandsFromDir(path.join(dir, entry.name), prefix);
      commands.push(...subCommands);
      continue;
    }

    if (!entry.name.endsWith('.md')) {
      continue;
    }

    const filePath = path.join(dir, entry.name);
    const content = fs.readFileSync(filePath, 'utf-8');
    const commandId = entry.name.replace(/\.md$/, '');

    const args = extractNamedArgs(content);

    commands.push({
      id: prefix + commandId,
      title: prefix + commandId,
      description: `Custom command from ${path.relative(dir, filePath)}`,
      content,
      args,
    });
  }

  return commands;
}

function extractNamedArgs(content: string): Array<{ name: string }> {
  const matches = content.matchAll(NAMED_ARG_PATTERN);
  const argNames = new Set<string>();

  for (const match of matches) {
    argNames.add(match[1]);
  }

  return Array.from(argNames).map((name) => ({ name }));
}

export function resolveCommandArgs(content: string, args: Record<string, string>): string {
  return content.replace(NAMED_ARG_PATTERN, (match, name) => {
    return args[name] || match;
  });
}
