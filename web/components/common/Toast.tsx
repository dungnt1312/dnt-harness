import { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Icon from './Icon.tsx'
import { ErrorNotice } from './ErrorNotice.tsx'
import { errorSummary } from '../../lib/copy.ts'
import { IconButton } from '../ui/IconButton.tsx'

export type ToastKind = 'ok' | 'bad' | 'info'

export interface ToastItem {
  readonly id: number
  readonly kind: ToastKind
  readonly text: string
  /** How many notifications collapsed into this toast (absent = 1). */
  readonly count?: number
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
  notify(text: string, kind?: ToastKind): void
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
  const timers = useRef(new Map<number, number>())

  const dispose = useCallback((id: number) => {
    setItems((prev) => prev.filter((item) => item.id !== id))
    const timer = timers.current.get(id)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timers.current.delete(id)
    }
  }, [])

  const notify = useCallback((text: string, kind: ToastKind = 'bad') => {
    const ttl = TOAST_TTL[kind]
    setItems((prev) => {
      // A repeat of a live toast restarts its clock instead of stacking a copy.
      // Errors compare by their rendered summary: a burst of failures whose raw
      // text differs (URL, status) still reads as one message to the user.
      const key = toastKey(kind, text)
      const existing = prev.find((item) => item.kind === kind && toastKey(item.kind, item.text) === key)
      if (existing !== undefined) {
        const timer = timers.current.get(existing.id)
        if (timer !== undefined) window.clearTimeout(timer)
        timers.current.set(existing.id, window.setTimeout(() => dispose(existing.id), ttl))
        // Keep the newest raw text so "Original response" shows the latest failure.
        return prev.map((item) => (item.id === existing.id ? { ...item, text, count: (item.count ?? 1) + 1 } : item))
      }
      const id = Date.now() + Math.random()
      // Bounded stack: the oldest toast leaves when the cap is hit.
      const overflow = prev.length >= TOAST_MAX ? prev.slice(0, prev.length - TOAST_MAX + 1) : []
      for (const dropped of overflow) {
        const timer = timers.current.get(dropped.id)
        if (timer !== undefined) {
          window.clearTimeout(timer)
          timers.current.delete(dropped.id)
        }
      }
      timers.current.set(id, window.setTimeout(() => dispose(id), ttl))
      return overflow.length > 0 ? [...prev.slice(overflow.length), { id, kind, text }] : [...prev, { id, kind, text }]
    })
  }, [dispose])

  useEffect(() => () => {
    for (const timer of timers.current.values()) window.clearTimeout(timer)
  }, [])

  const api = useMemo(() => ({ notify, dispose }), [notify, dispose])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 top-[calc(0.75rem+env(safe-area-inset-top))] z-[60] flex flex-col items-center gap-2 px-4">
        {items.map((item) => (
          <div
            key={item.id}
            role={item.kind === 'bad' ? 'alert' : 'status'}
            className="pointer-events-auto flex w-full max-w-md items-start gap-2 rounded-2xl border border-line bg-surface py-2 pl-3.5 pr-1.5 text-sm shadow-pop animate-fade-up"
          >
            {item.kind === 'ok' ? <Icon name="check" size={16} className="mt-2 text-ok" /> : null}
            {item.kind === 'bad' ? <Icon name="alertTriangle" size={16} className="mt-2 text-bad" /> : null}
            <div className="min-w-0 flex-1 py-1.5">{item.kind === 'bad' ? <ErrorNotice raw={item.text} announce={false} /> : <p className="m-0">{item.text}</p>}</div>
            {(item.count ?? 1) > 1 ? <span className="mt-2 shrink-0 text-xs tabular-nums text-fg-muted" aria-label={`Repeated ${item.count} times`}>×{item.count}</span> : null}
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
