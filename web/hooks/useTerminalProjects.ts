import { useCallback, useRef, useState } from 'react'
import {
  parseTerminalProjects,
  parseWorkbenchPreferences,
  TERMINAL_PROJECTS_STORAGE_KEY,
  WORKBENCH_STORAGE_KEY,
  type TerminalProjectState,
  type TerminalProjectsRecord,
} from '../lib/workbench-preferences.ts'

/** Remembered project terminal states kept at once; the least recently written falls off. */
export const TERMINAL_PROJECTS_MAX = 60

const CLOSED: TerminalProjectState = { footerOpen: false, workbenchTab: false }

interface TerminalProjectsStore {
  readonly record: TerminalProjectsRecord
  /**
   * The footer state of the old global preference, used only while no project
   * has a record yet, so the upgrade does not close a footer the operator had
   * open. It fades out as projects gain records of their own.
   */
  readonly legacyFooterOpen: boolean
  /** True when storage held no project records at load: the pre-split state still seeds. */
  readonly legacy: boolean
}

function readStore(): TerminalProjectsStore {
  try {
    const record = parseTerminalProjects(window.localStorage.getItem(TERMINAL_PROJECTS_STORAGE_KEY))
    if (Object.keys(record).length > 0) return { record, legacyFooterOpen: false, legacy: false }
    return { record: {}, legacyFooterOpen: parseWorkbenchPreferences(window.localStorage.getItem(WORKBENCH_STORAGE_KEY)).terminalOpen, legacy: true }
  } catch {
    return { record: {}, legacyFooterOpen: false, legacy: false }
  }
}

function persist(record: TerminalProjectsRecord): void {
  try {
    window.localStorage.setItem(TERMINAL_PROJECTS_STORAGE_KEY, JSON.stringify(record))
  } catch {
    // Presentation state remains usable when browser storage is unavailable.
  }
}

function limit(record: TerminalProjectsRecord): TerminalProjectsRecord {
  const keys = Object.keys(record)
  if (keys.length <= TERMINAL_PROJECTS_MAX) return record
  return Object.fromEntries(keys.slice(keys.length - TERMINAL_PROJECTS_MAX).map((key) => [key, record[key]]))
}

/**
 * Terminal surface state per project folder, under
 * `dnt-harness.terminal.projects.v1`: conversations in the same folder share
 * it, conversations in different folders never touch each other's. The key is
 * `<workspaceId>:<projectId>` (see terminalProjectKey); a null key (binding
 * still loading) reads as closed and drops patches, so nothing is written
 * under a folder the conversation does not belong to.
 *
 * `legacyWorkbenchTab` says whether the conversation's own strip lists the
 * Terminal tab; on the first load after the upgrade (no project records yet)
 * it seeds a project without a record, and is ignored once records exist.
 */
export function useTerminalProjects(projectKey: string | null, legacyWorkbenchTab: boolean): {
  readonly state: TerminalProjectState
  readonly patch: (patch: Partial<TerminalProjectState>) => void
} {
  const [store, setStore] = useState<TerminalProjectsStore>(readStore)
  const keyRef = useRef(projectKey)
  keyRef.current = projectKey
  const seedRef = useRef<TerminalProjectState>(CLOSED)
  const seed: TerminalProjectState = store.legacy
    ? { footerOpen: store.legacyFooterOpen, workbenchTab: legacyWorkbenchTab }
    : CLOSED
  seedRef.current = seed

  const state = projectKey === null ? CLOSED : store.record[projectKey] ?? seed

  const patch = useCallback((change: Partial<TerminalProjectState>) => {
    const key = keyRef.current
    if (key === null) return
    const fallback = seedRef.current
    setStore((current) => {
      const base = current.record[key] ?? fallback
      const merged: TerminalProjectState = {
        footerOpen: change.footerOpen ?? base.footerOpen,
        workbenchTab: change.workbenchTab ?? base.workbenchTab,
      }
      // Reinsert at the end so the cap drops the least recently written.
      const rest: TerminalProjectsRecord = {}
      for (const [entryKey, entry] of Object.entries(current.record)) {
        if (entryKey !== key) rest[entryKey] = entry
      }
      const record = limit({ ...rest, [key]: merged })
      persist(record)
      return { record, legacyFooterOpen: current.legacyFooterOpen, legacy: current.legacy }
    })
  }, [])

  return { state, patch }
}
