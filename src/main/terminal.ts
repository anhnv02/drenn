import * as pty from 'node-pty';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { BrowserWindow } from 'electron';
import { getSessionCwd } from './history';

interface TerminalInstance {
  pty: pty.IPty;
  id: string;
}

const terminals = new Map<string, TerminalInstance>();

function getShell(): string {
  if (process.platform === 'win32') return 'powershell.exe';
  return process.env.SHELL || '/bin/zsh';
}

export async function createTerminal(
  mainWindow: BrowserWindow,
  sessionId: string | null,
  cols: number,
  rows: number,
): Promise<{ id: string; cwd: string }> {
  const id = randomUUID();
  const shell = getShell();
  let cwd = process.cwd();

  if (sessionId) {
    const sessionCwd = await getSessionCwd(sessionId);
    if (sessionCwd && existsSync(sessionCwd)) {
      cwd = sessionCwd;
    }
  }

  if (!existsSync(cwd)) {
    cwd = homedir();
  }

  const term = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: process.env as Record<string, string>,
  });

  terminals.set(id, { pty: term, id });

  term.onData((data: string) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:data', { id, data });
    }
  });

  term.onExit(({ exitCode }) => {
    terminals.delete(id);
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:exit', { id, exitCode });
    }
  });

  return { id, cwd };
}

export function writeTerminal(id: string, data: string): void {
  const terminal = terminals.get(id);
  if (terminal) {
    try {
      terminal.pty.write(data);
    } catch (err) {
      if ((err as any)?.code !== 'EPIPE') {
        console.error('Terminal write error:', err);
      }
    }
  }
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  const terminal = terminals.get(id);
  if (terminal) {
    try {
      terminal.pty.resize(cols, rows);
    } catch (err) {
      if ((err as any)?.code !== 'EPIPE') {
        console.error('Terminal resize error:', err);
      }
    }
  }
}

export function disposeTerminal(id: string): void {
  const terminal = terminals.get(id);
  if (terminal) {
    terminal.pty.kill();
    terminals.delete(id);
  }
}

export function disposeAllTerminals(): void {
  for (const [id] of terminals) {
    disposeTerminal(id);
  }
}
