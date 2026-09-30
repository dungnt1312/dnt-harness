/**
 * Composer completion: what the caret is currently asking for, and how a
 * chosen suggestion lands back in the draft. Pure string work so the popup and
 * the textarea can stay dumb.
 *
 * `@name` mentions a project file anywhere a word starts; `/name` runs a skill
 * and only triggers at the very start of a draft, so `/usr/bin` or a path
 * pasted mid-sentence never opens the menu.
 */

import type { DraftSegment, RichDraft } from './composer-draft.ts'
import { BUILTIN_COMMANDS, isBuiltinCommand, messageText } from './inline-chips.ts'

export type CompletionKind = 'file' | 'skill'

export interface CompletionRequest {
  readonly kind: CompletionKind
  /** Text typed after the trigger character, without the trigger. */
  readonly query: string
  /** Draft offset of the trigger character. */
  readonly start: number
  /** Draft offset just past the query (the caret). */
  readonly end: number
}

export interface CompletionItem {
  /** Stable identity for keys and `aria-activedescendant`. */
  readonly id: string
  /** Text inserted in place of the trigger and its query. */
  readonly insert: string
  /** What the editor actually inserts, when it is semantic rather than plain text. */
  readonly segment?: DraftSegment
  readonly label: string
  readonly detail?: string
}

/** A skill becomes a command chip; its wire text is owned by `inline-chips.ts`. */
export function skillCompletionItem(skill: { readonly name: string; readonly description?: string }): CompletionItem {
  const segment: DraftSegment = { kind: 'command', name: skill.name }
  return {
    id: `skill:${skill.name}`,
    insert: messageText([segment]),
    segment,
    label: skill.name,
    ...(skill.description !== undefined ? { detail: skill.description } : {}),
  }
}

/** A built-in command becomes the same command chip shape, under its own id space. */
export function builtinCompletionItem(command: { readonly name: string; readonly description: string }): CompletionItem {
  const segment: DraftSegment = { kind: 'command', name: command.name }
  return {
    id: `command:${command.name}`,
    insert: `/${command.name}`,
    segment,
    label: `/${command.name}`,
    detail: command.description,
  }
}

/**
 * The built-in command a draft carries, if any — matched by command chip,
 * not by text. `null` means the draft sends as a normal message.
 */
export function builtinCommandIn(draft: RichDraft): string | null {
  for (const segment of draft.segments) {
    if (segment.kind === 'command' && isBuiltinCommand(segment.name)) return segment.name
  }
  return null
}

/**
 * Whether the draft is exactly the named command: no attachments, no other
 * chips, and no text beyond whitespace. Built-in commands run on their own —
 * a mixed draft is refused rather than silently ignoring the extra content.
 */
export function draftIsOnlyCommand(draft: RichDraft, name: string): boolean {
  if (draft.attachments.length > 0) return false
  return draft.segments.every((segment) =>
    segment.kind === 'command'
      ? segment.name === name
      : segment.kind === 'text' && segment.text.trim() === '',
  )
}

/** A mention query stops at whitespace; the trigger needs a word boundary. */
const FILE_TRIGGER = /(^|\s)@([^\s@]*)$/
/** Skill names are one token; the trigger is anchored to the draft start. */
const SKILL_TRIGGER = /^\/([^\s/]*)$/

/**
 * The completion the caret is inside, or null. `caret` is the selection start;
 * a selection that spans text never completes.
 */
export function completionAt(draft: string, caret: number, selectionEnd = caret): CompletionRequest | null {
  if (caret !== selectionEnd || caret < 0 || caret > draft.length) return null
  const before = draft.slice(0, caret)

  const skill = SKILL_TRIGGER.exec(before)
  if (skill !== null) return { kind: 'skill', query: skill[1] ?? '', start: 0, end: caret }

  const file = FILE_TRIGGER.exec(before)
  if (file === null) return null
  const query = file[2] ?? ''
  return { kind: 'file', query, start: caret - query.length - 1, end: caret }
}

/** Move an active-item index, wrapping at both ends; -1 for an empty list. */
export function moveActive(index: number, delta: number, count: number): number {
  if (count <= 0) return -1
  return ((index + delta) % count + count) % count
}

/**
 * Client-side skill ranking for the `/` menu: name prefix, then name
 * substring, then description substring. Ties keep catalog order.
 */
export function rankSkills<T extends { readonly name: string; readonly description?: string }>(
  skills: readonly T[],
  query: string,
  limit = 20,
): readonly T[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return skills.slice(0, limit)
  const scored: { readonly skill: T; readonly score: number; readonly order: number }[] = []
  skills.forEach((skill, order) => {
    const name = skill.name.toLowerCase()
    const score = name.startsWith(needle) ? 3 : name.includes(needle) ? 2 : (skill.description ?? '').toLowerCase().includes(needle) ? 1 : -1
    if (score >= 0) scored.push({ skill, score, order })
  })
  return scored
    .sort((a, b) => (a.score !== b.score ? b.score - a.score : a.order - b.order))
    .slice(0, limit)
    .map((entry) => entry.skill)
}
