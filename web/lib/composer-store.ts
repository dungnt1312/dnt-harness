import { useSyncExternalStore } from 'react'
import type { RichDraft } from './composer-draft.ts'
import { persistDrafts, readDrafts } from './composer-drafts.ts'
import { emptyComposer, type ComposerState } from './interaction.ts'

/** Typing settles this long before unsent drafts are written to storage. */
const PERSIST_DELAY_MS = 300

export type ComposerMap = Readonly<Record<string, ComposerState>>

/**
 * Composer state for every conversation scope, kept outside React state.
 *
 * Each keystroke replaces a draft. Held in the app root's state, that would
 * re-render the whole app — transcript, sidebar, workbench — per character.
 * Here only the subscribers whose selected slice changed re-render: the
 * composer for its draft, the app for `sending` and `error`.
 *
 * Unsent drafts survive a reload; `sending`/`error` describe a request that
 * is gone, so only the drafts come back.
 */
export class ComposerStore {
  private state: ComposerMap
  private readonly listeners = new Set<() => void>()
  private persistTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    this.state = Object.fromEntries(Object.entries(readDrafts()).map(([scope, draft]) => [scope, { ...emptyComposer, draft }]))
  }

  readonly get = (): ComposerMap => this.state

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Replace the whole map; the new state is readable before React re-renders. */
  readonly set = (update: (all: ComposerMap) => ComposerMap): void => {
    const next = update(this.state)
    if (next === this.state) return
    this.state = next
    this.schedulePersist()
    for (const listener of this.listeners) listener()
  }

  readonly update = (scope: string, update: (state: ComposerState) => ComposerState): void =>
    this.set((all) => ({ ...all, [scope]: update(all[scope] ?? emptyComposer) }))

  /** Replace one scope's draft, advancing its revision. */
  readonly setDraft = (scope: string, draft: RichDraft): void =>
    this.update(scope, (state) => ({ ...state, draft, revision: state.revision + 1 }))

  /** Write pending drafts now (page hide), instead of after the typing pause. */
  readonly flush = (): void => {
    if (this.persistTimer === null) return
    clearTimeout(this.persistTimer)
    this.persistTimer = null
    persistDrafts(Object.fromEntries(Object.entries(this.state).map(([scope, state]) => [scope, state.draft])))
  }

  private schedulePersist(): void {
    if (this.persistTimer !== null) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(this.flush, PERSIST_DELAY_MS)
  }
}

/** One scope's slice; re-renders only when the selected value changes identity. */
export function useComposerSlice<T>(store: ComposerStore, scope: string, select: (state: ComposerState) => T): T {
  const read = (): T => select(store.get()[scope] ?? emptyComposer)
  return useSyncExternalStore(store.subscribe, read, read)
}
