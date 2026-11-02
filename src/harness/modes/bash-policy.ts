/**
 * The Bash-specific mode properties, shared by the web host and the
 * headless bin so both gates read them the same way.
 */
import { isReadOnlyBashCommand } from '../guard/bash-readonly.ts'
import { matchRiskyCommand, type RiskyMatch } from '../guard/bash-risky.ts'
import type { ToolCall } from '../llm/types.ts'
import type { DangerousCommandsConfig } from '../guard/types.ts'
import type { ModeDefinition } from './types.ts'

type BashModeFields = Pick<Partial<ModeDefinition>, 'readOnlyBash' | 'riskyBash'>

function bashCommand(call: ToolCall): string | undefined {
  if (call.name !== 'Bash') return undefined
  const command = (call.args as Record<string, unknown>)['command']
  return typeof command === 'string' ? command : undefined
}

/** True when the mode lets this Bash call skip a policy `ask` (read-only, contained). */
export function liftsReadOnlyBash(mode: BashModeFields, call: ToolCall): boolean {
  if (mode.readOnlyBash !== 'allow') return false
  const command = bashCommand(call)
  return command !== undefined && isReadOnlyBashCommand(command)
}

/** The risky match that needs a per-call approval in this mode, if any. */
export function riskyBashMatch(mode: BashModeFields, call: ToolCall): RiskyMatch | null {
  if (mode.riskyBash !== 'ask') return null
  const command = bashCommand(call)
  return command === undefined ? null : matchRiskyCommand(command)
}

/** Approval-card text for a risky match. */
export function riskyBashWarning(match: RiskyMatch): string {
  return `Risky command: ${match.label} — this mode asks before each one`
}

/**
 * The Dangerous Commands config one call runs under: a mode with
 * `dangerousPresets: off` switches every built-in preset off and keeps the
 * user's custom rules. The hash changes with it, so an approval bound to the
 * full config is never reused under the narrowed one or the reverse.
 */
export function modeGuardConfig(
  mode: Pick<Partial<ModeDefinition>, 'dangerousPresets'>,
  config: DangerousCommandsConfig,
  hash: string,
): { readonly config: DangerousCommandsConfig; readonly hash: string; readonly revision: string } {
  if (mode.dangerousPresets !== 'off') return { config, hash, revision: hash }
  const presets = Object.fromEntries(Object.keys(config.presets).map((id) => [id, 'off'])) as DangerousCommandsConfig['presets']
  const narrowed = `${hash}:presets-off`
  return { config: { ...config, presets }, hash: narrowed, revision: narrowed }
}
