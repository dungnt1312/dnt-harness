/**
 * Mask text a command only carries as data, so destructive-command
 * matching does not fire on prose: a commit message that mentions
 * `git branch -D`, or a PR body fed through a heredoc.
 *
 * Two shapes, both fail-closed:
 * - Heredoc bodies whose consumer is a known data program (`cat`, `tee`,
 *   `git`, `gh`, …) are dropped together with their `<<DELIM` operator. A
 *   heredoc fed to anything else (`bash`, `python`, `ssh`, unknown), or on a
 *   line that also pipes (`cat <<EOF | sh`), is kept verbatim. An
 *   unterminated heredoc leaves the whole command unchanged.
 * - Quoted message values: `git commit|tag|notes|merge|revert|stash … -m/--message`
 *   and `gh … --title/--body/--notes`. Single-quoted text is always literal;
 *   double-quoted text is masked only when it holds no `$(` or backtick,
 *   which would execute.
 *
 * Everything else, including quoted arguments of other programs, is left
 * as written.
 */

const DATA_CONSUMERS = new Set(['cat', 'tee', 'git', 'gh', 'glab', 'wc', 'head', 'tail', 'sort', 'uniq', 'grep', 'jq'])
const WRAPPERS = new Set(['sudo', 'env', 'command', 'nohup', 'time', 'nice'])
const GIT_MESSAGE_SUBCOMMANDS = new Set(['commit', 'tag', 'notes', 'merge', 'revert', 'stash'])
const GH_TEXT_FLAGS = new Set(['--title', '-t', '--body', '-b', '--notes'])
const PLACEHOLDER = 'MSG'

/** The program a simple command runs, skipping assignments and wrappers. */
function programOf(words: readonly string[]): { program: string | undefined; rest: readonly string[] } {
  let i = 0
  while (i < words.length) {
    const word = words[i]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || word.startsWith('-')) { i++; continue }
    if (WRAPPERS.has(word)) { i++; continue }
    break
  }
  const program = words[i]?.split('/').pop()
  return { program, rest: words.slice(i + 1) }
}

/** `git [-C dir] [-c k=v] <sub> …` → `<sub>`. */
function gitSubcommand(rest: readonly string[]): string | undefined {
  let i = 0
  while (i < rest.length && rest[i]!.startsWith('-')) i += ['-C', '-c', '--git-dir', '--work-tree'].includes(rest[i]!) ? 2 : 1
  return rest[i]
}

function heredocKeeps(prefixWords: readonly string[], restOfLine: string): boolean {
  const { program } = programOf(prefixWords)
  return program === undefined || !DATA_CONSUMERS.has(program) || /[|`]|\$\(/.test(restOfLine)
}

/** Unquoted words of `text` (rough split; quotes removed). */
function roughWords(text: string): string[] {
  return text.replace(/(["'])(?:\\.|(?!\1).)*\1/g, 'Q').trim().split(/\s+/).filter((word) => word !== '')
}

function stripDataHeredocs(command: string): string {
  if (!command.includes('<<')) return command
  const lines = command.split('\n')
  const out: string[] = []
  const pending: { delim: string; tabs: boolean; keep: boolean }[] = []
  for (const raw of lines) {
    const current = pending[0]
    if (current !== undefined) {
      const line = raw.replace(/\r$/, '')
      const compared = current.tabs ? line.replace(/^\t+/, '') : line
      if (compared === current.delim) {
        pending.shift()
        if (current.keep) out.push(raw)
        continue
      }
      if (current.keep) out.push(raw)
      continue
    }
    let line = raw
    let inSingle = false
    let inDouble = false
    let segmentStart = 0
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!
      if (c === '\\' && !inSingle) { i++; continue }
      if (c === "'" && !inDouble) { inSingle = !inSingle; continue }
      if (c === '"' && !inSingle) { inDouble = !inDouble; continue }
      if (inSingle || inDouble) continue
      if (';|&()'.includes(c)) { segmentStart = i + 1; continue }
      if (c !== '<' || line[i + 1] !== '<' || line[i + 2] === '<') continue
      const op = /^<<(-?)[ \t]*(?:(['"])([^'"\s]+)\2|\\?([^\s'"<>|;&()]+))/.exec(line.slice(i))
      if (op === null) continue
      const delim = op[3] ?? op[4] ?? ''
      const end = i + op[0].length
      const keep = heredocKeeps(roughWords(line.slice(segmentStart, i)), line.slice(end))
      pending.push({ delim, tabs: op[1] === '-', keep })
      if (!keep) {
        line = `${line.slice(0, i)}${line.slice(end)}`
        i -= 1
      } else {
        i = end - 1
      }
    }
    out.push(line)
  }
  // An unterminated heredoc that we would have dropped: classify as written.
  if (pending.some((entry) => !entry.keep)) return command
  return out.join('\n')
}

function maskMessageArgs(command: string): string {
  let out = ''
  let words: string[] = []
  let token = ''
  const pushToken = (): void => {
    if (token !== '') words.push(token)
    token = ''
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (c === '\\') {
      out += c + (command[i + 1] ?? '')
      token += command[i + 1] ?? ''
      i++
      continue
    }
    if (c === "'" || c === '"') {
      let j = i + 1
      while (j < command.length && command[j] !== c) j += c === '"' && command[j] === '\\' ? 2 : 1
      if (j >= command.length) {
        // Unterminated quote: leave the rest untouched.
        return out + command.slice(i)
      }
      const content = command.slice(i + 1, j)
      const executes = c === '"' && /`|\$\(/.test(content)
      const all = [...words, ...(token !== '' ? [token] : [])]
      const { program, rest } = programOf(all)
      const previous = token !== '' ? token : words[words.length - 1] ?? ''
      let isMessage = false
      if (program === 'git' && GIT_MESSAGE_SUBCOMMANDS.has(gitSubcommand(rest) ?? '')) {
        isMessage = token === '--message=' || /^-[a-zA-Z]*m$/.test(previous) || previous === '--message'
      } else if (program === 'gh') {
        isMessage = GH_TEXT_FLAGS.has(previous) || /^--(?:title|body|notes)=$/.test(token)
      }
      out += isMessage && !executes ? `${c}${PLACEHOLDER}${c}` : command.slice(i, j + 1)
      token += PLACEHOLDER
      i = j
      continue
    }
    out += c
    if (c === ' ' || c === '\t') { pushToken(); continue }
    if (';|&()\n'.includes(c)) { pushToken(); words = []; continue }
    token += c
  }
  return out
}

/** The command with data-only text masked (see module comment). */
export function maskDataText(command: string): string {
  return maskMessageArgs(stripDataHeredocs(command))
}
