import { readFile } from 'fs/promises';

/**
 * Read and parse JSON file with proper error handling
 * Returns undefined for missing files (opencode pattern)
 */
export async function readJsonFile<T = unknown>(filePath: string): Promise<T | undefined> {
  try {
    const text = await readFile(filePath, 'utf-8');
    if (!text || !text.trim()) return undefined;
    return JSON.parse(text) as T;
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as { code: string }).code === 'ENOENT'
    ) {
      return undefined;
    }
    if (error instanceof SyntaxError) {
      console.error(`Corrupted JSON file: ${filePath}`);
      return undefined;
    }
    throw error;
  }
}

/**
 * Read and parse JSON file with default fallback
 */
export async function readJsonFileOrDefault<T>(filePath: string, defaultValue: T): Promise<T> {
  const result = await readJsonFile<T>(filePath);
  return result !== undefined ? result : defaultValue;
}

/**
 * Parse JSONL (JSON Lines) file line by line
 * Skips corrupted lines instead of failing the entire file
 */
export async function readJsonlFile<T>(filePath: string): Promise<T[]> {
  try {
    const text = await readFile(filePath, 'utf-8');
    if (!text || !text.trim()) return [];

    const lines = text.split('\n').filter((line: string) => line.trim());
    const results: T[] = [];

    for (const line of lines) {
      try {
        results.push(JSON.parse(line) as T);
      } catch {
        console.warn(`Skipping corrupted line in ${filePath}`);
      }
    }

    return results;
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as { code: string }).code === 'ENOENT'
    ) {
      return [];
    }
    throw error;
  }
}
