import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { HoldScrollProvider, useStickToBottom } from '../../hooks/useStickToBottom.ts'
import type { RetryTarget, ViewItem } from '../../lib/project.ts'
import { turnChanges, type TurnChanges } from '../../lib/turn-changes.ts'
import type { SseEvent } from '../../lib/types.ts'
import type { OpenPathResolver } from '../../lib/project-paths.ts'
import { toProjectRelative } from '../../lib/project-paths.ts'
import { processRows, type ProcessRow } from '../../lib/processes-view.ts'
import { hiddenSpawnCalls } from '../../lib/spawn-merge.ts'
import { turnTimings, type TurnTiming } from '../../lib/turn-timing.ts'
import { useSessionDerivedGates } from '../../lib/session-derived.ts'
import { ActivityBlock, AssistantMessage, AuditLine, CompactionMarker, ContinuationMarker, ContextMarker, HookContextMarker, DelegationCard, JumpToBottom, ProcessLinkContext, StatusLine, ToolCard, UserBubble, type ProcessLink } from './MessageParts.tsx'
import { TurnChangesCard } from './TurnChangesCard.tsx'
import type { WorkbenchProject } from '../workbench/Workbench.tsx'
import { ConversationMinimap } from './ConversationMinimap.tsx'
import { MarkdownFileLinkContext } from '../../Markdown.tsx'

interface Indexed {
  readonly item: ViewItem
  readonly index: number
  /**
   * Earlier `Agent · wait` calls this row stands for: a model polling a slow
   * child waits again and again, and nine identical rows say less than one
   * row that counts them. Oldest first; the row itself is the newest wait.
   */
  readonly folded?: readonly ViewItem[]
}
type Block =
  | { readonly kind: 'row'; readonly row: Indexed }
  | {
      readonly kind: 'activity'
      readonly rows: readonly Indexed[]
      /**
       * The turn this run belongs to is still open: between two steps no
       * call is running, yet the turn is working. Read from the turn's
       * assistant steps — tool rows carry no turn of their own.
       */
      readonly turnOpen: boolean
    }

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

/**
 * A landed change (Edit/Write with a recorded result) is the work the turn was
 * for. It breaks the run: work before it closes, the change stands as a run of
 * changes, and other work after it starts fresh — so no summary line can bury
 * the turn's product among the steps around it. A change still running,
 * failed or refused never landed and breaks nothing.
 */
const isChange = (item: ViewItem): boolean => {
  if (item.kind !== 'tool' || item.result === undefined || !item.result.ok) return false
  const name = item.call.name.toLowerCase()
  return name === 'edit' || name === 'write'
}

/** An `Agent` call that only waits on children already spawned. */
const isWait = (item: ViewItem): boolean =>
  item.kind === 'tool' && item.call.name.toLowerCase() === 'agent' && item.call.args['action'] === 'wait'

/** A wait that came back cleanly: only those fold, so a failed wait keeps its own row. */
const isCleanWait = (item: ViewItem): boolean =>
  isWait(item) && item.kind === 'tool' && item.result?.ok === true && item.recovered !== true

/** Every item a row stands for, folded waits included — what a run's summary counts. */
export function rowItems(row: Indexed): readonly ViewItem[] {
  return row.folded === undefined ? [row.item] : [...row.folded, row.item]
}

/**
 * `hidden`: tool calls another row already stands for (a spawn its
 * delegation row absorbed). They take no part in grouping, so a run neither
 * counts them nor folds early because of them.
 */
export function groupBlocks(items: readonly ViewItem[], hidden?: ReadonlySet<string>): readonly Block[] {
  const blocks: Block[] = []
  const open = (item: ViewItem, index: number): void => {
    blocks.push({ kind: 'activity', rows: [{ item, index }], turnOpen: false })
  }
  /** The open run a work row joins, or a fresh one when none is open. */
  const join = (item: ViewItem, index: number): void => {
    const last = blocks.at(-1)
    if (last?.kind === 'activity') (last.rows as Indexed[]).push({ item, index })
    else open(item, index)
  }
  // A landed change closes the run before it; a batch of changes keeps one
  // run; any row that is not itself a change ends that batch state.
  let afterChange = false
  items.forEach((item, index) => {
    if (item.kind === 'status' && item.reason === 'completed') return
    // Queued input waits on the strip above the composer (QueuedBar), not in
    // the transcript: the twin becomes a real row only when a turn consumes it.
    if (item.kind === 'user' && (item.queued === true || item.withdrawn === true)) return
    if (rendersNothing(item)) return
    if (item.kind === 'tool' && hidden?.has(item.call.id) === true) return
    const previous = items[index - 1]
    if (item.kind === 'status' && item.reason === 'failed' && previous?.kind === 'status' && previous.reason.includes(':')) return
    // Every consecutive work row joins the same run, delegations included —
    // except a landed Edit or Write, which ends the run it follows: the
    // turn's product must read as its own step, not as one row among
    // twenty-two commands.
    if (isChange(item)) {
      if (afterChange) join(item, index)
      else open(item, index)
      afterChange = true
      return
    }
    const afterBreak = afterChange
    afterChange = false
    if (isActivity(item)) {
      // A wait right after a wait in the same run folds into it: the row now
      // shows the newest wait and counts the ones before.
      const last = blocks.at(-1)
      const rows = last?.kind === 'activity' ? last.rows as Indexed[] : undefined
      const previous = rows?.at(-1)
      if (!afterBreak && rows !== undefined && previous !== undefined && isWait(item) && isCleanWait(previous.item)) {
        rows[rows.length - 1] = { item, index: previous.index, folded: [...(previous.folded ?? []), previous.item] }
        return
      }
      // The change closed the run before it: this row opens the next one
      // instead of joining the change's own run or standing alone.
      if (afterBreak) open(item, index)
      else join(item, index)
      return
    }
    blocks.push({ kind: 'row', row: { item, index } })
  })
  // The tail run of a turn still open is that turn's live work, even in the
  // gap between two steps when no call is running. Every step of a turn —
  // tool-only ones included — carries `turnOpen`; the newest step decides.
  const tail = blocks.at(-1)
  if (tail?.kind === 'activity' && latestStepOpen(items)) (tail as { turnOpen: boolean }).turnOpen = true
  return blocks
}

/** The newest assistant step belongs to a turn still open, and no newer message followed it. */
function latestStepOpen(items: readonly ViewItem[]): boolean {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!
    if (item.kind === 'assistant') return item.turnOpen === true
    if (item.kind === 'user' && item.queued !== true && item.withdrawn !== true) return false
  }
  return false
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
  const footers = useMemo(() => turnFooters(items), [items])
  // Files each closed turn's Write/Edit calls landed, projected once per
  // event revision from the raw log (tool traffic carries only a stepId —
  // the projection attributes positionally, like the transcript itself).
  // Gated: these four maps re-derive from whole-log scans, so each recomputes
  // only when traffic of the event types it reads arrived. A streaming frame
  // of chunks leaves every map untouched, and the memoized cards above keep
  // their references.
  const gates = useSessionDerivedGates(events ?? [])
  const turnChangeMap = useMemo(
    () => turnChanges(events ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- gated on tool traffic, not array identity (a new array lands every streamed frame)
    [gates.taskCount, events],
  )
  // Wall-clock boundaries per turn: the user row renders the start, the turn
  // footer the end and the span. Rebuilt only when turn traffic arrived.
  const turnTimingMap = useMemo(
    () => turnTimings(events ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- gated on turn-boundary traffic
    [gates.turnCount, events],
  )
  // Live background-process state for the tool rows, keyed off the process
  // events only so unrelated log traffic does not rebuild the map (and
  // re-render every memoized card) with it.
  const processStatuses = useMemo(
    () => new Map<string, ProcessRow>(processRows(events ?? []).map((row) => [row.id, row])),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- gated on process traffic
    [gates.processCount, events],
  )
  const processLink = useMemo<ProcessLink | null>(
    () => onOpenProcess === undefined ? null : { statuses: processStatuses, open: onOpenProcess },
    [onOpenProcess, processStatuses],
  )
  // Spawn calls the delegation row absorbs: one delegation, one row.
  const hiddenSpawns = useMemo(
    () => hiddenSpawnCalls(events ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- gated on tool + agent traffic
    [gates.taskCount, gates.agentCount, events],
  )
  // Grouping skips the spawn calls their delegation rows absorbed, so a run's
  // summary counts one delegation once.
  const blocks = useMemo(() => groupBlocks(items, hiddenSpawns), [items, hiddenSpawns])
  // Keep browser DOM/layout memory bounded for long conversations. Older
  // blocks remain in the lightweight projection and can be mounted on demand.
  const [visibleLimit, setVisibleLimit] = useState(TRANSCRIPT_WINDOW)
  const visibleStart = Math.max(0, blocks.length - visibleLimit)
  const visibleBlocks = blocks.slice(visibleStart)
  // A Write/Edit row's file opens its diff the way the turn card's file row
  // does: the Git view focused on that path. Stable across renders so the
  // memoized tool cards keep their props.
  const projectRoot = project?.path
  const openDiff = useMemo<OpenPathResolver | undefined>(() => {
    if (onReviewFile === undefined || projectRoot === undefined) return undefined
    return (reference) => {
      const relative = toProjectRelative(projectRoot, reference)
      return relative === null ? null : () => onReviewFile(relative)
    }
  }, [onReviewFile, projectRoot])
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

  const render = ({ item, index, folded }: Indexed): ReactNode => {
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
        const timing: TurnTiming | undefined = item.turnId !== undefined ? turnTimingMap.get(item.turnId) : undefined
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
            {...(timing !== undefined ? { timing } : {})}
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
        // A folded run of waits keys on its first wait, so the row keeps its
        // identity (and an opened body) while newer waits replace it.
        return <ToolCard key={folded?.[0]?.kind === 'tool' ? folded[0].call.id : item.call.id} item={item} {...(folded !== undefined ? { repeats: folded.length + 1 } : {})} hidden={hiddenSpawns.has(item.call.id)} {...(openPath !== undefined ? { openPath } : {})} {...(openDiff !== undefined ? { openDiff } : {})} />
      case 'delegation':
        return <DelegationCard key={item.childSessionId} item={item} {...(workspaceId !== undefined ? { workspaceId } : {})} rootSessionId={conversationId} {...(onOpenChild !== undefined ? { onOpen: onOpenChild } : {})} />
      case 'audit':
        return <AuditLine key={`audit-${index}`} item={item} />
      case 'context':
        return <ContextMarker key={`context-${index}`} item={item} workspaceId={workspaceId ?? null} sessionId={conversationId} />
      case 'compaction':
        return <CompactionMarker key={`compaction-${index}`} item={item} />
      case 'continuation':
        return <ContinuationMarker key={`continuation-${index}`} item={item} />
      case 'hook-context':
        return <HookContextMarker key={`hook-context-${index}`} item={item} />
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
      <MarkdownFileLinkContext.Provider value={openPath ?? null}>
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
                      <ActivityBlock items={block.rows.flatMap(rowItems)} turnOpen={block.turnOpen}>{block.rows.map(render)}</ActivityBlock>
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
      </MarkdownFileLinkContext.Provider>
      </ProcessLinkContext.Provider>
    </HoldScrollProvider>
  )
})
