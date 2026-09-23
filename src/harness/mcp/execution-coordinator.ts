/**
 * One automatic `tools/call` per invocation. The intent is synced before the
 * transport is asked to send. Anything that might already have left the
 * process becomes `indeterminate` and is not sent again.
 */
import { promises as fs } from 'node:fs'
import { McpDispatchError } from './boundaries.ts'
import { digestText, McpExecutionJournal, type DispatchIntent } from './execution-journal.ts'
import type { ToolOutcome } from '../tools/types.ts'

export interface CoordinatorCall {
  readonly text: string
  readonly isError: boolean
}

export interface DispatchInput {
  readonly journal: McpExecutionJournal
  readonly intent: Omit<DispatchIntent, 'kind'>
  readonly call: () => Promise<CoordinatorCall>
}

export interface DispatchOutput {
  readonly outcome: ToolOutcome
  readonly output: string
  readonly invocationId: string
}

export class AuditFaultBlock extends Error {
  constructor() {
    super('MCP dispatch is blocked until the audit fault is repaired')
    this.name = 'AuditFaultBlock'
  }
}

export async function dispatchToolCall(input: DispatchInput, auditFaultFile: string): Promise<DispatchOutput> {
  if (await faultIsOpen(auditFaultFile)) throw new AuditFaultBlock()
  const existing = input.journal.hasTerminal(input.intent.invocationId)
  if (existing !== undefined) {
    return {
      outcome: existing.outcome,
      output: existing.detail,
      invocationId: input.intent.invocationId,
    }
  }
  try {
    await input.journal.appendIntent({ kind: 'dispatch_intent', ...input.intent })
  } catch (error) {
    return {
      outcome: 'error',
      output: `MCP call was not sent: ${error instanceof Error ? error.message : String(error)}`,
      invocationId: input.intent.invocationId,
    }
  }
  let call: CoordinatorCall
  try {
    call = await input.call()
  } catch (error) {
    const notSent = error instanceof McpDispatchError && error.receipt.kind === 'not_dispatched'
    const outcome: ToolOutcome = notSent ? 'error' : 'indeterminate'
    const detail = error instanceof Error ? error.message : String(error)
    await finish(input, auditFaultFile, outcome, detail)
    return { outcome, output: detail, invocationId: input.intent.invocationId }
  }
  const outcome: ToolOutcome = call.isError ? 'error' : 'success'
  const persisted = await finish(input, auditFaultFile, outcome, call.text)
  if (!persisted) {
    return {
      outcome: 'audit_fault',
      output: `${call.text}\n\nThe remote outcome is known, but its execution record could not be stored. Further MCP calls are blocked until that record is repaired.`,
      invocationId: input.intent.invocationId,
    }
  }
  return { outcome, output: call.text, invocationId: input.intent.invocationId }
}

async function finish(input: DispatchInput, auditFaultFile: string, outcome: ToolOutcome, detail: string): Promise<boolean> {
  try {
    await input.journal.appendTerminal({
      kind: 'terminal',
      invocationId: input.intent.invocationId,
      outcome,
      outputHash: digestText(detail),
      detail: detail.slice(0, 500),
    })
    return true
  } catch (error) {
    await fs.mkdir(pathDir(auditFaultFile), { recursive: true }).catch(() => undefined)
    await fs.writeFile(auditFaultFile, JSON.stringify({
      invocationId: input.intent.invocationId,
      outcome,
      message: error instanceof Error ? error.message : String(error),
    }), 'utf8').catch(() => undefined)
    return false
  }
}

export async function faultIsOpen(file: string): Promise<boolean> {
  try {
    await fs.stat(file)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    return true
  }
}

export async function clearAuditFault(file: string): Promise<void> {
  await fs.rm(file, { force: true })
}

function pathDir(file: string): string {
  const index = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
  return index === -1 ? '.' : file.slice(0, index)
}
