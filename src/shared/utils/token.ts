const CHARS_PER_TOKEN = 4

export const estimate = (input: string): number => Math.max(0, Math.round(input.length / CHARS_PER_TOKEN))

const safe = (value: number | undefined): number => Math.max(0, Number.isFinite(value) ? (value ?? 0) : 0)

export interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export interface RawUsage {
  inputTokens?: number
  outputTokens?: number
  nonCachedInputTokens?: number
  cacheReadInputTokens?: number
  cacheWriteInputTokens?: number
  reasoningTokens?: number
}

export const computeTokenUsage = (usage: RawUsage | undefined): TokenUsage => {
  const reasoning = safe(usage?.reasoningTokens)
  const read = safe(usage?.cacheReadInputTokens)
  const write = safe(usage?.cacheWriteInputTokens)
  const outputTokens = safe(usage?.outputTokens)
  const reasoningTokens = safe(usage?.reasoningTokens)
  const visibleOutput = Math.max(0, outputTokens - reasoningTokens)
  return {
    input: safe(usage?.nonCachedInputTokens),
    output: visibleOutput,
    reasoning,
    cache: { read, write },
  }
}