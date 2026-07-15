import { spawn, type ChildProcess } from 'child_process';
import type { BaseTool, ExecutionContext, ToolCall, ToolInfo, ToolResponse } from './types';
import { parseToolInput } from '../../shared/utils/json';

const MAX_JOB_OUTPUT = 1024 * 1024;

export type ShellJobStatus = 'running' | 'completed' | 'failed' | 'killed';

interface ShellJob {
  id: string;
  command: string;
  child: ChildProcess;
  output: string;
  readOffset: number;
  status: ShellJobStatus;
  exitCode?: number;
  startedAt: number;
}

const jobs = new Map<string, ShellJob>();
let nextJobId = 1;

export function startBackgroundShell(command: string, cwd: string): ShellJob {
  const id = `shell_${nextJobId++}`;
  const child = spawn(command, {
    shell: true,
    cwd,
    env: { ...process.env, FORCE_COLOR: '0' },
  });

  const job: ShellJob = {
    id,
    command,
    child,
    output: '',
    readOffset: 0,
    status: 'running',
    startedAt: Date.now(),
  };

  const append = (chunk: Buffer): void => {
    job.output += chunk.toString();
    if (job.output.length > MAX_JOB_OUTPUT) {
      const dropped = job.output.length - MAX_JOB_OUTPUT;
      job.output = job.output.slice(dropped);
      job.readOffset = Math.max(0, job.readOffset - dropped);
    }
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);

  child.on('error', (err) => {
    job.output += `\n[spawn error: ${err.message}]`;
    job.status = 'failed';
  });
  child.on('close', (code, signal) => {
    if (job.status === 'killed') return;
    job.exitCode = code ?? undefined;
    job.status = signal ? 'killed' : code === 0 ? 'completed' : 'failed';
  });

  jobs.set(id, job);
  return job;
}

export function getShellJob(id: string): ShellJob | undefined {
  return jobs.get(id);
}

export function listShellJobs(): ShellJob[] {
  return Array.from(jobs.values());
}

export function disposeAllShellJobs(): void {
  for (const job of jobs.values()) {
    if (job.status === 'running') {
      job.status = 'killed';
      job.child.kill('SIGTERM');
    }
  }
  jobs.clear();
}

export class BashOutputTool implements BaseTool {
  info(): ToolInfo {
    return {
      name: 'bash_output',
      description: `Retrieve output from a background shell started with bash's run_in_background. Returns only the output produced since the last bash_output call for that shell, plus its status. Poll this while waiting for a long-running command; when the status is no longer "running" the job is finished.`,
      parameters: {
        type: 'object',
        properties: {
          shell_id: {
            type: 'string',
            description: 'The id returned when the background shell was started',
          },
        },
        required: ['shell_id'],
      },
      required: ['shell_id'],
    };
  }

  async run(_ctx: ExecutionContext, call: ToolCall): Promise<ToolResponse> {
    const params = parseToolInput<{
      shell_id?: string;
    }>(call.input);
    const shellId = String(params.shell_id ?? '');

    const job = jobs.get(shellId);
    if (!job) {
      const running = listShellJobs().map((j) => `${j.id} (${j.status}): ${j.command}`);
      return {
        content: `Error: no background shell "${shellId}". ${running.length ? `Known shells:\n${running.join('\n')}` : 'No background shells have been started.'}`,
        isError: true,
      };
    }

    const newOutput = job.output.slice(job.readOffset);
    job.readOffset = job.output.length;

    const statusLine =
      job.status === 'running'
        ? 'status: running'
        : `status: ${job.status}${job.exitCode !== undefined ? ` (exit code ${job.exitCode})` : ''}`;
    return {
      content: `${statusLine}\n${newOutput || '(no new output)'}`,
      isError: false,
      metadata: { shellId, status: job.status, exitCode: job.exitCode },
    };
  }
}

export class KillShellTool implements BaseTool {
  info(): ToolInfo {
    return {
      name: 'kill_shell',
      description:
        "Terminate a background shell started with bash's run_in_background, by its shell id.",
      parameters: {
        type: 'object',
        properties: {
          shell_id: {
            type: 'string',
            description: 'The id of the background shell to kill',
          },
        },
        required: ['shell_id'],
      },
      required: ['shell_id'],
    };
  }

  async run(_ctx: ExecutionContext, call: ToolCall): Promise<ToolResponse> {
    const params = parseToolInput<{
      shell_id?: string;
    }>(call.input);
    const shellId = String(params.shell_id ?? '');

    const job = jobs.get(shellId);
    if (!job) {
      return { content: `Error: no background shell "${shellId}"`, isError: true };
    }
    if (job.status !== 'running') {
      return { content: `Shell ${shellId} already finished (${job.status})`, isError: false };
    }

    job.status = 'killed';
    job.child.kill('SIGTERM');
    return { content: `Killed shell ${shellId} (${job.command})`, isError: false };
  }
}
