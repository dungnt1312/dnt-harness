/**
 * Atomic per-execution reservation: one host execution id dispatches at most
 * once, a mismatched intent under a reused id is an integrity error, and a
 * terminal record never masquerades as the full result after a restart.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { McpExecutionJournal, dispatchToolCall } from 'mini-dsh'

let home = ''
let file = ''
let fault = ''

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-reservation-'))
  file = path.join(home, 'executions.jsonl')
  fault = path.join(home, 'audit-fault.json')
})

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true })
})

function intent(invocationId: string, overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  }
}

describe('atomic MCP execution reservation', () => {
  it('two concurrent callers with the same execution id dispatch exactly once', async () => {
    const journal = new McpExecutionJournal(file)
    await journal.open()
    let sends = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const call = async () => {
      sends += 1
      await gate
      return { text: 'remote ok', isError: false }
    }
    const first = dispatchToolCall({ journal, intent: intent('exec-same'), call }, fault)
    const second = dispatchToolCall({ journal, intent: intent('exec-same'), call }, fault)
    // Let both reach the reservation before the first dispatch finishes.
    await new Promise((resolve) => setTimeout(resolve, 50))
    release()
    const [a, b] = await Promise.all([first, second])
    expect(sends).toBe(1)
    const outcomes = [a.outcome, b.outcome].sort()
    // The owner sees the real outcome; the duplicate is never a second send.
    expect(outcomes).toContain('success')
    expect([a, b].some((result) => result.outcome === 'indeterminate' && /already in flight/.test(result.output))).toBe(true)
  })

  it('a reused execution id with a different intent is an integrity error, open or terminal', async () => {
    const journal = new McpExecutionJournal(file)
    await journal.open()
    let sends = 0
    const call = async () => { sends += 1; return { text: 'ok', isError: false } }
    await dispatchToolCall({ journal, intent: intent('exec-a'), call }, fault)
    const mismatched = await dispatchToolCall({ journal, intent: intent('exec-a', { argsHash: 'different' }), call }, fault)
    expect(mismatched.outcome).toBe('error')
    expect(mismatched.output).toMatch(/integrity/)
    expect(sends).toBe(1)

    // Open (unresolved) intent with a mismatch is refused the same way.
    await journal.appendIntent({ kind: 'dispatch_intent', ...intent('exec-open') })
    const openMismatch = await dispatchToolCall({ journal, intent: intent('exec-open', { tool: 'other' }), call }, fault)
    expect(openMismatch.outcome).toBe('error')
    expect(openMismatch.output).toMatch(/integrity/)
    expect(sends).toBe(1)
  })

  it('after a restart a terminal record reports its outcome, not a fabricated full result', async () => {
    const journal = new McpExecutionJournal(file)
    await journal.open()
    const long = 'x'.repeat(2_000)
    const first = await dispatchToolCall({ journal, intent: intent('exec-r'), call: async () => ({ text: long, isError: false }) }, fault)
    expect(first.output).toBe(long)

    const reopened = new McpExecutionJournal(file)
    await reopened.open()
    let sends = 0
    const replay = await dispatchToolCall({ journal: reopened, intent: intent('exec-r'), call: async () => { sends += 1; return { text: 'no', isError: false } } }, fault)
    expect(sends).toBe(0)
    expect(replay.outcome).toBe('success')
    expect(replay.output).not.toBe(long)
    expect(replay.output).toMatch(/result unavailable after restart/)
  })
})
