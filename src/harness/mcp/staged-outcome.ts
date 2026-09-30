/**
 * Side channel from an MCP tool body to the tool pipeline. The tool contract
 * still returns a string so non-MCP tools and direct callers stay unchanged.
 * The pipeline attaches the staged outcome to the durable tool result.
 */
import type { ExecutionId } from '../../util/brand.ts'
import type { ToolOutcome } from '../tools/types.ts'

interface Staged {
  readonly outcome: ToolOutcome
  readonly invocationId: string
  readonly ok: boolean
}

const staged = new Map<ExecutionId, Staged>()

export function stageMcpOutcome(executionId: ExecutionId, value: Staged): void {
  staged.set(executionId, value)
}

export function takeMcpOutcome(executionId: ExecutionId): Staged | undefined {
  const value = staged.get(executionId)
  if (value !== undefined) staged.delete(executionId)
  return value
}
