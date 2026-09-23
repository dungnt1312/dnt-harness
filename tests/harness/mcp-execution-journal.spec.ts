import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AuditFaultBlock, McpDispatchError, McpExecutionJournal, clearAuditFault, dispatchToolCall, faultIsOpen, receiptForTransportFailure } from 'mini-dsh'

describe('mcp execution journal', () => {
  it('records one intent and does not dispatch an unresolved invocation again', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-journal-'))
    const file = path.join(home, 'executions.jsonl')
    const fault = path.join(home, 'audit-fault.json')
    try {
      const journal = new McpExecutionJournal(file)
      await journal.open()
      let calls = 0
      const first = await dispatchToolCall({
        journal,
        intent: intent('call-1'),
        call: async () => {
          calls += 1
          throw new McpDispatchError('response lost', receiptForTransportFailure(true, 'response_lost'))
        },
      }, fault)
      expect(first.outcome).toBe('indeterminate')
      expect(calls).toBe(1)
      const second = await dispatchToolCall({
        journal,
        intent: intent('call-1'),
        call: async () => {
          calls += 1
          return { text: 'should not run', isError: false }
        },
      }, fault)
      expect(second.outcome).toBe('indeterminate')
      expect(calls).toBe(1)

      const reloaded = new McpExecutionJournal(file)
      const recovered = await reloaded.open()
      expect(recovered.unresolved).toEqual([])
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  it('blocks later dispatch when the known outcome cannot be stored', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-fault-'))
    const fault = path.join(home, 'audit-fault.json')
    const file = path.join(home, 'executions.jsonl')
    try {
      let writes = 0
      const journal = new McpExecutionJournal(file, async () => {
        writes += 1
        if (writes > 1) throw new Error('disk full')
      })
      await journal.open()
      const result = await dispatchToolCall({
        journal,
        intent: intent('call-2'),
        call: async () => ({ text: 'remote ok', isError: false }),
      }, fault)
      expect(result.outcome).toBe('audit_fault')
      expect(result.output).toContain('remote ok')
      await expect(faultIsOpen(fault)).resolves.toBe(true)
      const blocked = new McpExecutionJournal(path.join(home, 'later.jsonl'))
      await blocked.open()
      await expect(dispatchToolCall({
        journal: blocked,
        intent: intent('call-3'),
        call: async () => ({ text: 'no', isError: false }),
      }, fault)).rejects.toBeInstanceOf(AuditFaultBlock)
      await clearAuditFault(fault)
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })
})

function intent(invocationId: string) {
  return {
    invocationId,
    workspaceId: 'ws',
    server: 'fixture',
    tool: 'query',
    argsHash: 'abc',
    generation: 1,
    epoch: 1,
    configRevision: 1,
    secretRevision: 1,
  }
}

  it('fails closed on a corrupt middle record and does not send the call', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-corrupt-'))
    const file = path.join(home, 'executions.jsonl')
    const fault = path.join(home, 'audit-fault.json')
    try {
      await fs.writeFile(file, '{"v":1,"seq":1,"kind":"dispatch_intent","invocationId":"old","digest":"nope"}\n')
      const journal = new McpExecutionJournal(file)
      await expect(journal.open()).rejects.toThrow(/corrupt|digest|sequence/)
      let calls = 0
      const result = await dispatchToolCall({
        journal,
        intent: intent('call-4'),
        call: async () => {
          calls += 1
          return { text: 'sent', isError: false }
        },
      }, fault)
      expect(result.outcome).toBe('error')
      expect(result.output).toMatch(/not sent|corrupt|digest|sequence/)
      expect(calls).toBe(0)
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  it('closes an unresolved intent on restart without sending it', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-restart-'))
    const file = path.join(home, 'executions.jsonl')
    try {
      const journal = new McpExecutionJournal(file)
      await journal.open()
      await journal.appendIntent({ kind: 'dispatch_intent', ...intent('call-5') })
      const reloaded = new McpExecutionJournal(file)
      const recovered = await reloaded.open()
      expect(recovered.unresolved).toEqual(['call-5'])
      const closed = await reloaded.terminalizeUnresolved()
      expect(closed).toEqual(['call-5'])
      expect(reloaded.hasTerminal('call-5')?.outcome).toBe('indeterminate')
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })
