/**
 * The per-session wiring the web host needs around capture: which request is
 * armed, which finished cleanly, which snapshot a session currently holds, and
 * what identity it was built for. Pure state + the pure helpers; the server
 * only forwards events into it.
 */
import { describe, expect, it } from 'vitest'
import type { ModelCompletion, ModelRequest, StreamEvent } from '../../src/harness/llm/types.ts'
import type { CompactionProjection } from '../../src/harness/context/compaction-projection.ts'
import { CaptureRegistry, identityOf, requestPrefixHash } from '../../src/web/compaction-wiring.ts'

const STOP: ModelCompletion = { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
const projection: CompactionProjection = { v: 1, policyVersion: 1, history: 'compact', sources: [], losses: [] }
const request: ModelRequest = { model: 'm', providerName: 'p', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }] }

async function* stream(...events: StreamEvent[]): AsyncIterable<StreamEvent> { for (const event of events) yield event }
async function drain(iterable: AsyncIterable<StreamEvent>): Promise<void> { for await (const event of iterable) void event }

describe('CaptureRegistry', () => {
  it('arms one capture per turn and hands back the newest clean one for that turn only', async () => {
    const registry = new CaptureRegistry()
    registry.arm('s1', 't1', request, projection)
    await drain(registry.tap('s1', 't1', stream({ type: 'delta', delta: 'x' }, STOP)))
    expect(registry.cleanFor('s1', 't1')).toBeDefined()
    expect(registry.cleanFor('s1', 't2')).toBeUndefined()
    expect(registry.cleanFor('other', 't1')).toBeUndefined()
  })

  it('a newer armed request supersedes the previous one: only the LAST step of a turn counts', async () => {
    const registry = new CaptureRegistry()
    registry.arm('s1', 't1', request, projection)
    await drain(registry.tap('s1', 't1', stream(STOP)))
    registry.arm('s1', 't1', { ...request, messages: [...request.messages, { role: 'tool', content: 'r', toolCallId: 'c' }] }, projection)
    // The second step has not finished: the earlier clean capture must not stand in for it.
    expect(registry.cleanFor('s1', 't1')).toBeUndefined()
    await drain(registry.tap('s1', 't1', stream({ type: 'delta', delta: 'final' }, STOP)))
    expect(registry.cleanFor('s1', 't1')?.request.messages).toHaveLength(3)
  })

  it('an unfinished or failed stream leaves nothing clean', async () => {
    const registry = new CaptureRegistry()
    registry.arm('s1', 't1', request, projection)
    await drain(registry.tap('s1', 't1', stream({ type: 'delta', delta: 'x' }, { ...STOP, finishReason: 'length' }))).catch(() => {})
    expect(registry.cleanFor('s1', 't1')).toBeUndefined()
    registry.arm('s1', 't2', request, projection)
    await drain(registry.tap('s1', 't2', (async function* (): AsyncIterable<StreamEvent> { yield STOP; throw new Error('tail') })())).catch(() => {})
    expect(registry.cleanFor('s1', 't2')).toBeUndefined()
  })

  it('a stream with no armed capture passes through untouched', async () => {
    const registry = new CaptureRegistry()
    const seen: StreamEvent[] = []
    for await (const event of registry.tap('s1', 't1', stream({ type: 'delta', delta: 'x' }, STOP))) seen.push(event)
    expect(seen).toHaveLength(2)
    expect(registry.cleanFor('s1', 't1')).toBeUndefined()
  })

  it('arming consumes itself on first use, so an internal tool-model call in the same turn cannot claim it', async () => {
    const registry = new CaptureRegistry()
    registry.arm('s1', 't1', request, projection)
    await drain(registry.tap('s1', 't1', stream({ type: 'delta', delta: 'real' }, STOP)))
    // A second stream in the same turn (e.g. a tool that calls a model) must not replace it.
    await drain(registry.tap('s1', 't1', stream({ type: 'delta', delta: 'internal' }, { ...STOP, finishReason: 'length' }))).catch(() => {})
    expect(registry.cleanFor('s1', 't1')).toBeDefined()
  })

  it('forget() drops everything held for a session', async () => {
    const registry = new CaptureRegistry()
    registry.arm('s1', 't1', request, projection)
    await drain(registry.tap('s1', 't1', stream(STOP)))
    registry.forget('s1')
    expect(registry.cleanFor('s1', 't1')).toBeUndefined()
  })

  it('holds the promoted snapshot for a session and clears it when forgotten', () => {
    const registry = new CaptureRegistry()
    const snapshot = { id: 'x' } as never
    registry.keep('s1', snapshot)
    expect(registry.snapshotOf('s1')).toBe(snapshot)
    registry.forget('s1')
    expect(registry.snapshotOf('s1')).toBeUndefined()
  })
})

describe('identityOf and requestPrefixHash', () => {
  const base = { provider: 'p', model: 'm', thinkingLevel: 'high', modeId: 'agent', modeRevision: 3, grants: [{ path: '/a', access: 'write' as const }], providerGeneration: 1 }

  it('is stable for the same inputs and ignores grant order', () => {
    const a = identityOf({ ...base, grants: [{ path: '/a', access: 'write' }, { path: '/b', access: 'read' }] }, 'prefix')
    const b = identityOf({ ...base, grants: [{ path: '/b', access: 'read' }, { path: '/a', access: 'write' }] }, 'prefix')
    expect(a).toEqual(b)
  })

  it('changes with the model, mode revision, grants, thinking level and prefix', () => {
    const ref = identityOf(base, 'prefix')
    expect(identityOf({ ...base, model: 'n' }, 'prefix')).not.toEqual(ref)
    expect(identityOf({ ...base, modeRevision: 4 }, 'prefix')).not.toEqual(ref)
    expect(identityOf({ ...base, grants: [{ path: '/a', access: 'read' }] }, 'prefix')).not.toEqual(ref)
    expect(identityOf({ ...base, thinkingLevel: 'low' }, 'prefix')).not.toEqual(ref)
    expect(identityOf(base, 'other')).not.toEqual(ref)
  })

  it('never carries a secret: only hashes and ids', () => {
    expect(JSON.stringify(identityOf(base, 'prefix'))).not.toMatch(/\/a|Bearer|apiKey/)
  })

  it('hashes the wire prefix of a request: system, tools and ordering, not host handles', () => {
    const one = requestPrefixHash({ ...request, tools: [{ name: 'Read', description: 'd', parameters: { type: 'object', properties: {} } }] })
    expect(requestPrefixHash({ ...request, tools: [{ name: 'Read', description: 'd', parameters: { type: 'object', properties: {} } }], assemblySignal: new AbortController().signal })).toBe(one)
    expect(requestPrefixHash(request)).not.toBe(one)
    expect(requestPrefixHash({ ...request, messages: [...request.messages].reverse() })).not.toBe(requestPrefixHash(request))
  })
})
