import { useEffect, useId, useRef, useState } from 'react'
import Icon from '../common/Icon.tsx'
import { useHoldScroll } from '../../hooks/useStickToBottom.ts'
import { cn } from '../../lib/cn.ts'

/** Distance from the body's bottom that still counts as following the trace. */
const FOLLOW_THRESHOLD = 24

/**
 * The model's reasoning trace: open while thinking streams, collapsed to a
 * one-line disclosure once the answer starts (a user toggle wins). While it
 * streams the body follows its own tail, so the newest reasoning is the part
 * on screen — until the reader scrolls up inside it.
 */
export function ThinkingPanel({ thinking, live }: { readonly thinking: readonly string[]; readonly live: boolean }) {
  const [userPreference, setUserPreference] = useState<boolean | null>(null)
  const body = useRef<HTMLDivElement | null>(null)
  const following = useRef(true)
  const holdScroll = useHoldScroll()
  const bodyId = useId()
  const content = thinking.join('')
  const open = userPreference ?? live

  useEffect(() => {
    const element = body.current
    if (!live || !open || element === null || !following.current) return
    element.scrollTop = element.scrollHeight
  }, [content, live, open])

  if (content === '' && !live) return null

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => { if (!open) holdScroll(); setUserPreference(!open) }}
        aria-expanded={open}
        aria-controls={bodyId}
        className="-mx-2 flex min-h-8 items-center gap-1.5 self-start rounded-lg px-2 text-sm text-fg-muted hover:text-fg"
      >
        <span className={cn(live && 'text-shimmer')}>{live ? 'Thinking…' : 'Thought process'}</span>
        <Icon name="chevronRight" size={14} className={cn('transition-transform', open && 'rotate-90')} />
      </button>
      {open ? (
        <div
          ref={body}
          onScroll={(event) => {
            const element = event.currentTarget
            following.current = element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_THRESHOLD
          }}
          id={bodyId}
          role="region"
          aria-label="Thinking"
          aria-live={live ? 'polite' : undefined}
          aria-atomic={live ? 'false' : undefined}
          className="mb-2 ml-1 max-h-72 overflow-y-auto whitespace-pre-wrap break-words border-l-2 border-line pl-4 text-[13px] leading-relaxed text-fg-muted"
        >
          {content}
        </div>
      ) : null}
    </div>
  )
}
