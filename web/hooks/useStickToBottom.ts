import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'

/** Distance from the bottom (px) that still counts as "following the tail". */
const PIN_THRESHOLD = 80

/**
 * Lets a row deep inside the scroller say "I just grew on purpose — keep what
 * is on screen where it is". Without it, expanding a disclosure while the
 * reader sits at the tail scrolls the row they just opened out of view.
 */
const HoldScrollContext = createContext<() => void>(() => {})
export const HoldScrollProvider = HoldScrollContext.Provider
export const useHoldScroll = (): (() => void) => useContext(HoldScrollContext)

/**
 * Keeps a scroll container glued to its bottom while the reader is at the tail.
 * Content growth (streaming chunks, expanded rows, late markdown layout) is
 * observed with a ResizeObserver instead of per-render effects, so a freshly
 * opened long conversation lands at the latest message and scrolling up is
 * never fought. `resetKey` (the conversation id) re-pins on navigation.
 */
export function useStickToBottom(resetKey: unknown) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const pinned = useRef(true)
  const [atBottom, setAtBottom] = useState(true)

  const jump = useCallback((behavior: ScrollBehavior) => {
    const element = scrollRef.current
    if (element === null) return
    element.scrollTo({ top: element.scrollHeight, behavior })
  }, [])

  useLayoutEffect(() => {
    pinned.current = true
    setAtBottom(true)
    jump('auto')
  }, [resetKey, jump])

  const measure = useCallback(() => {
    const element = scrollRef.current
    if (element === null) return
    const near = element.scrollHeight - element.scrollTop - element.clientHeight < PIN_THRESHOLD
    pinned.current = near
    setAtBottom(near)
  }, [])

  useEffect(() => {
    const content = contentRef.current
    if (content === null || typeof ResizeObserver === 'undefined') return
    // Unpinned growth re-measures instead: content that grew without pushing
    // the tail off screen (a short transcript) must not leave a stale
    // "Jump to latest" behind.
    const observer = new ResizeObserver(() => { if (pinned.current) jump('auto'); else measure() })
    observer.observe(content)
    return () => observer.disconnect()
  }, [jump, measure])

  const onScroll = measure

  const scrollToBottom = useCallback(() => {
    pinned.current = true
    setAtBottom(true)
    jump('smooth')
  }, [jump])

  // Growth the reader asked for (an expanded row) must not move the page: it
  // unpins, and "Jump to latest" is then the way back to the tail.
  const holdPosition = useCallback(() => {
    pinned.current = false
    setAtBottom(false)
  }, [])

  return { scrollRef, contentRef, atBottom, onScroll, scrollToBottom, holdPosition }
}
