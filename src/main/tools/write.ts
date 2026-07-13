import * as fs from 'fs/promises';
import * as path from 'path';
import type { BaseTool, ExecutionContext, ToolCall, ToolInfo, ToolResponse } from './types';
import { deniedToolResult, type PermissionService } from '../permission';
import { recordFileRead } from './edit';
import { isExternalPath } from './pathUtil';
import { recordCheckpoint } from '../checkpoints';

export class WriteTool implements BaseTool {
  private permissions: PermissionService;

  constructor(permissions: PermissionService) {
    this.permissions = permissions;
  }

  info(): ToolInfo {
    return {
      name: 'write',
      description: `Writes a file to the filesystem, overwriting it if it already exists.

Usage:
- ALWAYS prefer the edit tool for changing an existing file; use write only to create a new file or fully rewrite one.
- If the file already exists, use the view tool first to read its current content.
- NEVER proactively create documentation files (*.md) or READMEs unless the user explicitly asks for one.
- Parent directories are created automatically.`,
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Absolute path to the file to create or overwrite',
          },
          content: {
            type: 'string',
            description: 'Complete content to write to the file',
          },
        },
        required: ['file_path', 'content'],
      },
      required: ['file_path', 'content'],
    };
  }

  async run(ctx: ExecutionContext, call: ToolCall): Promise<ToolResponse> {
    try {
      const params = JSON.parse(call.input);
      const { file_path, content } = params;

      if (!file_path || content === undefined) {
        return { content: 'Error: file_path and content are required', isError: true };
      }

      if (ctx.mode === 'plan') {
        return {
          content:
            'Plan mode is active: file modifications are disabled. Describe the change you would make instead; the user can switch modes to let you apply it.',
          isError: true,
        };
      }

      const resolvedPath = path.resolve(ctx.cwd, file_path);
      const external = isExternalPath(ctx.cwd, resolvedPath);

      // Check if file exists
      let exists = false;
      let oldContent = '';
      try {
        const stat = await fs.stat(resolvedPath);
        if (stat.isDirectory()) {
          return { content: `Error: ${file_path} is a directory`, isError: true };
        }
        exists = true;
        oldContent = await fs.readFile(resolvedPath, 'utf-8');

        // Skip if content is the same
        if (oldContent === content) {
          return {
            content: `No changes needed: ${file_path} already has the desired content`,
            isError: false,
          };
        }
      } catch {
        // File doesn't exist, that's fine
      }

      // Request permission ('acceptEdits' and 'bypassPermissions' auto-approve
      // file writes; acceptEdits only inside the working directory — external
      // paths always prompt, matching Claude Code).
      if (ctx.mode !== 'bypassPermissions' && (ctx.mode !== 'acceptEdits' || external)) {
        const decision = await this.permissions.request({
          id: call.id,
          sessionId: ctx.sessionId,
          messageId: ctx.messageId,
          toolName: 'write',
          action: exists ? 'write' : 'create',
          path: file_path,
          description: external
            ? `${exists ? 'Overwrite' : 'Create'} ${resolvedPath} (outside project)`
            : `${exists ? 'Overwrite' : 'Create'} ${file_path}`,
          params: { content },
          diff: exists ? generateDiff(oldContent, content) : undefined,
          resource: resolvedPath,
          cwd: ctx.cwd,
          external,
        });

        if (!decision.approved) {
          return { content: deniedToolResult(decision.feedback), isError: true };
        }
      }

      // Create parent directories
      const dir = path.dirname(resolvedPath);
      await fs.mkdir(dir, { recursive: true });

      // Write file
      recordCheckpoint(ctx.sessionId, 'write', resolvedPath, exists ? oldContent : null);
      await fs.writeFile(resolvedPath, content, 'utf-8');

      const newStat = await fs.stat(resolvedPath);
      recordFileRead(ctx.sessionId, resolvedPath, newStat.mtimeMs);

      const lines = content.split('\n').length;
      return {
        content: `Successfully ${exists ? 'overwrote' : 'created'} ${file_path}\n${lines} lines written`,
        isError: false,
        metadata: { lines, created: !exists },
      };
    } catch (error) {
      return { content: `Error writing file: ${error}`, isError: true };
    }
  }
}

function generateDiff(oldContent: string, newContent: string): string {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const diff: string[] = [];

  const maxLines = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLines; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];

    if (oldLine !== newLine) {
      if (oldLine !== undefined) diff.push(`-${oldLine}`);
      if (newLine !== undefined) diff.push(`+${newLine}`);
    } else {
      diff.push(` ${oldLine}`);
    }
  }

  return diff.join('\n');
}
