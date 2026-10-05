import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import { normalizeDraft, type DraftSegment, type RichDraft } from '../../lib/composer-draft.ts'
import { chipLabel, chipTitle, type ChipSegment } from '../../lib/inline-chips.ts'
import { CHIP_CLASS, CHIP_ICON_CLASS, CHIP_ICON_PATHS, CHIP_ICON_SIZE, CHIP_LABEL_CLASS, CHIP_TONE, MENTION_ICON_FALLBACK, chipAriaLabel, mentionIconSrc } from '../common/InlineChip.tsx'
import { classifyPlainTextPaste, SAFE_MODEL_VISIBLE_BYTES, utf8Bytes } from './paste-classification.ts'

/**
 * The composer's input: a contenteditable that holds chips inline, where the
 * user put them.
 *
 * It is deliberately **uncontrolled**. Rewriting the content from React state
 * on every keystroke would destroy the caret, the selection and the browser's
 * undo stack, and would fight IME composition — which for Vietnamese input is
 * not an edge case but the normal path. React owns the initial content and
 * explicit resets only; everything else flows outward through `onChange`.
 *
 * Chips are `contenteditable="false"` spans built as plain DOM and carrying
 * their own payload, so the editor's DOM is the single source of truth and
 * serialization is a plain walk. They are not React nodes: a portal into an
 * element the browser may split, merge or delete during editing would fight
 * the same battle the controlled value already lost.
 */

export interface CaretBookmark {
  /**
   * Offset in the editor's atomic stream: text consumes one unit per code unit,
   * while each chip consumes exactly one unit. This distinguishes both sides of
   * adjacent chips without ever treating their labels as editable text.
   */
  readonly offset: number
  /** Editor revision at which the offset was captured. */
  readonly revision: number
}

export interface RichInputHandle {
  focus: () => void
  /** Replace the whole content (reuse, recall, clear-after-send). */
  setDraft: (draft: RichDraft) => void
  /** The caret's text node content and offset, for completion triggers. */
  caretContext: () => { readonly text: string; readonly offset: number } | null
  /** Replace `[start, end)` of the caret's text node with one segment. */
  replaceAtCaret: (start: number, end: number, insert: DraftSegment) => void
  /** Insert a segment at the caret, keeping words from gluing together. */
  insertAtCaret: (segment: DraftSegment) => void
  /** A logical text offset and revision for exact asynchronous restoration. */
  bookmark: () => CaretBookmark | null
  /** Build resulting segments at a saved offset without emitting a parent draft. */
  segmentsWithInsertAtBookmark: (bookmark: CaretBookmark, segment: DraftSegment) => readonly DraftSegment[] | null
  /** Build resulting segments at the current caret without emitting. */
  segmentsWithInsertAtCaret: (segment: DraftSegment) => readonly DraftSegment[] | null
  /** Insert at a saved logical offset; false means the editor changed and it is unsafe. */
  insertAtBookmark: (bookmark: CaretBookmark, segment: DraftSegment) => boolean
  /** Replace exactly one saved inline string; never crosses an atomic chip. */
  replaceTextAtBookmark: (bookmark: CaretBookmark, expected: string, replacement: string) => boolean
}

export interface RichInputProps {
  readonly draft: RichDraft
  readonly onChange: (draft: RichDraft) => void
  readonly onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void
  /** Files pasted or dropped onto the editor; the parent decides what to do. */
  readonly onFiles: (files: readonly File[]) => void
  /** Handles a long plain-text paste as a text attachment at its logical caret. */
  readonly onTextAttachment: (text: string, bookmark: CaretBookmark | null) => void
  /** Exposes an explicit conversion action for middle-band pasted text. */
  readonly onConvertibleText: (text: string, bookmark: CaretBookmark | null) => void
  /** Reports an unsafe paste while preserving it inline. */
  readonly onPasteError: (text: string, bookmark: CaretBookmark | null) => void
  /** A chip was clicked (the remove button still only removes). */
  readonly onChipClick?: (segment: ChipSegment) => void
  readonly placeholder: string
  readonly disabled: boolean
  readonly ariaLabel: string
  readonly ariaDescribedBy?: string
  readonly autoFocus?: boolean
  readonly listId?: string
  readonly expanded: boolean
  readonly activeOptionId?: string
}

const CHIP_ATTRIBUTE = 'data-chip-segment'
const SVG_NS = 'http://www.w3.org/2000/svg'
/** The remove cross, as 24x24 stroke paths. */
const CROSS_PATHS = ['M6 6l12 12', 'M18 6L6 18']

/** Read the editor's DOM back into segments. */
export function serializeEditor(root: HTMLElement): RichDraft {
  const segments: DraftSegment[] = []
  const walk = (node: Node, depth: number): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        // An empty text node carries nothing (it only appears after a splice
        // that deletes a range); keeping it would be a junk draft segment.
        const text = child.textContent ?? ''
        if (text !== '') segments.push({ kind: 'text', text })
        continue
      }
      if (!(child instanceof HTMLElement)) continue
      const encoded = child.getAttribute(CHIP_ATTRIBUTE)
      if (encoded !== null) {
        try {
          segments.push(JSON.parse(encoded) as DraftSegment)
        } catch {
          // A chip whose payload cannot be read is dropped rather than sent as
          // something the user never chose.
        }
        continue
      }
      // Browsers wrap new lines in <div>/<p> and end them with <br>; both mean
      // a line break, but a block's own trailing <br> must not double it.
      if (child.tagName === 'BR') {
        segments.push({ kind: 'text', text: '\n' })
        continue
      }
      if (depth === 0 && (child.tagName === 'DIV' || child.tagName === 'P')) {
        segments.push({ kind: 'text', text: '\n' })
        const last = child.lastChild
        // Do not mutate the live editor while serializing; ignore the browser's
        // trailing block break during this read-only walk instead.
        if (last instanceof HTMLElement && last.tagName === 'BR') {
          for (const nested of Array.from(child.childNodes).slice(0, -1)) walk(nested, depth + 1)
          continue
        }
      }
      walk(child, depth + 1)
    }
  }
  walk(root, 0)
  return normalizeDraft(segments)
}

/**
 * A stroke icon built as DOM. Drawn rather than written: a glyph would be a
 * literal in the UI, and the Icon component cannot render into DOM the editor
 * builds by hand.
 */
function strokeIcon(document: Document, paths: readonly string[], className: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  for (const [name, value] of Object.entries({
    viewBox: '0 0 24 24', width: String(CHIP_ICON_SIZE), height: String(CHIP_ICON_SIZE), fill: 'none',
    stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: className,
  })) svg.setAttribute(name, value)
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}

/** Build one chip: an inert span carrying its payload and a remove button. */
function chipElement(segment: ChipSegment, document: Document): HTMLElement {
  const host = document.createElement('span')
  host.setAttribute(CHIP_ATTRIBUTE, JSON.stringify(segment))
  host.setAttribute('contenteditable', 'false')
  host.dataset['chipKind'] = segment.kind
  host.className = `${CHIP_CLASS} ${CHIP_TONE.editor} select-none`
  host.title = chipTitle(segment)
  host.setAttribute('aria-label', chipAriaLabel(segment))
  // Mentions carry the file's themed icon — the same glyph the `@` picker row
  // shows — while commands keep the stroke drawing.
  if (segment.kind === 'mention') {
    const icon = document.createElement('img')
    const src = mentionIconSrc(segment.path)
    icon.src = src
    icon.width = CHIP_ICON_SIZE
    icon.height = CHIP_ICON_SIZE
    icon.draggable = false
    icon.alt = ''
    icon.setAttribute('aria-hidden', 'true')
    icon.className = 'shrink-0'
    // Same fallback contract as FileTypeIcon: a missing themed asset degrades
    // to the plain document icon rather than a broken image.
    const fallbackHref = new URL(MENTION_ICON_FALLBACK, document.baseURI).href
    icon.addEventListener('error', () => { if (icon.src !== fallbackHref) icon.src = MENTION_ICON_FALLBACK }, { once: true })
    host.append(icon)
  } else {
    host.append(strokeIcon(document, CHIP_ICON_PATHS[segment.kind], CHIP_ICON_CLASS[segment.kind]))
  }

  const label = document.createElement('span')
  label.className = CHIP_LABEL_CLASS
  label.textContent = chipLabel(segment)
  host.append(label)

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.dataset['chipRemove'] = 'true'
  remove.className = '-mr-0.5 flex shrink-0 items-center rounded text-fg-faint hover:text-fg'
  remove.setAttribute('aria-label', `Remove ${chipLabel(segment)}`)
  remove.append(strokeIcon(document, CROSS_PATHS, ''))
  host.append(remove)
  return host
}

export const RichInput = forwardRef<RichInputHandle, RichInputProps>(function RichInput({
  draft, onChange, onKeyDown, onFiles, onTextAttachment, onConvertibleText, onPasteError, onChipClick, placeholder, disabled, ariaLabel, ariaDescribedBy,
  autoFocus = false, listId, expanded, activeOptionId,
}, ref) {
  const host = useRef<HTMLDivElement | null>(null)
  /** The draft this editor itself last emitted, so its own echo is ignored. */
  const emitted = useRef<RichDraft | null>(null)
  /** Advances whenever the live DOM content changes. */
  const revision = useRef(0)

  const emit = (): void => {
    revision.current += 1
    const element = host.current
    if (element === null) return
    // Serialization owns only editor segments. The surrounding draft's tray is
    // carried through unchanged so normal typing cannot erase attachments.
    const serialized = serializeEditor(element)
    element.dataset['editorEmpty'] = element.childNodes.length === 0 || (element.childNodes.length === 1 && element.firstChild instanceof HTMLBRElement) ? 'true' : 'false'
    const next: RichDraft = { segments: serialized.segments, attachments: draft.attachments }
    emitted.current = next
    onChange(next)
  }

  /** Write a draft into the DOM. Resets only — never during normal typing. */
  const render = (next: RichDraft): void => {
    const element = host.current
    if (element === null) return
    element.replaceChildren()
    const document = element.ownerDocument
    for (const segment of next.segments) {
      if (segment.kind === 'text') {
        for (const [index, line] of segment.text.split('\n').entries()) {
          if (index > 0) element.append(document.createElement('br'))
          if (line !== '') element.append(document.createTextNode(line))
        }
        continue
      }
      element.append(chipElement(segment, document))
    }
    element.dataset['editorEmpty'] = next.segments.length === 0 ? 'true' : 'false'
    emitted.current = next
    revision.current += 1
  }

  // Mount, then re-render only when the parent supplies a draft this editor
  // did not produce (reuse, recall, clear after send).
  useLayoutEffect(() => {
    if (emitted.current === draft) return
    // Attachment-only parent echoes must not rewrite the uncontrolled editor or
    // invalidate a recovery bookmark captured in its unchanged text.
    if (emitted.current !== null && JSON.stringify(emitted.current.segments) === JSON.stringify(draft.segments)) {
      emitted.current = draft
      return
    }
    render(draft)
  }, [draft])

  useLayoutEffect(() => {
    if (autoFocus) host.current?.focus()
  }, [autoFocus])

  const caretTextNode = (): { node: Text; offset: number } | null => {
    const element = host.current
    const selection = element?.ownerDocument.getSelection()
    if (element == null || selection == null || selection.rangeCount === 0) return null
    const { anchorNode, anchorOffset, isCollapsed } = selection
    if (!isCollapsed || anchorNode === null || !element.contains(anchorNode)) return null
    if (anchorNode.nodeType === Node.TEXT_NODE) return { node: anchorNode as Text, offset: anchorOffset }
    // A range positioned between atomic children (including adjacent chips)
    // needs a real text anchor before DOM splicing can preserve that boundary.
    if (anchorNode === element) {
      const anchor = element.ownerDocument.createTextNode('')
      element.insertBefore(anchor, element.childNodes[anchorOffset] ?? null)
      return { node: anchor, offset: 0 }
    }
    return null
  }

  /** Replace `[start, end)` of the caret's text node with the given nodes. */
  const spliceAtCaret = (start: number, end: number, nodes: readonly Node[]): void => {
    const element = host.current
    if (element === null || nodes.length === 0) return
    const document = element.ownerDocument
    const caret = caretTextNode()
    const selection = document.getSelection()

    if (caret === null) {
      // No caret inside the editor (a chip inserted from a menu, say): append.
      for (const node of nodes) element.append(node)
      const tail = document.createTextNode('')
      element.append(tail)
      const range = document.createRange()
      range.setStart(tail, 0)
      range.collapse(true)
      selection?.removeAllRanges()
      selection?.addRange(range)
      emit()
      return
    }

    const text = caret.node.textContent ?? ''
    const parent = caret.node.parentNode
    if (parent === null) return
    const tail = document.createTextNode(text.slice(end))
    caret.node.textContent = text.slice(0, start)
    const anchor = caret.node.nextSibling
    for (const node of nodes) parent.insertBefore(node, anchor)
    parent.insertBefore(tail, anchor)
    if (caret.node.textContent === '') caret.node.remove()
    const range = document.createRange()
    range.setStart(tail, 0)
    range.collapse(true)
    selection?.removeAllRanges()
    selection?.addRange(range)
    emit()
  }

  const atomicOffsetAtCaret = (): number | null => {
    const element = host.current
    const caret = caretTextNode()
    if (element === null) return null
    if (caret === null) return element.childNodes.length === 0 ? 0 : null
    if (caret.node.parentElement?.closest(`[${CHIP_ATTRIBUTE}]`) !== null) return null
    let offset = 0
    for (const child of Array.from(element.childNodes)) {
      if (child === caret.node) return offset + caret.offset
      if (child.nodeType === Node.TEXT_NODE) offset += child.textContent?.length ?? 0
      else if (child instanceof HTMLElement && child.hasAttribute(CHIP_ATTRIBUTE)) offset += 1
      else if (child instanceof HTMLElement && child.tagName === 'BR') offset += 1
    }
    return null
  }

  const segmentsWithInsertAtBookmark = (bookmark: CaretBookmark, segment: DraftSegment): readonly DraftSegment[] | null => {
    if (bookmark.revision !== revision.current || bookmark.offset < 0) return null
    const serialized = serializeEditor(host.current as HTMLElement).segments
    const next: DraftSegment[] = []
    let remaining = bookmark.offset
    for (const [index, current] of serialized.entries()) {
      const width = current.kind === 'text' ? current.text.length : 1
      if (remaining > width) { next.push(current); remaining -= width; continue }
      if (current.kind === 'text') {
        next.push({ kind: 'text', text: current.text.slice(0, remaining) }, segment, { kind: 'text', text: current.text.slice(remaining) })
      } else if (remaining === 0) next.push(segment, current)
      else next.push(current, segment)
      next.push(...serialized.slice(index + 1))
      return normalizeDraft(next).segments
    }
    return remaining === 0 ? normalizeDraft([...next, segment]).segments : null
  }

  const segmentsWithInsertAtCaret = (segment: DraftSegment): readonly DraftSegment[] | null => {
    const offset = atomicOffsetAtCaret()
    return offset === null ? null : segmentsWithInsertAtBookmark({ offset, revision: revision.current }, segment)
  }

  /**
   * The chip the delete key would reach: the one ending exactly at the caret
   * (Backspace) or starting exactly at it (Delete). A caret in the middle of
   * text, or with no chip on that side, is no chip at all.
   */
  const chipBesideCaret = (side: 'before' | 'after'): Element | null => {
    const element = host.current
    const selection = element?.ownerDocument.getSelection()
    if (element === null || selection == null || selection.rangeCount === 0 || !selection.isCollapsed) return null
    const { anchorNode, anchorOffset } = selection
    if (anchorNode === element) {
      const target = side === 'before' ? anchorOffset - 1 : anchorOffset
      const child = element.childNodes[target] ?? null
      return child instanceof Element && child.hasAttribute(CHIP_ATTRIBUTE) ? child : null
    }
    // A caret at a text boundary is also beside a chip that ends (or starts)
    // exactly there: Backspace at a node's start reaches behind it, Delete at
    // its end reaches past it.
    const text = anchorNode?.nodeType === Node.TEXT_NODE ? anchorNode.textContent ?? '' : null
    if (text === null || anchorNode === null || !element.contains(anchorNode)) return null
    if (side === 'before' ? anchorOffset !== 0 : anchorOffset !== text.length) return null
    const node = side === 'before' ? anchorNode.previousSibling : anchorNode.nextSibling
    return node instanceof Element && node.hasAttribute(CHIP_ATTRIBUTE) ? node : null
  }

  const setCaretAtBookmark = (bookmark: CaretBookmark): boolean => {
    if (bookmark.revision !== revision.current || bookmark.offset < 0) return false
    const element = host.current
    if (element === null) return false
    let remaining = bookmark.offset
    for (const child of Array.from(element.childNodes)) {
      const width = child.nodeType === Node.TEXT_NODE ? child.textContent?.length ?? 0 : child instanceof HTMLElement && (child.hasAttribute(CHIP_ATTRIBUTE) || child.tagName === 'BR') ? 1 : 0
      if (remaining > width) { remaining -= width; continue }
      const document = element.ownerDocument
      const range = document.createRange()
      if (child.nodeType === Node.TEXT_NODE) {
        // At a text-node boundary, prefer the following text node. Browser
        // splices deliberately split prefix/pasted/suffix into siblings.
        const following = child.nextSibling
        if (remaining === width && following?.nodeType === Node.TEXT_NODE) range.setStart(following, 0)
        else range.setStart(child, remaining)
      } else {
        // Atomic stream offset 0 is before a chip; an offset equal to a chip's
        // width is after it. This keeps the boundary between adjacent chips.
        const anchor = element.ownerDocument.createTextNode('')
        element.insertBefore(anchor, remaining === width ? child.nextSibling : child)
        range.setStart(anchor, 0)
      }
      range.collapse(true)
      const selection = document.getSelection()
      selection?.removeAllRanges(); selection?.addRange(range)
      return true
    }
    if (remaining !== 0) return false
    const document = element.ownerDocument
    const tail = document.createTextNode('')
    element.append(tail)
    const range = document.createRange(); range.setStart(tail, 0); range.collapse(true)
    const selection = document.getSelection(); selection?.removeAllRanges(); selection?.addRange(range)
    return true
  }

  const insertAtBookmark = (bookmark: CaretBookmark, segment: DraftSegment): boolean => {
    if (!setCaretAtBookmark(bookmark)) return false
    const caret = caretTextNode()
    if (caret === null) return false
    spliceAtCaret(caret.offset, caret.offset, nodesFor(segment))
    return true
  }

  const replaceTextAtBookmark = (bookmark: CaretBookmark, expected: string, replacement: string): boolean => {
    if (!setCaretAtBookmark(bookmark)) return false
    const caret = caretTextNode()
    if (caret === null) return false
    const text = caret.node.textContent ?? ''
    if (text.slice(caret.offset, caret.offset + expected.length) !== expected) return false
    spliceAtCaret(caret.offset, caret.offset + expected.length, [caret.node.ownerDocument.createTextNode(replacement)])
    return true
  }

  const nodesFor = (segment: DraftSegment): Node[] => {
    const document = host.current?.ownerDocument
    if (document === undefined) return []
    if (segment.kind === 'text') return [document.createTextNode(segment.text)]
    // A chip needs breathing room, or the next typed word joins it visually.
    return [chipElement(segment, document), document.createTextNode(' ')]
  }

  useImperativeHandle(ref, () => ({
    focus: () => host.current?.focus(),
    setDraft: (next) => render(next),
    caretContext: () => {
      const caret = caretTextNode()
      return caret === null ? null : { text: caret.node.textContent ?? '', offset: caret.offset }
    },
    replaceAtCaret: (start, end, insert) => spliceAtCaret(start, end, nodesFor(insert)),
    insertAtCaret: (segment) => {
      const offset = caretTextNode()?.offset ?? 0
      spliceAtCaret(offset, offset, nodesFor(segment))
    },
    bookmark: () => {
      const offset = atomicOffsetAtCaret()
      return offset === null ? null : { offset, revision: revision.current }
    },
    segmentsWithInsertAtBookmark,
    segmentsWithInsertAtCaret,
    insertAtBookmark,
    replaceTextAtBookmark,
  }))

  return (
    <div
      ref={host}
      data-composer-input
      data-editor-empty="true"
      role="combobox"
      contentEditable={!disabled}
      suppressContentEditableWarning
      tabIndex={0}
      aria-label={ariaLabel}
      aria-expanded={expanded}
      aria-autocomplete="list"
      aria-disabled={disabled || undefined}
      {...(listId !== undefined ? { 'aria-controls': listId } : {})}
      {...(activeOptionId !== undefined ? { 'aria-activedescendant': activeOptionId } : {})}
      {...(ariaDescribedBy !== undefined ? { 'aria-describedby': ariaDescribedBy } : {})}
      data-placeholder={placeholder}
      onInput={emit}
      onKeyDown={(event) => {
        // A chip remove button is an interactive descendant, not editor input.
        // Do not let its activation key bubble into the composer's send shortcut.
        if ((event.target as HTMLElement).closest('[data-chip-remove]') !== null) return
        // Backspace/Delete with the caret beside a chip removes that chip, the
        // way the picker's remove button does — typing text alone would only
        // sit next to it and the chip would survive every other delete route.
        if (event.key === 'Backspace' || event.key === 'Delete') {
          const chip = chipBesideCaret(event.key === 'Backspace' ? 'before' : 'after')
          if (chip !== null) {
            event.preventDefault()
            chip.remove()
            emit()
          }
          return
        }
        onKeyDown(event)
      }}
      onClick={(event) => {
        // Chips are inert content, so their remove button is handled here.
        const target = event.target as HTMLElement
        const button = target.closest('[data-chip-remove]')
        if (button !== null) {
          event.preventDefault()
          button.closest(`[${CHIP_ATTRIBUTE}]`)?.remove()
          emit()
          host.current?.focus()
          return
        }
        // Clicking a chip itself reports it: a file mention opens in the
        // workbench, a command chip has nothing to open.
        if (onChipClick === undefined) return
        const chip = target.closest(`[${CHIP_ATTRIBUTE}]`)
        if (chip === null) return
        const encoded = chip.getAttribute(CHIP_ATTRIBUTE)
        if (encoded === null) return
        try {
          const segment = JSON.parse(encoded) as ChipSegment
          if (segment.kind === 'mention') {
            event.preventDefault()
            onChipClick(segment)
          }
        } catch {
          // An unreadable payload has nothing to act on.
        }
      }}
      onPaste={(event) => {
        event.preventDefault()
        const files = Array.from(event.clipboardData.files)
        const text = event.clipboardData.getData('text/plain')
        if (files.length > 0) onFiles(files)
        if (text === '') return
        // Plain text only: pasted markup would smuggle elements the serializer
        // does not understand into the draft.
        const disposition = classifyPlainTextPaste(text)
        const caret = caretTextNode()
        const bookmarkOffset = atomicOffsetAtCaret()
        const bookmark = bookmarkOffset === null ? null : { offset: bookmarkOffset, revision: revision.current }
        if (utf8Bytes(text) > SAFE_MODEL_VISIBLE_BYTES) {
          spliceAtCaret(caret?.offset ?? 0, caret?.offset ?? 0, [event.currentTarget.ownerDocument.createTextNode(text)])
          onPasteError(text, bookmark)
        } else if (disposition.kind === 'attachment') {
          onTextAttachment(text, bookmark)
        } else {
          spliceAtCaret(caret?.offset ?? 0, caret?.offset ?? 0, [event.currentTarget.ownerDocument.createTextNode(text)])
          if (disposition.kind === 'convertible') onConvertibleText(text, bookmarkOffset === null ? null : { offset: bookmarkOffset, revision: revision.current })
        }
      }}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }}
      onDrop={(event) => {
        event.preventDefault()
        const files = Array.from(event.dataTransfer.files)
        if (files.length > 0) onFiles(files)
      }}
      className="composer-input max-h-[200px] min-h-[52px] w-full overflow-y-auto whitespace-pre-wrap break-words px-5 pb-1 pt-4 text-[15px] leading-6 outline-none focus-visible:outline-none"
    />
  )
})
