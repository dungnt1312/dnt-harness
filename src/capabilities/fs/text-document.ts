/**
 * The single byte boundary of the file tools. Everything the model sees and
 * everything it asks to change is "document text": decoded, BOM-free, with
 * every CRLF folded to LF. Writing goes back through this module, which
 * restores the file's own encoding, BOM, and line endings:
 *
 * - `spliceDocument` replaces LF-text spans inside the ORIGINAL decoded text,
 *   so every byte outside the edited spans is untouched (a mixed-EOL file
 *   stays exactly as mixed as it was); inserted newlines take the file's
 *   dominant line ending.
 * - `encodeForWrite` turns a whole replacement text into bytes using the
 *   existing file's encoding/BOM/EOL (or the text verbatim for a new file).
 *
 * Binary content is refused, never "decoded" into replacement characters
 * that a later write would bake in. Text that is not valid UTF-8 (and has no
 * UTF-16 BOM) is readable lossily but never writable.
 */
import { createHash } from 'node:crypto'

export type Encoding = 'utf8' | 'utf16le'
export type LineEnding = 'lf' | 'crlf'

export interface TextDocument {
  /** What the model sees: decoded, no BOM, CRLF folded to LF. */
  readonly text: string
  /** The decoded file content exactly as stored (no BOM, original EOLs). */
  readonly raw: string
  readonly encoding: Encoding
  readonly bom: boolean
  /** The ending used for newly inserted lines. */
  readonly eol: LineEnding
  /** True when the file mixes CRLF and bare LF lines. */
  readonly mixedEol: boolean
  /** False when the bytes are not valid in `encoding` (decoded lossily). */
  readonly writable: boolean
  /** sha256 of the stored bytes. */
  readonly hash: string
  /** Positions in `text` of every `\n` whose stored form is `\r\n`, ascending. */
  readonly crlfAt: readonly number[]
}

export class BinaryFileError extends Error {
  constructor(readonly file: string) {
    super(`${file} looks like a binary file; the text tools cannot read or edit it`)
    this.name = 'BinaryFileError'
  }
}

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const
const BINARY_SNIFF = 8_192

export function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value)
}

/** NUL bytes, or a high share of control bytes, in the head of the file mean binary. */
function looksBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, BINARY_SNIFF)
  if (end === 0) return false
  let control = 0
  for (let index = 0; index < end; index++) {
    const byte = bytes[index] ?? 0
    if (byte === 0) return true
    // Tab, LF, FF, CR and ESC are ordinary in text files.
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d && byte !== 0x1b) control++
  }
  return control / end > 0.3
}

/** Decode stored bytes into a document. Throws {@link BinaryFileError} for binary content. */
export function decodeDocument(bytes: Uint8Array, file: string): TextDocument {
  const hash = hashBytes(bytes)
  let encoding: Encoding = 'utf8'
  let bom = false
  let raw: string
  let writable = true
  if (startsWith(bytes, [0xff, 0xfe])) {
    encoding = 'utf16le'
    bom = true
    raw = new TextDecoder('utf-16le').decode(bytes.subarray(2))
  } else if (startsWith(bytes, [0xfe, 0xff])) {
    throw new BinaryFileError(file)
  } else {
    if (startsWith(bytes, UTF8_BOM)) bom = true
    const body = bom ? bytes.subarray(3) : bytes
    if (looksBinary(body)) throw new BinaryFileError(file)
    try {
      raw = new TextDecoder('utf-8', { fatal: true }).decode(body)
    } catch {
      raw = new TextDecoder('utf-8').decode(body)
      writable = false
    }
  }

  const crlfAt: number[] = []
  let text = ''
  let lf = 0
  let segmentStart = 0
  for (let index = 0; index < raw.length; index++) {
    if (raw.charCodeAt(index) !== 0x0a) continue
    if (index > 0 && raw.charCodeAt(index - 1) === 0x0d) {
      text += raw.slice(segmentStart, index - 1)
      crlfAt.push(text.length)
      text += '\n'
    } else {
      text += raw.slice(segmentStart, index + 1)
      lf++
    }
    segmentStart = index + 1
  }
  text += raw.slice(segmentStart)
  return {
    text,
    raw,
    encoding,
    bom,
    eol: crlfAt.length > lf ? 'crlf' : 'lf',
    mixedEol: crlfAt.length > 0 && lf > 0,
    writable,
    hash,
    crlfAt,
  }
}

/** Map an offset in `doc.text` to the offset in `doc.raw`; a CRLF's `\n` maps onto its `\r`. */
function rawOffset(doc: TextDocument, offset: number): number {
  // Number of folded CRs strictly before `offset`.
  let low = 0
  let high = doc.crlfAt.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if ((doc.crlfAt[mid] ?? 0) < offset) low = mid + 1
    else high = mid
  }
  return offset + low
}

function withEol(text: string, eol: LineEnding): string {
  return eol === 'crlf' ? text.replace(/\r?\n/g, '\r\n') : text.replace(/\r\n/g, '\n')
}

/** One replacement of `doc.text.slice(start, end)` by LF text. */
export interface Splice {
  readonly start: number
  readonly end: number
  readonly text: string
}

/**
 * Apply non-overlapping splices (document-text offsets) to the stored text,
 * leaving every character outside them unchanged. Returns the new raw text.
 */
export function spliceDocument(doc: TextDocument, splices: readonly Splice[]): string {
  const ordered = [...splices].sort((a, b) => a.start - b.start)
  let result = ''
  let cursor = 0
  for (const splice of ordered) {
    const start = rawOffset(doc, splice.start)
    const end = rawOffset(doc, splice.end)
    if (start < cursor) throw new Error('internal: overlapping edits')
    result += doc.raw.slice(cursor, start) + withEol(splice.text, doc.eol)
    cursor = end
  }
  return result + doc.raw.slice(cursor)
}

/** Encode stored text with the document's encoding and BOM. */
export function encodeRaw(raw: string, format: Pick<TextDocument, 'encoding' | 'bom'>): Buffer {
  const body = Buffer.from(raw, format.encoding)
  if (!format.bom) return body
  const bom = format.encoding === 'utf16le' ? Buffer.from([0xff, 0xfe]) : Buffer.from(UTF8_BOM)
  return Buffer.concat([bom, body])
}

/**
 * Bytes for a whole-file write. Over an existing document the text adopts
 * that file's encoding, BOM, and dominant line ending; a new file is written
 * as UTF-8 exactly as given.
 */
export function encodeForWrite(text: string, existing: TextDocument | undefined): Buffer {
  if (existing === undefined) return Buffer.from(text, 'utf8')
  return encodeRaw(withEol(text, existing.eol), existing)
}

/** Split document text into lines (a trailing newline does not open an extra line). */
export function documentLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** 1-based line number of a document-text offset. */
export function lineOf(text: string, offset: number): number {
  let line = 1
  for (let index = text.indexOf('\n'); index !== -1 && index < offset; index = text.indexOf('\n', index + 1)) line++
  return line
}
