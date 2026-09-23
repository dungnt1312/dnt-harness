import * as Collapsible from '@radix-ui/react-collapsible'
import { useState, type DragEvent, type ReactNode } from 'react'
import Icon from '../common/Icon.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { Menu, menuItemClass } from '../ui/Menu.tsx'
import { cn } from '../../lib/cn.ts'
import { formatAge } from '../../lib/format.ts'
import type { ProjectRow, SessionListing, SessionSort } from '../../lib/types.ts'

/** Insert `dragId` before/after `overId`; input unchanged when either id is absent. */
export function moveProject(ids: readonly string[], dragId: string, overId: string, position: 'before' | 'after'): readonly string[] {
  if (dragId === overId || ids.indexOf(dragId) === -1 || ids.indexOf(overId) === -1) return ids
  const next = ids.filter((id) => id !== dragId)
  let at = next.indexOf(overId)
  if (position === 'after') at += 1
  next.splice(at, 0, dragId)
  return next
}

interface RowProps {
  readonly session: SessionListing
  readonly active: boolean
  /** The open session's live turn state (fresher than the polled listing). */
  readonly liveRunning: boolean
  readonly onSelect: () => void
  readonly onRename: (id: string, title: string) => void
  readonly onDeleteRequest: (session: SessionListing) => void
  /** Absent when pinning is unavailable; the row then offers no pin action. */
  readonly onTogglePinned?: (id: string, pinned: boolean) => void
}

function SessionRow({ session, active, liveRunning, onSelect, onRename, onDeleteRequest, onTogglePinned }: RowProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(session.title)
  const status = session.status ?? 'idle'
  const isRunning = status === 'running' || (active && liveRunning)
  const cancelling = status === 'cancelling'
  const queued = session.pendingInputs ?? 0

  if (editing) {
    return (
      <form
        className="px-1 py-0.5"
        onSubmit={(event) => { event.preventDefault(); onRename(session.id, draft); setEditing(false) }}
      >
        <input
          aria-label="Conversation title"
          value={draft}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(event) => { if (event.key === 'Escape') setEditing(false) }}
          className="h-9 w-full rounded-lg border border-line-strong bg-bg px-2.5 text-sm outline-none"
        />
      </form>
    )
  }

  return (
    <div className={cn('group relative flex items-center rounded-lg text-fg hover:bg-hover', active && 'bg-hover')}>
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? 'page' : undefined}
        className="flex min-h-9 min-w-0 flex-1 items-center gap-2 py-1.5 pl-2.5 pr-2 text-left text-sm"
      >
        {session.pinned === true ? <Icon name="pin" size={13} className="shrink-0 text-fg-faint" aria-label="Pinned" /> : null}
        <span className="min-w-0 flex-1 truncate font-medium">{session.title || 'New conversation'}</span>
        {queued > 0 ? <span className="shrink-0 text-[11px] text-fg-faint">{queued} queued</span> : null}
        {isRunning ? (
          <span className="flex shrink-0 items-center" title={`Working with ${session.activity === 'tool' ? 'tool' : 'model'}`}>
            <Spinner size={11} />
            <span className="sr-only">working with {session.activity === 'tool' ? 'tool' : 'model'}</span>
          </span>
        ) : cancelling ? <span className="shrink-0 text-[11px] text-fg-faint">stopping…</span> : null}
        {session.updatedAt !== undefined ? (
          <span
            className="shrink-0 text-[11px] tabular-nums text-fg-faint transition-opacity group-hover:opacity-0 group-focus-within:opacity-0 group-has-[[data-state=open]]:opacity-0 [@media(pointer:coarse)]:opacity-0"
            title={new Date(session.updatedAt).toLocaleString()}
          >
            {formatAge(session.updatedAt)}
          </span>
        ) : null}
      </button>
      <span className="absolute right-1 flex opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100 [@media(pointer:coarse)]:opacity-100">
        <Menu
          label={`Options for ${session.title || 'conversation'}`}
          align="start"
          triggerClassName="flex size-7 items-center justify-center rounded-md text-fg-muted hover:text-fg"
          trigger={() => <Icon name="dots" size={16} />}
        >
          {(close) => (
            <>
              {onTogglePinned !== undefined ? (
                <button type="button" role="menuitemcheckbox" aria-checked={session.pinned === true} className={menuItemClass} onClick={() => { close(); onTogglePinned(session.id, session.pinned !== true) }}>
                  <Icon name="pin" size={15} className="text-fg-muted" />
                  <span className="flex-1">{session.pinned === true ? 'Unpin' : 'Pin'}</span>
                </button>
              ) : null}
              <button type="button" role="menuitem" className={menuItemClass} onClick={() => { close(); setDraft(session.title); setEditing(true) }}>
                <Icon name="pencil" size={15} className="text-fg-muted" />Rename
              </button>
              <button type="button" role="menuitem" className={cn(menuItemClass, 'text-bad')} onClick={() => { close(); onDeleteRequest(session) }}>
                <Icon name="trash" size={15} />Delete
              </button>
            </>
          )}
        </Menu>
      </span>
    </div>
  )
}

/** Real-time buckets only — conversations without timestamps stay ungrouped. */
function dayBucket(ts: number | undefined): 'today' | 'yesterday' | 'earlier' | 'none' {
  if (ts === undefined) return 'none'
  const day = 86_400_000
  const startOfToday = new Date().setHours(0, 0, 0, 0)
  if (ts >= startOfToday) return 'today'
  if (ts >= startOfToday - day) return 'yesterday'
  return 'earlier'
}

const BUCKET_LABELS: Readonly<Record<'today' | 'yesterday' | 'earlier', string>> = { today: 'Today', yesterday: 'Yesterday', earlier: 'Earlier' }
const BUCKET_ORDER = ['today', 'yesterday', 'earlier', 'none'] as const
/** Collapse-record key for the unfiled-chats folder; session ids never look like this. */
const CHATS_KEY = 'loose-chats'

function bucketed(sessions: readonly SessionListing[]): readonly (readonly [typeof BUCKET_ORDER[number], readonly SessionListing[]])[] {
  const buckets = new Map<typeof BUCKET_ORDER[number], SessionListing[]>()
  for (const session of sessions) {
    const bucket = dayBucket(session.updatedAt)
    buckets.set(bucket, [...(buckets.get(bucket) ?? []), session])
  }
  return BUCKET_ORDER.filter((bucket) => (buckets.get(bucket)?.length ?? 0) > 0).map((bucket) => [bucket, buckets.get(bucket) ?? []] as const)
}

function GroupHead({ children }: { readonly children: ReactNode }) {
  return <div className="px-2.5 pb-1 pt-3 text-xs font-medium text-fg-faint">{children}</div>
}

export function SessionList({ sessions, projects, current, filter, liveRunning, onSelect, onRename, onDeleteRequest, onTogglePinned, onNewInProject, sort = 'recent', emptyLabel, onReorder }: {
  readonly sessions: readonly SessionListing[]
  readonly projects: readonly ProjectRow[]
  readonly current: string | null
  readonly filter: string
  readonly liveRunning: boolean
  readonly onSelect: (id: string) => void
  readonly onRename: (id: string, title: string) => void
  readonly onDeleteRequest: (session: SessionListing) => void
  readonly onTogglePinned?: (id: string, pinned: boolean) => void
  readonly onNewInProject?: (projectId: string) => void
  /** Ordering already applied upstream; non-recent orders flatten the day buckets. */
  readonly sort?: SessionSort
  /** Overrides the default empty message (e.g. filtered down to nothing). */
  readonly emptyLabel?: string
  /** Persists a dragged folder order; drag is disabled when absent. */
  readonly onReorder?: (orderedIds: readonly string[]) => void
}) {
  // UI-local collapse state, honored for every group including the open one.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  // Drag-to-reorder: the hovered target edge shows an insertion line; rows
  // never move mid-drag because relocating the dragged node cancels native
  // browser drag-and-drop.
  const [dragId, setDragId] = useState<string | null>(null)
  const [over, setOver] = useState<{ readonly id: string; readonly position: 'before' | 'after' } | null>(null)
  const query = filter.trim().toLowerCase()
  // A folder is searchable too: typing part of a project name keeps that
  // project's conversations, so "dnt" finds the dntbrowser folder and its work.
  const projectNames = new Map(projects.map((project) => [project.id, project.name.toLowerCase()]))
  const matches = (session: SessionListing): boolean => query === ''
    || session.title.toLowerCase().includes(query)
    || (session.projectId != null && (projectNames.get(session.projectId) ?? '').includes(query))
  const shown = sessions.filter(matches)

  const rows = (list: readonly SessionListing[]): ReactNode => (
    <ul className="m-0 flex list-none flex-col gap-px p-0">
      {list.map((session) => (
        <li key={session.id}>
          <SessionRow
            session={session}
            active={session.id === current}
            liveRunning={liveRunning}
            onSelect={() => onSelect(session.id)}
            onRename={onRename}
            onDeleteRequest={onDeleteRequest}
            {...(onTogglePinned !== undefined ? { onTogglePinned } : {})}
          />
        </li>
      ))}
    </ul>
  )
  const timeline = (list: readonly SessionListing[]): ReactNode => sort === 'recent' ? bucketed(list).map(([bucket, group]) => (
    <div key={bucket}>
      {bucket !== 'none' ? <GroupHead>{BUCKET_LABELS[bucket]}</GroupHead> : null}
      {rows(group)}
    </div>
  )) : rows(list)

  if (shown.length === 0) {
    return <p className="m-0 px-2.5 py-4 text-sm text-fg-faint">{emptyLabel ?? (query === '' ? 'No conversations yet' : 'No matching conversations')}</p>
  }
  // Pinned conversations lead the whole list, whatever folder or day they
  // belong to — that is what pinning them was for.
  const pinned = shown.filter((session) => session.pinned === true)
  const rest = pinned.length > 0 ? shown.filter((session) => session.pinned !== true) : shown
  const pinnedBlock = pinned.length > 0 ? <div><GroupHead>Pinned</GroupHead>{rows(pinned)}</div> : null

  if (projects.length === 0) return <div className="flex flex-col">{pinnedBlock}{timeline(rest)}</div>

  const loose = rest.filter((session) => session.projectId === undefined || session.projectId === null)
  const orderIds = projects.map((project) => project.id)
  /** Drop commits once, at the last hovered edge. */
  const commitDrag = () => {
    setDragId(null)
    setOver(null)
    if (onReorder === undefined || dragId === null || over === null) return
    const next = moveProject(orderIds, dragId, over.id, over.position)
    if (next.join('\n') !== orderIds.join('\n')) onReorder(next)
  }
  const dragHandlers = (project: ProjectRow): {
    readonly draggable: true
    readonly onDragStart: (event: DragEvent<HTMLDivElement>) => void
    readonly onDragOver: (event: DragEvent<HTMLDivElement>) => void
    readonly onDrop: (event: DragEvent<HTMLDivElement>) => void
    readonly onDragEnd: () => void
  } => ({
    draggable: true,
    onDragStart: (event) => {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', project.id)
      setDragId(project.id)
    },
    onDragOver: (event) => {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      // Pointer half within the row decides whether the line sits above or below.
      const rect = event.currentTarget.getBoundingClientRect()
      const position = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
      setOver((prev) => (prev?.id === project.id && prev.position === position ? prev : { id: project.id, position }))
    },
    onDrop: (event) => {
      event.preventDefault()
      commitDrag()
    },
    onDragEnd: () => {
      setDragId(null)
      setOver(null)
    },
  })
  return (
    <div className="flex flex-col">
      {pinnedBlock}
      {projects.map((project) => {
        const projectSessions = rest.filter((session) => session.projectId === project.id)
        if (projectSessions.length === 0) return null
        const runningCount = projectSessions.filter((session) => (session.status ?? 'idle') === 'running' || (session.id === current && liveRunning)).length
        const isCollapsed = collapsed[project.id] === true
        return (
          <Collapsible.Root key={project.id} open={!isCollapsed} onOpenChange={(open) => setCollapsed((prev) => ({ ...prev, [project.id]: !open }))} className="mt-1.5 first:mt-1">
            <div {...(onReorder !== undefined ? dragHandlers(project) : {})} className={cn('group relative flex items-center rounded-lg hover:bg-hover', dragId === project.id && 'opacity-40')}>
              {over?.id === project.id && dragId !== null && dragId !== project.id ? (
                <span
                  aria-hidden
                  className={cn('pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-primary', over.position === 'before' ? 'top-[-3px]' : 'bottom-[-3px]')}
                />
              ) : null}
              <Collapsible.Trigger className="flex min-h-9 min-w-0 flex-1 items-center gap-2 px-2.5 text-left text-sm font-medium">
                <Icon name={isCollapsed ? 'folder' : 'folderOpen'} size={15} className="shrink-0 text-fg-muted" />
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
                {runningCount > 0 ? <span className="flex items-center gap-1 text-[11px] font-normal text-fg-faint"><Spinner size={10} />{runningCount}<span className="sr-only">running</span></span> : null}
              </Collapsible.Trigger>
              {onNewInProject !== undefined ? (
                <IconButton label={`New conversation in ${project.name}`} className="mr-0.5 size-7 opacity-0 group-hover:opacity-100 focus:opacity-100 [@media(pointer:coarse)]:opacity-100" onClick={() => onNewInProject(project.id)}>
                  <Icon name="plus" size={15} />
                </IconButton>
              ) : null}
            </div>
            <Collapsible.Content className="mt-0.5 ml-3 pl-1.5">{rows(projectSessions)}</Collapsible.Content>
          </Collapsible.Root>
        )
      })}
      {loose.length > 0 ? (
        <Collapsible.Root open={!collapsed[CHATS_KEY]} onOpenChange={(open) => setCollapsed((prev) => ({ ...prev, [CHATS_KEY]: !open }))} className="mt-1.5 first:mt-1">
          <Collapsible.Trigger className="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-lg px-2.5 text-left text-sm font-medium hover:bg-hover">
            <Icon name={collapsed[CHATS_KEY] ? 'folder' : 'folderOpen'} size={15} className="shrink-0 text-fg-muted" />
            <span className="min-w-0 flex-1 truncate">Chats</span>
          </Collapsible.Trigger>
          <Collapsible.Content className="mt-0.5 ml-3 pl-1.5">{timeline(loose)}</Collapsible.Content>
        </Collapsible.Root>
      ) : null}
    </div>
  )
}
