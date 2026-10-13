import { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Icon from './Icon.tsx'
import { ErrorNotice } from './ErrorNotice.tsx'
import { errorSummary } from '../../lib/copy.ts'
import { Button } from '../ui/Button.tsx'
import { IconButton } from '../ui/IconButton.tsx'

export type ToastKind = 'ok' | 'bad' | 'info'

export interface ToastItem {
  readonly id: number
  readonly kind: ToastKind
  readonly text: string
  /** How many notifications collapsed into this toast (absent = 1). */
  readonly count?: number
  /** One button inside the toast (Zed `StatusToast::action`); clicking runs it and closes the toast. */
  readonly action?: ToastAction
  /** No auto-dismiss timer: the toast stays until dismissed. */
  readonly persistent?: boolean
  /** A 'bad' toast shows its text as the headline instead of the ErrorNotice summary. */
  readonly plain?: boolean
}

export interface ToastAction {
  readonly label: string
  readonly onClick: () => void
}

export interface ToastOptions {
  readonly action?: ToastAction
  readonly persistent?: boolean
  /** The text is already the message to read (e.g. `git push failed`): skip the error summary. */
  readonly plain?: boolean
}

/** Identity used to collapse repeats: a recognised error category collapses by
 * the summary the user reads; unrecognised errors stay distinct by raw text. */
const GENERIC_SUMMARY = errorSummary('')
function toastKey(kind: ToastKind, text: string): string {
  if (kind !== 'bad') return text
  const summary = errorSummary(text)
  return summary === GENERIC_SUMMARY ? text : summary
}

interface ToastApi {
  /** Returns the toast's id (a repeat of a live toast returns that toast's id). */
  notify(text: string, kind?: ToastKind, options?: ToastOptions): number
  dispose(id: number): void
}

const ToastContext = createContext<ToastApi | null>(null)

/** Auto-dismiss per variant: ok 5s, info 5s, error 8s. */
const TOAST_TTL: Readonly<Record<ToastKind, number>> = { ok: 5_000, info: 5_000, bad: 8_000 }

/** Same-text toasts stacked on each other are noise, not information: a
 * failing poll or reconnect loop must not pile up copies of one error. */
const TOAST_MAX = 4

export function ToastHost({ children }: { readonly children: ReactNode }) {
  const [items, setItems] = useState<readonly ToastItem[]>([])
  // The live list, updated synchronously so `notify` can hand back an id.
  const live = useRef<readonly ToastItem[]>([])
  const timers = useRef(new Map<number, number>())

  const commit = useCallback((next: readonly ToastItem[]) => {
    live.current = next
    setItems(next)
  }, [])

  const clearTimer = useCallback((id: number) => {
    const timer = timers.current.get(id)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timers.current.delete(id)
    }
  }, [])

  const dispose = useCallback((id: number) => {
    commit(live.current.filter((item) => item.id !== id))
    clearTimer(id)
  }, [commit, clearTimer])

  const notify = useCallback((text: string, kind: ToastKind = 'bad', options: ToastOptions = {}): number => {
    const prev = live.current
    // A repeat of a live toast restarts its clock instead of stacking a copy.
    // Errors compare by their rendered summary: a burst of failures whose raw
    // text differs (URL, status) still reads as one message to the user.
    const key = toastKey(kind, text)
    const plain = options.plain === true
    const existing = prev.find((item) => item.kind === kind && (item.plain === true) === plain && toastKey(item.kind, item.text) === key)
    if (existing !== undefined) {
      clearTimer(existing.id)
      const persistent = existing.persistent === true || options.persistent === true
      if (!persistent) timers.current.set(existing.id, window.setTimeout(() => dispose(existing.id), TOAST_TTL[kind]))
      // Keep the newest raw text so "Original response" shows the latest failure.
      const action = options.action ?? existing.action
      commit(prev.map((item) => (item.id === existing.id
        ? { ...item, text, count: (item.count ?? 1) + 1, ...(persistent ? { persistent } : {}), ...(action !== undefined ? { action } : {}) }
        : item)))
      return existing.id
    }
    const id = Date.now() + Math.random()
    // Bounded stack: the oldest toast leaves when the cap is hit.
    const overflow = prev.length >= TOAST_MAX ? prev.slice(0, prev.length - TOAST_MAX + 1) : []
    for (const dropped of overflow) clearTimer(dropped.id)
    if (options.persistent !== true) timers.current.set(id, window.setTimeout(() => dispose(id), TOAST_TTL[kind]))
    const item: ToastItem = {
      id, kind, text,
      ...(options.persistent === true ? { persistent: true } : {}),
      ...(plain ? { plain: true } : {}),
      ...(options.action !== undefined ? { action: options.action } : {}),
    }
    commit([...prev.slice(overflow.length), item])
    return id
  }, [commit, clearTimer, dispose])

  useEffect(() => () => {
    for (const timer of timers.current.values()) window.clearTimeout(timer)
  }, [])

  const api = useMemo(() => ({ notify, dispose }), [notify, dispose])

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* A live region: modal dialogs (Radix `hideOthers`) leave `[aria-live]`
          nodes visible to assistive tech, so toasts raised from inside a dialog
          — the Workbench, a Git failure — are still announced and reachable. */}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 top-[calc(0.75rem+env(safe-area-inset-top))] z-[60] flex flex-col items-center gap-2 px-4">
        {items.map((item) => (
          <div
            key={item.id}
            role={item.kind === 'bad' ? 'alert' : 'status'}
            className="pointer-events-auto flex w-full max-w-md items-start gap-2 rounded-2xl border border-line bg-surface py-2 pl-3.5 pr-1.5 text-sm shadow-pop animate-fade-up"
          >
            {item.kind === 'ok' ? <Icon name="check" size={16} className="mt-2 text-ok" /> : null}
            {item.kind === 'bad' ? <Icon name="alertTriangle" size={16} className="mt-2 text-bad" /> : null}
            <div className="min-w-0 flex-1 py-1.5">{item.kind === 'bad' && item.plain !== true ? <ErrorNotice raw={item.text} announce={false} /> : <p className="m-0">{item.text}</p>}</div>
            {item.action !== undefined ? (
              <Button size="sm" variant="outline" className="mt-1 shrink-0" onClick={() => { item.action?.onClick(); dispose(item.id) }}>{item.action.label}</Button>
            ) : null}
            {(item.count ?? 1) > 1 ? <span className="mt-2 shrink-0 text-xs tabular-nums text-fg-muted" aria-label={`Repeated ${item.count} times`}>x{item.count}</span> : null}
            <IconButton label="Dismiss notification" onClick={() => dispose(item.id)}><Icon name="close" size={14} /></IconButton>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

/** Report a transient message (errors by default). Safe to call anywhere. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext)
  if (api === null) throw new Error('useToast: missing <ToastHost>')
  return api
}
