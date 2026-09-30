import { useEffect } from 'react'

/** A keydown binding: `mod` means Ctrl (or Cmd on mac). */
interface Hotkey {
  readonly key: string
  readonly mod?: boolean
  readonly shift?: boolean
  readonly alt?: boolean
  /**
   * Also match when the event target is an editor. Off by default so typing
   * shortcuts (Ctrl+K, Ctrl+N) never steal keystrokes from the composer.
   * Panel toggles such as Ctrl+` set this: the terminal should open from
   * anywhere, including while a draft is focused.
   */
  readonly allowInEditable?: boolean
  readonly onPress: () => void
}

/** A small global hotkey registry; `onPress` runs when the target is the body. */
export function useHotkeys(keys: readonly Hotkey[]): void {
  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      const target = event.target
      const editing = target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, [contenteditable="true"]') !== null)
      for (const candidate of keys) {
        if (editing && candidate.allowInEditable !== true) continue
        const modMatches = candidate.mod === true
          ? (event.ctrlKey || event.metaKey)
          : !event.ctrlKey && !event.metaKey
        const shiftMatches = candidate.shift === true ? event.shiftKey : !event.shiftKey
        const altMatches = candidate.alt === true ? event.altKey : !event.altKey
        if (modMatches && shiftMatches && altMatches && event.key === candidate.key) {
          event.preventDefault()
          candidate.onPress()
          return
        }
      }
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [keys])
}
