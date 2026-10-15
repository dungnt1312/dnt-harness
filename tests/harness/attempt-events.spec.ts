import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readEventLog } from '../../src/harness/storage/events-jsonl.ts'
import { deriveMessages } from '../../src/harness/session/events.ts'
import { projectItems } from '../../web/lib/project.ts'
import { manifest } from '../fixtures/context-accounting.ts'

const fact = { requestId: 'request', attemptId: 'attempt', attempt: 1, state: 'start', committed: false, transportSettled: false }
async function read(records: Record<string, unknown>[]) {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'attempt-events-'))
  try {
    const file = path.join(dir, 'events.jsonl')
    await fs.writeFile(file, records.map((record, index) => JSON.stringify({ v: 1, seq: index + 1, timestamp: 100 + index, ...record })).join('\n') + '\n')
    return await readEventLog(file)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
}
describe('canonical attempt event readers', () => {
  it.each([
    { ...manifest(), budget: { ...manifest().budget, usedTokens: -1 } },
    { ...manifest(), breakdown: { ...manifest().breakdown, messages: 1 } },
    { ...manifest('forbidden-request-id') },
    { ...manifest(), usage: { last: { inputTokens: 1 } } },
  ])('rejects malformed post-compact estimates %#', async contextAfter => {
    await expect(read([{ type: 'compaction/end', trigger: 'manual', coversSeq: 1,
      summary: 'SUMMARY', summaryChars: 7, durationMs: 1, contextEffect: 'replaced', contextAfter,
    }])).rejects.toMatchObject({ kind: 'schema' })
  })

  it('rejects forged request context identities while preserving legacy manifest rows', async () => {
    await expect(read([{ type: 'context/manifest', turnId: 't', manifest: { ...manifest(), contextId: '../bad' } }])).rejects.toMatchObject({ kind: 'schema' })
    expect((await read([{ type: 'context/manifest', turnId: 't', manifest: manifest() }])).events).toHaveLength(1)
  })

  it('round-trips terminal context measurements without adding model history', async () => {
    const usage = { inputTokens: 120_000, cachedInputTokens: 110_000, outputTokens: 2 }
    const measured = { ...fact, state: 'end', transportSettled: true, contextId: 'ctx-1', usage }
    const { events } = await read([{ type: 'model/attempt', fact: measured }])
    expect(events[0]).toMatchObject({ fact: measured })
    expect(deriveMessages(events)).toEqual([])
  })

  it.each([
    { inputTokens: -1 }, { inputTokens: 1.5 }, { inputTokens: 10, cachedInputTokens: 11 },
    { inputTokens: 10, outputTokens: -1 }, { inputTokens: 10, rawBody: 'SECRET' },
    { inputTokens: null }, { cachedInputTokens: 1 },
  ])('rejects malformed persisted context usage %#', async usage => {
    await expect(read([{ type: 'model/attempt', fact: { ...fact, state: 'end', contextId: 'ctx-1', usage } }])).rejects.toMatchObject({ kind: 'schema' })
  })

  it('rejects usage on a start fact and an invalid context identity', async () => {
    await expect(read([{ type: 'model/attempt', fact: { ...fact, contextId: 'ctx-1', usage: { inputTokens: 0 } } }])).rejects.toMatchObject({ kind: 'schema' })
    await expect(read([{ type: 'model/attempt', fact: { ...fact, state: 'end', contextId: '../bad' } }])).rejects.toMatchObject({ kind: 'schema' })
  })
  it('reads old logs and optional-field-free attempt facts without adding model history', async () => {
    const { events } = await read([
      { type: 'user/message', turnId: 'turn', content: 'old log' },
      { type: 'model/attempt', fact },
      { type: 'execution/uncertain', fact: { ...fact, state: 'uncertain' } },
      { type: 'execution/reconciled', fact: { ...fact, state: 'reconciled', transportSettled: true } },
    ])
    expect(events).toHaveLength(4)
    expect(deriveMessages(events)).toEqual([{ role: 'user', content: 'old log' }])
    const projected = projectItems(events.map(event => event.type === 'user/message'
      ? { type: event.type, seq: event.seq, content: event.content }
      : 'fact' in event ? { type: event.type, seq: event.seq, fact: event.fact } : { type: event.type, seq: event.seq }))
    expect(projected.filter(item => item.kind === 'audit').map(item => item.text)).toEqual([
      'Provider request ownership unresolved · attempt 1; replacement execution fenced',
      'Provider request locally settled · attempt 1; ownership released',
    ])
    expect(projected.filter(item => item.kind === 'assistant')).toHaveLength(0)
  })
  it.each([
    { fact: null },
    { fact: { ...fact, attempt: 5 } },
    { fact: { ...fact, committed: 'false' } },
    { fact: { ...fact, reason: 'SECRET' } },
    { fact: { ...fact, provider: 'x'.repeat(129) } },
    { fact: { ...fact, attribution: { sessionId: 'session' } } },
    { fact: { ...fact, queuedAt: -1 } },
    { fact: { ...fact, finish: 'invalid' } },
    { fact: { ...fact, state: 'uncertain' } },
    { fact: { ...fact, rawBody: 'SECRET' } },
  ])('rejects malformed model attempt payload %#', async payload => {
    await expect(read([{ type: 'model/attempt', ...payload }])).rejects.toMatchObject({ kind: 'schema', lineNumber: 1 })
  })
  it('rejects contradictory uncertainty and reconciliation', async () => {
    await expect(read([{ type: 'execution/uncertain', fact: { ...fact, state: 'uncertain', transportSettled: true } }])).rejects.toMatchObject({ kind: 'schema' })
    await expect(read([{ type: 'execution/reconciled', fact: { ...fact, state: 'reconciled' } }])).rejects.toMatchObject({ kind: 'schema' })
  })
})
