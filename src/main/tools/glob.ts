import * as fs from 'fs/promises';
import * as path from 'path';
import type { BaseTool, ExecutionContext, ToolCall, ToolInfo, ToolResponse } from './types';

const MAX_RESULTS = 100;
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  '.next',
  '.turbo',
  'coverage',
]);

async function globPattern(pattern: string, dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (results.length >= MAX_RESULTS) break;

    const fullPath = path.join(dir, entry.name);

    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;

    if (entry.isDirectory()) {
      const remaining = MAX_RESULTS - results.length;
      const subResults = await globPattern(pattern, fullPath);
      results.push(...subResults.slice(0, remaining));
    } else if (matchGlob(pattern, entry.name)) {
      results.push(fullPath);
    }
  }

  return results;
}

function matchGlob(pattern: string, filename: string): boolean {
  const regexStr = pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`).test(filename);
}

export class GlobTool implements BaseTool {
  info(): ToolInfo {
    return {
      name: 'glob',
      description: `Fast file matching by name pattern (e.g. "**/*.ts", "src/**/*.tsx"). Use ** for recursive matching.

Usage:
- ALWAYS use this instead of bash \`find\` when locating files by name.
- Batch independent searches (multiple glob/grep calls) in a single response — they run in parallel.`,
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Glob pattern (e.g., "**/*.ts", "src/**/*.js")',
          },
          path: {
            type: 'string',
            description: 'Directory to search in (default: current working directory)',
          },
        },
        required: ['pattern'],
      },
      required: ['pattern'],
    };
  }

  async run(ctx: ExecutionContext, call: ToolCall): Promise<ToolResponse> {
    try {
      const params = JSON.parse(call.input);
      const { pattern, path: searchPath = ctx.cwd } = params;

      if (!pattern) {
        return { content: 'Error: pattern is required', isError: true };
      }

      const resolvedPath = path.resolve(ctx.cwd, searchPath);

      let stat;
      try {
        stat = await fs.stat(resolvedPath);
      } catch {
        return { content: `Error: Directory not found: ${searchPath}`, isError: true };
      }

      if (!stat.isDirectory()) {
        return { content: `Error: ${searchPath} is not a directory`, isError: true };
      }

      const files = await globPattern(pattern, resolvedPath);
      const relativePaths = files.map((f) => path.relative(ctx.cwd, f));

      if (relativePaths.length === 0) {
        return { content: `No files found matching pattern: ${pattern}`, isError: false };
      }

      const output = [
        `Found ${relativePaths.length} files:`,
        '',
        ...relativePaths.slice(0, MAX_RESULTS),
      ].join('\n');

      return { content: output, isError: false };
    } catch (error) {
      return { content: `Error searching files: ${error}`, isError: true };
    }
  }
}
