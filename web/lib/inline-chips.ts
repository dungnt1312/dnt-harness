/**
 * Inline chips on the wire. A sent message is plain text the model reads, so
 * each chip has one textual form that is both clear to the model and
 * unambiguous to parse back — the transcript and "reuse" rebuild chips from
 * the stored text alone.
 *
 * Every chip is a Markdown link `[label](destination)` (the ZCode convention):
 * - The destination alone is the chip's identity; its scheme names the kind.
 *   A project file is a `./relative/path`, a skill or command is
 *   `skill://name`. A new chip kind adds one scheme here.
 * - The label is display text derived from the identity, prefixed with the
 *   sigil of the menu that inserts it (`@` file, `$` skill).
 * - Only the canonical form parses back into a chip: a link whose text is not
 *   exactly what the chip would serialize to (a hand-written Markdown link,
 *   another label) stays text, so prose is never reinterpreted.
 *
 * One exception: a command at the very start of the message is a real
 * `/name` invocation the host expands, Claude Code style.
 *
 * `messageText(parseMessageText(text)) === text` holds for every string.
 */

import type { DraftSegment } from './composer-draft.ts'

export type ChipSegment = Exclude<DraftSegment, { readonly kind: 'text' }>

/** Command names as Claude Code accepts them (`review`, `git:commit`, `plugin:cmd`). */
const COMMAND_NAME = /^[a-zA-Z0-9_][a-zA-Z0-9:_-]{0,127}$/
/** A leading `/name`, followed by whitespace or the end. */
const SLASH_PREFIX = /^\/([a-zA-Z0-9_][a-zA-Z0-9:_-]{0,127})(?=\s|$)/
/** `[label](destination)`, the destination bare or `<angle-bracketed>`; `\` escapes. */
const CHIP_LINK = /\[((?:\\.|[^\\\]\n])*)\]\((?:<((?:\\.|[^\\<>\n])*)>|([^\s()<>\\]*))\)/g
const SKILL_SCHEME = 'skill://'
const FILE_PREFIX = './'

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

/** The identity a chip links to. */
function chipDestination(segment: ChipSegment): string {
  return segment.kind === 'command' ? `${SKILL_SCHEME}${segment.name}` : `${FILE_PREFIX}${segment.path}`
}

/** The chip a link destination names, or null when no chip kind owns it. */
function chipFromDestination(destination: string): ChipSegment | null {
  if (destination.startsWith(SKILL_SCHEME)) {
    const name = destination.slice(SKILL_SCHEME.length)
    return isSkillName(name) ? { kind: 'command', name } : null
  }
  if (destination.startsWith(FILE_PREFIX) && destination.length > FILE_PREFIX.length) {
    return { kind: 'mention', path: destination.slice(FILE_PREFIX.length) }
  }
  return null
}

function linkText(label: string, destination: string): string {
  const safeLabel = label.replace(/[\\[\]]/g, '\\$&')
  const safeDestination = /^[^\s()<>\\]+$/.test(destination) ? destination : `<${destination.replace(/[\\<>]/g, '\\$&')}>`
  return `[${safeLabel}](${safeDestination})`
}

/**
 * The wire text of one chip. `leading` is true for the message's first
 * segment: only there is a command a real `/name` invocation.
 */
export function chipWireText(segment: ChipSegment, leading = false): string {
  if (segment.kind === 'command' && leading) return `/${segment.name}`
  return linkText(`${segment.kind === 'command' ? '$' : '@'}${chipLabel(segment)}`, chipDestination(segment))
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
  if (slash !== null) {
    segments.push({ kind: 'command', name: slash[1] ?? '' })
    rest = rest.slice(slash[0].length)
  }
  return [...segments, ...parseChipLinks(rest)]
}

/**
 * Only the chip links in `rest`, without the leading `/name` rule: pasted text
 * is not a message start, so `/tmp is full` stays text.
 */
export function parseChipLinks(rest: string): DraftSegment[] {
  const segments: DraftSegment[] = []
  let cursor = 0
  for (const match of rest.matchAll(CHIP_LINK)) {
    const destination = (match[2] ?? match[3] ?? '').replace(/\\(.)/g, '$1')
    const chip = chipFromDestination(destination)
    // Only the canonical form is a chip, so re-serializing changes nothing.
    if (chip === null || chipWireText(chip) !== match[0]) continue
    const start = match.index ?? 0
    if (start > cursor) segments.push({ kind: 'text', text: rest.slice(cursor, start) })
    segments.push(chip)
    cursor = start + match[0].length
  }
  if (cursor < rest.length) segments.push({ kind: 'text', text: rest.slice(cursor) })
  return segments
}
