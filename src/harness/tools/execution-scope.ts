import { AsyncLocalStorage } from 'node:async_hooks'
import type { ToolExecution } from './types.ts'

/**
 * The execution context of the tool call currently passing through the
 * authorization chain. Rewrite listeners may forward only `{ call }`, and the
 * kernel hands later listeners exactly what was forwarded; per-call state
 * keyed by the host execution identity must not depend on every hook
 * remembering to forward `exec`.
 */
export const toolExecutionScope = new AsyncLocalStorage<ToolExecution>()

/** The payload's execution, else the one the pipeline is currently gating. */
export function currentToolExecution(exec: ToolExecution | undefined): ToolExecution | undefined {
  return exec ?? toolExecutionScope.getStore()
}
