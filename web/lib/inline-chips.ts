/**
 * Inline chips on the wire. A sent message is plain text the model reads, so
 * each chip has one textual form that is both clear to the model and
 * unambiguous to parse back — the transcript and "reuse" rebuild chips from
 * the stored text alone.
 *
 * - File mention: `@path`, or `@"path with spaces"` when the path needs it.
 * - Command (a custom slash command or a skill), Claude Code style: `/name`
 *   at the very start of the message — the host expands it. A command chip
 *   anywhere else (the `$` menu) is `Use the <name> skill:`, which the model
 *   reads and loads through the Skill tool; older messages that start with
 *   that phrase still parse back into a (legacy) chip.
 *
 * `messageText(parseMessageText(text)) === text` holds for every string: text
 * that merely looks like a chip becomes one, and nothing is lost or added.
 */

import type { DraftSegment } from './composer-draft.ts'

export type ChipSegment = Exclude<DraftSegment, { readonly kind: 'text' }>

/** Command names as Claude Code accepts them (`review`, `git:commit`, `plugin:cmd`). */
const COMMAND_NAME = /^[a-zA-Z0-9_][a-zA-Z0-9:_-]{0,127}$/
/** A leading `/name`, followed by whitespace or the end. */
const SLASH_PREFIX = /^\/([a-zA-Z0-9_][a-zA-Z0-9:_-]{0,127})(?=\s|$)/
const COMMAND_PREFIX = /^Use the ([a-zA-Z0-9_][a-zA-Z0-9:_-]{0,127}) skill:/
/** A mention starts a word: `@"quoted path"` or `@bare/path`. */
const MENTION = /(^|\s)@(?:"([^"\n]+)"|([^\s"]+))/g
/** Sentence punctuation glued to a bare path belongs to the sentence. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/

export function isSkillName(name: string): boolean {
  return COMMAND_NAME.test(name)
}

/**
 * Built-in composer commands: host actions a workspace skill cannot be,
 * reserved across every catalog. The `/` menu lists them before skills and a
 * skill whose name collides is shadowed — the namespace belongs to the host.
 */
export const BUILTIN_COMMANDS: readonly { readonly name: string; readonly description: string }[] = [
  { name: 'compact', description: 'Summarize older turns into a compaction checkpoint' },
]

export function isBuiltinCommand(name: string): boolean {
  return BUILTIN_COMMANDS.some((command) => command.name === name)
}

/**
 * The wire text of one chip. `leading` is true for the message's first
 * segment: only there is a command a real `/name` invocation.
 */
export function chipWireText(segment: ChipSegment, leading = false): string {
  if (segment.kind === 'command') return leading && segment.legacy !== true ? `/${segment.name}` : `Use the ${segment.name} skill:`
  const bare = segment.path !== '' && !/[\s"]/.test(segment.path) && !TRAILING_PUNCTUATION.test(segment.path)
  return bare ? `@${segment.path}` : `@"${segment.path}"`
}

/** Short on-chip label: a file's base name, a skill as its bare name. */
export function chipLabel(segment: ChipSegment): string {
  if (segment.kind === 'command') return segment.name
  return segment.path.split('/').at(-1) || segment.path
}

/** Hover text naming exactly what the chip carries. */
export function chipTitle(segment: ChipSegment): string {
  if (segment.kind !== 'command') return `Project file: ${segment.path}`
  return isBuiltinCommand(segment.name) ? `Command: ${segment.name}` : `Command: /${segment.name}`
}

/** Serialize editor segments into the message that is sent. */
export function messageText(segments: readonly DraftSegment[]): string {
  return segments.map((segment, index) => {
    if (segment.kind === 'text') return segment.text
    const wire = chipWireText(segment, index === 0)
    // A leading `/name` must end at whitespace, or `/review` + `fix` would
    // send `/reviewfix` and lose the chip.
    const next = segments[index + 1]
    const glued = index === 0 && segment.kind === 'command' && wire.startsWith('/') && next !== undefined && !(next.kind === 'text' && /^\s/.test(next.text))
    return glued ? `${wire} ` : wire
  }).join('')
}

/** Parse a stored message back into text and chips (inverse of {@link messageText}). */
export function parseMessageText(text: string): DraftSegment[] {
  const segments: DraftSegment[] = []
  let rest = text
  const slash = SLASH_PREFIX.exec(rest)
  const legacy = slash === null ? COMMAND_PREFIX.exec(rest) : null
  if (slash !== null) {
    segments.push({ kind: 'command', name: slash[1] ?? '' })
    rest = rest.slice(slash[0].length)
  } else if (legacy !== null) {
    segments.push({ kind: 'command', name: legacy[1] ?? '', legacy: true })
    rest = rest.slice(legacy[0].length)
  }

  let cursor = 0
  for (const match of rest.matchAll(MENTION)) {
    const lead = match[1] ?? ''
    const start = (match.index ?? 0) + lead.length
    let path = match[2] ?? match[3] ?? ''
    let tail = ''
    if (match[3] !== undefined) {
      tail = TRAILING_PUNCTUATION.exec(path)?.[0] ?? ''
      path = path.slice(0, path.length - tail.length)
    }
    // Only the canonical form is a chip, so re-serializing changes nothing
    // (`@"plain"` stays text: its chip would be written `@plain`).
    if (path === '' || match[0].slice(lead.length, match[0].length - tail.length) !== chipWireText({ kind: 'mention', path })) continue
    if (start > cursor) segments.push({ kind: 'text', text: rest.slice(cursor, start) })
    segments.push({ kind: 'mention', path })
    cursor = (match.index ?? 0) + match[0].length - tail.length
  }
  if (cursor < rest.length) segments.push({ kind: 'text', text: rest.slice(cursor) })
  return segments
}
