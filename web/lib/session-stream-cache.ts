import type { SseEvent } from './types.ts'

export interface CachedSessionStream { readonly events: readonly SseEvent[]; readonly cursor: number }

/** Per-hook, memory-only LRU. UTF-16 serialized size estimates payload retention,
 * not a hard JS heap limit; object overhead remains bounded by entry count. */
export function createSessionStreamCache(maxEntries = 3, maxBytes = 64 * 1024 * 1024) {
  const entries = new Map<string, { value: CachedSessionStream; bytes: number }>()
  let bytes = 0
  const remove = (key: string) => {
    const old = entries.get(key)
    if (old) { bytes -= old.bytes; entries.delete(key) }
  }
  return {
    get(key: string): CachedSessionStream | undefined {
      const entry = entries.get(key)
      if (!entry) return undefined
      entries.delete(key); entries.set(key, entry)
      return entry.value
    },
    set(key: string, value: CachedSessionStream): void {
      remove(key)
      const size = JSON.stringify(value.events).length * 2
      if (size > maxBytes || maxEntries <= 0) return
      entries.set(key, { value, bytes: size }); bytes += size
      while (entries.size > maxEntries || bytes > maxBytes) remove(entries.keys().next().value!)
    },
    clear(): void { entries.clear(); bytes = 0 },
  }
}
