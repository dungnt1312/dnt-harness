import * as Popover from '@radix-ui/react-popover'
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import Icon from '../common/Icon.tsx'
import { menuItemClass } from '../ui/Menu.tsx'
import type { GitChange } from '../../lib/api.ts'
import { stageIntent } from './git-panel-model.ts'

/** What the menu's actions call back into; the panel owns the queue and the confirmations. */
export interface GitEntryActions {
  readonly onStage: (paths: readonly string[], intent: 'stage' | 'unstage') => void
  readonly onDiscard: (entries: readonly GitChange[]) => void
  readonly onTrash: (entries: readonly GitChange[]) => void
  readonly onIgnore: (paths: readonly string[]) => void
  /** Selects the entry so the pane shows its diff. */
  readonly onOpenDiff: () => void
  /** Opens the file itself in the workbench; absent without an opener. */
  readonly onViewFile?: () => void
}

const separator = <div role="separator" className="my-1 h-px bg-line" />

function Item({ children, disabled = false, onClick, icon }: {
  readonly children: string
  readonly disabled?: boolean
  readonly onClick: () => void
  readonly icon?: 'trash' | 'refresh' | 'copy' | 'fileText' | 'check'
}): ReactNode {
  return (
    <button type="button" role="menuitem" className={menuItemClass} disabled={disabled} onClick={onClick}>
      {icon !== undefined ? <Icon name={icon} size={14} className="shrink-0 text-fg-muted" /> : <span className="w-3.5 shrink-0" />}
      {children}
    </button>
  )
}

/**
 * The items of Zed's entry context menu (`build_context_menu`, git_panel.rs
 * 8342-8448), for the entries this panel supports, in Zed's order: stage,
 * restore, copy paths, ignore, open. Shared by the row's ⋯ button and the
 * right-click / long-press menu. `close` runs before the action.
 */
export function GitEntryMenuItems({ entries, projectPath, close, actions }: {
  /** The entry (one) the menu is for. A folder passes its descendants and `folder`. */
  readonly entries: readonly GitChange[]
  readonly projectPath: string
  readonly close: () => void
  readonly actions: GitEntryActions
}) {
  const entry = entries[0]
  if (entry === undefined) return null
  const staged = entry.staging === 'staged'
  const intent = stageIntent(entry.staging)
  const act = (run: () => void) => (): void => { close(); run() }
  const revert = entry.created
    ? { label: 'Trash File', icon: 'trash' as const, run: () => actions.onTrash([entry]) }
    : { label: entry.deleted ? 'Restore File' : 'Discard Changes', icon: 'refresh' as const, run: () => actions.onDiscard([entry]) }
  const copy = (text: string) => (): void => { void navigator.clipboard?.writeText(text) }
  return (
    <>
      <Item icon="check" onClick={act(() => actions.onStage([entry.path], intent))}>{staged ? 'Unstage File' : 'Stage File'}</Item>
      <Item icon={revert.icon} onClick={act(revert.run)}>{revert.label}</Item>
      {separator}
      <Item icon="copy" onClick={act(copy(`${projectPath.replace(/\/$/, '')}/${entry.path}`))}>Copy Path</Item>
      <Item icon="copy" onClick={act(copy(entry.path))}>Copy Relative Path</Item>
      {separator}
      {/* Zed: enabled only for entries that are new (untracked). */}
      <Item disabled={!(entry.created && entry.indexStatus === '?')} onClick={act(() => actions.onIgnore([entry.path]))}>Add to .gitignore</Item>
      {separator}
      <Item icon="fileText" onClick={act(actions.onOpenDiff)}>Open Diff</Item>
      {/* Always listed, like Zed; without an opener in the workbench it is disabled. */}
      <Item icon="fileText" disabled={actions.onViewFile === undefined} onClick={act(() => actions.onViewFile?.())}>View File</Item>
    </>
  )
}

/**
 * A menu opened where the pointer is: right-click, or a 500 ms long-press on
 * touch. A zero-size anchor sits at the point and Radix places the panel
 * against it, so focus, collision and dismissal behave as in every Menu.
 */
export function useContextMenu(): {
  readonly bind: { readonly onContextMenu: (event: ReactMouseEvent) => void; readonly onPointerDown: (event: ReactPointerEvent) => void; readonly onPointerUp: () => void; readonly onPointerMove: (event: ReactPointerEvent) => void; readonly onPointerCancel: () => void }
  readonly at: { readonly x: number; readonly y: number } | null
  readonly close: () => void
} {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const origin = useRef<{ x: number; y: number } | null>(null)
  const clear = (): void => {
    if (timer.current !== undefined) clearTimeout(timer.current)
    timer.current = undefined
  }
  useEffect(() => clear, [])
  return {
    at,
    close: () => setAt(null),
    bind: {
      onContextMenu: (event) => {
        event.preventDefault()
        clear()
        setAt({ x: event.clientX, y: event.clientY })
      },
      onPointerDown: (event) => {
        if (event.pointerType !== 'touch') return
        origin.current = { x: event.clientX, y: event.clientY }
        clear()
        timer.current = setTimeout(() => setAt(origin.current), 500)
      },
      onPointerMove: (event) => {
        const start = origin.current
        if (start !== null && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) clear()
      },
      onPointerUp: clear,
      onPointerCancel: clear,
    },
  }
}

export function ContextMenuPanel({ at, label, onClose, children }: {
  readonly at: { readonly x: number; readonly y: number } | null
  readonly label: string
  readonly onClose: () => void
  readonly children: ReactNode
}) {
  if (at === null) return null
  return (
    <Popover.Root open onOpenChange={(open) => { if (!open) onClose() }}>
      <Popover.Anchor asChild>
        <div aria-hidden="true" style={{ position: 'fixed', left: at.x, top: at.y, width: 0, height: 0 }} />
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          role="menu"
          aria-label={label}
          side="bottom"
          align="start"
          sideOffset={2}
          collisionPadding={12}
          className="z-50 max-h-[min(70vh,var(--radix-popover-content-available-height))] min-w-52 max-w-[calc(100vw-24px)] overflow-y-auto rounded-2xl border border-line bg-surface p-1.5 text-fg shadow-pop outline-none animate-fade-up"
        >
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
