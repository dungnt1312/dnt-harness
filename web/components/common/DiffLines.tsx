/**
 * The one way this app draws a diff — the Git panel's: an old and a new
 * line-number gutter, then the line, tinted green or red. The Git panel and an
 * Edit/Write tool row both render through here, so a change reads the same
 * wherever it shows.
 */
import type { ReactNode } from 'react'
import { cn } from '../../lib/cn.ts'
import { lineDiff, splitLines } from '../../lib/line-diff.ts'

export type DiffRowKind = 'add' | 'del' | 'context' | 'meta' | 'hunk'

/** One printed diff row; a null side means that side has no line here. */
export interface DiffRow {
  readonly kind: DiffRowKind
  readonly text: string
  readonly old: number | null
  readonly new: number | null
}

/** Raw unified-diff lines, as the git endpoint returns them. */
export interface RawDiffLine {
  readonly kind: 'add' | 'del' | 'hunk' | 'meta' | 'context'
  readonly text: string
}

/**
 * Numbered rows from a unified diff: hunk headers set the counters and are
 * not printed — unless `keepHunks` asks for them as `hunk` rows (the Git
 * panel hangs its Stage/Restore buttons on them).
 */
export function diffRowsFromUnified(lines: readonly RawDiffLine[], options: { readonly keepHunks?: boolean } = {}): readonly DiffRow[] {
  const rows: DiffRow[] = []
  let oldNo = 0
  let newNo = 0
  for (const line of lines) {
    if (line.kind === 'hunk') {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line.text)
      if (hunk !== null) {
        oldNo = Number(hunk[1])
        newNo = Number(hunk[2])
      }
      if (options.keepHunks === true) rows.push({ kind: 'hunk', text: line.text, old: null, new: null })
      continue
    }
    // The file header repeats the name the row already shows.
    if (line.kind === 'meta' && /^[+-]{3}/.test(line.text)) continue
    if (line.kind === 'add') rows.push({ kind: 'add', text: line.text, old: null, new: newNo++ })
    else if (line.kind === 'del') rows.push({ kind: 'del', text: line.text, old: oldNo++, new: null })
    else if (line.kind === 'meta') rows.push({ kind: 'meta', text: line.text, old: null, new: null })
    // A context line exists on both sides, so both counters move past it.
    else rows.push({ kind: 'context', text: line.text, old: oldNo++, new: newNo++ })
  }
  return rows
}

/** `  12\tconst a = 2` — the numbered snippet `Edit` appends to its receipt. */
const NUMBERED = /^\s*(\d+)\t(.*)$/

/**
 * The rows an `Edit` call produced, numbered from the snippet its receipt
 * carries (the edited region as it now reads, with a little context). When the
 * snippet cannot be lined up with the replacement — a re-indented match, a
 * multi-occurrence edit, a pure deletion, a legacy receipt — the change is
 * still shown, with empty gutters and no context.
 *
 * The rows are a line diff of `old` against `new`: lines the edit only carried
 * as context read as context, not as one removed and one re-added.
 */
export function diffRowsFromEdit(oldText: string, newText: string, receipt = ''): readonly DiffRow[] {
  const removed = splitLines(oldText)
  const added = splitLines(newText)
  const ops = lineDiff(oldText, newText)
  const snippet = receipt.split('\n').slice(1).map((line) => NUMBERED.exec(line)).filter((match) => match !== null)
    .map((match) => ({ n: Number(match[1]), text: match[2] ?? '' }))
  const at = added.length === 0 ? -1 : snippet.findIndex((_, index) => added.every((line, offset) => snippet[index + offset]?.text === line))
  if (at === -1) {
    return ops.map((op): DiffRow => ({ kind: op.kind === 'same' ? 'context' : op.kind, text: op.text, old: null, new: null }))
  }
  const start = snippet[at]!.n
  const shift = removed.length - added.length
  let oldNo = start
  let newNo = start
  return [
    ...snippet.slice(0, at).map((line): DiffRow => ({ kind: 'context', text: line.text, old: line.n, new: line.n })),
    ...ops.map((op): DiffRow => op.kind === 'same'
      ? { kind: 'context', text: op.text, old: oldNo++, new: newNo++ }
      : op.kind === 'del'
        ? { kind: 'del', text: op.text, old: oldNo++, new: null }
        : { kind: 'add', text: op.text, old: null, new: newNo++ }),
    ...snippet.slice(at + added.length).map((line): DiffRow => ({ kind: 'context', text: line.text, old: line.n + shift, new: line.n })),
  ]
}

/** What a `Write` put in its file: every line added, numbered from the top. */
export function diffRowsFromWrite(content: string): readonly DiffRow[] {
  return splitLines(content).map((text, index) => ({ kind: 'add', text, old: null, new: index + 1 }))
}

export type DiffLayout = 'unified' | 'split'

type SplitEntry = { readonly full: DiffRow } | { readonly left: DiffRow | null; readonly right: DiffRow | null }

/** Side-by-side entries: context on both sides, a removed run paired index-wise with the added run after it. */
function splitPairs(rows: readonly DiffRow[]): readonly SplitEntry[] {
  const entries: SplitEntry[] = []
  for (let i = 0; i < rows.length;) {
    const row = rows[i]!
    if (row.kind === 'meta' || row.kind === 'hunk') { entries.push({ full: row }); i++; continue }
    if (row.kind === 'context') { entries.push({ left: row, right: row }); i++; continue }
    const dels: DiffRow[] = []
    const adds: DiffRow[] = []
    while (rows[i]?.kind === 'del') dels.push(rows[i++]!)
    while (rows[i]?.kind === 'add') adds.push(rows[i++]!)
    for (let n = 0; n < Math.max(dels.length, adds.length); n++) entries.push({ left: dels[n] ?? null, right: adds[n] ?? null })
  }
  return entries
}

function lineClass(kind: DiffRowKind): string {
  if (kind === 'add') return 'bg-ok-soft text-ok'
  if (kind === 'del') return 'bg-bad-soft text-bad'
  if (kind === 'meta' || kind === 'hunk') return 'text-fg-faint'
  return 'text-fg'
}

/**
 * The rows themselves, exactly as the Git panel draws them. The caller owns
 * the frame and the scrolling. A `hunk` row is drawn by `renderHunk` (its
 * 0-based index among the hunks and its header text), or not at all.
 */
export function DiffLines({ rows, renderHunk, layout = 'unified' }: {
  readonly rows: readonly DiffRow[]
  readonly renderHunk?: (index: number, header: string) => ReactNode
  /** `split` puts the old file left and the new one right, a removed run beside the lines that replaced it. */
  readonly layout?: DiffLayout
}) {
  let hunkIndex = -1
  if (layout === 'split') {
    const cell = (row: DiffRow | null, side: 'old' | 'new', key: string) => (
      <div key={key} data-kind={row?.kind ?? 'empty'} data-side={side} className={cn('flex min-w-0', side === 'new' && 'border-l border-line', row === null ? 'bg-muted/40' : lineClass(row.kind))}>
        <span aria-hidden="true" className="w-9 shrink-0 select-none pr-2 text-right text-fg-faint">{row === null ? '' : (side === 'old' ? row.old : row.new) ?? ''}</span>
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words pr-2">{row === null || row.text === '' ? ' ' : row.text}</span>
      </div>
    )
    return (
      // Two equal columns that wrap long lines: the pane never scrolls sideways.
      <pre className="m-0 grid grid-cols-2 px-0 py-1.5 font-mono text-[12.5px] leading-5">
        {splitPairs(rows).map((entry, index) => {
          if ('full' in entry) {
            if (entry.full.kind !== 'hunk') return <div key={index} data-kind={entry.full.kind} className={cn('col-span-2 whitespace-pre-wrap break-words px-3', lineClass(entry.full.kind))}>{entry.full.text === '' ? ' ' : entry.full.text}</div>
            hunkIndex++
            return renderHunk === undefined ? null : <div key={index} data-kind="hunk" data-hunk-index={hunkIndex} className="col-span-2">{renderHunk(hunkIndex, entry.full.text)}</div>
          }
          return [cell(entry.left, 'old', `${index}o`), cell(entry.right, 'new', `${index}n`)]
        })}
      </pre>
    )
  }
  return (
    // w-max: rows tint past the visible width when the pane scrolls sideways; min-w-full keeps short diffs pane-wide.
    <pre className="m-0 w-max min-w-full px-3 py-1.5 font-mono text-[12.5px] leading-5">
      {rows.map((row, index) => {
        if (row.kind === 'hunk') {
          hunkIndex++
          return renderHunk === undefined ? null : <div key={index} data-kind="hunk" data-hunk-index={hunkIndex}>{renderHunk(hunkIndex, row.text)}</div>
        }
        return (
        <div key={index} data-kind={row.kind} className={cn('whitespace-pre', lineClass(row.kind))}>
          <span aria-hidden="true" className="inline-block w-9 select-none pr-2 text-right text-fg-faint">{row.old === null ? '' : row.old}</span>
          <span aria-hidden="true" className="inline-block w-9 select-none pr-2 text-right text-fg-faint">{row.new === null ? '' : row.new}</span>
          {row.text === '' ? ' ' : row.text}
        </div>
        )
      })}
    </pre>
  )
}

/** Added and removed counts, the way the Git panel and tool rows both state them. */
export function LineCount({ added, removed, className }: { readonly added?: number; readonly removed?: number; readonly className?: string }) {
  const plus = added ?? 0
  const minus = removed ?? 0
  if (plus === 0 && minus === 0) return null
  return (
    <span className={cn('flex shrink-0 items-center gap-1.5 whitespace-nowrap font-mono text-xs', className)}>
      {plus > 0 ? <span className="text-ok">+{plus}</span> : null}
      {minus > 0 ? <span className="text-bad">−{minus}</span> : null}
    </span>
  )
}
