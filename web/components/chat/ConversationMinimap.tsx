import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { ViewItem } from '../../lib/project.ts'

interface MinimapEntry {
  readonly index: number
  readonly title: string
  readonly detail: string
  readonly width: number
}

interface PositionedEntry extends MinimapEntry {
  readonly top: number
  readonly bottom: number
}

interface ViewportMetrics {
  readonly top: number
  readonly bottom: number
}

const EMPTY_VIEWPORT: ViewportMetrics = { top: 0, bottom: 0 }

const RAIL_MARK_PITCH = 12
const RAIL_VERTICAL_INSET = 16

const cleanPreviewText = (text: string): string => text
  .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[^\n]*\n?/g, ' '))
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/<[^>]+>/g, ' ')
  .replace(/[*_~`#>]/g, ' ')
  .replace(/(^|\s)-+(?=\s)/g, '$1')
  .replace(/\s+/g, ' ')
  .trim()

const clipped = (text: string, limit: number): string => text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`

export function minimapPreview(text: string): { readonly title: string; readonly detail: string } {
  const cleaned = cleanPreviewText(text)
  if (cleaned === '') return { title: 'Conversation activity', detail: '' }
  const titleLimit = 64
  if (cleaned.length <= titleLimit) return { title: cleaned, detail: '' }
  const preferredBreak = cleaned.slice(0, titleLimit + 1).search(/[.!?]\s/)
  const titleEnd = preferredBreak >= 24 ? preferredBreak + 1 : titleLimit
  return {
    title: clipped(cleaned.slice(0, titleEnd).trim(), titleLimit),
    detail: clipped(cleaned.slice(titleEnd).trim(), 128),
  }
}

export function minimapEntries(items: readonly ViewItem[]): readonly MinimapEntry[] {
  return items.flatMap((item, index) => {
    if (item.kind !== 'user') return []
    // Queued input renders on the composer strip, not as a transcript row.
    if (item.queued === true) return []
    if (item.content.trim() === '') return []
    const preview = minimapPreview(item.content)
    const width = Math.min(20, Math.max(8, 7 + Math.round(preview.title.length / 6)))
    return [{ index, ...preview, width }]
  })
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

// The rail must never outgrow the visible transcript: when one 12px slot per
// user message would overflow it, every slot compresses proportionally so the
// cluster stays centered and fully visible. Buttons keep tiling without gaps,
// so hover and click resolution survive the compression.
export function minimapPitch(count: number, available: number | null): number {
  if (available === null || available <= 0 || count <= 0) return RAIL_MARK_PITCH
  return count * RAIL_MARK_PITCH > available ? available / count : RAIL_MARK_PITCH
}

export function activeMinimapIndex(entries: readonly Pick<PositionedEntry, 'index' | 'top' | 'bottom'>[], viewportTop: number, viewportBottom: number): number | null {
  const visible = entries.find((entry) => entry.bottom > viewportTop && entry.top < viewportBottom)
  if (visible !== undefined) return visible.index
  return [...entries].reverse().find((entry) => entry.bottom <= viewportTop)?.index ?? entries[0]?.index ?? null
}

export function minimapScrollTarget(rowTop: number, viewportHeight: number, scrollHeight: number): number {
  return clamp(rowTop - 16, 0, Math.max(0, scrollHeight - viewportHeight))
}

export function ConversationMinimap({ items, scrollRef, contentRef }: {
  readonly items: readonly ViewItem[]
  readonly scrollRef: RefObject<HTMLDivElement | null>
  readonly contentRef: RefObject<HTMLDivElement | null>
}) {
  const lastUsers = useRef<{ users: readonly { readonly index: number; readonly item: Extract<ViewItem, { kind: 'user' }> }[]; entries: readonly MinimapEntry[] }>({ users: [], entries: [] })
  const entries = useMemo(() => {
    const users = items.flatMap((item, index) => item.kind === 'user' ? [{ index, item }] : [])
    const previous = lastUsers.current
    if (users.length === previous.users.length && users.every((user, index) => user.index === previous.users[index]?.index && user.item === previous.users[index]?.item)) return previous.entries
    const next = { users, entries: minimapEntries(items) }
    lastUsers.current = next
    return next.entries
  }, [items])
  const [positioned, setPositioned] = useState<readonly PositionedEntry[]>([])
  const [viewport, setViewport] = useState<ViewportMetrics>(EMPTY_VIEWPORT)
  const [hovered, setHovered] = useState<number | null>(null)
  const [railCapacity, setRailCapacity] = useState<number | null>(null)

  const measureViewport = useCallback(() => {
    const scroll = scrollRef.current
    if (scroll === null) return
    const top = scroll.scrollTop
    const bottom = top + scroll.clientHeight
    setViewport((previous) => previous.top === top && previous.bottom === bottom ? previous : { top, bottom })
  }, [scrollRef])

  const measure = useCallback(() => {
    const scroll = scrollRef.current
    const content = contentRef.current
    if (scroll === null || content === null) return
    const scrollRect = scroll.getBoundingClientRect()
    const next = entries.flatMap<PositionedEntry>((entry) => {
      const row = content.querySelector<HTMLElement>(`[data-minimap-index="${entry.index}"]`)
      if (row === null) return []
      const rowRect = row.getBoundingClientRect()
      const top = scroll.scrollTop + rowRect.top - scrollRect.top
      return [{ ...entry, top, bottom: top + rowRect.height }]
    })
    const available = scroll.clientHeight - RAIL_VERTICAL_INSET * 2
    const nextCapacity = available > 0 ? available : null
    setRailCapacity((previous) => previous === nextCapacity ? previous : nextCapacity)
    setPositioned((previous) => previous.length === next.length && next.every((entry, index) => {
      const old = previous[index]
      return old?.index === entry.index && old.title === entry.title && old.detail === entry.detail && old.width === entry.width && old.top === entry.top && old.bottom === entry.bottom
    }) ? previous : next)
    measureViewport()
  }, [contentRef, entries, measureViewport, scrollRef])

  useEffect(() => {
    const scroll = scrollRef.current
    const content = contentRef.current
    if (scroll === null || content === null) return
    let frame = 0
    let lastMeasurement = -Infinity
    let pending = 0
    const runMeasure = (): void => {
      frame = 0
      pending = 0
      lastMeasurement = performance.now()
      measure()
    }
    const scheduleMeasure = (): void => {
      if (frame !== 0 || pending !== 0) return
      const wait = Math.max(0, 150 - (performance.now() - lastMeasurement))
      if (wait === 0) frame = requestAnimationFrame(runMeasure)
      else pending = window.setTimeout(() => { pending = 0; frame = requestAnimationFrame(runMeasure) }, wait)
    }
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleMeasure)
    resize?.observe(scroll)
    resize?.observe(content)
    scroll.addEventListener('scroll', measureViewport, { passive: true })
    window.addEventListener('resize', scheduleMeasure)
    // Measure synchronously once: a throttled rAF (background webview) must
    // not leave the rail unrendered after the transcript is ready.
    measure()
    lastMeasurement = performance.now()
    return () => {
      window.clearTimeout(pending)
      cancelAnimationFrame(frame)
      resize?.disconnect()
      scroll.removeEventListener('scroll', measureViewport)
      window.removeEventListener('resize', scheduleMeasure)
    }
  }, [contentRef, measure, measureViewport, scrollRef])

  const scrollToEntry = useCallback((entry: PositionedEntry) => {
    const scroll = scrollRef.current
    const content = contentRef.current
    const row = content?.querySelector<HTMLElement>(`[data-minimap-index="${entry.index}"]`)
    if (scroll === null || row == null) return
    const scrollRect = scroll.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    const rowTop = scroll.scrollTop + rowRect.top - scrollRect.top
    const target = minimapScrollTarget(rowTop, scroll.clientHeight, scroll.scrollHeight)
    scroll.scrollTo({ top: target, behavior: 'auto' })
    measureViewport()
  }, [contentRef, measureViewport, scrollRef])

  const activeIndex = useMemo(() => activeMinimapIndex(positioned, viewport.top, viewport.bottom), [positioned, viewport.top, viewport.bottom])
  const hoveredEntry = positioned.find((entry) => entry.index === hovered) ?? null
  const pitch = minimapPitch(positioned.length, railCapacity)
  const compressed = pitch !== RAIL_MARK_PITCH
  if (positioned.length < 2) return null

  return (
    <div className="conversation-minimap pointer-events-none absolute right-3 top-1/2 z-20 hidden -translate-y-1/2 md:flex" aria-label="Conversation minimap">
      <div
        role="navigation"
        aria-label="Jump through conversation"
        className="pointer-events-auto relative flex w-8 flex-col"
        onPointerLeave={() => setHovered(null)}
      >
        {positioned.map((entry) => {
          const active = activeIndex === entry.index
          return (
            <button
              key={entry.index}
              type="button"
              aria-label={`Jump to: ${entry.title}`}
              aria-current={active ? 'true' : undefined}
              className="group flex h-3 w-full shrink-0 items-center justify-end outline-none focus-visible:ring-1 focus-visible:ring-link"
              {...(compressed ? { style: { height: pitch } } : {})}
              onMouseEnter={() => setHovered(entry.index)}
              onFocus={() => setHovered(entry.index)}
              onBlur={() => setHovered(null)}
              onClick={() => scrollToEntry(entry)}
            >
              <span
                aria-hidden="true"
                className={`h-[3px] rounded-full ${active ? 'bg-fg opacity-90' : 'bg-fg-faint/50 opacity-80 group-hover:bg-fg group-hover:opacity-90'}`}
                style={{ width: active ? 16 : entry.width, ...(pitch < 5 ? { height: 2 } : {}) }}
              />
            </button>
          )
        })}
        {hoveredEntry !== null ? (
          <div
            role="tooltip"
            className="pointer-events-none absolute right-8 top-1/2 w-72 -translate-y-1/2 overflow-hidden rounded-xl border border-line bg-surface px-3 py-2.5 text-left shadow-pop"
          >
            <strong className="block truncate text-sm font-medium text-fg">{hoveredEntry.title}</strong>
            {hoveredEntry.detail !== '' ? <span className="mt-1 line-clamp-2 block text-xs leading-5 text-fg-muted">{hoveredEntry.detail}</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
