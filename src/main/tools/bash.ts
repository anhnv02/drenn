import { exec } from 'child_process';
import * as path from 'path';
import type { BaseTool, ExecutionContext, ToolCall, ToolInfo, ToolResponse } from './types';
import { deniedToolResult, type PermissionService } from '../permission';
import { isReadOnlyCommand, splitCommandSegments } from './readOnlyCommands';
import { startBackgroundShell } from './backgroundShells';
import { parseToolInput } from '../../shared/utils/json';

const MAX_OUTPUT_LENGTH = 100 * 1024;
const DEFAULT_TIMEOUT = 30000;

const BANNED_COMMANDS = ['curl', 'wget', 'open', 'browser'];

const ENV_ASSIGNMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s*/;

function findBannedCommand(command: string): string | undefined {
  for (const segment of splitCommandSegments(command)) {
    let s = segment;
    for (;;) {
      const stripped = s.replace(ENV_ASSIGNMENT_PREFIX, '');
      if (stripped === s) break;
      s = stripped;
    }
    if (s === '') continue;
    const head = path.basename(s.split(/\s+/)[0].replace(/^["']|["']$/g, ''));
    if (BANNED_COMMANDS.includes(head)) return head;
  }
  return undefined;
}

export class BashTool implements BaseTool {
  private permissions: PermissionService;

  constructor(permissions: PermissionService) {
    this.permissions = permissions;
  }

  info(): ToolInfo {
    return {
      name: 'bash',
      description: `Executes a shell command in the working directory and returns its output.

Usage notes:
- Each call runs in a fresh shell: environment variables and \`cd\` do NOT persist between calls. Chain dependent commands with \`&&\` in a single call, and prefer absolute paths over \`cd\`.
- Quote file paths that contain spaces (e.g. cd "path with spaces").
- IMPORTANT: Avoid using bash for file search or reading — use the dedicated tools instead: grep (search content), glob (find files by pattern), view (read files), ls (list directories).
- \`curl\` and \`wget\` are not allowed; use the fetch tool for HTTP requests.
- Output is truncated after 100KB. Default timeout is 30s (override with \`timeout\`).
- For long-running commands (dev servers, watch builds), set run_in_background: true — the call returns a shell id immediately; read incremental output with bash_output and stop it with kill_shell. Do not use it just to avoid waiting for a normal command.

Committing with git: only commit when the user explicitly asks you to. First run \`git status\` and \`git diff\` to review the changes and \`git log --oneline -5\` to match the repository's commit message style, then stage and commit with a concise message explaining the "why". For pull requests, use the \`gh\` CLI if available.`,
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Shell command to execute',
          },
          timeout: {
            type: 'number',
            description: 'Timeout in milliseconds (default: 30000; ignored for background shells)',
          },
          run_in_background: {
            type: 'boolean',
            description: 'Run the command in a background shell and return its id immediately',
          },
        },
        required: ['command'],
      },
      required: ['command'],
    };
  }

  async run(ctx: ExecutionContext, call: ToolCall): Promise<ToolResponse> {
    try {
      const params = parseToolInput<{
        command?: string;
        timeout?: number;
        run_in_background?: boolean;
      }>(call.input, { timeout: DEFAULT_TIMEOUT, run_in_background: false });
      const { command, timeout = DEFAULT_TIMEOUT, run_in_background = false } = params;

      if (!command) {
        return { content: 'Error: command is required', isError: true };
      }

      const banned = findBannedCommand(command);
      if (banned) {
        return {
          content: `Error: Command '${banned}' is not allowed for security reasons`,
          isError: true,
        };
      }

      if (ctx.mode === 'plan' && !isReadOnlyCommand(command)) {
        return {
          content:
            'Plan mode is active: only read-only commands may run (ls, cat, grep, find, git status/log/diff/show, ...). Describe the change in your plan instead of making it.',
          isError: true,
        };
      }

      if (ctx.mode !== 'bypassPermissions') {
        const decision = await this.permissions.request({
          id: call.id,
          sessionId: ctx.sessionId,
          messageId: ctx.messageId,
          toolName: 'bash',
          action: 'bash',
          description: `Execute: ${command}`,
          params: { command, timeout },
          resource: command,
          cwd: ctx.cwd,
          autoApprove: isReadOnlyCommand(command),
        });

        if (!decision.approved) {
          return { content: deniedToolResult(decision.feedback), isError: true };
        }
      }

      if (run_in_background) {
        const job = startBackgroundShell(command, ctx.cwd);
        return {
          content: `Started background shell ${job.id}: ${command}\nUse bash_output with shell_id "${job.id}" to read its output, kill_shell to stop it.`,
          isError: false,
          metadata: { shellId: job.id, background: true },
        };
      }

      const result = await this.executeCommand(command, ctx.cwd, timeout, ctx.abortSignal);

      return {
        content: result.output,
        isError: result.exitCode !== 0,
        metadata: { exitCode: result.exitCode },
      };
    } catch (error) {
      return { content: `Error executing command: ${error}`, isError: true };
    }
  }

  private executeCommand(
    command: string,
    cwd: string,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<{ output: string; exitCode: number }> {
    return new Promise((resolve) => {
      exec(
        command,
        {
          cwd,
          timeout,
          signal,
          maxBuffer: MAX_OUTPUT_LENGTH,
          env: { ...process.env, FORCE_COLOR: '0' },
        },
        (error, stdout, stderr) => {
          let output = '';
          if (stdout) output += stdout;
          if (stderr) output += (output ? '\n' : '') + stderr;

          if (output.length > MAX_OUTPUT_LENGTH) {
            output = output.slice(0, MAX_OUTPUT_LENGTH) + '\n... [output truncated]';
          }

          let exitCode = 0;
          if (error) {
            exitCode = typeof error.code === 'number' ? error.code : 1;
            let note = '';
            if (signal?.aborted) {
              note = '[command cancelled by user]';
            } else if (error.killed || error.signal) {
              note = `[command killed after exceeding the ${timeout}ms timeout]`;
            } else if (error.message.includes('maxBuffer')) {
              note = `[command killed: output exceeded ${MAX_OUTPUT_LENGTH / 1024}KB]`;
            }
            if (note) output += (output ? '\n' : '') + note;
          }

          resolve({
            output: output || (error ? error.message : 'Command completed'),
            exitCode,
          });
        },
      );
    });
  }
}
