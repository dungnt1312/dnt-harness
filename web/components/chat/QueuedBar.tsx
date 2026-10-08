import { useState, type KeyboardEvent } from 'react'
import Icon from '../common/Icon.tsx'
import { attachmentUrl } from '../../lib/api.ts'
import type { AttachmentRef } from '../../lib/composer-draft.ts'
import { parseMessageText } from '../../lib/inline-chips.ts'
import { InlineChip } from '../common/InlineChip.tsx'
import type { ViewItem } from '../../lib/project.ts'

type QueuedItem = Extract<ViewItem, { kind: 'user' }>

/**
 * Queued follow-ups, pinned above the composer — the surface they were typed
 * into. While a turn runs, Enter lands here and the strip says when the
 * messages will run; "Send now" steers: stop the current turn and run the
 * queue immediately. A queue left by a stop or restart runs on nobody's
 * initiative, so the button never hides on hover.
 *
 * The transcript renders nothing for queued input: the projection keeps each
 * queued item as a twin of its future message and flips it in place when a
 * turn consumes it, so this strip is the waiting state's only face.
 *
 * Each waiting message can be edited in place (Enter saves, Esc cancels) or
 * deleted until a turn claims it; the host answers 409 after that.
 */
export function QueuedBar({ items, workspaceId, running = false, onSendNow, onEdit, onDelete }: {
  readonly items: readonly QueuedItem[]
  /** Needed to show image attachments as thumbnails; without it they show as file chips. */
  readonly workspaceId?: string | null
  /** A turn is open: the queue runs when it ends, unless it is being stopped. */
  readonly running?: boolean
  readonly onSendNow?: () => void
  /** Revise one waiting message in place; rejects when a turn already claimed it. */
  readonly onEdit?: (inputId: string, content: string) => Promise<void>
  /** Remove one waiting message from the queue. */
  readonly onDelete?: (inputId: string) => Promise<void>
}) {
  if (items.length === 0) return null
  // A steer only "steers" while a turn is open; one stranded by a restart is
  // plain queued input again and gets Send now like any other.
  const steering = running && items.some((item) => item.steer === true)
  return (
    // A tab docked onto the composer's top edge: inset from its rounded
    // corners, no bottom border, so the queue reads as part of the input it
    // was typed into rather than a separate floating card. When nothing
    // follows (no composer), `last:` closes the bottom edge.
    <section
      aria-label="Queued messages"
      className="mx-4 flex flex-col gap-1 rounded-t-2xl border border-b-0 border-line bg-composer/70 px-3.5 pb-2 pt-2 last:rounded-b-2xl last:border-b sm:mx-5"
    >
      <div role="status" className="flex min-h-7 items-center justify-between gap-2 text-xs">
        <span className="flex min-w-0 items-center gap-1.5 text-fg-faint">
          <Icon name="clock" size={12} className="shrink-0" />
          <span className="shrink-0 font-medium text-fg-muted">{items.length === 1 ? 'Queued' : `${items.length} queued`}</span>
          {steering ? <span className="truncate">· stopping the current turn</span> : null}
        </span>
        {!steering && onSendNow !== undefined ? (
          <button
            type="button"
            onClick={onSendNow}
            title={running ? 'Stop the current turn and run the queued messages now' : 'Run the queued messages now'}
            className="flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-xs font-medium text-fg-muted hover:bg-hover hover:text-fg"
          >
            <Icon name="arrowUp" size={12} />
            Send now
          </button>
        ) : null}
      </div>
      <ul className="m-0 flex max-h-40 list-none flex-col gap-0.5 overflow-y-auto p-0">
        {items.map((item, index) => (
          <QueuedRow
            key={item.inputId ?? index}
            item={item}
            workspaceId={workspaceId ?? null}
            // A steer that is stopping the turn is about to run: hands off.
            locked={steering}
            {...(onEdit !== undefined ? { onEdit } : {})}
            {...(onDelete !== undefined ? { onDelete } : {})}
          />
        ))}
      </ul>
    </section>
  )
}

/** The queued message's files: image thumbnails, other files as name chips. */
function QueuedAttachments({ refs, workspaceId }: { readonly refs: readonly AttachmentRef[]; readonly workspaceId: string | null }) {
  if (refs.length === 0) return null
  return (
    <span className="flex shrink-0 items-center gap-1">
      {refs.map((ref) => workspaceId !== null && ref.mediaType.startsWith('image/') ? (
        <img
          key={ref.id}
          src={attachmentUrl(workspaceId, ref.id)}
          alt={ref.name}
          title={ref.name}
          loading="lazy"
          className="size-8 rounded-md border border-line object-cover"
        />
      ) : (
        <span key={ref.id} title={ref.name} className="flex max-w-32 items-center gap-1 rounded-md bg-bg/60 px-1.5 py-0.5 text-xs text-fg-muted">
          <Icon name="fileText" size={12} className="shrink-0" />
          <span className="truncate">{ref.name}</span>
        </span>
      ))}
    </span>
  )
}

function QueuedRow({ item, workspaceId, locked, onEdit, onDelete }: {
  readonly item: QueuedItem
  readonly workspaceId: string | null
  readonly locked: boolean
  readonly onEdit?: (inputId: string, content: string) => Promise<void>
  readonly onDelete?: (inputId: string) => Promise<void>
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const attachments = item.attachments?.length ?? 0
  const inputId = item.inputId
  const canAct = inputId !== undefined && !locked && !busy

  const run = async (action: () => Promise<void>): Promise<boolean> => {
    setBusy(true)
    try {
      await action()
      return true
    } catch {
      // The caller reports the failure (toast); the row stays as it was.
      return false
    } finally {
      setBusy(false)
    }
  }

  const save = async (): Promise<void> => {
    if (editing === null || inputId === undefined || onEdit === undefined) return
    const next = editing.trim()
    if (next === item.content.trim()) { setEditing(null); return }
    if (next === '' && attachments === 0) return
    if (await run(() => onEdit(inputId, next))) setEditing(null)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape') { event.preventDefault(); setEditing(null) }
    else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void save() }
  }

  if (editing !== null) {
    return (
      <li className="flex flex-col gap-1.5 py-1">
        <textarea
          aria-label="Edit queued message"
          autoFocus
          rows={Math.min(6, Math.max(1, editing.split('\n').length))}
          value={editing}
          disabled={busy}
          onChange={(event) => setEditing(event.target.value)}
          onKeyDown={onKeyDown}
          onFocus={(event) => { const end = event.target.value.length; event.target.setSelectionRange(end, end) }}
          className="w-full resize-none rounded-lg border border-line-strong bg-transparent px-2.5 py-1.5 text-sm text-fg outline-none focus:border-link"
        />
        <div className="flex items-center justify-end gap-1.5 text-xs">
          <button type="button" onClick={() => setEditing(null)} disabled={busy} className="rounded-full px-2.5 py-1 text-fg-muted hover:bg-hover hover:text-fg">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || (editing.trim() === '' && attachments === 0)}
            className="rounded-full bg-primary px-2.5 py-1 font-medium text-primary-fg hover:opacity-90 disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </li>
    )
  }

  return (
    <li className="group flex min-w-0 items-center gap-2 rounded-lg text-sm text-fg">
      <QueuedAttachments refs={item.attachments ?? []} workspaceId={workspaceId} />
      <span className="min-w-0 flex-1 truncate" title={item.content}>
        {item.content !== ''
          ? parseMessageText(item.content).map((segment, part) => (segment.kind === 'text' ? segment.text : <InlineChip key={part} segment={segment} />))
          : null}
      </span>
      {canAct && (onEdit !== undefined || onDelete !== undefined) ? (
        // Always reachable by keyboard; on hover-capable pointers they fade
        // in with the row so a long queue does not read as a wall of icons.
        <span className="flex shrink-0 items-center gap-0.5 opacity-100 transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:focus-within:opacity-100">
          {onEdit !== undefined ? (
            <button
              type="button"
              aria-label="Edit queued message"
              title="Edit"
              onClick={() => setEditing(item.content)}
              className="flex size-6 items-center justify-center rounded-md text-fg-faint hover:bg-hover hover:text-fg"
            >
              <Icon name="pencil" size={13} />
            </button>
          ) : null}
          {onDelete !== undefined && inputId !== undefined ? (
            <button
              type="button"
              aria-label="Delete queued message"
              title="Delete"
              onClick={() => void run(() => onDelete(inputId))}
              className="flex size-6 items-center justify-center rounded-md text-fg-faint hover:bg-hover hover:text-bad"
            >
              <Icon name="trash" size={13} />
            </button>
          ) : null}
        </span>
      ) : busy ? <span className="shrink-0 text-xs text-fg-faint">…</span> : null}
    </li>
  )
}
