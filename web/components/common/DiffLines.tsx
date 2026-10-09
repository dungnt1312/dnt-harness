/**
 * The one way this app draws a diff — the Git panel's: an old and a new
 * line-number gutter, then the line, tinted green or red. The Git panel and an
 * Edit/Write tool row both render through here, so a change reads the same
 * wherever it shows.
 */
import { cn } from '../../lib/cn.ts'

export type DiffRowKind = 'add' | 'del' | 'context' | 'meta'

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

/** Numbered rows from a unified diff: hunk headers set the counters and are not printed. */
export function diffRowsFromUnified(lines: readonly RawDiffLine[]): readonly DiffRow[] {
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

function splitLines(text: string): string[] {
  if (text === '') return []
  return text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
}

/** `  12\tconst a = 2` — the numbered snippet `Edit` appends to its receipt. */
const NUMBERED = /^\s*(\d+)\t(.*)$/

/**
 * The rows an `Edit` call produced, numbered from the snippet its receipt
 * carries (the edited region as it now reads, with a little context). When the
 * snippet cannot be lined up with the replacement — a re-indented match, a
 * multi-occurrence edit, a pure deletion, a legacy receipt — the change is
 * still shown, with empty gutters and no context.
 */
export function diffRowsFromEdit(oldText: string, newText: string, receipt = ''): readonly DiffRow[] {
  const removed = splitLines(oldText)
  const added = splitLines(newText)
  const snippet = receipt.split('\n').slice(1).map((line) => NUMBERED.exec(line)).filter((match) => match !== null)
    .map((match) => ({ n: Number(match[1]), text: match[2] ?? '' }))
  const at = added.length === 0 ? -1 : snippet.findIndex((_, index) => added.every((line, offset) => snippet[index + offset]?.text === line))
  if (at === -1) {
    return [
      ...removed.map((text): DiffRow => ({ kind: 'del', text, old: null, new: null })),
      ...added.map((text): DiffRow => ({ kind: 'add', text, old: null, new: null })),
    ]
  }
  const start = snippet[at]!.n
  const shift = removed.length - added.length
  return [
    ...snippet.slice(0, at).map((line): DiffRow => ({ kind: 'context', text: line.text, old: line.n, new: line.n })),
    ...removed.map((text, index): DiffRow => ({ kind: 'del', text, old: start + index, new: null })),
    ...added.map((text, index): DiffRow => ({ kind: 'add', text, old: null, new: start + index })),
    ...snippet.slice(at + added.length).map((line): DiffRow => ({ kind: 'context', text: line.text, old: line.n + shift, new: line.n })),
  ]
}

/** What a `Write` put in its file: every line added, numbered from the top. */
export function diffRowsFromWrite(content: string): readonly DiffRow[] {
  return splitLines(content).map((text, index) => ({ kind: 'add', text, old: null, new: index + 1 }))
}

function lineClass(kind: DiffRowKind): string {
  if (kind === 'add') return 'bg-ok-soft text-ok'
  if (kind === 'del') return 'bg-bad-soft text-bad'
  if (kind === 'meta') return 'text-fg-faint'
  return 'text-fg'
}

/** The rows themselves, exactly as the Git panel draws them. The caller owns the frame and the scrolling. */
export function DiffLines({ rows }: { readonly rows: readonly DiffRow[] }) {
  return (
    <pre className="m-0 px-3 py-1.5 font-mono text-[12px] leading-5">
      {rows.map((row, index) => (
        <div key={index} data-kind={row.kind} className={cn('whitespace-pre', lineClass(row.kind))}>
          <span aria-hidden="true" className="inline-block w-9 select-none pr-2 text-right text-fg-faint">{row.old === null ? '' : row.old}</span>
          <span aria-hidden="true" className="inline-block w-9 select-none pr-2 text-right text-fg-faint">{row.new === null ? '' : row.new}</span>
          {row.text === '' ? ' ' : row.text}
        </div>
      ))}
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
