/**
 * Copying chips. A chip renders as an icon and a short label, so the browser's
 * own copy drops what it names. Every chip element carries its wire text in
 * {@link CHIP_WIRE_ATTRIBUTE}. When a selection holds a chip, the clipboard
 * gets the text with each chip written as that link. The composer's paste
 * parses the links back into chips (ZCode does the same).
 */

export const CHIP_WIRE_ATTRIBUTE = 'data-chip-wire'

/** The selection as plain text with chips as their wire links; null when it holds no chip. */
export function selectionWireText(selection: Selection | null): string | null {
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null
  const fragment = selection.getRangeAt(0).cloneContents()
  const chips = fragment.querySelectorAll(`[${CHIP_WIRE_ATTRIBUTE}]`)
  if (chips.length === 0) return null
  for (const chip of Array.from(chips)) chip.replaceWith(chip.getAttribute(CHIP_WIRE_ATTRIBUTE) ?? '')
  for (const br of Array.from(fragment.querySelectorAll('br'))) br.replaceWith('\n')
  // Laid out off screen so innerText keeps the line breaks the user saw;
  // without layout (jsdom) textContent is the fallback.
  const document = selection.getRangeAt(0).startContainer.ownerDocument ?? window.document
  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;left:-9999px;top:0;white-space:pre-wrap'
  probe.append(fragment)
  document.body.append(probe)
  const text = typeof probe.innerText === 'string' ? probe.innerText : probe.textContent ?? ''
  probe.remove()
  return text
}

/**
 * Writes chip links on copy and cut anywhere in the page. A cut inside an
 * editor also deletes the selection (the default action is cancelled) and
 * fires `input`, so the editor re-reads its content.
 */
export function installChipClipboard(document: Document): () => void {
  const handle = (event: ClipboardEvent): void => {
    const selection = document.getSelection()
    const text = selectionWireText(selection)
    if (text === null || event.clipboardData === null) return
    event.clipboardData.setData('text/plain', text)
    event.preventDefault()
    if (event.type !== 'cut' || selection === null) return
    const editable = selection.anchorNode?.parentElement?.closest('[contenteditable="true"]')
    if (editable == null) return
    selection.deleteFromDocument()
    editable.dispatchEvent(new Event('input', { bubbles: true }))
  }
  document.addEventListener('copy', handle)
  document.addEventListener('cut', handle)
  return () => {
    document.removeEventListener('copy', handle)
    document.removeEventListener('cut', handle)
  }
}
