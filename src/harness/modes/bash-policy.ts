/**
 * The two Bash-specific mode properties, shared by the web host and the
 * headless bin so both gates read them the same way.
 */
import { isReadOnlyBashCommand } from '../guard/bash-readonly.ts'
import { matchRiskyCommand, type RiskyMatch } from '../guard/bash-risky.ts'
import type { ToolCall } from '../llm/types.ts'
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
