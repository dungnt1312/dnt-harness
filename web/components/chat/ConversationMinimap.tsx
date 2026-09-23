import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import type { ViewItem } from '../../lib/project.ts'

interface MinimapEntry {
  readonly index: number
  readonly title: string
  readonly detail: string
  readonly width: number
}

interface PositionedEntry extends MinimapEntry {
  readonly position: number
}

interface ViewportMetrics {
  readonly center: number
}

const EMPTY_VIEWPORT: ViewportMetrics = { center: 0 }

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
    if (item.content.trim() === '') return []
    const preview = minimapPreview(item.content)
    const width = Math.min(20, Math.max(8, 7 + Math.round(preview.title.length / 6)))
    return [{ index, ...preview, width }]
  })
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

export function ConversationMinimap({ items, scrollRef, contentRef }: {
  readonly items: readonly ViewItem[]
  readonly scrollRef: RefObject<HTMLDivElement | null>
  readonly contentRef: RefObject<HTMLDivElement | null>
}) {
  const entries = useMemo(() => minimapEntries(items), [items])
  const railRef = useRef<HTMLDivElement | null>(null)
  const [positioned, setPositioned] = useState<readonly PositionedEntry[]>([])
  const [viewport, setViewport] = useState<ViewportMetrics>(EMPTY_VIEWPORT)
  const [hovered, setHovered] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)

  const measureViewport = useCallback(() => {
    const scroll = scrollRef.current
    if (scroll === null) return
    const height = Math.max(1, scroll.scrollHeight)
    const center = clamp((scroll.scrollTop + scroll.clientHeight / 2) / height, 0, 1)
    setViewport({ center })
  }, [scrollRef])

  const measure = useCallback(() => {
    const scroll = scrollRef.current
    const content = contentRef.current
    if (scroll === null || content === null) return
    const scrollRect = scroll.getBoundingClientRect()
    const scrollHeight = Math.max(1, scroll.scrollHeight)
    const next = entries.flatMap<PositionedEntry>((entry) => {
      const row = content.querySelector<HTMLElement>(`[data-minimap-index="${entry.index}"]`)
      if (row === null) return []
      const rowRect = row.getBoundingClientRect()
      const offset = scroll.scrollTop + rowRect.top - scrollRect.top + rowRect.height / 2
      return [{ ...entry, position: clamp(offset / scrollHeight, 0, 1) }]
    })
    setPositioned(next)
    measureViewport()
  }, [contentRef, entries, measureViewport, scrollRef])

  useEffect(() => {
    const scroll = scrollRef.current
    const content = contentRef.current
    if (scroll === null || content === null) return
    let frame = 0
    const scheduleMeasure = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }
    const scheduleViewport = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measureViewport)
    }
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleMeasure)
    resize?.observe(scroll)
    resize?.observe(content)
    scroll.addEventListener('scroll', scheduleViewport, { passive: true })
    window.addEventListener('resize', scheduleMeasure)
    // Measure synchronously once: a throttled rAF (background webview) must
    // not leave the rail unrendered after the transcript is ready.
    measure()
    return () => {
      cancelAnimationFrame(frame)
      resize?.disconnect()
      scroll.removeEventListener('scroll', scheduleViewport)
      window.removeEventListener('resize', scheduleMeasure)
    }
  }, [contentRef, measure, measureViewport, scrollRef])

  const scrollToRatio = useCallback((clientY: number) => {
    const rail = railRef.current
    const scroll = scrollRef.current
    if (rail === null || scroll === null) return
    const rect = rail.getBoundingClientRect()
    const ratio = clamp((clientY - rect.top) / Math.max(1, rect.height), 0, 1)
    scroll.scrollTo({ top: ratio * Math.max(0, scroll.scrollHeight - scroll.clientHeight), behavior: 'auto' })
  }, [scrollRef])

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button') !== null) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
    scrollToRatio(event.clientY)
  }, [scrollToRatio])

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragging) scrollToRatio(event.clientY)
  }, [dragging, scrollToRatio])

  const scrollToEntry = useCallback((entry: PositionedEntry) => {
    const scroll = scrollRef.current
    const content = contentRef.current
    const row = content?.querySelector<HTMLElement>(`[data-minimap-index="${entry.index}"]`)
    if (scroll === null || row == null) return
    const scrollRect = scroll.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    const target = scroll.scrollTop + rowRect.top - scrollRect.top - Math.max(16, (scroll.clientHeight - rowRect.height) / 3)
    scroll.scrollTo({ top: clamp(target, 0, Math.max(0, scroll.scrollHeight - scroll.clientHeight)), behavior: 'smooth' })
  }, [contentRef, scrollRef])

  const positionedActive = useMemo(() => positioned.reduce<PositionedEntry | null>((nearest, entry) => nearest === null || Math.abs(entry.position - viewport.center) < Math.abs(nearest.position - viewport.center) ? entry : nearest, null), [positioned, viewport.center])
  const hoveredEntry = positioned.find((entry) => entry.index === hovered) ?? null
  if (positioned.length < 2) return null

  return (
    <div className="conversation-minimap pointer-events-none absolute inset-y-0 right-3 z-20 hidden items-center md:flex" aria-label="Conversation minimap">
      <div className="pointer-events-none absolute inset-y-6 right-3 w-px rounded-full bg-line" aria-hidden="true" />
      <div
        ref={railRef}
        role="navigation"
        aria-label="Jump through conversation"
        className="pointer-events-auto relative h-full max-h-[60vh] w-6 touch-none select-none py-6"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        onPointerLeave={() => { if (!dragging) setHovered(null) }}
      >
        {positioned.map((entry) => {
          const active = positionedActive?.index === entry.index
          return (
            <button
              key={entry.index}
              type="button"
              aria-label={`Jump to: ${entry.title}`}
              aria-current={active ? 'true' : undefined}
              className={`absolute right-0 flex h-[3px] -translate-y-1/2 items-center justify-end rounded-full outline-none focus-visible:ring-1 focus-visible:ring-link ${active ? 'bg-fg opacity-90' : 'bg-fg-faint/50 opacity-80 hover:bg-fg hover:opacity-90'}`}
              style={{ top: `${entry.position * 100}%`, width: active ? 16 : entry.width }}
              onPointerDown={(event) => event.stopPropagation()}
              onMouseEnter={() => setHovered(entry.index)}
              onFocus={() => setHovered(entry.index)}
              onMouseLeave={() => setHovered(null)}
              onBlur={() => setHovered(null)}
              onClick={() => scrollToEntry(entry)}
            />
          )
        })}
        {hoveredEntry !== null ? (
          <div
            role="tooltip"
            className="pointer-events-none absolute right-8 w-72 -translate-y-1/2 overflow-hidden rounded-xl border border-line bg-surface px-3 py-2.5 text-left shadow-pop"
            style={{ top: `${clamp(hoveredEntry.position * 100, 8, 92)}%` }}
          >
            <strong className="block truncate text-sm font-medium text-fg">{hoveredEntry.title}</strong>
            {hoveredEntry.detail !== '' ? <span className="mt-1 line-clamp-2 block text-xs leading-5 text-fg-muted">{hoveredEntry.detail}</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
