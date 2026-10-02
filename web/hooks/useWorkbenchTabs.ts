import { useCallback, useRef, useState } from 'react'
import {
  parseWorkbenchLegacyTabs,
  parseWorkbenchTabs,
  normalizeWorkbenchTabs,
  WORKBENCH_STORAGE_KEY,
  WORKBENCH_TABS_DEFAULTS,
  WORKBENCH_TABS_STORAGE_KEY,
  type WorkbenchSessionTabs,
  type WorkbenchTabsRecord,
} from '../lib/workbench-preferences.ts'

/** Remembered tab strips kept at once; the least recently used entry falls off. */
export const WORKBENCH_TABS_MAX = 60

interface WorkbenchTabsState {
  readonly record: WorkbenchTabsRecord
  /**
   * Where a conversation without its own record starts. Captured once at load
   * from the tab fields the global preference used to hold, so the split into
   * per-session records does not reset every existing conversation to a bare
   * Files tab; it fades out as sessions gain records of their own.
   */
  readonly seed: WorkbenchSessionTabs
}

function readTabsState(): WorkbenchTabsState {
  try {
    const record = parseWorkbenchTabs(window.localStorage.getItem(WORKBENCH_TABS_STORAGE_KEY))
    if (Object.keys(record).length > 0) return { record, seed: WORKBENCH_TABS_DEFAULTS }
    return { record: {}, seed: parseWorkbenchLegacyTabs(window.localStorage.getItem(WORKBENCH_STORAGE_KEY)) }
  } catch {
    return { record: {}, seed: WORKBENCH_TABS_DEFAULTS }
  }
}

function persistTabs(record: WorkbenchTabsRecord): void {
  try {
    window.localStorage.setItem(WORKBENCH_TABS_STORAGE_KEY, JSON.stringify(record))
  } catch {
    // Presentation preferences remain usable when browser storage is unavailable.
  }
}

function limitTabs(record: WorkbenchTabsRecord): WorkbenchTabsRecord {
  const keys = Object.keys(record)
  if (keys.length <= WORKBENCH_TABS_MAX) return record
  return Object.fromEntries(keys.slice(keys.length - WORKBENCH_TABS_MAX).map((key) => [key, record[key]]))
}

/**
 * The workbench tab strip and the selected view, remembered per conversation
 * under `dnt-harness.workbench.tabs.v1`: the key is `<workspaceId>:<sessionId>`,
 * or `draft` before the first message, and one conversation's open tabs never
 * leak into another. A null key (no workspace yet) reads as defaults and drops
 * patches. Widths, collapse and the terminal stay one global preference — see
 * {@link ../hooks/useWorkbenchPreferences.ts}.
 */
export function useWorkbenchTabs(sessionKey: string | null): {
  readonly tabs: WorkbenchSessionTabs
  readonly patchTabs: (patch: Partial<WorkbenchSessionTabs>) => void
} {
  const [state, setState] = useState<WorkbenchTabsState>(readTabsState)
  const sessionKeyRef = useRef(sessionKey)
  sessionKeyRef.current = sessionKey

  const tabs = sessionKey !== null ? state.record[sessionKey] ?? state.seed : WORKBENCH_TABS_DEFAULTS

  const patchTabs = useCallback((patch: Partial<WorkbenchSessionTabs>) => {
    const key = sessionKeyRef.current
    if (key === null) return
    setState((current) => {
      // One patch at a time against the merged entry: the strip writes and the
      // selection writes land as separate patches and must not lose each
      // other's half (see normalizeWorkbenchTabs for the invariants).
      const base = current.record[key] ?? current.seed
      const merged = normalizeWorkbenchTabs(
        patch.inspectorTab ?? base.inspectorTab,
        patch.inspectorViews ?? base.inspectorViews,
      )
      // Reinserting the key moves it to the end, so the record is kept in
      // least-recently-written order for the cap.
      const rest: WorkbenchTabsRecord = {}
      for (const [entryKey, entry] of Object.entries(current.record)) {
        if (entryKey !== key) rest[entryKey] = entry
      }
      const record = limitTabs({ ...rest, [key]: merged })
      persistTabs(record)
      return { record, seed: current.seed }
    })
  }, [])

  return { tabs, patchTabs }
}
