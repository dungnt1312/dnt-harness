import { useCallback, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { cn } from '../../lib/cn.ts'

/** The Git view's split: how much the list takes, and whether the diff pane is folded away. */
export interface GitSplitState {
  readonly ratio: number
  readonly collapsed: boolean
}

const DEFAULT_SPLIT: GitSplitState = { ratio: 0.4, collapsed: false }
const MIN_RATIO = 0.2
const MAX_RATIO = 0.8
const STEP = 0.05

const splitKey = (projectId: string): string => `dnt-harness.git.split.${projectId}`

/** Stored per project; anything unreadable is the default. */
export function readSplit(projectId: string): GitSplitState {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(splitKey(projectId)) ?? 'null') as { ratio?: unknown; collapsed?: unknown } | null
    if (parsed === null || typeof parsed.ratio !== 'number' || typeof parsed.collapsed !== 'boolean') return DEFAULT_SPLIT
    return { ratio: clampRatio(parsed.ratio), collapsed: parsed.collapsed }
  } catch {
    return DEFAULT_SPLIT
  }
}

export function writeSplit(projectId: string, state: GitSplitState): void {
  try { window.localStorage.setItem(splitKey(projectId), JSON.stringify(state)) } catch { /* storage may be unavailable */ }
}

/** Rounded to the 5% step so the stored value and `aria-valuenow` never drift by float noise. */
const clampRatio = (value: number): number => Math.round(Math.min(MAX_RATIO, Math.max(MIN_RATIO, value)) * 100) / 100

/**
 * List and diff, side by side from 720px of panel width (a container query,
 * not the window's), stacked below that. The handle is a keyboard-operable
 * separator; the ratio and the collapsed flag persist per project.
 */
export function GitSplit({ projectId, list, diff, state, onChange }: {
  readonly projectId: string
  readonly list: ReactNode
  /** The diff pane; null when there is nothing selected to show. */
  readonly diff: ReactNode | null
  readonly state: GitSplitState
  readonly onChange: (next: GitSplitState) => void
}) {
  const box = useRef<HTMLDivElement | null>(null)
  const [dragging, setDragging] = useState(false)
  // While a finger or mouse drags, the ratio lives here only: persisting (and
  // re-rendering the whole panel through onChange) on every pointermove would
  // write storage dozens of times a second. It is saved once, on release.
  const [live, setLive] = useState<number | null>(null)
  const liveRef = useRef<number | null>(null)
  const commit = useCallback((ratio: number): void => {
    const next = { ratio: clampRatio(ratio), collapsed: state.collapsed }
    writeSplit(projectId, next)
    onChange(next)
  }, [projectId, state.collapsed, onChange])
  /** The drag is over, however it ended: save the last ratio once and go back to the stored one. */
  const endDrag = useCallback((): void => {
    setDragging(false)
    const last = liveRef.current
    liveRef.current = null
    setLive(null)
    if (last !== null) commit(last)
  }, [commit])

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    const back = event.key === 'ArrowLeft' || event.key === 'ArrowUp'
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown'
    if (!back && !forward) return
    event.preventDefault()
    commit(state.ratio + (forward ? STEP : -STEP))
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>): void => {
    if (!dragging || box.current === null) return
    const rect = box.current.getBoundingClientRect()
    // Side by side measures across, stacked measures down; the handle's own
    // orientation tells which one applies.
    const horizontal = getComputedStyle(box.current).flexDirection === 'row'
    const size = horizontal ? rect.width : rect.height
    if (size <= 0) return
    const next = clampRatio((horizontal ? event.clientX - rect.left : event.clientY - rect.top) / size)
    liveRef.current = next
    setLive(next)
  }
  const onPointerUp = (event: ReactPointerEvent<HTMLElement>): void => {
    try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* already released */ }
    endDrag()
  }

  const percent = Math.round((live ?? state.ratio) * 100)
  if (state.collapsed || diff === null) {
    return <div className="flex min-h-0 flex-1 flex-col" data-split="collapsed">{list}</div>
  }
  // A container query answers for the container's DESCENDANTS only, so the
  // `@container` wrapper is one element and the row/column flex is its child.
  return (
    <div className="@container flex min-h-0 flex-1 flex-col" data-split="open">
      <div ref={box} className="flex min-h-0 flex-1 flex-col @[720px]:flex-row">
        <div className="flex min-h-0 min-w-0 flex-col overflow-hidden" style={{ flexBasis: `${percent}%`, flexGrow: 0, flexShrink: 0 }}>{list}</div>
        <div
          role="separator"
          aria-label="Resize the diff pane"
          aria-orientation="vertical"
          aria-valuemin={20}
          aria-valuemax={80}
          aria-valuenow={percent}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          // A browser that takes the gesture for a scroll sends pointercancel; the drag then ends, it does not hang.
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
          className={cn(
            // `touch-none`: the browser must not claim a finger on the handle for scrolling.
            'shrink-0 touch-none bg-line outline-none transition-colors hover:bg-fg-faint focus-visible:bg-fg-faint',
            'h-1.5 cursor-row-resize @[720px]:h-auto @[720px]:w-1.5 @[720px]:cursor-col-resize',
            dragging && 'bg-fg-faint',
          )}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{diff}</div>
      </div>
    </div>
  )
}
