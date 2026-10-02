import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { AuditFaultBlock, McpDispatchError, McpExecutionJournal, McpServerClient, clearAuditFault, dispatchToolCall, faultIsOpen, receiptForTransportFailure } from 'dnt-harness'
import { DataHomeLock } from '../../src/harness/mcp/ownership-lock.ts'

const stdioFixture = fileURLToPath(new URL('../fixtures/mcp-stdio-server.mjs', import.meta.url))

describe('mcp execution journal', () => {
  it('records one intent and does not dispatch an unresolved invocation again', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-journal-'))
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
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-fault-'))
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

describe('lost response against a real MCP process', () => {
  it('one dispatch, one remote side effect, and no resend — in process or after a restart', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-lost-response-'))
    const file = path.join(home, 'executions.jsonl')
    const fault = path.join(home, 'audit-fault.json')
    const effects = path.join(home, 'side-effects.log')
    const env = { SIDE_EFFECT_FILE: effects }
    const client = new McpServerClient('fixture', {
      name: 'fixture', transport: 'stdio', command: process.execPath, args: [stdioFixture], env, enabled: true,
    }, { env }, () => {})
    try {
      const journal = new McpExecutionJournal(file)
      await journal.open()
      let sends = 0
      const call = async () => {
        sends += 1
        // `hang` performs its side effect and never answers: the response is lost.
        const result = await client.callTool('hang', {}, 400)
        return { text: JSON.stringify(result.content), isError: result.isError }
      }
      const lost = await dispatchToolCall({ journal, intent: intent('lost-1'), call }, fault)
      expect(lost.outcome).toBe('indeterminate')

      // The same invocation again, in this process: answered from the record.
      expect((await dispatchToolCall({ journal, intent: intent('lost-1'), call }, fault)).outcome).toBe('indeterminate')
      // And after a restart: the reopened journal still knows it was settled.
      const reopened = new McpExecutionJournal(file)
      expect((await reopened.open()).unresolved).toEqual([])
      expect((await dispatchToolCall({ journal: reopened, intent: intent('lost-1'), call }, fault)).outcome).toBe('indeterminate')

      expect(sends).toBe(1)
      expect((await fs.readFile(effects, 'utf8')).trim().split('\n')).toEqual(['hang'])
    } finally {
      await client.disconnect()
      await fs.rm(home, { recursive: true, force: true })
    }
  }, 20_000)
})

describe('journal faults fail closed', () => {
  it('a journal the host cannot write refuses to send, and a repaired file sends again', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-journal-perm-'))
    const file = path.join(home, 'executions.jsonl')
    const fault = path.join(home, 'audit-fault.json')
    try {
      await fs.writeFile(file, '')
      await fs.chmod(file, 0o444)
      const journal = new McpExecutionJournal(file)
      await journal.open()
      let calls = 0
      const call = async () => { calls += 1; return { text: 'sent', isError: false } }
      const refused = await dispatchToolCall({ journal, intent: intent('perm-1'), call }, fault)
      expect(refused.outcome).toBe('error')
      expect(refused.output).toMatch(/not sent/)
      expect(journal.faulted).toBe(true)
      // Still refused on the next call: nothing reaches the server unrecorded.
      expect((await dispatchToolCall({ journal, intent: intent('perm-2'), call }, fault)).outcome).toBe('error')
      expect(calls).toBe(0)

      // Operator recovery: fix the file, reopen the journal, and calls flow.
      await fs.chmod(file, 0o644)
      const reopened = new McpExecutionJournal(file)
      await reopened.open()
      expect((await dispatchToolCall({ journal: reopened, intent: intent('perm-3'), call }, fault)).outcome).toBe('success')
      expect(calls).toBe(1)
    } finally {
      await fs.chmod(file, 0o644).catch(() => undefined)
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  it('a terminal record the host cannot write is an audit fault that blocks the next dispatch', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-journal-perm-'))
    const file = path.join(home, 'executions.jsonl')
    const fault = path.join(home, 'audit-fault.json')
    try {
      const journal = new McpExecutionJournal(file)
      await journal.open()
      let calls = 0
      const result = await dispatchToolCall({
        journal,
        intent: intent('perm-4'),
        // The remote call succeeds, then the disk refuses the terminal record.
        call: async () => { calls += 1; await fs.chmod(file, 0o444); return { text: 'remote ok', isError: false } },
      }, fault)
      expect(result.outcome).toBe('audit_fault')
      expect(calls).toBe(1)
      await expect(faultIsOpen(fault)).resolves.toBe(true)
      await expect(dispatchToolCall({ journal, intent: intent('perm-5'), call: async () => { calls += 1; return { text: 'no', isError: false } } }, fault))
        .rejects.toBeInstanceOf(AuditFaultBlock)
      expect(calls).toBe(1)
    } finally {
      await fs.chmod(file, 0o644).catch(() => undefined)
      await clearAuditFault(fault)
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  it('an intent is only written under the live ownership epoch; a fenced host sends nothing', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-journal-epoch-'))
    const file = path.join(home, 'executions.jsonl')
    const fault = path.join(home, 'audit-fault.json')
    try {
      const first = await DataHomeLock.acquire(home, { leaseMs: 60_000 })
      const journal = new McpExecutionJournal(file, () => first.assertHeld())
      await journal.open()
      let calls = 0
      const call = async () => { calls += 1; return { text: 'sent', isError: false } }
      expect((await dispatchToolCall({ journal, intent: { ...intent('epoch-1'), epoch: first.epoch }, call }, fault)).outcome).toBe('success')

      // The first host stalls; a second one takes the data home over.
      await first.abandon()
      const second = await DataHomeLock.acquire(home, { isAlive: () => false })
      expect(second.epoch).toBeGreaterThan(first.epoch)
      const fenced = await dispatchToolCall({ journal, intent: { ...intent('epoch-2'), epoch: first.epoch }, call }, fault)
      expect(fenced.outcome).toBe('error')
      expect(fenced.output).toMatch(/not sent/)
      expect(calls).toBe(1)

      // Every intent on disk carries the epoch that was live when it was written.
      const intents = (await fs.readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { kind: string; epoch?: number })
        .filter((record) => record.kind === 'dispatch_intent')
      expect(intents.map((record) => record.epoch)).toEqual([first.epoch])
      await second.release()
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
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-corrupt-'))
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
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-restart-'))
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
