import { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Icon from './Icon.tsx'
import { ErrorNotice } from './ErrorNotice.tsx'
import { IconButton } from '../ui/IconButton.tsx'

export type ToastKind = 'ok' | 'bad' | 'info'

export interface ToastItem {
  readonly id: number
  readonly kind: ToastKind
  readonly text: string
}

interface ToastApi {
  notify(text: string, kind?: ToastKind): void
  dispose(id: number): void
}

const ToastContext = createContext<ToastApi | null>(null)

/** Auto-dismiss per variant: ok 5s, info 5s, error 8s. */
const TOAST_TTL: Readonly<Record<ToastKind, number>> = { ok: 5_000, info: 5_000, bad: 8_000 }

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
    const id = Date.now() + Math.random()
    setItems((prev) => [...prev, { id, kind, text }])
    timers.current.set(id, window.setTimeout(() => dispose(id), TOAST_TTL[kind]))
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
