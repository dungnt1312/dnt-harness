/**
 * Rows the user cleared from the background-process / subagent lists, kept
 * per workspace+session in browser storage so a Clear survives a reload and
 * applies to every panel showing the same conversation (Environment panel and
 * the workbench Process view share one store). Dismissal is view state only:
 * the durable log and the host registry keep the full history. Storage is
 * best-effort — every path works when it is unavailable.
 */
import { useCallback, useSyncExternalStore } from 'react'

export const DISMISSED_STORAGE_KEY = 'dnt-harness.dismissed-rows.v1'
/** Newest conversations kept; older ones drop out rather than grow forever. */
export const MAX_DISMISSED_SESSIONS = 50
/** Per-conversation id ceiling (oldest dismissals fall off first). */
export const MAX_DISMISSED_IDS = 1_000

const EMPTY: ReadonlySet<string> = new Set()

export function dismissedKey(workspaceId: string | null, sessionId: string | null): string | null {
  return workspaceId === null || sessionId === null ? null : `${workspaceId}:${sessionId}`
}

export function parseDismissed(raw: string | null): Map<string, ReadonlySet<string>> {
  const result = new Map<string, ReadonlySet<string>>()
  if (raw === null) return result
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return result
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue
      const ids = value.filter((id): id is string => typeof id === 'string' && id !== '')
      if (ids.length > 0) result.set(key, new Set(ids.slice(-MAX_DISMISSED_IDS)))
    }
  } catch {
    // Corrupt storage reads as nothing dismissed.
  }
  return result
}

export function serializeDismissed(entries: ReadonlyMap<string, ReadonlySet<string>>): string {
  const kept = [...entries]
    .filter(([, ids]) => ids.size > 0)
    .slice(-MAX_DISMISSED_SESSIONS)
    .map(([key, ids]) => [key, [...ids].slice(-MAX_DISMISSED_IDS)] as const)
  return JSON.stringify(Object.fromEntries(kept))
}

let cache: Map<string, ReadonlySet<string>> | null = null
const listeners = new Set<() => void>()

function load(): Map<string, ReadonlySet<string>> {
  if (cache !== null) return cache
  try {
    cache = parseDismissed(window.localStorage.getItem(DISMISSED_STORAGE_KEY))
  } catch {
    cache = new Map()
  }
  return cache
}

function commit(key: string, next: ReadonlySet<string>): void {
  const entries = load()
  // Re-insert so the most recently touched conversation sorts last (kept longest).
  entries.delete(key)
  if (next.size > 0) entries.set(key, next)
  try {
    window.localStorage.setItem(DISMISSED_STORAGE_KEY, serializeDismissed(entries))
  } catch {
    // A full or blocked store still dismisses for this page load.
  }
  for (const listener of [...listeners]) listener()
}

export function readDismissed(key: string | null): ReadonlySet<string> {
  if (key === null) return EMPTY
  return load().get(key) ?? EMPTY
}

export function dismissRows(key: string | null, ids: Iterable<string>): void {
  if (key === null) return
  const previous = readDismissed(key)
  const next = new Set(previous)
  for (const id of ids) next.add(id)
  if (next.size !== previous.size) commit(key, next)
}

export function undismissRow(key: string | null, id: string): void {
  if (key === null) return
  const previous = readDismissed(key)
  if (!previous.has(id)) return
  const next = new Set(previous)
  next.delete(id)
  commit(key, next)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  // Another tab cleared the same conversation: drop the cache and re-read.
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== DISMISSED_STORAGE_KEY) return
    cache = null
    listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

/** Test seam: forget the in-memory copy so the next read hits storage. */
export function resetDismissedCache(): void {
  cache = null
}

/** The conversation's dismissed ids plus stable mutators, shared across panels. */
export function useDismissedRows(workspaceId: string | null, sessionId: string | null): {
  readonly dismissed: ReadonlySet<string>
  readonly dismiss: (ids: Iterable<string>) => void
  readonly undismiss: (id: string) => void
} {
  const key = dismissedKey(workspaceId, sessionId)
  const dismissed = useSyncExternalStore(subscribe, () => readDismissed(key), () => EMPTY)
  const dismiss = useCallback((ids: Iterable<string>) => dismissRows(key, ids), [key])
  const undismiss = useCallback((id: string) => undismissRow(key, id), [key])
  return { dismissed, dismiss, undismiss }
}
