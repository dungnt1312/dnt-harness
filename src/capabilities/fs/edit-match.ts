/**
 * Locate the text an Edit replaces, inside LF document text.
 *
 * Exact matching comes first. When it finds nothing, a short ordered list of
 * conservative fallbacks handles the ways a model's copy of the file
 * predictably differs from the bytes: a pasted Read line-number gutter,
 * trailing whitespace, a different base indentation, or typographic quotes.
 * Every step must find exactly ONE location, or the edit is refused as
 * ambiguous. There is deliberately no similarity/anchor matching: a "close
 * enough" block is how an edit lands silently in the wrong place.
 *
 * `replaceAll` only uses exact matching (after the gutter strip).
 */
import { documentLines, lineOf, type Splice } from './text-document.ts'

export type MatchStrategy = 'exact' | 'line-numbers-stripped' | 'trailing-whitespace' | 'indentation' | 'quotes'

export type MatchResult =
  | { readonly kind: 'matched'; readonly strategy: MatchStrategy; readonly splices: readonly Splice[] }
  | { readonly kind: 'ambiguous'; readonly strategy: MatchStrategy; readonly lines: readonly number[] }
  | { readonly kind: 'not-found'; readonly hint?: string | undefined }

/** `old`/`new` as the model sent them, with CRLF folded like the document. */
export function foldEol(value: string): string {
  return value.replace(/\r\n/g, '\n')
}

function exactOffsets(text: string, search: string): number[] {
  const found: number[] = []
  if (search === '') return found
  for (let index = text.indexOf(search); index !== -1; index = text.indexOf(search, index + search.length)) found.push(index)
  return found
}

/** The Read gutter: `   12\t` (right-aligned number, tab). Every non-empty line must carry it. */
const GUTTER = /^ *\d+\t/

function stripGutter(value: string): string | undefined {
  const lines = value.split('\n')
  const content = lines.filter((line) => line !== '')
  if (content.length === 0 || !content.every((line) => GUTTER.test(line))) return undefined
  return lines.map((line) => line.replace(GUTTER, '')).join('\n')
}

/** Line-level view of a search block: lines, and whether it ended with a newline. */
function blockOf(search: string): { lines: string[]; trailingNewline: boolean } {
  const trailingNewline = search.endsWith('\n')
  const lines = (trailingNewline ? search.slice(0, -1) : search).split('\n')
  return { lines, trailingNewline }
}

function leadingWhitespace(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? ''
}

/** The shared leading whitespace of the non-blank lines. */
function commonIndent(lines: readonly string[]): string {
  let common: string | undefined
  for (const line of lines) {
    if (line.trim() === '') continue
    const indent = leadingWhitespace(line)
    if (common === undefined) {
      common = indent
      continue
    }
    let length = 0
    while (length < common.length && length < indent.length && common[length] === indent[length]) length++
    common = common.slice(0, length)
  }
  return common ?? ''
}

function dedent(lines: readonly string[], indent: string): string[] {
  return lines.map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line.trimStart()))
}

interface LineBlock {
  readonly startLine: number
  readonly count: number
}

/** Line-start offsets of `text`, plus a sentinel at the end. */
function lineStarts(text: string): number[] {
  const starts = [0]
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) starts.push(index + 1)
  return starts
}

/** Document span of whole lines `[startLine, startLine+count)`, optionally with the final newline. */
function spanOf(text: string, starts: readonly number[], block: LineBlock, withNewline: boolean): { start: number; end: number } {
  const start = starts[block.startLine] ?? text.length
  const nextStart = starts[block.startLine + block.count]
  const end = nextStart === undefined ? text.length : withNewline ? nextStart : nextStart - 1
  return { start, end }
}

/**
 * A whole-line splice. When the search consumed its newline but the block is
 * the file's last line (no newline there), the replacement's own trailing
 * newline is dropped so the edit never invents one.
 */
function lineSplice(text: string, starts: readonly number[], block: LineBlock, consumesNewline: boolean, replacement: string): Splice {
  const span = spanOf(text, starts, block, consumesNewline)
  const hadNewline = consumesNewline && text.charCodeAt(span.end - 1) === 0x0a
  const adjusted = consumesNewline && !hadNewline && replacement.endsWith('\n') ? replacement.slice(0, -1) : replacement
  return { ...span, text: adjusted }
}

function findBlocks(fileLines: readonly string[], search: readonly string[], same: (fileBlock: readonly string[]) => boolean): LineBlock[] {
  const found: LineBlock[] = []
  for (let index = 0; index + search.length <= fileLines.length; index++) {
    if (same(fileLines.slice(index, index + search.length))) found.push({ startLine: index, count: search.length })
  }
  return found
}

const CURLY: Readonly<Record<string, string>> = { '\u2018': "'", '\u2019': "'", '\u201c': '"', '\u201d': '"' }

function straightQuotes(value: string): string {
  return value.replace(/[\u2018\u2019\u201c\u201d]/g, (quote) => CURLY[quote] ?? quote)
}

/** Re-indent replacement lines from the model's base indent to the file's. */
function reindent(replacement: string, from: string, to: string): string {
  if (from === to) return replacement
  return replacement
    .split('\n')
    .map((line) => {
      if (line.trim() === '') return line
      if (line.startsWith(from)) return to + line.slice(from.length)
      return to + line.trimStart()
    })
    .join('\n')
}

function result(text: string, strategy: MatchStrategy, spans: readonly { start: number; end: number; text: string }[], replaceAll: boolean): MatchResult {
  if (spans.length === 0) return { kind: 'not-found' }
  if (spans.length > 1 && !replaceAll) {
    return { kind: 'ambiguous', strategy, lines: spans.map((span) => lineOf(text, span.start)) }
  }
  return { kind: 'matched', strategy, splices: spans }
}

/**
 * Find where `search` (LF) occurs in `text` and what replaces it. `search`
 * and `replacement` must already be EOL-folded with {@link foldEol}.
 */
export function findEditMatch(text: string, search: string, replacement: string, replaceAll: boolean): MatchResult {
  const exact = exactOffsets(text, search)
  if (exact.length > 0) {
    return result(text, 'exact', exact.map((start) => ({ start, end: start + search.length, text: replacement })), replaceAll)
  }

  const stripped = stripGutter(search)
  if (stripped !== undefined) {
    const offsets = exactOffsets(text, stripped)
    if (offsets.length > 0) {
      const strippedReplacement = stripGutter(replacement) ?? replacement
      return result(text, 'line-numbers-stripped', offsets.map((start) => ({ start, end: start + stripped.length, text: strippedReplacement })), replaceAll)
    }
  }
  if (replaceAll) return { kind: 'not-found', hint: closestRegion(text, search) }

  const fileLines = text.split('\n')
  const starts = lineStarts(text)
  const block = blockOf(stripped ?? search)
  const blockReplacement = stripped !== undefined ? (stripGutter(replacement) ?? replacement) : replacement
  // Line strategies match whole lines. A search that ended with a newline
  // also consumes the block's newline, so a replacement without one joins
  // the next line exactly as an exact match would.
  const consumesNewline = block.trailingNewline
  const lineReplacement = blockReplacement
  const meaningful = block.lines.some((line) => line.trim() !== '')

  if (meaningful) {
    // Trailing whitespace differs (editors, formatters, or the model).
    const wanted = block.lines.map((line) => line.trimEnd())
    const blocks = findBlocks(fileLines, wanted, (candidate) => candidate.every((line, index) => line.trimEnd() === wanted[index]))
    if (blocks.length > 0) {
      return result(text, 'trailing-whitespace', blocks.map((found) => lineSplice(text, starts, found, consumesNewline, lineReplacement)), false)
    }

    // Same relative indentation, different base indent (multi-line only).
    if (block.lines.length >= 2) {
      const searchIndent = commonIndent(block.lines)
      const normalized = dedent(block.lines, searchIndent).map((line) => line.trimEnd())
      const indentBlocks = findBlocks(fileLines, normalized, (candidate) => {
        const indent = commonIndent(candidate)
        return dedent(candidate, indent).every((line, index) => line.trimEnd() === normalized[index])
      })
      if (indentBlocks.length > 0) {
        return result(
          text,
          'indentation',
          indentBlocks.map((found) => {
            const fileIndent = commonIndent(fileLines.slice(found.startLine, found.startLine + found.count))
            return lineSplice(text, starts, found, consumesNewline, reindent(lineReplacement, searchIndent, fileIndent))
          }),
          false,
        )
      }
    }
  }

  // Typographic quotes in the file, straight quotes from the model (or vice versa).
  // The mapping is one character to one character, so offsets carry over.
  const plainSearch = straightQuotes(stripped ?? search)
  const quoteOffsets = exactOffsets(straightQuotes(text), plainSearch)
  if (quoteOffsets.length > 0) {
    return result(text, 'quotes', quoteOffsets.map((start) => ({ start, end: start + plainSearch.length, text: blockReplacement })), false)
  }

  return { kind: 'not-found', hint: closestRegion(text, stripped ?? search) }
}

const HINT_CONTEXT = 2
const HINT_MAX_LINES = 14

/**
 * The file region that best resembles `search`: the window sharing the most
 * distinctive (trimmed, non-trivial) lines. Rendered with Read's gutter so
 * the model can copy from it directly.
 */
function closestRegion(text: string, search: string): string | undefined {
  const wanted = new Set(
    search
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length >= 4),
  )
  if (wanted.size === 0) return undefined
  const lines = documentLines(text)
  const span = Math.max(1, search.split('\n').length)
  let bestStart = -1
  let bestScore = 0
  const hits = lines.map((line) => (wanted.has(line.trim()) ? 1 : 0))
  let score = 0
  for (let index = 0; index < lines.length; index++) {
    score += hits[index] ?? 0
    if (index >= span) score -= hits[index - span] ?? 0
    if (score > bestScore) {
      bestScore = score
      bestStart = Math.max(0, index - span + 1)
    }
  }
  if (bestStart < 0) return undefined
  const from = Math.max(0, bestStart - HINT_CONTEXT)
  const to = Math.min(lines.length, Math.min(bestStart + span + HINT_CONTEXT, from + HINT_MAX_LINES))
  return formatLines(lines.slice(from, to), from + 1)
}

/** Read-style gutter: right-aligned 1-based number, a tab, the line. */
export function formatLines(lines: readonly string[], firstLine: number): string {
  const width = String(firstLine + lines.length - 1).length
  return lines.map((line, index) => `${String(firstLine + index).padStart(width, ' ')}\t${line}`).join('\n')
}
