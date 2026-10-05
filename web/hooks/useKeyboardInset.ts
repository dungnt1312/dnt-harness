import { useEffect } from 'react'

/**
 * Keyboard-aware layout on touch devices. iOS (Safari and the standalone PWA)
 * never resizes the layout viewport for the on-screen keyboard, so a
 * `h-dvh` shell keeps its height and the keyboard simply covers the composer.
 * While an editable element owns focus, this writes the keyboard's height to
 * the `--kb-inset` custom property on `<html>`; the app shell pads its bottom
 * with it, lifting the composer above the keys. Android resizes the viewport
 * itself (`interactive-widget=resizes-content`), so the difference is zero
 * there and the property is simply never set.
 *
 * The editable-focus guard keeps pinch-zoom (which also shrinks the visual
 * viewport) from masquerading as a keyboard, and the 60% ceiling bounds a
 * future OS quirk to something the transcript can survive.
 */
export function useKeyboardInset(): void {
  useEffect(() => {
    const viewport = window.visualViewport
    if (viewport == null) return
    const root = document.documentElement
    let editableFocused = false

    const isEditable = (element: Element | null): boolean =>
      element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || (element instanceof HTMLElement && element.isContentEditable)

    const update = (): void => {
      if (!editableFocused) { root.style.removeProperty('--kb-inset'); return }
      const inset = Math.round(Math.min(window.innerHeight - viewport.height, window.innerHeight * 0.6))
      if (inset > 0) root.style.setProperty('--kb-inset', `${inset}px`)
      else root.style.removeProperty('--kb-inset')
    }

    const onFocusIn = (event: FocusEvent): void => {
      editableFocused = isEditable(event.target instanceof Element ? event.target : null)
      update()
    }
    // Read on the next task: mid-transition, activeElement still names the
    // element being left, and a blur into the page must lift the padding.
    const onFocusOut = (): void => {
      window.setTimeout(() => {
        editableFocused = isEditable(document.activeElement)
        update()
      }, 0)
    }

    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    return () => {
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
      root.style.removeProperty('--kb-inset')
    }
  }, [])
}
