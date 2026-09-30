import { useCallback, useRef, type KeyboardEvent, type PointerEvent } from 'react'

const KEY_STEP = 16
const KEY_STEP_LARGE = 64

/**
 * Pointer + keyboard resizing for a panel docked on any edge but the top. The
 * `side` decides which drag/arrow direction grows it; for `bottom` the size is
 * a height and dragging up grows it. The caller owns clamping and persistence
 * through `onChange`.
 */
export function usePanelResize({ width, min, max, defaultWidth, side = 'right', onChange }: {
  /** The current size: a width, or a height for `side: 'bottom'`. */
  readonly width: number
  readonly min: number
  readonly max: number
  readonly defaultWidth: number
  readonly side?: 'left' | 'right' | 'bottom'
  readonly onChange: (width: number) => void
}) {
  const vertical = side === 'bottom'
  const drag = useRef<{ readonly startX: number; readonly startWidth: number; readonly userSelect: string } | null>(null)
  const clamp = useCallback((value: number) => Math.min(max, Math.max(min, Math.round(value))), [min, max])

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { startX: vertical ? event.clientY : event.clientX, startWidth: width, userSelect: document.body.style.userSelect }
    document.body.style.userSelect = 'none'
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (drag.current === null) return
    const delta = vertical
      ? drag.current.startX - event.clientY
      : side === 'left' ? event.clientX - drag.current.startX : drag.current.startX - event.clientX
    onChange(clamp(drag.current.startWidth + delta))
  }
  const end = (event: PointerEvent<HTMLDivElement>): void => {
    if (drag.current === null) return
    document.body.style.userSelect = drag.current.userSelect
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP
    const next = vertical
      ? event.key === 'ArrowUp' ? width + step
        : event.key === 'ArrowDown' ? width - step
          : event.key === 'Home' ? max
            : event.key === 'End' ? min
              : null
      : event.key === 'ArrowLeft' ? width + (side === 'left' ? -step : step)
      : event.key === 'ArrowRight' ? width + (side === 'left' ? step : -step)
        : event.key === 'Home' ? (side === 'left' ? min : max)
          : event.key === 'End' ? (side === 'left' ? max : min)
            : null
    if (next === null) return
    event.preventDefault()
    onChange(clamp(next))
  }

  return {
    role: 'separator' as const,
    tabIndex: 0,
    // A separator's orientation is the line's, not the drag's.
    'aria-orientation': (vertical ? 'horizontal' : 'vertical') as 'horizontal' | 'vertical',
    'aria-valuemin': min,
    'aria-valuemax': max,
    'aria-valuenow': width,
    onPointerDown,
    onPointerMove,
    onPointerUp: end,
    onPointerCancel: end,
    onKeyDown,
    onDoubleClick: () => onChange(defaultWidth),
  }
}
