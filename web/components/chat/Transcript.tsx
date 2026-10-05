import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { HoldScrollProvider, useStickToBottom } from '../../hooks/useStickToBottom.ts'
import type { RetryTarget, ViewItem } from '../../lib/project.ts'
import { turnChanges, type TurnChanges } from '../../lib/turn-changes.ts'
import type { SseEvent } from '../../lib/types.ts'
import type { OpenPathResolver } from '../../lib/project-paths.ts'
import { toProjectRelative } from '../../lib/project-paths.ts'
import { processRows, type ProcessRow } from '../../lib/processes-view.ts'
import { hiddenSpawnCalls } from '../../lib/spawn-merge.ts'
import { ActivityBlock, AssistantMessage, AuditLine, CompactionMarker, ContextMarker, DelegationCard, JumpToBottom, ProcessLinkContext, StatusLine, ToolCard, UserBubble, type ProcessLink } from './MessageParts.tsx'
import { TurnChangesCard } from './TurnChangesCard.tsx'
import type { WorkbenchProject } from '../workbench/Workbench.tsx'
import { ConversationMinimap } from './ConversationMinimap.tsx'

interface Indexed { readonly item: ViewItem; readonly index: number }
type Block = { readonly kind: 'row'; readonly row: Indexed } | { readonly kind: 'activity'; readonly rows: readonly Indexed[] }

const ACTIVITY_KINDS: ReadonlySet<ViewItem['kind']> = new Set(['tool', 'delegation', 'audit'])
const TRANSCRIPT_WINDOW = 300

/** Copy payload carried by the last answer of a closed turn. */
export interface TurnFooter { readonly parts: readonly string[]; readonly text: string }

/**
 * One footer per assistant turn: the last answer of a closed turn carries the
 * copy action for every answer text that turn produced. Answers still inside
 * an open turn (streaming, tools running) show nothing yet; answers without a
 * recorded turn (legacy events) each keep their own footer.
 */
export function turnFooters(items: readonly ViewItem[]): ReadonlyMap<number, TurnFooter> {
  const groups = new Map<string, { readonly indexes: number[]; readonly parts: string[]; open: boolean }>()
  items.forEach((item, index) => {
    if (item.kind !== 'assistant' || item.discarded === true) return
    const key = item.turnId ?? `index:${index}`
    const group = groups.get(key) ?? { indexes: [], parts: [], open: false }
    // Only answers that said something can carry the footer: a trailing
    // thinking-only step is activity, and belongs nowhere near the answer's
    // action row.
    if (item.content !== '') {
      group.parts.push(item.content)
      group.indexes.push(index)
    }
    if (item.turnOpen === true) group.open = true
    groups.set(key, group)
  })
  const footers = new Map<number, TurnFooter>()
  for (const group of groups.values()) {
    if (group.open || group.parts.length === 0) continue
    const lastIndex = group.indexes.at(-1)
    if (lastIndex !== undefined) footers.set(lastIndex, { parts: group.parts, get text() { return group.parts.join('\n\n') } })
  }
  return footers
}

/**
 * Consecutive tool/delegation/audit rows render as one tight block so a busy
 * turn reads as a compact activity log between messages. Terminal markers
 * that render nothing, and a bare "failed" marker right after a detailed
 * failure card, are dropped so they cannot add empty spacing. An assistant
 * step that renders nothing either (a tool-only step: no text, no thinking,
 * not live) is transparent for grouping — without this, every step boundary
 * would split the activity block and punch a full gap between tool rows.
 */
const rendersNothing = (item: ViewItem): boolean =>
  item.kind === 'assistant' && item.content === '' && !item.live && item.thinking.length === 0 && !item.thinkingLive

/**
 * A step that shows thinking but no answer. It stays in the column, but it
 * must not split the work around it into two blocks: each block carries its
 * own top margin, so the split would open a double gap on either side of the
 * thinking while every other work row sits one gap apart.
 */
const isThinkingBeat = (item: ViewItem): boolean =>
  item.kind === 'assistant' && item.content === '' && (item.thinking.length > 0 || item.thinkingLive)

/** Rows that read as activity rather than as a message, for grouping. */
const isActivity = (item: ViewItem): boolean => ACTIVITY_KINDS.has(item.kind) || isThinkingBeat(item)

export function groupBlocks(items: readonly ViewItem[]): readonly Block[] {
  const blocks: Block[] = []
  items.forEach((item, index) => {
    if (item.kind === 'status' && item.reason === 'completed') return
    // Queued input waits on the strip above the composer (QueuedBar), not in
    // the transcript: the twin becomes a real row only when a turn consumes it.
    if (item.kind === 'user' && item.queued === true) return
    if (rendersNothing(item)) return
    const previous = items[index - 1]
    if (item.kind === 'status' && item.reason === 'failed' && previous?.kind === 'status' && previous.reason.includes(':')) return
    const last = blocks.at(-1)
    // Every consecutive work row joins the same run, edits and delegations
    // included. Splitting them out made each one its own block, and a block
    // margin on top of the run's own gap is the uneven spacing in the column.
    if (isActivity(item)) {
      if (last?.kind === 'activity') (last.rows as Indexed[]).push({ item, index })
      else blocks.push({ kind: 'activity', rows: [{ item, index }] })
      return
    }
    blocks.push({ kind: 'row', row: { item, index } })
  })
  return blocks
}

/**
 * The conversation column: projected log items in one centered reading
 * column. The scroller spans the full pane so the wheel works anywhere; it
 * follows new output only while the reader is at the bottom.
 *
 * Memoized: the app re-renders on every composer keystroke, and a long
 * transcript must not re-render with it while its own props are unchanged.
 */
export const Transcript = memo(function Transcript({ items, events, conversationId, modelLabel, workspaceId, onReuse, onOpenChild, onRetry, openPath, project, onReviewFile, onReviewChanges, onOpenProcess }: {
  readonly items: readonly ViewItem[]
  /** The raw log behind `items`; per-turn changes project from it. */
  readonly events?: readonly SseEvent[]
  readonly conversationId: string | null
  readonly modelLabel?: string
  readonly workspaceId?: string | null
  readonly onReuse?: (text: string) => void
  readonly onOpenChild?: (childSessionId: string) => void
  /** Resends one failed turn's own inputs. */
  readonly onRetry?: (target: RetryTarget) => void
  readonly openPath?: OpenPathResolver
  /** The conversation's project, for the per-turn change card's git chips. */
  readonly project?: WorkbenchProject | null
  /** Reviews one file of a turn: the Git view focused on that diff. */
  readonly onReviewFile?: (path: string) => void
  /** Reviews one turn: the Git view narrowed to the turn's recorded files. */
  readonly onReviewChanges?: (paths: readonly string[]) => void
  /** Opens a background process's live detail in the workbench. */
  readonly onOpenProcess?: (processId: string) => void
}) {
  const blocks = useMemo(() => groupBlocks(items), [items])
  // Keep browser DOM/layout memory bounded for long conversations. Older
  // blocks remain in the lightweight projection and can be mounted on demand.
  const [visibleLimit, setVisibleLimit] = useState(TRANSCRIPT_WINDOW)
  const visibleStart = Math.max(0, blocks.length - visibleLimit)
  const visibleBlocks = blocks.slice(visibleStart)
  const footers = useMemo(() => turnFooters(items), [items])
  // Files each closed turn's Write/Edit calls landed, projected once per
  // event revision from the raw log (tool traffic carries only a stepId —
  // the projection attributes positionally, like the transcript itself).
  const turnChangeMap = useMemo(() => turnChanges(events ?? []), [events])
  // Live background-process state for the tool rows, keyed off the process
  // events only so unrelated log traffic does not rebuild the map (and
  // re-render every memoized card) with it.
  const processEventCount = useMemo(
    () => (events ?? []).reduce((count, event) => count + (event.type === 'process/start' || event.type === 'process/exit' ? 1 : 0), 0),
    [events],
  )
  const processStatuses = useMemo(
    () => new Map<string, ProcessRow>(processRows(events ?? []).map((row) => [row.id, row])),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuilt only when process traffic changes
    [processEventCount],
  )
  const processLink = useMemo<ProcessLink | null>(
    () => onOpenProcess === undefined ? null : { statuses: processStatuses, open: onOpenProcess },
    [onOpenProcess, processStatuses],
  )
  // Spawn calls the delegation row absorbs: one delegation, one row.
  const hiddenSpawns = useMemo(() => hiddenSpawnCalls(events ?? []), [events])
  const turnChangeFooter = (turnId?: string): TurnChanges | undefined => {
    if (turnId === undefined) return undefined
    const changes = turnChangeMap.get(turnId)
    return changes !== undefined && (changes.files.length > 0 || changes.uncertain.length > 0) ? changes : undefined
  }
  const { scrollRef, contentRef, atBottom, onScroll, scrollToBottom, holdPosition } = useStickToBottom(conversationId)

  // Rows that arrived while the reader was away from the tail. Streaming into
  // an existing answer does not count — only rows nobody has seen yet.
  const [seen, setSeen] = useState(items.length)
  const seenRef = useRef(seen)
  seenRef.current = seen
  useEffect(() => {
    if (atBottom && seenRef.current !== items.length) setSeen(items.length)
  }, [atBottom, items.length])
  const unseen = Math.max(0, items.length - seen)

  const render = ({ item, index }: Indexed): ReactNode => {
    switch (item.kind) {
      case 'user':
        return (
          <UserBubble
            key={`user-${index}`}
            item={item}
            workspaceId={workspaceId ?? null}
            {...(onReuse !== undefined ? { onReuse } : {})}
          />
        )
      case 'assistant': {
        const turn = footers.get(index)
        // The card rides the same anchor row as the footer: the last answer
        // of a CLOSED turn. An open turn's card would render mid-work and
        // then never leave.
        const changes = turn !== undefined ? turnChangeFooter(item.turnId) : undefined
        // Review all narrows the Git view to exactly this turn's files, in
        // the project-relative form git status reports. Paths that resolve
        // outside the project are dropped: git cannot see them anyway, and
        // the card's own list still shows them.
        const review = changes !== undefined && onReviewChanges !== undefined && project != null
          ? () => {
              const root = project.path
              const paths = changes.files
                .map((file) => toProjectRelative(root, file.path))
                .filter((path): path is string => path !== null)
              onReviewChanges(paths)
            }
          : undefined
        return (
          <AssistantMessage
            key={`assistant-${index}`}
            item={item}
            {...(modelLabel !== undefined ? { modelLabel } : {})}
            {...(turn !== undefined ? { turn } : {})}
            {...(changes !== undefined ? { changes } : {})}
            {...(changes !== undefined && project !== undefined ? { changesProject: project } : {})}
            {...(changes !== undefined ? { changesWorkspaceId: workspaceId ?? null } : {})}
            {...(changes !== undefined && openPath !== undefined ? { changesOpenPath: openPath } : {})}
            {...(changes !== undefined && onReviewFile !== undefined ? { changesReviewFile: onReviewFile } : {})}
            {...(review !== undefined ? { changesReviewAll: review } : {})}
          />
        )
      }
      case 'tool':
        return <ToolCard key={item.call.id} item={item} hidden={hiddenSpawns.has(item.call.id)} {...(openPath !== undefined ? { openPath } : {})} />
      case 'delegation':
        return <DelegationCard key={item.childSessionId} item={item} {...(workspaceId !== undefined ? { workspaceId } : {})} rootSessionId={conversationId} {...(onOpenChild !== undefined ? { onOpen: onOpenChild } : {})} />
      case 'audit':
        return <AuditLine key={`audit-${index}`} item={item} />
      case 'context':
        return <ContextMarker key={`context-${index}`} item={item} workspaceId={workspaceId ?? null} sessionId={conversationId} />
      case 'compaction':
        return <CompactionMarker key={`compaction-${index}`} item={item} />
      case 'status':
        {
          // Retry exists only where the log names what to resend: the failed
          // turn's own inputs. Older lines never retry a newer message.
          const target = item.retry
          return (
            <StatusLine
              key={`status-${index}`}
              reason={item.reason}
              {...(onRetry !== undefined && target !== undefined ? { onRetry: () => onRetry(target), toolsRan: target.toolsRan } : {})}
            />
          )
        }
      default:
        return null
    }
  }

  return (
    <HoldScrollProvider value={holdPosition}>
      <ProcessLinkContext.Provider value={processLink}>
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          tabIndex={0}
          role="region"
          aria-label="Conversation transcript"
          className="chat-scroll absolute inset-0 overflow-y-auto overflow-x-hidden outline-none"
        >
          <div ref={contentRef} className="px-3 pb-8 pt-4 sm:px-6">
            {/* One beat between every block. Top margin only: an activity run
                and a standalone tool row are both work items, so they share the
                same gap instead of a run's vertical margin stacking on the
                next row's. */}
            <div className="mx-auto flex w-full max-w-3xl flex-col px-1">
              {visibleStart > 0 ? (
                <button
                  type="button"
                  className="mx-auto mb-3 rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted hover:bg-hover hover:text-fg"
                  onClick={() => { holdPosition(); setVisibleLimit((current) => current + TRANSCRIPT_WINDOW) }}
                >
                  Load {Math.min(TRANSCRIPT_WINDOW, visibleStart)} earlier items
                </button>
              ) : null}
              {visibleBlocks.map((block) => {
                // A spawn call its delegation row absorbed renders nothing —
                // not even its spacing wrapper.
                if (block.kind === 'row' && block.row.item.kind === 'tool' && hiddenSpawns.has(block.row.item.call.id)) return null
                // One beat above every block. Rows inside a run take the same beat
                // from the run, so nothing here adds a second margin.
                const spacing = 'mt-2.5 sm:mt-4'
                const row = block.kind === 'row' ? block.row : null
                const isUserRow = row?.item.kind === 'user'
                if (block.kind === 'activity') {
                  return (
                    <div key={`activity-${block.rows[0]?.index ?? 0}`} className={spacing}>
                      <ActivityBlock items={block.rows.map((row) => row.item)}>{block.rows.map(render)}</ActivityBlock>
                    </div>
                  )
                }
                return <div key={`row-${block.row.index}`} {...(isUserRow ? { 'data-minimap-index': block.row.index } : {})} className={spacing}>{render(block.row)}</div>
              })}
            </div>
          </div>
        </div>
        <ConversationMinimap items={items} scrollRef={scrollRef} contentRef={contentRef} />
        {!atBottom ? <JumpToBottom unseen={unseen} onClick={scrollToBottom} /> : null}
      </div>
      </ProcessLinkContext.Provider>
    </HoldScrollProvider>
  )
})
