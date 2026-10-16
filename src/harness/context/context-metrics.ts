import type { TokenUsage } from '../llm/types.ts'

/** Host-only context identities never contain paths or provider credentials. */
export function isValidContextId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

/** Shared live-wire and durable-log accounting boundary. Unknown is not zero. */
export function isValidTokenUsage(value: unknown): value is TokenUsage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const usage = value as Record<string, unknown>
  if (Object.keys(usage).some(key => !['inputTokens', 'cachedInputTokens', 'outputTokens'].includes(key))) return false
  const count = (item: unknown): item is number => Number.isSafeInteger(item) && (item as number) >= 0
  return count(usage['inputTokens'])
    && (usage['cachedInputTokens'] === undefined || (count(usage['cachedInputTokens']) && usage['cachedInputTokens'] <= usage['inputTokens']))
    && (usage['outputTokens'] === undefined || count(usage['outputTokens']))
}
