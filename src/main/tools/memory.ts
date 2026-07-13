import * as fs from 'fs/promises';
import * as path from 'path';
import type { BaseTool, ExecutionContext, ToolCall, ToolInfo, ToolResponse } from './types';
import { isExternalPath } from './pathUtil';
import { projectMemoryDir, invalidateProjectMemory } from '../agent/memoryStore';

const MEMORY_INDEX_FILE = 'MEMORY.md';

type MemoryAction = 'read' | 'write' | 'list' | 'delete';

export class MemoryTool implements BaseTool {
  info(): ToolInfo {
    return {
      name: 'memory',
      description: `Read, write, list, or delete files in your persistent per-project memory: an index file (MEMORY.md) plus individual topic files. This is your own private, durable notebook for this project — it survives across sessions, is not part of the user's project files, and needs no permission prompt to use.

Usage:
- MEMORY.md is the index: keep it to short one-line pointers, e.g. "- [Title](topic-file.md) — one-line hook". The full MEMORY.md is loaded into your context every session, so keep it small.
- Put substance in individual topic files (e.g. "deploy-process.md", "known-gotchas.md"). Read them on demand with the \`read\` action — they are not auto-loaded.
- Use \`list\` before adding a new topic file, to update an existing one instead of creating a near-duplicate.
- Use \`delete\` to prune entries that are no longer accurate; update MEMORY.md's index afterward with \`write\`.`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['read', 'write', 'list', 'delete'],
            description: 'Which operation to perform',
          },
          path: {
            type: 'string',
            description:
              'File name relative to the memory directory, e.g. "MEMORY.md" or "deploy-process.md". Not required for `list`.',
          },
          content: {
            type: 'string',
            description: 'File content. Required for `write`.',
          },
        },
        required: ['action'],
      },
      required: ['action'],
    };
  }

  async run(ctx: ExecutionContext, call: ToolCall): Promise<ToolResponse> {
    let params: { action?: MemoryAction; path?: string; content?: string };
    try {
      params = JSON.parse(call.input);
    } catch {
      return { content: 'Error: invalid tool input', isError: true };
    }

    const { action, path: relPath, content } = params;
    if (!action) {
      return { content: 'Error: action is required', isError: true };
    }

    const memoryDir = projectMemoryDir(ctx.cwd);

    if (action === 'list') {
      try {
        const entries = await fs.readdir(memoryDir);
        const files = entries.filter((name) => name.endsWith('.md')).sort();
        return {
          content: files.length ? files.join('\n') : '(no memory files yet)',
          isError: false,
        };
      } catch {
        return { content: '(no memory files yet)', isError: false };
      }
    }

    if (!relPath) {
      return { content: `Error: path is required for '${action}'`, isError: true };
    }

    const resolvedPath = path.resolve(memoryDir, relPath);
    if (isExternalPath(memoryDir, resolvedPath)) {
      return {
        content: `Error: path must stay inside the memory directory (${relPath})`,
        isError: true,
      };
    }

    if ((action === 'write' || action === 'delete') && ctx.mode === 'plan') {
      return {
        content:
          'Plan mode is active: memory writes are disabled. Describe what you would save instead; the user can switch modes to let you write it.',
        isError: true,
      };
    }

    if (action === 'read') {
      try {
        const text = await fs.readFile(resolvedPath, 'utf8');
        return { content: text, isError: false };
      } catch {
        return { content: `Error: memory file not found (${relPath})`, isError: true };
      }
    }

    if (action === 'write') {
      if (content === undefined) {
        return { content: "Error: content is required for 'write'", isError: true };
      }
      try {
        await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
        await fs.writeFile(resolvedPath, content, 'utf8');
      } catch (err: any) {
        return { content: `Error writing ${relPath}: ${err}`, isError: true };
      }
      if (relPath === MEMORY_INDEX_FILE) {
        invalidateProjectMemory(ctx.cwd);
      }
      return { content: `Saved ${relPath}`, isError: false };
    }

    if (action === 'delete') {
      try {
        await fs.unlink(resolvedPath);
        if (relPath === MEMORY_INDEX_FILE) {
          invalidateProjectMemory(ctx.cwd);
        }
        return { content: `Deleted ${relPath}`, isError: false };
      } catch (err: any) {
        if (err?.code === 'ENOENT') {
          return { content: `${relPath} did not exist`, isError: false };
        }
        return { content: `Error deleting ${relPath}: ${err}`, isError: true };
      }
    }

    return { content: `Error: unknown action '${action}'`, isError: true };
  }
}
