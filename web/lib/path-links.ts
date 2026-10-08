/**
 * File references inside free text — a command, its output, a search result —
 * so a tool row can make every file it mentions open in the workbench.
 *
 * Detection is deliberately conservative: a token is a path only when it has a
 * directory separator or a well-known file extension, so `e.g.`, `github.com`
 * and `v1.2.3` stay text. Whether a match is offered as a link is still the
 * caller's resolver's call (inside the project or not).
 */

export interface PathRef {
  readonly path: string
  readonly line?: number
  readonly column?: number
}

export interface TextPiece {
  readonly text: string
  readonly ref?: PathRef
}

const KNOWN_EXTENSIONS = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc', 'md', 'mdx', 'css', 'scss', 'less', 'html',
  'yml', 'yaml', 'toml', 'ini', 'env', 'py', 'go', 'rs', 'java', 'kt', 'rb', 'php', 'sh', 'zsh', 'bash', 'txt', 'log',
  'lock', 'sql', 'prisma', 'graphql', 'gql', 'vue', 'svelte', 'astro', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'swift',
  'xml', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'csv', 'proto', 'dart', 'lua', 'ex', 'exs', 'erl', 'scala',
])

/**
 * A path, optionally `:line[:column]`. It may not start right after another
 * path character (so `https://x/a.js` never yields `x/a.js`), and the last
 * segment must carry a letter-led extension.
 */
const PATH_PATTERN = /(?<![\w@./:~\\-])((?:\.{1,2}\/)*\/?(?:[\w@+-][\w@.+-]*\/)*[\w@+-][\w@.+-]*\.[A-Za-z][A-Za-z0-9]{0,9})(?::(\d+)(?::(\d+))?)?(?![\w/])/g

/** Product names spelled like files (`node.js`); a bare one in prose is not a file. */
const PRODUCT_NAMES = /^(?:node|next|nuxt|vue|react|three|express|d3|chart|moment|ember|backbone|deno|bun|solid|alpine)\.js$/i

function isPathLike(candidate: string): boolean {
  if (candidate.includes('/')) return true
  if (PRODUCT_NAMES.test(candidate)) return false
  const extension = candidate.slice(candidate.lastIndexOf('.') + 1).toLowerCase()
  return KNOWN_EXTENSIONS.has(extension)
}

/** Split text into plain runs and path references, in order. */
export function findPathRefs(text: string): readonly TextPiece[] {
  const pieces: TextPiece[] = []
  let last = 0
  for (const match of text.matchAll(PATH_PATTERN)) {
    const path = match[1]!
    if (!isPathLike(path)) continue
    const start = match.index
    if (start > last) pieces.push({ text: text.slice(last, start) })
    const line = match[2] !== undefined ? Number(match[2]) : undefined
    const column = match[3] !== undefined ? Number(match[3]) : undefined
    pieces.push({
      text: match[0],
      ref: { path, ...(line !== undefined && line > 0 ? { line } : {}), ...(column !== undefined && column > 0 ? { column } : {}) },
    })
    last = start + match[0].length
  }
  if (last < text.length) pieces.push({ text: text.slice(last) })
  return pieces
}

/**
 * Where a command's relative paths live. `undefined`: the tool's own working
 * directory (the project root). A string: the absolute folder a leading
 * `cd <dir> &&` moved to. `null`: unknown (a relative or variable `cd`, or a
 * `cd` later in the chain) — only absolute paths can be trusted then.
 */
export function commandBase(command: string): string | null | undefined {
  const trimmed = command.trim()
  const lead = /^cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*(?:&&|;|\n)/.exec(trimmed)
  const rest = lead !== null ? trimmed.slice(lead[0].length) : trimmed
  if (/(?:^|[;&|\n(]\s*)(?:cd|pushd|popd)\b/.test(rest)) return null
  if (lead === null) return /^(?:cd|pushd)\b/.test(trimmed) ? null : undefined
  const dir = lead[1]!.replace(/^["']|["']$/g, '')
  if (!dir.startsWith('/') || dir.includes('$')) return null
  return dir.replace(/\/+$/, '')
}

/** A run of one line's visible text that renders as a file link. */
export interface LinkRange { readonly start: number; readonly end: number; readonly ref: PathRef }

/** Finds the link ranges in one line of visible text. */
export type LineLinker = (line: string) => readonly LinkRange[]

/** Every path-looking token in free text (a command's output), kept when `accept` returns a ref. */
export function freeTextLinker(accept: (ref: PathRef) => PathRef | null): LineLinker {
  return (line) => {
    const ranges: LinkRange[] = []
    let offset = 0
    for (const piece of findPathRefs(line)) {
      const ref = piece.ref !== undefined ? accept(piece.ref) : null
      if (ref !== null) ranges.push({ start: offset, end: offset + piece.text.length, ref })
      offset += piece.text.length
    }
    return ranges
  }
}

/** A tool's own note about itself (`… [search incomplete: …]`), never a path. */
const NOTE_LINE = /^… \[/

/**
 * Search output whose shape is known, so any file name counts — no extension
 * needed (`Makefile`, `LICENSE`): Glob prints one path per line, Grep prints
 * `path:line: text` and links the `path:line` head only.
 */
export function searchLinker(kind: 'glob' | 'grep', accept: (ref: PathRef) => PathRef | null): LineLinker {
  return (line) => {
    if (line.trim() === '' || NOTE_LINE.test(line) || line === 'no matches') return []
    if (kind === 'glob') {
      const ref = accept({ path: line.trim() })
      const start = line.length - line.trimStart().length
      return ref === null ? [] : [{ start, end: start + line.trim().length, ref }]
    }
    const match = /^(.+?):(\d+): /.exec(line)
    if (match === null) return []
    const ref = accept({ path: match[1]!, line: Number(match[2]) })
    return ref === null ? [] : [{ start: 0, end: match[1]!.length + 1 + match[2]!.length, ref }]
  }
}

/** A reference as the resolver should see it: relative paths re-rooted on the command's folder. */
export function rebase(ref: PathRef, base: string | null | undefined): PathRef | null {
  if (ref.path.startsWith('/')) return ref
  if (base === null) return null
  if (base === undefined) return ref
  return { ...ref, path: `${base}/${ref.path.replace(/^(?:\.\/)+/, '')}` }
}
