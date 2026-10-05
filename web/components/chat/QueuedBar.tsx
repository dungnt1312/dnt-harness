import Icon from '../common/Icon.tsx'
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
 */
export function QueuedBar({ items, running = false, onSendNow }: {
  readonly items: readonly QueuedItem[]
  /** A turn is open: the queue runs when it ends, unless it is being stopped. */
  readonly running?: boolean
  readonly onSendNow?: () => void
}) {
  if (items.length === 0) return null
  // A steer only "steers" while a turn is open; one stranded by a restart is
  // plain queued input again and gets Send now like any other.
  const steering = running && items.some((item) => item.steer === true)
  return (
    <section aria-label="Queued messages" className="flex flex-col gap-1.5 rounded-2xl border border-dashed border-line-strong px-3.5 py-2.5">
      <div role="status" className="flex items-center justify-between gap-2 text-[13px]">
        <span className="flex min-w-0 items-center gap-1.5">
          <Icon name="clock" size={13} className="shrink-0 text-fg-faint" />
          <span className="shrink-0 font-medium text-fg">{items.length === 1 ? '1 message' : `${items.length} messages`}</span>
          <span className="truncate text-fg-faint">
            {steering ? '· stopping the current turn — the queue runs next' : running ? '· runs after the current turn' : '· queued'}
          </span>
        </span>
        {!steering && onSendNow !== undefined ? (
          <button
            type="button"
            onClick={onSendNow}
            title={running ? 'Stop the current turn and run the queued messages now' : 'Run the queued messages now'}
            className="shrink-0 rounded-full border border-line-strong px-2.5 py-1 text-xs font-medium text-fg hover:bg-hover"
          >
            Send now
          </button>
        ) : null}
      </div>
      <ul className="m-0 flex max-h-40 list-none flex-col gap-1 overflow-y-auto p-0">
        {items.map((item, index) => {
          const attachments = item.attachments?.length ?? 0
          return (
            <li key={item.inputId ?? index} className="flex min-w-0 items-baseline gap-1.5 text-[13px] text-fg-muted" title={item.content}>
              <span aria-hidden="true" className="shrink-0 text-fg-faint">·</span>
              <span className="min-w-0 truncate">
                {item.content !== ''
                  ? parseMessageText(item.content).map((segment, part) => (segment.kind === 'text' ? segment.text : <InlineChip key={part} segment={segment} />))
                  : null}
                {attachments > 0 ? (
                  <span className="text-fg-faint">{item.content !== '' ? ' · ' : ''}{attachments} attachment{attachments === 1 ? '' : 's'}</span>
                ) : null}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
