/** Small, pure facts about a text document that the editor chrome states. */

export type IndentStyle = { readonly kind: 'tab' } | { readonly kind: 'spaces'; readonly width: 2 | 4 | 8 }

/** Lines scanned for the indent style: enough to be certain, bounded for a 1 MB file. */
const INDENT_SCAN_LINES = 400

/**
 * How the document indents: a tab when any scanned line starts with one,
 * otherwise the smallest run of leading spaces (2, 4 or 8; two when nothing is
 * indented). The editor inserts this unit on Tab, and the status bar names it.
 */
export function detectIndent(text: string): IndentStyle {
  let smallest = Number.POSITIVE_INFINITY
  let scanned = 0
  let start = 0
  while (start < text.length && scanned < INDENT_SCAN_LINES) {
    const end = text.indexOf('\n', start)
    const stop = end === -1 ? text.length : end
    const first = text.charCodeAt(start)
    if (first === 9) return { kind: 'tab' }
    if (first === 32) {
      let width = 0
      while (start + width < stop && text.charCodeAt(start + width) === 32) width += 1
      // A blank line of spaces says nothing about how code is indented.
      if (start + width < stop && width < smallest) smallest = width
    }
    scanned += 1
    if (end === -1) break
    start = end + 1
  }
  if (smallest === 8) return { kind: 'spaces', width: 8 }
  if (smallest >= 4 && smallest < 8) return { kind: 'spaces', width: 4 }
  return { kind: 'spaces', width: 2 }
}

export function indentUnitOf(style: IndentStyle): string {
  return style.kind === 'tab' ? '\t' : ' '.repeat(style.width)
}

export function indentLabel(style: IndentStyle): string {
  return style.kind === 'tab' ? 'Tabs' : `Spaces: ${style.width}`
}

export type Eol = 'LF' | 'CRLF'

/** The dominant line ending of stored text; null when it has no line break at all. */
export function eolOf(text: string): Eol | null {
  let crlf = 0
  let lf = 0
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    if (index > 0 && text.charCodeAt(index - 1) === 13) crlf += 1
    else lf += 1
  }
  if (crlf === 0 && lf === 0) return null
  return crlf > lf ? 'CRLF' : 'LF'
}

const BOM = '\uFEFF'

export const hasBom = (text: string): boolean => text.startsWith(BOM)

/**
 * The text the editor holds: LF line endings and no byte-order mark. The
 * server restores the file's own ending and BOM when it saves, so neither is
 * the editor's to carry (and a BOM is never shown as a stray glyph).
 */
export function toEditorText(text: string): string {
  return (hasBom(text) ? text.slice(1) : text).replace(/\r\n?/g, '\n')
}

/** Editor text back in the shape `original` was stored in (its BOM and dominant line ending). */
export function inFormatOf(text: string, original: string): string {
  const body = eolOf(original) === 'CRLF' ? text.replace(/\n/g, '\r\n') : text
  return hasBom(original) ? `${BOM}${body}` : body
}
