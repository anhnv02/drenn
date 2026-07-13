import * as fs from 'fs/promises';
import * as path from 'path';
import type { BaseTool, ExecutionContext, ToolCall, ToolInfo, ToolResponse } from './types';
import { deniedToolResult, type PermissionService } from '../permission';
import { recordFileRead, getFileReadTime } from './edit';
import { isExternalPath } from './pathUtil';
import { recordCheckpoint } from '../checkpoints';

interface PatchFile {
  action: 'create' | 'update' | 'delete' | 'move';
  filePath: string;
  newPath?: string;
  content?: string;
}

export class ApplyPatchTool implements BaseTool {
  private permissions: PermissionService;

  constructor(permissions: PermissionService) {
    this.permissions = permissions;
  }

  info(): ToolInfo {
    return {
      name: 'apply_patch',
      description: `Apply patches to files. Supports creating, updating, deleting, and moving files.
Patch format uses marker lines:
- *** Add File: <path>
- *** Update File: <path>
- *** Delete File: <path>
- *** Move to: <new-path>

After markers, include the full file content for creates/updates, or nothing for deletes/moves.`,
      parameters: {
        type: 'object',
        properties: {
          patchText: {
            type: 'string',
            description: 'The patch content with marker lines',
          },
        },
        required: ['patchText'],
      },
      required: ['patchText'],
    };
  }

  async run(ctx: ExecutionContext, call: ToolCall): Promise<ToolResponse> {
    try {
      const params = JSON.parse(call.input);
      const { patchText } = params;

      if (!patchText) {
        return { content: 'Error: patchText is required', isError: true };
      }

      if (ctx.mode === 'plan') {
        return {
          content:
            'Plan mode is active: file modifications are disabled. Describe the change you would make instead; the user can switch modes to let you apply it.',
          isError: true,
        };
      }

      const files = this.parsePatch(patchText);

      if (files.length === 0) {
        return { content: 'Error: No valid patch operations found', isError: true };
      }

      const staleness = await this.checkUpdatesAreReadable(ctx, files);
      if (staleness) return staleness;

      const descriptions = files.map((f) => {
        switch (f.action) {
          case 'create':
            return `Create ${f.filePath}`;
          case 'update':
            return `Update ${f.filePath}`;
          case 'delete':
            return `Delete ${f.filePath}`;
          case 'move':
            return `Move ${f.filePath} → ${f.newPath}`;
        }
      });

      const external = files.some((f) =>
        isExternalPath(ctx.cwd, path.resolve(ctx.cwd, f.newPath ?? f.filePath)),
      );

      if (ctx.mode !== 'bypassPermissions' && (ctx.mode !== 'acceptEdits' || external)) {
        const decision = await this.permissions.request({
          id: call.id,
          sessionId: ctx.sessionId,
          messageId: ctx.messageId,
          toolName: 'apply_patch',
          action: 'edit',
          description: `Apply patch: ${descriptions.join(', ')}`,
          params: { patchText },
          resource: patchText,
          cwd: ctx.cwd,
          external,
        });

        if (!decision.approved) {
          return { content: deniedToolResult(decision.feedback), isError: true };
        }
      }

      const results: string[] = [];

      for (const file of files) {
        try {
          const targetPath = path.resolve(ctx.cwd, file.filePath || file.newPath || '');
          const before = await fs.readFile(targetPath, 'utf-8').catch(() => null);
          recordCheckpoint(ctx.sessionId, 'apply_patch', targetPath, before);

          switch (file.action) {
            case 'create':
              await this.createFile(ctx.sessionId, ctx.cwd, file);
              results.push(`✓ Created ${file.filePath}`);
              break;
            case 'update':
              await this.updateFile(ctx.sessionId, ctx.cwd, file);
              results.push(`✓ Updated ${file.filePath}`);
              break;
            case 'delete':
              await this.deleteFile(ctx.cwd, file);
              results.push(`✓ Deleted ${file.filePath}`);
              break;
            case 'move':
              await this.moveFile(ctx.sessionId, ctx.cwd, file);
              results.push(`✓ Moved ${file.filePath} → ${file.newPath}`);
              break;
          }
        } catch (error) {
          results.push(`✗ Failed ${file.filePath}: ${error}`);
        }
      }

      return { content: results.join('\n'), isError: false };
    } catch (error) {
      return { content: `Error applying patch: ${error}`, isError: true };
    }
  }

  private async checkUpdatesAreReadable(
    ctx: ExecutionContext,
    files: PatchFile[],
  ): Promise<ToolResponse | null> {
    for (const file of files) {
      if (file.action !== 'update') continue;
      const resolvedPath = path.resolve(ctx.cwd, file.filePath);
      let stat;
      try {
        stat = await fs.stat(resolvedPath);
      } catch {
        return { content: `Error: File not found: ${file.filePath}`, isError: true };
      }
      const lastRead = getFileReadTime(ctx.sessionId, resolvedPath);
      if (!lastRead) {
        return {
          content: `Error: You must use the view tool to read ${file.filePath} before updating it with apply_patch`,
          isError: true,
        };
      }
      if (stat.mtimeMs !== lastRead) {
        return {
          content: `Error: ${file.filePath} has been modified since you last read it. Please read it again.`,
          isError: true,
        };
      }
    }
    return null;
  }

  private parsePatch(patchText: string): PatchFile[] {
    const files: PatchFile[] = [];
    const lines = patchText.split('\n');
    let currentFile: PatchFile | null = null;
    let contentLines: string[] = [];

    for (const line of lines) {
      const createMatch = line.match(/^\*\*\* Add File:\s*(.+)$/);
      const updateMatch = line.match(/^\*\*\* Update File:\s*(.+)$/);
      const deleteMatch = line.match(/^\*\*\* Delete File:\s*(.+)$/);
      const moveMatch = line.match(/^\*\*\* Move to:\s*(.+)$/);

      if (createMatch || updateMatch || deleteMatch || moveMatch) {
        if (currentFile) {
          currentFile.content = contentLines.join('\n');
          files.push(currentFile);
        }

        if (createMatch) {
          currentFile = { action: 'create', filePath: createMatch[1].trim() };
        } else if (updateMatch) {
          currentFile = { action: 'update', filePath: updateMatch[1].trim() };
        } else if (deleteMatch) {
          currentFile = { action: 'delete', filePath: deleteMatch[1].trim() };
        } else if (moveMatch) {
          currentFile = { action: 'move', filePath: '', newPath: moveMatch[1].trim() };
        }

        contentLines = [];
      } else if (currentFile) {
        contentLines.push(line);
      }
    }

    if (currentFile) {
      currentFile.content = contentLines.join('\n');
      files.push(currentFile);
    }

    return files;
  }

  private async createFile(sessionId: string, cwd: string, file: PatchFile): Promise<void> {
    const resolvedPath = path.resolve(cwd, file.filePath);
    const dir = path.dirname(resolvedPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(resolvedPath, file.content || '', 'utf-8');
    recordFileRead(sessionId, resolvedPath, (await fs.stat(resolvedPath)).mtimeMs);
  }

  private async updateFile(sessionId: string, cwd: string, file: PatchFile): Promise<void> {
    const resolvedPath = path.resolve(cwd, file.filePath);
    await fs.writeFile(resolvedPath, file.content || '', 'utf-8');
    recordFileRead(sessionId, resolvedPath, (await fs.stat(resolvedPath)).mtimeMs);
  }

  private async deleteFile(cwd: string, file: PatchFile): Promise<void> {
    const resolvedPath = path.resolve(cwd, file.filePath);
    await fs.unlink(resolvedPath);
  }

  private async moveFile(sessionId: string, cwd: string, file: PatchFile): Promise<void> {
    const srcPath = path.resolve(cwd, file.filePath);
    const destPath = path.resolve(cwd, file.newPath!);
    const dir = path.dirname(destPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.rename(srcPath, destPath);
    recordFileRead(sessionId, destPath, (await fs.stat(destPath)).mtimeMs);
  }
}
