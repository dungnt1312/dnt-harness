import type { ReactNode } from 'react'
import Icon from '../common/Icon.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { Menu, menuItemClass } from '../ui/Menu.tsx'
import { cn } from '../../lib/cn.ts'
import type { StreamState } from '../../lib/api.ts'

const STREAM_TEXT: Readonly<Record<StreamState, string>> = {
  idle: 'No conversation selected',
  open: 'Connected',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
}

/** The chip shape the header's folder and title share. */
const chipClass = 'flex h-9 min-w-0 max-w-[16rem] items-center gap-1.5 rounded-lg px-2.5 text-sm text-fg-muted'

/**
 * Center-column header: navigation affordances when the sidebar is hidden,
 * then the conversation's own chips — folder and title — an overflow menu for
 * what can be done to the conversation itself, connection state and the
 * workbench toggle.
 */
export function ChatHeader({ sidebarVisible, stream, workbenchOpen, scopeControl, title, pinned = false, onOpenSidebar, onNew, onToggleWorkbench, onTogglePinned, onCopyId }: {
  readonly sidebarVisible: boolean
  readonly stream: StreamState
  readonly workbenchOpen: boolean
  readonly scopeControl: ReactNode
  readonly title?: string | undefined
  readonly pinned?: boolean
  readonly onOpenSidebar: () => void
  readonly onNew: () => void
  readonly onToggleWorkbench: () => void
  /** Absent with no conversation open: there is nothing to pin. */
  readonly onTogglePinned?: () => void
  readonly onCopyId?: () => void
}) {
  const connecting = stream === 'connecting' || stream === 'reconnecting'
  const actions = onTogglePinned !== undefined || onCopyId !== undefined
  return (
    <header className="flex h-14 shrink-0 items-center gap-1 px-2 sm:px-3">
      {!sidebarVisible ? (
        <>
          <IconButton label="Open sidebar" size="md" onClick={onOpenSidebar}><Icon name="panelLeft" size={18} /></IconButton>
          <IconButton label="New conversation" size="md" onClick={onNew}><Icon name="squarePen" size={18} /></IconButton>
        </>
      ) : null}
      <div className="flex min-w-0 items-center">{scopeControl}</div>
      {/* From `sm` up: below that the scope chip and the icon controls already
          fill the row, and the sidebar names the conversation. */}
      {title !== undefined && title !== '' ? (
        <span className={cn(chipClass, 'hidden sm:flex')} title={title}>
          {pinned ? <Icon name="pin" size={14} className="shrink-0 text-fg-faint" /> : null}
          <span className="truncate">{title}</span>
        </span>
      ) : null}
      {actions ? (
        <Menu
          label="Conversation actions"
          align="start"
          panelClassName="w-56"
          triggerClassName="flex size-9 shrink-0 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-hover hover:text-fg"
          trigger={() => <Icon name="dots" size={18} />}
        >
          {(close) => (
            <>
              {onTogglePinned !== undefined ? (
                <button type="button" role="menuitemcheckbox" aria-checked={pinned} className={menuItemClass} onClick={() => { close(); onTogglePinned() }}>
                  <Icon name="pin" size={15} className="text-fg-muted" />
                  <span className="flex-1">{pinned ? 'Unpin conversation' : 'Pin conversation'}</span>
                  {pinned ? <Icon name="check" size={15} /> : null}
                </button>
              ) : null}
              {onCopyId !== undefined ? (
                <button type="button" role="menuitem" className={menuItemClass} onClick={() => { close(); onCopyId() }}>
                  <Icon name="copy" size={15} className="text-fg-muted" />
                  Copy session ID
                </button>
              ) : null}
            </>
          )}
        </Menu>
      ) : null}
      <div className="flex-1" />
      <span role="status" className={connecting ? 'flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs text-fg-muted' : 'sr-only'}>
        {connecting ? <Spinner size={11} /> : null}
        {STREAM_TEXT[stream]}
      </span>
      <IconButton label={workbenchOpen ? 'Close workbench' : 'Open workbench'} size="md" aria-expanded={workbenchOpen} onClick={onToggleWorkbench}>
        <Icon name="panelRight" size={18} />
      </IconButton>
    </header>
  )
}
