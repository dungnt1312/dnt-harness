import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../common/Icon.tsx'
import { Modal } from '../ui/Modal.tsx'
import { cn } from '../../lib/cn.ts'
import { activityAt } from '../../lib/format.ts'
import type { ProjectRow, SessionListing, WorkspaceRow } from '../../lib/types.ts'

export type QuickSwitchItem =
  | { readonly kind: 'session'; readonly id: string; readonly label: string; readonly detail: string }
  | { readonly kind: 'project'; readonly id: string; readonly label: string; readonly detail: string }
  | { readonly kind: 'workspace'; readonly id: string; readonly label: string; readonly detail: string }

/** Conversations shown at most; the sidebar keeps the full history. */
const SESSION_LIMIT = 50

/**
 * Everything the switcher can jump to, filtered by a case-insensitive
 * substring of the name. Conversations come newest first and skip subagents;
 * the active workspace is left out since switching to it does nothing.
 */
export function quickSwitchItems(query: string, sessions: readonly SessionListing[], projects: readonly ProjectRow[], workspaces: readonly WorkspaceRow[], activeWorkspaceId: string | null): QuickSwitchItem[] {
  const needle = query.trim().toLowerCase()
  const hit = (text: string): boolean => text.toLowerCase().includes(needle)
  const projectName = new Map(projects.map((project) => [project.id, project.name]))
  const conversations = sessions
    .filter((session) => (session.parentSessionId ?? null) === null && hit(session.title || 'untitled'))
    .sort((a, b) => (activityAt(b) ?? 0) - (activityAt(a) ?? 0))
    .slice(0, SESSION_LIMIT)
    .map((session): QuickSwitchItem => ({ kind: 'session', id: session.id, label: session.title || 'untitled', detail: projectName.get(session.projectId ?? '') ?? '' }))
  return [
    ...conversations,
    ...projects.filter((project) => hit(project.name)).map((project): QuickSwitchItem => ({ kind: 'project', id: project.id, label: project.name, detail: 'New conversation' })),
    ...workspaces.filter((row) => row.id !== activeWorkspaceId && !row.archived && hit(row.name)).map((row): QuickSwitchItem => ({ kind: 'workspace', id: row.id, label: row.name, detail: 'Switch workspace' })),
  ]
}

const ICONS = { session: 'messageSquare', project: 'folder', workspace: 'layers' } as const

/** Mod+K: jump to a conversation, start one in a project, or switch workspace. */
export function QuickSwitch({ open, sessions, projects, workspaces, activeWorkspaceId, onChoose, onDismiss }: {
  readonly open: boolean
  readonly sessions: readonly SessionListing[]
  readonly projects: readonly ProjectRow[]
  readonly workspaces: readonly WorkspaceRow[]
  readonly activeWorkspaceId: string | null
  readonly onChoose: (item: QuickSwitchItem) => void
  readonly onDismiss: () => void
}) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)
  const items = useMemo(() => quickSwitchItems(query, sessions, projects, workspaces, activeWorkspaceId), [query, sessions, projects, workspaces, activeWorkspaceId])

  useEffect(() => { if (open) { setQuery(''); setIndex(0) } }, [open])
  useEffect(() => { setIndex(0) }, [query])
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index, items.length])

  const choose = (item: QuickSwitchItem): void => {
    onDismiss()
    onChoose(item)
  }

  return (
    <Modal open={open} onDismiss={onDismiss} label="Quick switch" width="md" className="top-[18%] -translate-y-0" bodyClassName="p-0">
      <div className="flex items-center gap-2 border-b border-line px-3">
        <Icon name="search" size={14} className="shrink-0 text-fg-faint" />
        <input
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls="quick-switch-results"
          aria-activedescendant={items[index] !== undefined ? `quick-switch-${index}` : undefined}
          aria-label="Search conversations, projects and workspaces"
          placeholder="Search conversations, projects and workspaces"
          spellCheck={false}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'ArrowDown') { event.preventDefault(); setIndex((current) => Math.min(current + 1, Math.max(items.length - 1, 0))) }
            else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex((current) => Math.max(current - 1, 0)) }
            else if (event.key === 'Enter') {
              const item = items[index]
              if (item !== undefined) { event.preventDefault(); choose(item) }
            }
          }}
          className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-faint"
        />
      </div>
      <div className="max-h-80 min-h-16 overflow-auto py-1">
        {items.length === 0 ? (
          <p className="m-0 px-3 py-3 text-[13px] text-fg-faint">No matches</p>
        ) : (
          <ul ref={listRef} id="quick-switch-results" role="listbox" aria-label="Matches" className="m-0 flex list-none flex-col p-0">
            {items.map((item, position) => (
              <li
                key={`${item.kind}:${item.id}`}
                id={`quick-switch-${position}`}
                role="option"
                aria-selected={position === index}
                onMouseMove={() => setIndex(position)}
                onClick={() => choose(item)}
                className={cn('flex min-h-8 cursor-pointer items-center gap-2 px-3 text-[13px]', position === index && 'bg-hover')}
              >
                <Icon name={ICONS[item.kind]} size={14} className="shrink-0 text-fg-muted" />
                <span className="min-w-0 truncate">{item.label}</span>
                {item.detail !== '' ? <span className="ml-auto shrink-0 pl-2 text-fg-faint">{item.detail}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}
