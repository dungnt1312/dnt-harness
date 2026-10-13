import { useEffect, useSyncExternalStore } from 'react'
import { GitOutputDialog, type GitOutput } from './GitOutputDialog.tsx'

/**
 * The Git output dialog lives outside any panel: a persistent failure toast
 * outlives the GitPanel that raised it, and its View Log must still open.
 * The toast action carries the log payload and calls {@link showGitOutput}.
 */
let current: GitOutput | null = null
const listeners = new Set<() => void>()

function emit(next: GitOutput | null): void {
  current = next
  for (const listener of listeners) listener()
}

export function showGitOutput(output: GitOutput): void { emit(output) }

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Mount once next to `ToastHost`. */
export function GitOutputHost() {
  const output = useSyncExternalStore(subscribe, () => current, () => null)
  // A host that goes away takes its open dialog with it, so the next one starts closed.
  useEffect(() => () => { current = null }, [])
  return <GitOutputDialog output={output} onClose={() => emit(null)} />
}
