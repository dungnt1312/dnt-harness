/**
 * A line diff between an `Edit`'s recorded `old` and `new`: which lines stayed,
 * which went, which came. The whole `old`/`new` text is not the change — an
 * Edit usually carries unchanged context lines to make its match unique, and
 * counting those as removed and added again overstates every edit.
 *
 * Common head and tail lines are peeled off first (the usual shape of an
 * edit), then the middle is aligned by longest common subsequence. A middle too
 * large to align cheaply falls back to "all removed, all added" — honest about
 * the lines involved, never a hang.
 */

export type LineOp = { readonly kind: 'same' | 'del' | 'add'; readonly text: string }

/** Past this many cells the LCS table is not worth building in a render. */
const MAX_CELLS = 250_000

/** Lines of a recorded argument, ignoring one trailing newline. */
export function splitLines(text: string): string[] {
  if (text === '') return []
  return text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
}

export function lineDiff(oldText: string, newText: string): readonly LineOp[] {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1
  const midA = a.slice(head, a.length - tail)
  const midB = b.slice(head, b.length - tail)
  const same = (text: string): LineOp => ({ kind: 'same', text })
  return [
    ...a.slice(0, head).map(same),
    ...alignMiddle(midA, midB),
    ...a.slice(a.length - tail).map(same),
  ]
}

function alignMiddle(a: readonly string[], b: readonly string[]): LineOp[] {
  const del = (text: string): LineOp => ({ kind: 'del', text })
  const add = (text: string): LineOp => ({ kind: 'add', text })
  if (a.length === 0 || b.length === 0 || a.length * b.length > MAX_CELLS) return [...a.map(del), ...b.map(add)]
  // lcs[i][j]: common lines of a[i..] and b[j..], filled from the end.
  const width = b.length + 1
  const lcs = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i * width + j] = a[i] === b[j]
        ? lcs[(i + 1) * width + j + 1]! + 1
        : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!)
    }
  }
  const ops: LineOp[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { ops.push({ kind: 'same', text: a[i]! }); i += 1; j += 1 }
    else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) { ops.push(del(a[i]!)); i += 1 }
    else { ops.push(add(b[j]!)); j += 1 }
  }
  while (i < a.length) { ops.push(del(a[i]!)); i += 1 }
  while (j < b.length) { ops.push(add(b[j]!)); j += 1 }
  return ops
}

/** Lines one Edit actually added and removed, context excluded. */
export function editLineCounts(oldText: string, newText: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const op of lineDiff(oldText, newText)) {
    if (op.kind === 'add') added += 1
    else if (op.kind === 'del') removed += 1
  }
  return { added, removed }
}

/** `edited x: replaced 3 occurrences` — how many places a replaceAll Edit changed. */
export function editOccurrences(output: string | undefined): number {
  const match = /replaced (\d+) occurrences/.exec(output ?? '')
  return match?.[1] !== undefined ? Math.max(1, Number(match[1])) : 1
}
