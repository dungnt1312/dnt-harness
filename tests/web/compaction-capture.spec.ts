/**
 * Capture of the exact completed request a compaction summary is computed
 * from. The contract: a snapshot is promoted only from a request whose stream
 * was drained cleanly to one settled stop completion AND whose covering turn
 * is durably completed — never from an EOF after stop, a tail error, an
 * abandoned step or a still-open turn.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ModelCompletion, ModelRequest, StreamEvent } from '../../src/harness/llm/types.ts'
import type { SessionEvent } from '../../src/harness/session/events.ts'
import type { CompactionProjection } from '../../src/harness/context/compaction-projection.ts'
import { sourceDigest, type SnapshotIdentity } from '../../src/harness/context/compaction-snapshot.ts'
import { CompactionSnapshotStore } from '../../src/harness/storage/compaction-snapshot-store.ts'
import {
  captureStream,
  promoteCapture,
  reconstructSnapshot,
  type PendingCapture,
} from '../../src/web/compaction-capture.ts'

type Row = { type: string; [key: string]: unknown }
const log = (rows: Row[]): SessionEvent[] =>
  rows.map((row, index) => ({ seq: index + 1, timestamp: 1000 + index, ...row })) as unknown as SessionEvent[]

const STOP: ModelCompletion = { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }

/** Turn t1: user, a Read call whose result is cleared in the request, a final answer. */
function turnRows(extra: Row[] = []): Row[] {
  return [
    { type: 'turn/start', turnId: 't1' }, // 1
    { type: 'user/message', turnId: 't1', content: 'hello' }, // 2
    { type: 'assistant/message', stepId: 's1', content: '', toolCalls: [{ id: 'c1', name: 'Read', args: { path: 'a.ts' } }] }, // 3
    { type: 'tool/call', stepId: 's1', call: { id: 'c1', name: 'Read', args: { path: 'a.ts' } } }, // 4
    { type: 'tool/result', stepId: 's1', callId: 'c1', ok: true, output: 'body' }, // 5
    { type: 'assistant/message', stepId: 's2', content: 'done' }, // 6
    ...extra,
  ]
}
const COMPLETED = (): SessionEvent[] => log(turnRows([{ type: 'turn/end', turnId: 't1', reason: 'completed' }])) // cutoff 7
const CUTOFF = 7

const request: ModelRequest = {
  model: 'm1',
  providerName: 'p1',
  thinkingLevel: 'high',
  messages: [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'Read', args: { path: 'a.ts' } }] },
    { role: 'tool', content: 'body', toolCallId: 'c1' },
  ],
  tools: [{ name: 'Read', description: 'read', parameters: { type: 'object', properties: {} } }],
  assemblySignal: new AbortController().signal,
}

function projectionFor(events: readonly SessionEvent[]): CompactionProjection {
  // System message is index 0; history messages follow in log order.
  const sources = [
    { messageIndex: 1, seq: 2, turnId: 't1' },
    { messageIndex: 2, seq: 3, turnId: 't1' },
    { messageIndex: 3, seq: 5, turnId: 't1' },
  ]
  void events
  return { v: 1, policyVersion: 1, history: 'compact', sources, losses: [{ kind: 'tool-result-cleared', seq: 5, callId: 'c1', policyVersion: 1 }] }
}

const identity: SnapshotIdentity = { provider: 'p1', model: 'm1', thinkingLevel: 'high', modeHash: 'mode', grantsHash: 'grants', providerGeneration: 1, policyVersion: 1, prefixHash: 'prefix' }

async function* stream(events: StreamEvent[], failAfter?: Error): AsyncIterable<StreamEvent> {
  for (const event of events) yield event
  if (failAfter !== undefined) throw failAfter
}

async function drain(iterable: AsyncIterable<StreamEvent>): Promise<void> {
  for await (const event of iterable) void event
}

describe('captureStream', () => {
  it('yields the upstream events unchanged and records a clean stop', async () => {
    const seen: StreamEvent[] = []
    const upstream: StreamEvent[] = [{ type: 'delta', delta: 'hi' }, STOP, { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }]
    const pending = captureStream(request, projectionFor(COMPLETED()))
    for await (const event of pending.tap(stream(upstream))) seen.push(event)
    expect(seen).toEqual(upstream)
    expect(pending.outcome()).toMatchObject({ clean: true, usage: { inputTokens: 10, outputTokens: 2 } })
  })

  it('does not call a stream clean when it errors AFTER the stop completion', async () => {
    const pending = captureStream(request, projectionFor(COMPLETED()))
    await expect(drain(pending.tap(stream([STOP], new Error('tail error'))))).rejects.toThrow('tail error')
    expect(pending.outcome().clean).toBe(false)
  })

  it('rejects duplicate completion, non-stop finishes, unsettled transport and aborts', async () => {
    const cases: StreamEvent[][] = [
      [STOP, STOP],
      [{ ...STOP, finishReason: 'tool_calls' }],
      [{ ...STOP, finishReason: 'length' }],
      [{ ...STOP, transportSettled: false }],
      [{ type: 'delta', delta: 'partial' }],
    ]
    for (const events of cases) {
      const pending = captureStream(request, projectionFor(COMPLETED()))
      await drain(pending.tap(stream(events))).catch(() => {})
      expect(pending.outcome().clean).toBe(false)
    }
    // Abandoned by the consumer (return() before the end): never clean.
    const abandoned = captureStream(request, projectionFor(COMPLETED()))
    for await (const event of abandoned.tap(stream([{ type: 'delta', delta: 'x' }, STOP]))) {
      void event
      break
    }
    expect(abandoned.outcome().clean).toBe(false)
  })

  it('keeps only wire-shaping fields: no assembly signal or host handles', () => {
    const pending = captureStream(request, projectionFor(COMPLETED()))
    expect(Object.keys(pending.request).sort()).toEqual(['messages', 'model', 'providerName', 'thinkingLevel', 'tools'])
  })

  it('freezes the request: later mutation of the live arrays cannot alter the capture', () => {
    const messages = [...request.messages]
    const live: ModelRequest = { ...request, messages }
    const pending = captureStream(live, projectionFor(COMPLETED()))
    messages.push({ role: 'user', content: 'added later' })
    expect(pending.request.messages).toHaveLength(request.messages.length)
  })
})

describe('promoteCapture', () => {
  let root: string
  let store: CompactionSnapshotStore
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'dnt-capture-'))
    store = new CompactionSnapshotStore((id) => path.join(root, id, 'snapshots'))
  })
  afterEach(async () => {
    await store.close()
    await fs.rm(root, { recursive: true, force: true })
  })

  async function cleanPending(events: readonly SessionEvent[]): Promise<PendingCapture> {
    const pending = captureStream(request, projectionFor(events))
    await drain(pending.tap(stream([{ type: 'delta', delta: 'done' }, STOP])))
    return pending
  }

  const finalAnswer = { role: 'assistant', content: 'done' } as const

  it('promotes a clean request once its turn is durably completed, with the final answer attached', async () => {
    const events = COMPLETED()
    const snapshot = await promoteCapture({ sessionId: 'session-a', events, turnId: 't1', pending: await cleanPending(events), finalAnswer, identity, store, newId: () => 'snap-1' })
    expect(snapshot).toBeDefined()
    expect(snapshot!.cutoff).toBe(CUTOFF)
    expect(snapshot!.request.messages).toEqual(request.messages)
    expect(snapshot!.finalAnswer).toEqual(finalAnswer)
    expect(snapshot!.sourceDigest).toBe(sourceDigest(events, CUTOFF))
    expect(snapshot!.projection.losses.some((loss) => loss.kind === 'tool-result-cleared')).toBe(true)
    // The sidecar exists and the snapshot has a reference to append.
    expect((await fs.readdir(path.join(root, 'session-a', 'snapshots'))).sort()).toEqual(['snap-1.json'])
  })

  it('never promotes an unclean capture', async () => {
    const events = COMPLETED()
    const pending = captureStream(request, projectionFor(events))
    await drain(pending.tap(stream([STOP], new Error('boom')))).catch(() => {})
    expect(await promoteCapture({ sessionId: 'session-a', events, turnId: 't1', pending, finalAnswer, identity, store, newId: () => 'snap-2' })).toBeUndefined()
    await expect(fs.readdir(path.join(root, 'session-a', 'snapshots'))).rejects.toThrow()
  })

  it('never promotes while the turn is still open, failed, abandoned or ended by something other than completion', async () => {
    for (const tail of [[], [{ type: 'turn/end', turnId: 't1', reason: 'cancelled' }], [{ type: 'turn/end', turnId: 't1', reason: 'failed' }], [{ type: 'step/abandoned', turnId: 't1', stepId: 's2', reason: 'retry' }]] as Row[][]) {
      const events = log(turnRows(tail))
      const pending = await cleanPending(events)
      expect(await promoteCapture({ sessionId: 'session-a', events, turnId: 't1', pending, finalAnswer, identity, store, newId: () => 'snap-x' })).toBeUndefined()
    }
  })

  it('never promotes when the closing answer is not the one the request was followed by', async () => {
    const events = COMPLETED()
    const pending = await cleanPending(events)
    // The log's last assistant answer is "done"; a different final answer means this request is not the turn's last.
    expect(await promoteCapture({ sessionId: 'session-a', events, turnId: 't1', pending, finalAnswer: { role: 'assistant', content: 'something else' }, identity, store, newId: () => 'snap-y' })).toBeUndefined()
  })

  it('never promotes a request of an execution with an unresolved outcome', async () => {
    const events = log(turnRows([{ type: 'execution/uncertain', fact: { requestId: 'r', attemptId: 'a', attempt: 1, state: 'uncertain', committed: false, transportSettled: false } }, { type: 'turn/end', turnId: 't1', reason: 'completed' }]))
    expect(await promoteCapture({ sessionId: 'session-a', events, turnId: 't1', pending: await cleanPending(events), finalAnswer, identity, store, newId: () => 'snap-z' })).toBeUndefined()
  })

  it('refuses a projection that is not eligible (a dropped uncovered turn)', async () => {
    const events = COMPLETED()
    const pending = captureStream(request, { ...projectionFor(events), losses: [{ kind: 'uncovered-history-dropped', fromSeq: 1, throughSeq: CUTOFF }] })
    await drain(pending.tap(stream([{ type: 'delta', delta: 'done' }, STOP])))
    expect(await promoteCapture({ sessionId: 'session-a', events, turnId: 't1', pending, finalAnswer, identity, store, newId: () => 'snap-w' })).toBeUndefined()
  })
})

describe('reconstructSnapshot', () => {
  it('rebuilds an eligible snapshot from a builder request and the committed log', () => {
    const events = COMPLETED()
    const snapshot = reconstructSnapshot({ sessionId: 'session-a', events, turnId: 't1', request, projection: projectionFor(events), finalAnswer: { role: 'assistant', content: 'done' }, identity, newId: () => 'rec-1' })
    expect(snapshot).toBeDefined()
    expect(snapshot!.cutoff).toBe(CUTOFF)
    expect(snapshot!.id).toBe('rec-1')
    expect(snapshot!.request.messages).toEqual(request.messages)
  })

  it('refuses an uncovered dropped turn instead of inventing coverage', () => {
    const events = COMPLETED()
    const projection: CompactionProjection = { ...projectionFor(events), losses: [{ kind: 'uncovered-history-dropped', fromSeq: 1, throughSeq: 6 }] }
    expect(reconstructSnapshot({ sessionId: 'session-a', events, turnId: 't1', request, projection, finalAnswer: { role: 'assistant', content: 'done' }, identity, newId: () => 'rec-2' })).toBeUndefined()
  })

  it('refuses when the turn is not completed', () => {
    const events = log(turnRows([]))
    expect(reconstructSnapshot({ sessionId: 'session-a', events, turnId: 't1', request, projection: projectionFor(events), finalAnswer: { role: 'assistant', content: 'done' }, identity, newId: () => 'rec-3' })).toBeUndefined()
  })
})
