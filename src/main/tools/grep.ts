import * as fs from 'fs/promises';
import * as path from 'path';
import type { BaseTool, ExecutionContext, ToolCall, ToolInfo, ToolResponse } from './types';
import { parseToolInput } from '../../shared/utils/json';

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

interface GrepMatch {
  file: string;
  line: number;
  content: string;
}

async function searchDir(
  dir: string,
  pattern: RegExp,
  include?: string,
  results: GrepMatch[] = [],
): Promise<GrepMatch[]> {
  if (results.length >= MAX_RESULTS) return results;

  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (results.length >= MAX_RESULTS) break;

    const fullPath = path.join(dir, entry.name);

    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;

    if (entry.isDirectory()) {
      await searchDir(fullPath, pattern, include, results);
    } else {
      if (include && !matchGlob(include, entry.name)) continue;

      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
          if (pattern.test(lines[i])) {
            results.push({
              file: fullPath,
              line: i + 1,
              content: lines[i].slice(0, 200),
            });
            if (results.length >= MAX_RESULTS) break;
          }
        }
      } catch {}
    }
  }

  return results;
}

function matchGlob(pattern: string, filename: string): boolean {
  const regexStr = pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`).test(filename);
}

export class GrepTool implements BaseTool {
  info(): ToolInfo {
    return {
      name: 'grep',
      description: `Searches file contents for a regex pattern and returns file:line matches (capped at 100).

Usage:
- ALWAYS use this instead of bash \`grep\`/\`rg\` for searching code.
- Use \`include\` to filter by filename pattern (e.g. "*.ts").
- Set literal_text: true when searching for exact text that contains regex special characters.
- node_modules, .git, dist and other generated directories are skipped automatically.
- For open-ended exploration that may take several rounds of globbing and grepping, use the task tool with the explore agent instead.`,
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Search pattern (regex or literal text)',
          },
          path: {
            type: 'string',
            description: 'Directory to search in (default: current working directory)',
          },
          include: {
            type: 'string',
            description: 'File pattern to include (e.g., "*.ts")',
          },
          literal_text: {
            type: 'boolean',
            description: 'If true, treat pattern as literal text (default: false)',
          },
        },
        required: ['pattern'],
      },
      required: ['pattern'],
    };
  }

  async run(ctx: ExecutionContext, call: ToolCall): Promise<ToolResponse> {
    try {
      const params = parseToolInput<{
        pattern?: string;
        path?: string;
        include?: string;
        literal_text?: boolean;
      }>(call.input, { literal_text: false });
      const { pattern, path: searchPath = ctx.cwd, include, literal_text = false } = params;

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

      const regex = literal_text
        ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        : (() => {
            try {
              return new RegExp(pattern);
            } catch {
              return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
            }
          })();

      const matches = await searchDir(resolvedPath, regex, include);

      if (matches.length === 0) {
        return { content: `No matches found for pattern: ${pattern}`, isError: false };
      }

      const output = [
        `Found ${matches.length} matches:`,
        '',
        ...matches.map((m) => `${path.relative(ctx.cwd, m.file)}:${m.line}: ${m.content}`),
      ].join('\n');

      return { content: output, isError: false };
    } catch (error) {
      return { content: `Error searching files: ${error}`, isError: true };
    }
  }
}
