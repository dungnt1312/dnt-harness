import type { DangerousCommandsConfig, GuardMatch, PresetId } from './types.ts'
import { PRESET_REGEXES } from './presets.ts'
import { PRESET_LABELS } from './defaults.ts'

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
      const git = /^(\s*(?:sudo\s+)?git(?:\s+-[Cc]\s+\S+|\s+--?[a-z][\w-]*(?:=\S+)?)*\s+)rm\b(.*)$/i.exec(segment)
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

  for (const rule of config.customRules) {
    let hit = false
    if (rule.isRegex) {
      try {
        hit = new RegExp(rule.pattern, 'i').test(normalized)
      } catch {
        hit = false
      }
    } else {
      hit = normalized.toLowerCase().includes(rule.pattern.toLowerCase())
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
  // historical single-space form they were authored against).
  const commands = classifyGitRm(normalizeCommand(command, ' ; '))
  for (const id of PRESET_PRIORITY) {
    if (config.presets[id] === 'off') continue
    const regexes = PRESET_REGEXES[id]
    const matched = regexes.find((rx) => rx.test(commands))
    if (matched) {
      return {
        presetId: id,
        action: config.presets[id],
        reason: `matched ${PRESET_LABELS[id].name}`,
        pattern: matched.source,
      }
    }
  }

  return null
}
