import * as fs from 'fs/promises';
import * as path from 'path';
import type { BaseTool, ExecutionContext, ToolCall, ToolInfo, ToolResponse } from './types';
import { deniedToolResult, type PermissionService } from '../permission';
import { recordFileRead } from './edit';
import { isExternalPath } from './pathUtil';

const MAX_FILE_SIZE = 250 * 1024;
const MAX_LINE_LENGTH = 2000;

export class ViewTool implements BaseTool {
  private permissions: PermissionService;

  constructor(permissions: PermissionService) {
    this.permissions = permissions;
  }

  info(): ToolInfo {
    return {
      name: 'view',
      description: `Reads a file from the filesystem. Returns up to 2000 lines by default, each prefixed with its line number (\`N: \`); use offset/limit to read a specific range of a long file.

Usage:
- Always read a file before editing it.
- When you need several files, batch multiple view calls in a single response — they run in parallel.
- Files over 250KB cannot be read with this tool; read a slice via bash (e.g. head -n 200 file | tail -n 100) instead.`,
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Absolute path to the file to read',
          },
          offset: {
            type: 'number',
            description: 'Line number to start reading from (1-indexed, default: 1)',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of lines to return (default: 2000)',
          },
        },
        required: ['file_path'],
      },
      required: ['file_path'],
    };
  }

  async run(ctx: ExecutionContext, call: ToolCall): Promise<ToolResponse> {
    try {
      const params = JSON.parse(call.input);
      const { file_path, offset = 1, limit = 2000 } = params;

      if (!file_path) {
        return { content: 'Error: file_path is required', isError: true };
      }

      const resolvedPath = path.resolve(ctx.cwd, file_path);

      if (ctx.mode !== 'bypassPermissions' && isExternalPath(ctx.cwd, resolvedPath)) {
        const decision = await this.permissions.request({
          id: call.id,
          sessionId: ctx.sessionId,
          messageId: ctx.messageId,
          toolName: 'view',
          action: 'read',
          path: file_path,
          description: `Read ${resolvedPath} (outside project)`,
          params: { file_path, offset, limit },
          resource: resolvedPath,
          cwd: ctx.cwd,
          external: true,
        });

        if (!decision.approved) {
          return { content: deniedToolResult(decision.feedback), isError: true };
        }
      }

      let stat;
      try {
        stat = await fs.stat(resolvedPath);
      } catch {
        return { content: `Error: File not found: ${file_path}`, isError: true };
      }

      if (stat.isDirectory()) {
        return { content: `Error: ${file_path} is a directory, not a file`, isError: true };
      }

      if (stat.size > MAX_FILE_SIZE) {
        return {
          content: `Error: File too large (${(stat.size / 1024).toFixed(1)}KB). Max size is ${MAX_FILE_SIZE / 1024}KB`,
          isError: true,
        };
      }

      const content = await fs.readFile(resolvedPath, 'utf-8');
      const lines = content.split('\n');

      const start = Math.max(1, offset);
      const end = Math.min(lines.length, start + limit - 1);
      const selectedLines = lines.slice(start - 1, end);

      const numberedLines = selectedLines.map((line, i) => {
        const truncated =
          line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + '... [truncated]' : line;
        return `${start + i}: ${truncated}`;
      });

      const output = [
        `File: ${file_path}`,
        `Lines ${start}-${end} of ${lines.length}`,
        '',
        ...numberedLines,
      ].join('\n');

      recordFileRead(ctx.sessionId, resolvedPath, stat.mtimeMs);

      return { content: output, isError: false };
    } catch (error) {
      return { content: `Error reading file: ${error}`, isError: true };
    }
  }
}
