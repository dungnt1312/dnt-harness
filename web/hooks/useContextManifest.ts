import { useEffect, useRef, useState } from 'react'
import { fetchManifest, type ContextStatus, type ContextView } from '../lib/api.ts'

interface Owned { readonly owner: string; readonly status: ContextStatus; readonly view: ContextView | null }

/**
 * Context figures for one conversation. A figure belongs to the
 * `{workspaceId, sessionId}` that fetched it: any other owner reads as `loading`
 * on the very render the selection changes, so a previous conversation's count
 * (or a made-up zero) is never shown. `refreshKey` re-fetches the same
 * conversation after a 150 ms debounce; a switch fetches at once. HTTP 204 is
 * `none` (no request yet, or no conversation selected); any other failure is `error`.
 */
export function useContextManifest(workspaceId: string | null, sessionId: string | null, refreshKey: string): { readonly manifest: ContextView | null; readonly status: ContextStatus } {
  const [state, setState] = useState<Owned | null>(null)
  const shown = useRef<string | null>(null)
  const latest = useRef({ workspaceId, sessionId })
  latest.current = { workspaceId, sessionId }
  const owner = workspaceId !== null && sessionId !== null ? `${workspaceId}:${sessionId}` : null

  useEffect(() => {
    if (workspaceId === null || sessionId === null) return
    const key = `${workspaceId}:${sessionId}`
    const switched = shown.current !== key
    shown.current = key
    let cancelled = false
    const settle = (status: ContextStatus, view: ContextView | null): void => {
      if (!cancelled && latest.current.sessionId === sessionId && latest.current.workspaceId === workspaceId) setState({ owner: key, status, view })
    }
    const timer = setTimeout(() => {
      void fetchManifest(workspaceId, sessionId).then(
        (view) => settle(view === null ? 'none' : 'ready', view),
        () => settle('error', null),
      )
    }, switched ? 0 : 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [workspaceId, sessionId, refreshKey])

  const owned = owner !== null && state?.owner === owner
  if (owner === null) return { manifest: null, status: 'none' } // home or an unsent draft: nothing to load
  return { manifest: owned ? state.view : null, status: owned ? state.status : 'loading' }
}
