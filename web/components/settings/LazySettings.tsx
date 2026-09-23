import { lazy, Suspense, useState, type ComponentProps } from 'react'
import type { SettingsModal as SettingsModalType } from './SettingsModal.tsx'

const SettingsModal = lazy(async () => ({ default: (await import('./SettingsModal.tsx')).SettingsModal }))

export function LazySettings({ open, ...props }: ComponentProps<typeof SettingsModalType>) {
  const [opened, setOpened] = useState(false)
  if (open && !opened) setOpened(true)
  if (!opened && !open) return null
  return <Suspense fallback={<div role="status" className="sr-only">Loading settings…</div>}><SettingsModal open={open} {...props} /></Suspense>
}
