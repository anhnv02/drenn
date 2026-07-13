import { spawn } from 'child_process';
import { readHooks } from '../config/settingsStore';

export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'UserPromptSubmit'
  | 'Stop'
  | 'SubagentStop'
  | 'SessionStart'
  | 'PreCompact'
  | 'Notification'
  | 'PermissionRequest';

export interface HookDef {
  matcher?: string;
  command: string;
  timeout?: number;
}

export interface HookPayload {
  hook_event_name: HookEvent;
  session_id: string;
  cwd: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: { content: string; isError: boolean };
  prompt?: string;
  source?: 'startup' | 'resume';
  trigger?: 'auto' | 'error';
  message?: string;
  agent_name?: string;
  resource?: string;
}

export interface HookOutcome {
  blocked: boolean;
  feedback?: string;
  context?: string;
}

const DEFAULT_TIMEOUT_S = 60;

function matchTarget(payload: Omit<HookPayload, 'hook_event_name'>): string | undefined {
  return payload.tool_name ?? payload.source ?? payload.trigger;
}

function matches(def: HookDef, target?: string): boolean {
  if (!def.matcher) return true;
  if (!target) return false;
  try {
    return new RegExp(def.matcher).test(target);
  } catch {
    return def.matcher === target;
  }
}

function runHookCommand(
  def: HookDef,
  payload: HookPayload,
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(def.command, {
      shell: true,
      cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timeoutMs = (def.timeout ?? DEFAULT_TIMEOUT_S) * 1000;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({
        exitCode: 1,
        stdout,
        stderr: `[hook timed out after ${timeoutMs / 1000}s] ${stderr}`,
      });
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: `[hook failed to start: ${err.message}]` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });

    try {
      child.stdin?.write(JSON.stringify(payload));
      child.stdin?.end();
    } catch {
      // stdin may already be closed if the command exited instantly
    }
  });
}

export async function runHooks(
  event: HookEvent,
  payload: Omit<HookPayload, 'hook_event_name'>,
): Promise<HookOutcome> {
  const defs = readHooks()[event] ?? [];
  const applicable = defs.filter((d) => d.command && matches(d, matchTarget(payload)));

  const contexts: string[] = [];
  for (const def of applicable) {
    const { exitCode, stdout, stderr } = await runHookCommand(
      def,
      { hook_event_name: event, ...payload },
      payload.cwd,
    );
    if (exitCode === 2) {
      return {
        blocked: true,
        feedback: stderr.trim() || `Blocked by ${event} hook: ${def.command}`,
      };
    }
    if (exitCode !== 0) {
      console.error(`[hooks] ${event} hook failed (exit ${exitCode}): ${def.command}\n${stderr}`);
    } else if (stdout.trim()) {
      contexts.push(stdout.trim());
    }
  }
  return { blocked: false, context: contexts.length ? contexts.join('\n') : undefined };
}

export function hasHooks(event: HookEvent): boolean {
  return (readHooks()[event] ?? []).some((d) => d.command);
}
