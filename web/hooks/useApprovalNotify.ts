import { useCallback, useEffect, useRef, useState } from 'react'
import { listWorkspaces } from '../lib/api.ts'
import { toolFacts } from '../lib/tool-facts.ts'
import type { PendingApproval } from '../lib/types.ts'

const STORAGE_KEY = 'notify-approvals'

function readStored(): boolean {
  try { return window.localStorage.getItem(STORAGE_KEY) === '1' } catch { return false }
}

function notifySupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window
}

/**
 * Opt-in background-tab approval notifications (spec: Global states).
 * Fires only for approvals of the OPEN session while document.hidden;
 * clicking one focuses the window. A visible tab never notifies — the
 * ApprovalBar on the canvas is the anchor there.
 */
export function useApprovalNotify(approvals: readonly PendingApproval[], workspaceName?: string): {
  readonly enabled: boolean
  readonly blocked: boolean
  readonly toggle: () => void
} {
  const [enabled, setEnabled] = useState(readStored)
  const [blocked, setBlocked] = useState(false)
  const notified = useRef(new Set<string>())
  const workspaceRef = useRef(workspaceName)
  workspaceRef.current = workspaceName

  useEffect(() => {
    if (!enabled || !notifySupported() || Notification.permission !== 'granted') return
    if (typeof document === 'undefined' || !document.hidden) return
    for (const approval of approvals) {
      if (notified.current.has(approval.approvalId)) continue
      notified.current.add(approval.approvalId)
      const facts = toolFacts(approval.call)
      const body = `${facts.name}${facts.fullTarget !== '' ? ` · ${facts.fullTarget}` : ''} (workspace "${workspaceRef.current ?? 'current'}")`
      try {
        const notification = new Notification('dnt-harness — approval needed', { body })
        notification.onclick = () => { window.focus(); notification.close() }
      } catch {
        // Construction can throw on some platforms; notifications are
        // best-effort by contract.
      }
    }
    // Bounded to what is still pending: a long session would otherwise
    // remember every id it ever notified about.
    const live = new Set(approvals.map((row) => row.approvalId))
    for (const id of notified.current) if (!live.has(id)) notified.current.delete(id)
  }, [approvals, enabled])

  useEffect(() => {
    if (!enabled || !notifySupported() || Notification.permission !== 'granted') return
    let primed = false
    let lastOther = 0
    const tick = async (): Promise<void> => {
      if (typeof document === 'undefined' || !document.hidden) return
      try {
        const rows = await listWorkspaces()
        const total = rows.reduce((sum, row) => sum + (row.approvals ?? 0), 0)
        const other = Math.max(0, total - approvals.length)
        if (primed && other > lastOther) {
          const body = other === 1
            ? 'Another conversation is waiting for an approval.'
            : `${other} approvals are waiting in other conversations.`
          try {
            const notification = new Notification('dnt-harness — approval needed', { body })
            notification.onclick = () => { window.focus(); notification.close() }
          } catch { /* best-effort */ }
        }
        primed = true
        lastOther = other
      } catch { /* listing is best-effort while hidden */ }
    }
    const id = window.setInterval(() => { void tick() }, 8_000)
    void tick()
    return () => { window.clearInterval(id) }
  }, [approvals.length, enabled])

  const toggle = useCallback(() => {
    if (!notifySupported()) { setBlocked(true); return }
    if (enabled) {
      setEnabled(false)
      try { window.localStorage.setItem(STORAGE_KEY, '0') } catch { /* storage may be unavailable */ }
      return
    }
    void (async () => {
      const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
      if (permission !== 'granted') {
        setBlocked(true)
        setEnabled(false)
        try { window.localStorage.setItem(STORAGE_KEY, '0') } catch { /* storage may be unavailable */ }
        return
      }
      setBlocked(false)
      setEnabled(true)
      try { window.localStorage.setItem(STORAGE_KEY, '1') } catch { /* storage may be unavailable */ }
    })()
  }, [enabled])

  return { enabled, blocked, toggle }
}
