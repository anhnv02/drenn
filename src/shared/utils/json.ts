/**
 * Safe JSON parsing with empty input handling (opencode pattern)
 * Returns undefined on parse failure instead of throwing
 */
export function parseJsonSafe(input: string | undefined | null): unknown | undefined {
  if (!input || !input.trim()) return undefined;
  try {
    return JSON.parse(input);
  } catch {
    return undefined;
  }
}

/**
 * Parse JSON with default fallback (opencode pattern)
 * Returns defaultValue if input is empty or invalid
 */
export function parseJsonOrDefault<T>(input: string | undefined | null, defaultValue: T): T {
  if (!input || !input.trim()) return defaultValue;
  try {
    return JSON.parse(input) as T;
  } catch {
    return defaultValue;
  }
}

/**
 * Parse tool input - handles empty strings as empty object (opencode pattern)
 * This is the key pattern from opencode's parseToolInput
 */
export function parseToolInput<T>(input: string | undefined | null, defaults?: T): T {
  const raw = input || '{}';
  try {
    return JSON.parse(raw) as T;
  } catch {
    return defaults || ({} as T);
  }
}
