import type { PatchEdit, PatchHunk } from './patch.ts'
import { documentLines, type Splice } from './text-document.ts'

/** Exact, unique matching against the original document; never guess at indentation. */
export function patchSplices(text: string, hunks: readonly PatchHunk[]): { splices: Splice[]; edits: PatchEdit[] } {
  const lines = documentLines(text)
  const offsets = [0]
  for (const line of lines) offsets.push(Math.min(text.length, offsets[offsets.length - 1]! + line.length + 1))
  const splices: Splice[] = []
  const edits: PatchEdit[] = []
  let cursor = 0
  let delta = 0
  for (const hunk of hunks) {
    if (hunk.context !== undefined) {
      const matches = lines.flatMap((line, index) => index >= cursor && line === hunk.context ? [index] : [])
      if (matches.length !== 1) throw new Error(matches.length ? 'ambiguous @@ context; include more context lines' : '@@ context not found')
      cursor = matches[0]! + 1
    }
    const old = hunk.lines.filter((line) => !line.startsWith('+')).map((line) => line.slice(1))
    const candidates: number[] = []
    if (old.length === 0) candidates.push(lines.length)
    else {
      for (let at = cursor; at + old.length <= lines.length; at++) {
        if (hunk.eof && at + old.length !== lines.length) continue
        if (old.every((line, n) => lines[at + n] === line)) candidates.push(at)
      }
    }
    if (candidates.length === 0) throw new Error('patch hunk not found; Read the region and include exact context')
    if (candidates.length > 1) throw new Error('ambiguous patch hunk; include more context')
    let at = candidates[0]!
    if (at < cursor) throw new Error('overlapping or out-of-order patch hunks')
    let index = 0
    while (index < hunk.lines.length) {
      if (hunk.lines[index]!.startsWith(' ')) { at++; index++; continue }
      const removed: string[] = []
      const added: string[] = []
      const startLine = at
      while (index < hunk.lines.length && !hunk.lines[index]!.startsWith(' ')) {
        const line = hunk.lines[index++]!
        if (line.startsWith('-')) { removed.push(line.slice(1)); at++ } else added.push(line.slice(1))
      }
      const start = offsets[startLine] ?? text.length
      const end = offsets[at] ?? text.length
      // A missing final newline is a file property, not an implicit patch change.
      const trailing = at < lines.length || text.endsWith('\n')
      const replacement = added.join('\n') + (added.length && trailing ? '\n' : '')
      const prefix = start === text.length && text !== '' && !text.endsWith('\n') && added.length ? '\n' : ''
      splices.push({ start, end, text: prefix + replacement })
      edits.push({ old: text.slice(start, end), new: prefix + replacement, oldLine: startLine + 1, newLine: startLine + delta + 1 })
      delta += added.length - removed.length
    }
    cursor = at
  }
  return { splices, edits }
}
