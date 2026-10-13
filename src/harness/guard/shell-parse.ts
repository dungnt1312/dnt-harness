/**
 * A small POSIX-shell word splitter for command classification. It is NOT a
 * shell: anything it cannot reason about statically — command or process
 * substitution, backticks, subshells/groups, background `&`, heredocs,
 * unterminated quotes — marks the whole parse `unsupported`, and callers treat
 * that as "unknown", never as "safe".
 *
 * Simple commands are split on `;`, `&&`, `||`, `|`, `|&` and line breaks.
 * Each word records whether its unquoted text can still expand at run time
 * (`$…` parameter expansion → `expands`; unquoted glob or brace characters →
 * `glob`), because such a word's real value is not the text we see.
 */
export interface ShellWord {
  /** The word after quote removal. */
  readonly value: string
  /** Contains a `$` expansion (unquoted or inside double quotes). */
  readonly expands: boolean
  /** Contains an unquoted glob or brace character (`*`, `?`, `[`, `{`, `}`). */
  readonly glob: boolean
}

export interface ShellRedirect {
  /** Operator including any fd prefix: `>`, `2>`, `>>`, `&>`, `2>&`, `<`, … */
  readonly op: string
  readonly target: ShellWord
}

export interface ShellCommand {
  /** Leading `NAME=value` assignments. */
  readonly assignments: readonly string[]
  readonly words: readonly ShellWord[]
  readonly redirects: readonly ShellRedirect[]
}

export interface ShellParse {
  readonly commands: readonly ShellCommand[]
  readonly unsupported: boolean
}

/** Longer inputs are not classified at all. */
const MAX_LENGTH = 10_000

export function parseShell(source: string): ShellParse {
  if (source.length > MAX_LENGTH) return { commands: [], unsupported: true }
  const commands: ShellCommand[] = []
  let assignments: string[] = []
  let words: ShellWord[] = []
  let redirects: ShellRedirect[] = []
  let buf = ''
  let inWord = false
  let quoted = false
  let expands = false
  let glob = false
  /** The unquoted prefix of the current word (for assignment detection). */
  let bare = ''
  let pendingRedirect: string | undefined
  let unsupported = false

  const endWord = (): void => {
    if (!inWord) return
    const word: ShellWord = { value: buf, expands, glob }
    if (!quoted && (buf === '{' || buf === '}')) unsupported = true
    if (pendingRedirect !== undefined) {
      redirects.push({ op: pendingRedirect, target: word })
      pendingRedirect = undefined
    } else if (words.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(bare)) {
      assignments.push(buf)
    } else {
      words.push(word)
    }
    buf = ''
    bare = ''
    inWord = false
    quoted = false
    expands = false
    glob = false
  }
  const endCommand = (): void => {
    endWord()
    if (pendingRedirect !== undefined) unsupported = true
    pendingRedirect = undefined
    if (assignments.length > 0 || words.length > 0 || redirects.length > 0) commands.push({ assignments, words, redirects })
    assignments = []
    words = []
    redirects = []
  }
  const add = (text: string, isQuoted: boolean): void => {
    buf += text
    if (!isQuoted && !quoted) bare += text
    inWord = true
  }

  for (let i = 0; i < source.length && !unsupported; i++) {
    const c = source[i]!
    const next = source[i + 1]
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord()
    } else if (c === '\n') {
      endCommand()
    } else if (c === '#' && !inWord) {
      while (i + 1 < source.length && source[i + 1] !== '\n') i++
    } else if (c === '\\') {
      if (next === '\n') { i++; continue }
      if (next === undefined) { unsupported = true; break }
      add(next, true)
      quoted = true
      i++
    } else if (c === "'") {
      const close = source.indexOf("'", i + 1)
      if (close === -1) { unsupported = true; break }
      add(source.slice(i + 1, close), true)
      quoted = true
      i = close
    } else if (c === '"') {
      let j = i + 1
      let text = ''
      for (; j < source.length; j++) {
        const d = source[j]!
        if (d === '"') break
        if (d === '\\' && j + 1 < source.length && '$`"\\\n'.includes(source[j + 1]!)) {
          if (source[j + 1] !== '\n') text += source[j + 1]
          j++
          continue
        }
        if (d === '`') { unsupported = true; break }
        if (d === '$') {
          if (source[j + 1] === '(') { unsupported = true; break }
          expands = true
        }
        text += d
      }
      if (unsupported) break
      if (j >= source.length) { unsupported = true; break }
      add(text, true)
      quoted = true
      i = j
    } else if (c === '`') {
      unsupported = true
    } else if (c === '$') {
      if (next === '(') { unsupported = true; break }
      expands = true
      add(c, false)
    } else if (c === ';') {
      endCommand()
    } else if (c === '&') {
      if (next === '&') { endCommand(); i++ }
      else if (next === '>') {
        endWord()
        if (source[i + 2] === '>') { pendingRedirect = '&>>'; i += 2 } else { pendingRedirect = '&>'; i++ }
      } else unsupported = true
    } else if (c === '|') {
      endCommand()
      if (next === '|' || next === '&') i++
    } else if (c === '(' || c === ')') {
      unsupported = true
    } else if (c === '<' || c === '>') {
      let fd = ''
      if (inWord && !quoted && /^\d+$/.test(buf)) {
        fd = buf
        buf = ''
        bare = ''
        inWord = false
      } else {
        endWord()
      }
      if (pendingRedirect !== undefined) { unsupported = true; break }
      let op: string
      if (c === '<') {
        if (next === '<' || next === '(') { unsupported = true; break }
        if (next === '>') { op = '<>'; i++ } else if (next === '&') { op = '<&'; i++ } else op = '<'
      } else {
        if (next === '(') { unsupported = true; break }
        if (next === '>') { op = '>>'; i++ } else if (next === '|') { op = '>|'; i++ } else if (next === '&') { op = '>&'; i++ } else op = '>'
      }
      pendingRedirect = `${fd}${op}`
    } else {
      if (c === '*' || c === '?' || c === '[' || c === '{' || c === '}') glob = true
      add(c, false)
    }
  }
  if (!unsupported) endCommand()
  return { commands: unsupported ? [] : commands, unsupported }
}
