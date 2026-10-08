import { createContext, useContext, useEffect, useId, useRef } from 'react'

/**
 * Settings-wide unsaved-change tracking. Each panel reports whether it holds
 * edits that are not on disk; the Settings dialog consults the registry before
 * switching tab or closing, and panels ask through the same dialog before an
 * in-panel action (back to list, open another row) would drop their draft.
 */
export interface UnsavedChangesApi {
  /** Record (or clear) one reporter's dirty flag. */
  readonly report: (key: string, dirty: boolean) => void
  /** Ask the operator to discard unsaved edits; runs `action` on confirm. */
  readonly confirmDiscard: (action: () => void) => void
}

export const UnsavedChangesContext = createContext<UnsavedChangesApi | null>(null)

/**
 * Report this draft's dirty state and get a guard for in-panel actions that
 * would discard it: the guard asks first only when THIS draft is dirty, so an
 * unrelated draft elsewhere in the panel never triggers a misleading prompt.
 * Outside a provider (standalone tests) the guard runs the action directly.
 */
export function useUnsavedChanges(dirty: boolean): (action: () => void) => void {
  const api = useContext(UnsavedChangesContext)
  const key = useId()
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  useEffect(() => {
    api?.report(key, dirty)
  }, [api, key, dirty])
  // Unmounting means the draft is gone: never leave a stale flag behind.
  useEffect(() => () => api?.report(key, false), [api, key])
  return (action) => {
    if (api !== null && dirtyRef.current) api.confirmDiscard(action)
    else action()
  }
}
