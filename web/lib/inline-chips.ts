/**
 * Inline chips on the wire. A sent message is plain text the model reads, so
 * each chip has one textual form that is both clear to the model and
 * unambiguous to parse back — the transcript and "reuse" rebuild chips from
 * the stored text alone.
 *
 * - File mention: `@path`, or `@"path with spaces"` when the path needs it.
 * - Skill command: `Use the <name> skill:`, only at the very start of the
 *   message (the `/` menu only opens there).
 *
 * `messageText(parseMessageText(text)) === text` holds for every string: text
 * that merely looks like a chip becomes one, and nothing is lost or added.
 */

import type { DraftSegment } from './composer-draft.ts'

export type ChipSegment = Exclude<DraftSegment, { readonly kind: 'text' }>

/** Skill names as the server catalog accepts them. */
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/
const COMMAND_PREFIX = /^Use the ([a-z0-9][a-z0-9-]{0,63}) skill:/
/** A mention starts a word: `@"quoted path"` or `@bare/path`. */
const MENTION = /(^|\s)@(?:"([^"\n]+)"|([^\s"]+))/g
/** Sentence punctuation glued to a bare path belongs to the sentence. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/

export function isSkillName(name: string): boolean {
  return SKILL_NAME.test(name)
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

/** The model-visible text of one chip. */
export function chipWireText(segment: ChipSegment): string {
  if (segment.kind === 'command') return `Use the ${segment.name} skill:`
  const bare = segment.path !== '' && !/[\s"]/.test(segment.path) && !TRAILING_PUNCTUATION.test(segment.path)
  return bare ? `@${segment.path}` : `@"${segment.path}"`
}

/** Short on-chip label: a file's base name, a skill as `/name`. */
export function chipLabel(segment: ChipSegment): string {
  if (segment.kind === 'command') return `/${segment.name}`
  return segment.path.split('/').at(-1) || segment.path
}

/** Hover text naming exactly what the chip carries. */
export function chipTitle(segment: ChipSegment): string {
  if (segment.kind !== 'command') return `Project file: ${segment.path}`
  return isBuiltinCommand(segment.name) ? `Command: ${segment.name}` : `Skill: ${segment.name}`
}

/** Serialize editor segments into the message the model reads. */
export function messageText(segments: readonly DraftSegment[]): string {
  return segments.map((segment) => (segment.kind === 'text' ? segment.text : chipWireText(segment))).join('')
}

/** Parse a stored message back into text and chips (inverse of {@link messageText}). */
export function parseMessageText(text: string): DraftSegment[] {
  const segments: DraftSegment[] = []
  let rest = text
  const command = COMMAND_PREFIX.exec(rest)
  if (command !== null) {
    segments.push({ kind: 'command', name: command[1] ?? '' })
    rest = rest.slice(command[0].length)
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
