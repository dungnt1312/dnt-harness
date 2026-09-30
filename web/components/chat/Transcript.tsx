import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { HoldScrollProvider, useStickToBottom } from '../../hooks/useStickToBottom.ts'
import type { ViewItem } from '../../lib/project.ts'
import type { OpenPathResolver } from '../../lib/project-paths.ts'
import { ActivityBlock, AssistantMessage, AuditLine, CompactionMarker, ContextMarker, DelegationCard, JumpToBottom, StatusLine, ToolCard, UserBubble } from './MessageParts.tsx'
import { ConversationMinimap } from './ConversationMinimap.tsx'

interface Indexed { readonly item: ViewItem; readonly index: number }
type Block = { readonly kind: 'row'; readonly row: Indexed } | { readonly kind: 'activity'; readonly rows: readonly Indexed[] }

const ACTIVITY_KINDS: ReadonlySet<ViewItem['kind']> = new Set(['tool', 'delegation', 'audit'])

/** Copy payload carried by the last answer of a closed turn. */
export interface TurnFooter { readonly text: string }

/**
 * One footer per assistant turn: the last answer of a closed turn carries the
 * copy action for every answer text that turn produced. Answers still inside
 * an open turn (streaming, tools running) show nothing yet; answers without a
 * recorded turn (legacy events) each keep their own footer.
 */
export function turnFooters(items: readonly ViewItem[]): ReadonlyMap<number, TurnFooter> {
  const groups = new Map<string, { readonly indexes: number[]; text: string; open: boolean }>()
  items.forEach((item, index) => {
    if (item.kind !== 'assistant') return
    const key = item.turnId ?? `index:${index}`
    const group = groups.get(key) ?? { indexes: [], text: '', open: false }
    // Only answers that said something can carry the footer: a trailing
    // thinking-only step is activity, and belongs nowhere near the answer's
    // action row.
    if (item.content !== '') {
      group.text = group.text === '' ? item.content : `${group.text}\n\n${item.content}`
      group.indexes.push(index)
    }
    if (item.turnOpen === true) group.open = true
    groups.set(key, group)
  })
  const footers = new Map<number, TurnFooter>()
  for (const group of groups.values()) {
    if (group.open || group.text === '') continue
    const lastIndex = group.indexes.at(-1)
    if (lastIndex !== undefined) footers.set(lastIndex, { text: group.text })
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
 * Work that must stay legible on its own line, never folded into a run's
 * summary: anything that changed the workspace, and handing work to an agent.
 * Reading twenty files is one step; editing one file is not.
 */
const STANDALONE_TOOLS: ReadonlySet<string> = new Set(['write', 'edit', 'multiedit', 'notebookedit', 'patch', 'applypatch', 'agent'])

const standsAlone = (item: ViewItem): boolean =>
  item.kind === 'delegation' || (item.kind === 'tool' && STANDALONE_TOOLS.has(item.call.name.toLowerCase()))

/** Rows that read as activity rather than as a message, for grouping and spacing. */
const isActivity = (item: ViewItem): boolean => ACTIVITY_KINDS.has(item.kind)

/** A block the reader skims past: it sits close to its neighbour, not a message apart. */
const isQuiet = (block: Block): boolean => block.kind === 'activity'
  || isActivity(block.row.item)
  || (block.row.item.kind === 'assistant' && block.row.item.content === '')

export function groupBlocks(items: readonly ViewItem[]): readonly Block[] {
  const blocks: Block[] = []
  items.forEach((item, index) => {
    if (item.kind === 'status' && item.reason === 'completed') return
    if (rendersNothing(item)) return
    const previous = items[index - 1]
    if (item.kind === 'status' && item.reason === 'failed' && previous?.kind === 'status' && previous.reason.includes(':')) return
    const last = blocks.at(-1)
    if (isActivity(item) && !standsAlone(item)) {
      if (last?.kind === 'activity') blocks[blocks.length - 1] = { kind: 'activity', rows: [...last.rows, { item, index }] }
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
export const Transcript = memo(function Transcript({ items, conversationId, modelLabel, workspaceId, onReuse, onOpenChild, onRetry, onOpenSettings, openPath }: {
  readonly items: readonly ViewItem[]
  readonly conversationId: string | null
  readonly modelLabel?: string
  readonly workspaceId?: string | null
  readonly onReuse?: (text: string) => void
  readonly onOpenChild?: (childSessionId: string) => void
  readonly onRetry?: () => void
  readonly onOpenSettings?: () => void
  readonly openPath?: OpenPathResolver
}) {
  const blocks = useMemo(() => groupBlocks(items), [items])
  const footers = useMemo(() => turnFooters(items), [items])
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

  /**
   * An answer already reserves a (hover-revealed) action row underneath, so it
   * does not also need a full message gap: the reserved row is the gap. A user
   * bubble keeps its actions beside it and reserves nothing.
   */
  const carriesActions = (block: Block): boolean => block.kind === 'row' && footers.has(block.row.index)

  const render = ({ item, index }: Indexed): ReactNode => {
    switch (item.kind) {
      case 'user':
        return <UserBubble key={`user-${index}`} item={item} workspaceId={workspaceId ?? null} {...(onReuse !== undefined ? { onReuse } : {})} />
      case 'assistant': {
        const turn = footers.get(index)
        return <AssistantMessage key={`assistant-${index}`} item={item} {...(modelLabel !== undefined ? { modelLabel } : {})} {...(turn !== undefined ? { turn } : {})} />
      }
      case 'tool':
        return <ToolCard key={item.call.id} item={item} {...(openPath !== undefined ? { openPath } : {})} />
      case 'delegation':
        return <DelegationCard key={item.childSessionId} item={item} {...(workspaceId !== undefined ? { workspaceId } : {})} rootSessionId={conversationId} {...(onOpenChild !== undefined ? { onOpen: onOpenChild } : {})} />
      case 'audit':
        return <AuditLine key={`audit-${index}`} item={item} />
      case 'context':
        return <ContextMarker key={`context-${index}`} item={item} workspaceId={workspaceId ?? null} sessionId={conversationId} />
      case 'compaction':
        return <CompactionMarker key={`compaction-${index}`} item={item} />
      case 'status':
        return <StatusLine key={`status-${index}`} reason={item.reason} {...(onRetry !== undefined ? { onRetry } : {})} {...(onOpenSettings !== undefined ? { onOpenSettings } : {})} />
      default:
        return null
    }
  }

  return (
    <HoldScrollProvider value={holdPosition}>
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
            {/* Spacing is per neighbour, not one flat gap: activity sits close
                to what it belongs to, and a message whose reserved action row
                already adds height does not add a full gap on top of it. */}
            <div className="mx-auto flex w-full max-w-3xl flex-col px-1">
              {blocks.map((block, position) => {
                const spacing = 'mt-1.5'
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
    </HoldScrollProvider>
  )
})
