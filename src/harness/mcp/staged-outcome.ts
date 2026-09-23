/**
 * Side channel from an MCP tool body to the tool pipeline. The tool contract
 * still returns a string so non-MCP tools and direct callers stay unchanged.
 * The pipeline attaches the staged outcome to the durable tool result.
 */
import type { ToolOutcome } from '../tools/types.ts'

interface Staged {
  readonly outcome: ToolOutcome
  readonly invocationId: string
  readonly ok: boolean
}

const staged = new Map<string, Staged>()

export function stageMcpOutcome(invocationId: string, value: Staged): void {
  staged.set(invocationId, value)
}

export function takeMcpOutcome(invocationId: string): Staged | undefined {
  const value = staged.get(invocationId)
  if (value !== undefined) staged.delete(invocationId)
  return value
}
