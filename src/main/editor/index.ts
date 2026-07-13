import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';

export interface OpenEditorResult {
  content: string;
  cancelled: boolean;
}

export async function openExternalEditor(initialContent?: string): Promise<OpenEditorResult> {
  const editor = process.env.EDITOR || process.env.VISUAL || 'vi';

  const tmpFile = path.join(os.tmpdir(), `drenn-msg-${randomUUID()}.md`);

  try {
    if (initialContent) {
      fs.writeFileSync(tmpFile, initialContent, 'utf-8');
    } else {
      fs.writeFileSync(tmpFile, '', 'utf-8');
    }

    // Parse editor command to handle paths with spaces
    const editorParts = editor.trim().split(/\s+/);
    const editorCmd = editorParts[0];
    const editorArgs = [...editorParts.slice(1), tmpFile];

    await new Promise<void>((resolve, reject) => {
      const child = spawn(editorCmd, editorArgs, {
        stdio: 'inherit',
        env: process.env,
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Editor exited with code ${code}`));
        } else {
          resolve();
        }
      });
    });

    const content = fs.readFileSync(tmpFile, 'utf-8');

    return {
      content,
      cancelled: content.trim() === '',
    };
  } catch (error) {
    return {
      content: '',
      cancelled: true,
    };
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // Ignore cleanup errors
    }
  }
}

export function getAvailableEditor(): string | null {
  return process.env.EDITOR || process.env.VISUAL || null;
}
