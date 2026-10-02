import type { ReactNode } from 'react'
import CopyButton from '../common/CopyButton.tsx'
import { cn } from '../../lib/cn.ts'
import type { ToolCall } from '../../lib/types.ts'

/** `copy` offers the section's exact text — arguments and tool output are what a reader reaches for. */
export function Section({ label, copy, children }: { readonly label: string; readonly copy?: string; readonly children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="flex min-h-7 items-center gap-1 text-xs font-medium text-fg-faint">
        <span className="min-w-0 truncate">{label}</span>
        {copy !== undefined && copy !== '' ? <CopyButton text={copy} label={`Copy ${label}`} className="size-7" /> : null}
      </span>
      {children}
    </div>
  )
}

export const preClass = 'm-0 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted px-3 py-2 font-mono text-xs leading-relaxed text-fg'

/**
 * Argument fields that carry code or prose rather than an identifier. They
 * get their own block: inside a JSON dump their newlines are `\n` escapes,
 * which is exactly the content a reader opened the row to read.
 */
const PROSE_ARGS: Readonly<Record<string, string>> = {
  old: 'Replaced',
  new: 'With',
  content: 'Content',
  command: 'Command',
}

/** The replaced/replacement pair reads as a change when each side is tinted. */
const PROSE_TINT: Readonly<Record<string, string>> = {
  old: 'bg-bad-soft',
  new: 'bg-ok-soft',
}

/**
 * Fields that are file content whatever their length. A short command or
 * pattern stays in the JSON block instead: the row already shows it, and a
 * block of its own would only say it twice.
 */
const ALWAYS_PROSE: ReadonlySet<string> = new Set(['old', 'new', 'content'])

/** A string argument long enough that a JSON dump would hide it. */
function isProse(key: string, value: unknown): value is string {
  if (typeof value !== 'string') return false
  return ALWAYS_PROSE.has(key) || value.includes('\n') || value.length > 120
}

/**
 * Exact arguments, in a readable order: the short ones as one JSON block
 * (whose copy carries the complete payload), then each prose field on its
 * own so it can be read and copied as the text it is.
 *
 * `limit` bounds what is drawn, never what is copied: a surface that must stay
 * small (an approval card) can clip a huge payload and still hand over all of it.
 */
export function ToolArguments({ call, limit }: { readonly call: ToolCall; readonly limit?: number }) {
  const complete = JSON.stringify(call.args, null, 2)
  const entries = Object.entries(call.args)
  const prose = entries.filter(([key, value]) => isProse(key, value)) as [string, string][]
  const rest = Object.fromEntries(entries.filter(([key, value]) => !isProse(key, value)))
  const restText = JSON.stringify(rest, null, 2)
  const clip = (text: string): string => (limit === undefined || text.length <= limit ? text : `${text.slice(0, limit)}\n…`)
  const clipped = limit !== undefined && (restText.length > limit || prose.some(([, value]) => value.length > limit))
  // When every argument is a prose block, a lone `{}` above them says nothing.
  const showJson = Object.keys(rest).length > 0 || prose.length === 0
  return (
    <>
      {showJson ? (
        <Section label="Arguments" copy={complete}>
          <pre tabIndex={0} aria-label="Arguments" className={preClass}>{clip(restText)}</pre>
        </Section>
      ) : null}
      {prose.map(([key, value]) => (
        <Section key={key} label={PROSE_ARGS[key] ?? key} copy={value}>
          <pre tabIndex={0} aria-label={PROSE_ARGS[key] ?? key} className={cn(preClass, PROSE_TINT[key])}>{clip(value)}</pre>
        </Section>
      ))}
      {clipped ? <p className="m-0 text-xs text-fg-muted">Arguments truncated for display. Copy takes the full text.</p> : null}
    </>
  )
}

/** Whether any argument is a block of text a one-line target cannot show. */
export function hasProseArgs(args: Record<string, unknown>): boolean {
  return Object.entries(args).some(([key, value]) => isProse(key, value))
}
