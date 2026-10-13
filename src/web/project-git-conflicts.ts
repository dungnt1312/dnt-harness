/**
 * Conflict markers in one worktree file (a port of Zed `conflict_set.rs`):
 * parsing two-way and diff3 blocks, and the ours/theirs/both rewrites behind
 * the Use buttons. Zed edits the buffer only — resolving never stages.
 */
import { createHash } from 'node:crypto'
import { promises as fsPromises } from 'node:fs'
import path from 'node:path'
import { ProjectGitError } from './project-git.ts'

export interface GitConflict {
  /** 0-based, in file order. */
  readonly index: number
  /** 1-based line of `<<<<<<<` … `>>>>>>>` inclusive. */
  readonly startLine: number
  readonly endLine: number
  readonly ours: string
  readonly theirs: string
  /** The text after `<<<<<<< ` / `>>>>>>> `, trimmed; `HEAD` / `Origin` defaults. */
  readonly oursName: string
  readonly theirsName: string
  /** sha1 of the raw region text, so a stale client ref is refused. */
  readonly fingerprint: string
}

const OURS_DEFAULT = 'HEAD'
const THEIRS_DEFAULT = 'Origin'

/**
 * Parse conflict blocks. A diff3 `|||||||` base section is parsed and
 * dropped. Nested or unterminated markers stop the parse; what closed stays.
 */
export function parseConflicts(text: string): GitConflict[] {
  const lines = text.split('\n')
  // split() drops the final empty piece only when the text ends with \n; the
  // line numbers git and the editor use count the same way either way.
  const conflicts: GitConflict[] = []
  let index = 0
  let cursor = 0
  while (cursor < lines.length) {
    const line = lines[cursor]!
    if (!line.startsWith('<<<<<<<')) { cursor++; continue }
    const startLine = cursor + 1
    const oursName = line.slice(7).trim() || OURS_DEFAULT
    const ours: string[] = []
    const base: string[] = []
    const theirs: string[] = []
    let section: 'ours' | 'base' | 'theirs' | null = 'ours'
    let closed = false
    let endLine = -1
    const theirsName = THEIRS_DEFAULT
    for (let inner = cursor + 1; inner < lines.length; inner++) {
      const text = lines[inner]!
      if (text.startsWith('|||||||')) { section = 'base'; continue }
      if (text.startsWith('=======')) { section = 'theirs'; continue }
      if (text.startsWith('>>>>>>>')) {
        const name = text.slice(7).trim() || THEIRS_DEFAULT
        const region = lines.slice(cursor, inner + 1).join('\n')
        conflicts.push({
          index: index++,
          startLine,
          endLine: inner + 1,
          ours: ours.join('\n') + (ours.length > 0 ? '\n' : ''),
          theirs: theirs.join('\n') + (theirs.length > 0 ? '\n' : ''),
          oursName,
          theirsName: name,
          fingerprint: createHash('sha1').update(region).digest('hex'),
        })
        endLine = inner + 1
        closed = true
        void theirsName
        void base
        break
      }
      if (section === 'ours') ours.push(text)
      else if (section === 'base') base.push(text)
      else theirs.push(text)
    }
    if (!closed) break
    cursor = endLine
  }
  return conflicts
}

/** Replace the whole conflict region with the kept side(s); `both` keeps ours then theirs. */
export function resolveConflictText(text: string, conflict: GitConflict, choice: 'ours' | 'theirs' | 'both'): string {
  const lines = text.split('\n')
  const kept = choice === 'ours' ? conflict.ours : choice === 'theirs' ? conflict.theirs : `${conflict.ours}${conflict.theirs}`
  const before = lines.slice(0, conflict.startLine - 1)
  const after = lines.slice(conflict.endLine)
  return [...before, ...kept.split('\n').slice(0, -1), ...after].join('\n')
}

export const STALE_CONFLICT = 'The file changed since the diff was shown. Refresh and try again.'

/** `resolve-conflict`: re-parse, match by index + fingerprint, rewrite the file. No staging (Zed edits only). */
export async function resolveConflict(
  root: string,
  rel: string,
  index: number,
  fingerprint: string,
  choice: 'ours' | 'theirs' | 'both',
): Promise<void> {
  const abs = path.join(root, rel)
  const text = await fsPromises.readFile(abs, 'utf8')
  const conflicts = parseConflicts(text)
  const conflict = conflicts.find((entry) => entry.index === index && entry.fingerprint === fingerprint)
  if (conflict === undefined) throw new ProjectGitError(STALE_CONFLICT)
  await fsPromises.writeFile(abs, resolveConflictText(text, conflict, choice))
}
