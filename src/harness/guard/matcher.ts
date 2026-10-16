import type { DangerousCommandsConfig, GuardMatch, PresetId } from './types.ts'
import { PRESET_REGEXES } from './presets.ts'
import { PRESET_LABELS } from './defaults.ts'
import { parseShell, splitExpansions } from './shell-parse.ts'
import { maskDataText } from './data-text.ts'

/**
 * `lineSeparator` replaces an unquoted line break. The default `' '` keeps
 * the historical form custom rules were written against; preset matching
 * passes `' ; '` because a newline ends a shell command, and a flag on the
 * next line must not be read as belonging to the previous command
 * (`rm -f a` ⏎ `ls -R` is not a recursive rm). Quoted line breaks stay `' '`.
 */
export function normalizeCommand(cmd: string, lineSeparator = ' '): string {
  let normalized = ''
  let inSingle = false
  let inDouble = false
  let lineHasContent = false

  const isEscaped = (index: number): boolean => {
    let backslashes = 0
    for (let i = index - 1; i >= 0 && cmd[i] === '\\'; i--) backslashes++
    return backslashes % 2 === 1
  }

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!
    const escaped = isEscaped(i)
    const nextIsNewline = cmd[i + 1] === '\n' || (cmd[i + 1] === '\r' && cmd[i + 2] === '\n')

    if (c === '\\' && nextIsNewline && !inSingle && !inDouble) {
      i += cmd[i + 1] === '\r' ? 2 : 1
      continue
    }

    const startsComment =
      c === '#' &&
      !escaped &&
      !inSingle &&
      !inDouble &&
      (!lineHasContent || (i > 0 && /\s/.test(cmd[i - 1]!)))

    if (startsComment) {
      while (i + 1 < cmd.length && cmd[i + 1] !== '\n' && cmd[i + 1] !== '\r') i++
      continue
    }

    if (c === '\n' || c === '\r') {
      if (c === '\r' && cmd[i + 1] === '\n') i++
      normalized += inSingle || inDouble ? ' ' : lineSeparator
      lineHasContent = false
      continue
    }

    // Outside quotes a backslash escapes the next byte, so \' is a literal
    // quote and must not open a single-quoted region; inside single quotes
    // backslashes are literal, so a closing ' always closes.
    if (c === "'" && !inDouble && (inSingle || !escaped)) inSingle = !inSingle
    if (c === '"' && !escaped && !inSingle) inDouble = !inDouble
    normalized += c
    if (!/\s/.test(c)) lineHasContent = true
  }

  const collapsed = normalized.trim().replace(/\s+/g, ' ')
  // Blank or comment-only lines must not leave empty `; ;` runs or edges.
  return lineSeparator === ' ' ? collapsed : collapsed.replace(/(?:\s*;\s*)+$/, '').replace(/^(?:\s*;\s*)+/, '').replace(/(?:\s;){2,}/g, ' ;')
}

/**
 * `git rm` is not the filesystem `rm`: per simple command (split on `;`,
 * `&&`, `||`, `|`, `&`), `git [-C dir …] rm --cached …` only untracks and is
 * dropped from preset matching; any other `git rm` deletes working-tree
 * files and its verb is rewritten to the single word `gitrm` (no `-`, which
 * would still be a `\b` boundary) so fsDestructive's `\brm\b` does not match
 * it while gitDestructive's `\bgitrm\b` rule (ask) does. Only the git
 * segment itself is touched — a real `rm` chained after it is still seen.
 */
function classifyGitRm(commands: string): string {
  return commands
    .split(/(\s*(?:;|&&|\|\||\||&)\s*)/)
    .map((segment) => {
      const git = /^(\s*(?:sudo\s+)?git(?:\s+-[Cc]\s+[^\s-]\S*|\s+--?[a-z][\w-]*(?:=\S+)?)*\s+)rm\b(.*)$/i.exec(segment)
      if (git === null) return segment
      // A substitution would run its own command; never exempt that text.
      if (/[`]|\$\(|[<>]\(/.test(segment)) return segment
      const args = (git[2] ?? '').trim().split(/\s+/)
      const optionEnd = args.indexOf('--')
      const options = optionEnd === -1 ? args : args.slice(0, optionEnd)
      if (options.some((token) => token.toLowerCase() === '--cached')) return ''
      return `${git[1]}gitrm${git[2]}`
    })
    .join('')
}

/** `./tmp/` → `tmp`; `/tmp/` → `/tmp`. Empty means "no usable prefix". */
export function normalizeExceptionPrefix(prefix: string): string {
  let value = prefix.trim()
  while (value.startsWith('./')) value = value.slice(2)
  while (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1)
  return value === '.' ? '' : value
}

/** Git subcommands whose next word is a verb, not an operand. */
const GIT_NESTED = new Set(['worktree', 'stash', 'remote', 'submodule'])

/** The path-like operands of one simple command, or undefined when unknowable. */
function commandOperands(segment: string): string[] | undefined {
  const parsed = parseShell(segment)
  if (parsed.unsupported || parsed.commands.length !== 1) return undefined
  const [command] = parsed.commands
  if (command === undefined || command.assignments.length > 0) return undefined
  const [program, ...args] = command.words
  if (program === undefined) return undefined
  // A changed working directory makes relative operands mean something else.
  if (args.some((word) => word.value === '-C' || word.value.startsWith('--git-dir') || word.value.startsWith('--work-tree'))) return undefined
  // `find`: the paths come before the expression; option values (`-name x`)
  // are not paths.
  const firstExpression = program.value === 'find'
    ? args.findIndex((word) => word.value.startsWith('-') || word.value === '(' || word.value === '!')
    : -1
  // A find payload (`-exec rm -rf src {} +`) runs on its own operands.
  if (program.value === 'find' && args.some((word) => ['-exec', '-execdir', '-ok', '-okdir'].includes(word.value))) return undefined
  const pathWords = firstExpression === -1 ? args : args.slice(0, firstExpression)
  let operands = pathWords.filter((word) => !word.value.startsWith('-') || word.value === '-')
  // A glob or brace word can expand to anything (`tmp/{../src,x}`), like `$`.
  if (operands.some((word) => word.expands || word.glob)) return undefined
  if (program.value === 'git') {
    const skip = operands[0] !== undefined && GIT_NESTED.has(operands[0].value) ? 2 : 1
    operands = operands.slice(skip)
  }
  return operands.map((word) => word.value)
}

function underPrefix(operand: string, prefixes: readonly string[]): boolean {
  let value = operand
  while (value.startsWith('./')) value = value.slice(2)
  if (value === '' || /(^|\/)\.\.(\/|$)/.test(value)) return false
  return prefixes.some((prefix) => value === prefix || value.startsWith(`${prefix}/`))
}

/**
 * True when a preset match should be skipped because every simple command
 * the preset matches targets only paths under an allowed prefix. Fails
 * closed: a match that spans commands (`curl … | sh`), an unparsable
 * command, an expansion, a `cd` anywhere in the line, or a command without
 * operands keeps the match.
 */
function exemptByPaths(commands: string, regexes: readonly RegExp[], rawPrefixes: readonly string[] | undefined): boolean {
  const prefixes = (rawPrefixes ?? []).map(normalizeExceptionPrefix).filter((prefix) => prefix !== '')
  if (prefixes.length === 0) return false
  const segments = commands.split(/\s*(?:;|&&|\|\||\||&)\s*/).filter((segment) => segment.trim() !== '')
  if (segments.some((segment) => /^(?:cd|pushd|popd)\b/.test(segment.trim()))) return false
  const hits = segments.filter((segment) => regexes.some((rx) => rx.test(segment)))
  if (hits.length === 0) return false
  return hits.every((segment) => {
    const operands = commandOperands(segment)
    return operands !== undefined && operands.length > 0 && operands.every((operand) => underPrefix(operand, prefixes))
  })
}

const PRESET_PRIORITY: PresetId[] = [
  'fsDestructive',
  'networkExfil',
  'resourceExhaust',
  'gitDestructive',
  'systemPriv',
  'dbDestructive',
]

export function matchCommand(command: string, config: DangerousCommandsConfig): GuardMatch | null {
  const normalized = normalizeCommand(command)
  // `rm${IFS}-rf` / `rm$' '-rf` / `{rm,-rf,x}` run `rm -rf`: also test the
  // text with expansions turned into word breaks (never for `allow` rules,
  // which must not be manufactured by this over-approximation). Over the
  // expansion bound the split text is unknown: tested as the plain text, and
  // the command asks below if nothing else matches.
  const rawSplit = splitExpansions(command)
  const split = rawSplit === undefined ? normalized : normalizeCommand(rawSplit)

  for (const rule of config.customRules) {
    const texts = rule.action === 'allow' || split === normalized ? [normalized] : [normalized, split]
    let hit = false
    if (rule.isRegex) {
      try {
        const rx = new RegExp(rule.pattern, 'i')
        hit = texts.some((text) => rx.test(text))
      } catch {
        hit = false
      }
    } else {
      hit = texts.some((text) => text.toLowerCase().includes(rule.pattern.toLowerCase()))
    }
    if (hit) {
      return {
        ruleId: rule.id,
        action: rule.action,
        reason: `matched custom rule "${rule.pattern}"`,
        pattern: rule.pattern,
      }
    }
  }

  // Presets see line breaks as command separators (custom rules keep the
  // historical single-space form they were authored against), and skip text
  // that is only data: commit messages and heredocs fed to `cat`/`git`/`gh`.
  const commands = classifyGitRm(normalizeCommand(maskDataText(command), ' ; '))
  const maskedSplit = splitExpansions(maskDataText(command))
  const splitCommands = maskedSplit === undefined ? commands : classifyGitRm(normalizeCommand(maskedSplit, ' ; '))
  const unknown = rawSplit === undefined || maskedSplit === undefined
  for (const id of PRESET_PRIORITY) {
    if (config.presets[id] === 'off') continue
    const regexes = PRESET_REGEXES[id]
    const matched = regexes.find((rx) => rx.test(commands) || rx.test(splitCommands))
    // Exempt only when both spellings are exempt: a command visible only in
    // the split text has no hit in `commands`, so it keeps the match.
    const exempt = matched !== undefined && !unknown && exemptByPaths(commands, regexes, config.exceptions?.[id])
      && (splitCommands === commands || exemptByPaths(splitCommands, regexes, config.exceptions?.[id]))
    if (matched && !exempt) {
      return {
        presetId: id,
        action: config.presets[id],
        reason: `matched ${PRESET_LABELS[id].name}`,
        pattern: matched.source,
      }
    }
  }

  if (unknown) {
    return { ruleId: 'unanalyzable-expansion', action: 'ask', reason: 'brace expansion too large to analyze', pattern: '' }
  }
  return null
}
