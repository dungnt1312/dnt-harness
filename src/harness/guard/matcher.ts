import type { DangerousCommandsConfig, GuardMatch, PresetId } from './types.ts'
import { PRESET_REGEXES } from './presets.ts'
import { PRESET_LABELS } from './defaults.ts'

export function normalizeCommand(cmd: string): string {
  let s = cmd.trim().replace(/\s+/g, ' ')
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === "'" && !inDouble) inSingle = !inSingle
    if (c === '"' && !inSingle) inDouble = !inDouble
    if (c === '#' && !inSingle && !inDouble && i > 0 && s[i - 1] === ' ') {
      s = s.slice(0, i).trimEnd()
      break
    }
  }
  return s
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
