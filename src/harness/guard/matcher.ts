import type { DangerousCommandsConfig, GuardMatch, PresetId } from './types.ts'
import { PRESET_REGEXES } from './presets.ts'
import { PRESET_LABELS } from './defaults.ts'

export function normalizeCommand(cmd: string): string {
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
      normalized += ' '
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

  return normalized.trim().replace(/\s+/g, ' ')
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

  for (const id of PRESET_PRIORITY) {
    if (config.presets[id] === 'off') continue
    const regexes = PRESET_REGEXES[id]
    const matched = regexes.find((rx) => rx.test(normalized))
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
