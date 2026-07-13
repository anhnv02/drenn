import { writeFile, readFile, mkdir, readdir, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { TOOL_OUTPUTS_DIR } from '../config/paths';

const MAX_LINES = 2000;
const MAX_CHARS = 50 * 1024;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function sanitizeForFilename(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '-');
}

interface StoredOutput {
  filePath: string;
  totalLines: number;
  totalChars: number;
  truncated: boolean;
}

class ToolOutputStore {
  private outputDir: string;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.outputDir = TOOL_OUTPUTS_DIR;
    this.ensureDir();
    this.startCleanup();
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.outputDir, { recursive: true });
  }

  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  async store(
    sessionId: string,
    toolCallId: string,
    output: string,
  ): Promise<{ content: string; metadata: StoredOutput | null }> {
    const lines = output.split('\n');
    const needsTruncation = lines.length > MAX_LINES || output.length > MAX_CHARS;

    if (!needsTruncation) {
      return { content: output, metadata: null };
    }

    const fileName = `${sanitizeForFilename(sessionId)}_${sanitizeForFilename(toolCallId)}_${Date.now()}.txt`;
    const filePath = join(this.outputDir, fileName);

    await writeFile(filePath, output, 'utf8');

    const truncatedLines = lines.slice(0, MAX_LINES);
    const truncated = truncatedLines.join('\n').slice(0, MAX_CHARS);

    const metadata: StoredOutput = {
      filePath,
      totalLines: lines.length,
      totalChars: output.length,
      truncated: true,
    };

    const preview = `${truncated}\n\n[Output truncated: ${lines.length} lines (${output.length} chars) total. Full output saved to: ${filePath}]`;

    return { content: preview, metadata };
  }

  async read(filePath: string): Promise<string> {
    return readFile(filePath, 'utf8');
  }

  private async cleanup(): Promise<void> {
    try {
      const files = await readdir(this.outputDir);
      const now = Date.now();

      for (const file of files) {
        const filePath = join(this.outputDir, file);
        const fileStat = await stat(filePath).catch(() => null);
        if (fileStat && now - fileStat.mtimeMs > MAX_AGE_MS) {
          await unlink(filePath).catch(() => {});
        }
      }
    } catch {}
  }

  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

export const toolOutputStore = new ToolOutputStore();
