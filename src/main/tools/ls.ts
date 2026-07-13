import * as fs from 'fs/promises';
import * as path from 'path';
import type { BaseTool, ExecutionContext, ToolCall, ToolInfo, ToolResponse } from './types';

export class LsTool implements BaseTool {
  info(): ToolInfo {
    return {
      name: 'ls',
      description: 'List directory contents with file types and sizes.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Directory path to list (default: current working directory)',
          },
          ignore: {
            type: 'array',
            items: { type: 'string' },
            description: 'Glob patterns to ignore (e.g., ["node_modules", "*.log"])',
          },
        },
        required: [],
      },
      required: [],
    };
  }

  async run(ctx: ExecutionContext, call: ToolCall): Promise<ToolResponse> {
    try {
      const params = JSON.parse(call.input);
      const { path: dirPath = ctx.cwd, ignore = [] } = params;

      const resolvedPath = path.resolve(ctx.cwd, dirPath);

      let stat;
      try {
        stat = await fs.stat(resolvedPath);
      } catch {
        return { content: `Error: Directory not found: ${dirPath}`, isError: true };
      }

      if (!stat.isDirectory()) {
        return { content: `Error: ${dirPath} is not a directory`, isError: true };
      }

      const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
      const items: string[] = [];

      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;

        const shouldIgnore = ignore.some((pattern: string) => matchGlob(pattern, entry.name));
        if (shouldIgnore) continue;

        const fullPath = path.join(resolvedPath, entry.name);
        const relativePath = path.relative(ctx.cwd, fullPath);

        try {
          const entryStat = await fs.stat(fullPath);
          const size = formatSize(entryStat.size);
          const type = entry.isDirectory() ? 'dir' : 'file';
          items.push(`${type.padEnd(5)} ${size.padStart(10)} ${relativePath}`);
        } catch {
          items.push(`?     ${relativePath}`);
        }
      }

      if (items.length === 0) {
        return { content: `Directory is empty: ${dirPath}`, isError: false };
      }

      const output = [`Contents of ${dirPath || '.'}:`, '', ...items].join('\n');

      return { content: output, isError: false };
    } catch (error) {
      return { content: `Error listing directory: ${error}`, isError: true };
    }
  }
}

function matchGlob(pattern: string, filename: string): boolean {
  const regexStr = pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`).test(filename);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
