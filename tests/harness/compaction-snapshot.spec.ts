/**
 * Effective-compaction snapshot: schema, source digest and atomic sidecar.
 * Real temp directories — the ordering of write / sync / rename / reference
 * is the behavior under test, so the filesystem is not mocked.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionEvent } from '../../src/harness/session/events.ts'
import type { CompactionProjection } from '../../src/harness/context/compaction-projection.ts'
import {
  SNAPSHOT_SCHEMA_VERSION,
  snapshotHash,
  sourceDigest,
  validateSnapshot,
  type EffectiveCompactionSnapshot,
} from '../../src/harness/context/compaction-snapshot.ts'
import { CompactionSnapshotStore } from '../../src/harness/storage/compaction-snapshot-store.ts'

type Row = { type: string; [key: string]: unknown }

/** Mutate one row of a fixture by index; rows are plain data. */
function edit(rows: Row[], index: number, patch: Record<string, unknown>): Row[] {
  const row = rows[index]
  if (row === undefined) throw new Error(`no fixture row ${index}`)
  Object.assign(row, patch)
  return rows
}

function log(rows: Row[]): SessionEvent[] {
  return rows.map((row, index) => ({ seq: index + 1, timestamp: 1000 + index, ...row })) as unknown as SessionEvent[]
}

/** Turn 1 with a Read call, its result and an answer, completed at seq 7. */
function baseRows(): Row[] {
  return [
    { type: 'turn/start', turnId: 't1' }, // 1
    { type: 'user/message', turnId: 't1', content: 'hello' }, // 2
    { type: 'assistant/message', stepId: 's1', content: '', toolCalls: [{ id: 'c1', name: 'Read', args: { path: 'a.ts', limit: 10 } }] }, // 3
    { type: 'tool/call', stepId: 's1', call: { id: 'c1', name: 'Read', args: { path: 'a.ts', limit: 10 } } }, // 4
    { type: 'tool/result', stepId: 's1', callId: 'c1', ok: true, output: 'file body' }, // 5
    { type: 'assistant/message', stepId: 's2', content: 'done' }, // 6
    { type: 'turn/end', turnId: 't1', reason: 'completed' }, // 7
  ]
}
const CUTOFF = 7

function projectionFor(events: readonly SessionEvent[]): CompactionProjection {
  const sources: { messageIndex: number; seq: number; turnId: string }[] = []
  for (const event of events) {
    if (event.seq > CUTOFF) break
    if (event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result') {
      sources.push({ messageIndex: sources.length + 1, seq: event.seq, turnId: 't1' })
    }
  }
  return { v: 1, policyVersion: 1, history: 'compact', sources, losses: [] }
}

function makeSnapshot(events: readonly SessionEvent[], over: Partial<EffectiveCompactionSnapshot> = {}): EffectiveCompactionSnapshot {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    v: SNAPSHOT_SCHEMA_VERSION,
    policyVersion: 1,
    sessionId: 'session-test',
    cutoff: CUTOFF,
    turnId: 't1',
    request: {
      model: 'm1',
      providerName: 'p1',
      thinkingLevel: 'high',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'Read', args: { path: 'a.ts', limit: 10 } }] },
        { role: 'tool', content: 'file body', toolCallId: 'c1' },
      ],
      tools: [{ name: 'Read', description: 'read', parameters: { type: 'object', properties: {} } }],
    },
    finalAnswer: { role: 'assistant', content: 'done' },
    projection: projectionFor(events),
    sourceDigest: sourceDigest(events, CUTOFF),
    identity: { provider: 'p1', model: 'm1', thinkingLevel: 'high', modeHash: 'mode', grantsHash: 'grants', providerGeneration: 1, policyVersion: 1, prefixHash: 'prefix' },
    ...over,
  }
}

describe('sourceDigest', () => {
  it('is stable across key order and ignores metadata-only churn', () => {
    const rows = baseRows()
    const plain = sourceDigest(log(rows), CUTOFF)
    // Same content, different key order inside the effective call args.
    const reordered = edit(baseRows(), 3, { call: { id: 'c1', name: 'Read', args: { limit: 10, path: 'a.ts' } } })
    expect(sourceDigest(log(reordered), CUTOFF)).toBe(plain)
    // Telemetry and attempt events interleaved do not change content semantics.
    const noisy: Row[] = []
    for (const row of rows) {
      noisy.push(row)
      noisy.push({ type: 'context/manifest', turnId: 't1', manifest: { n: noisy.length } })
      noisy.push({ type: 'hook/run', event: 'PreToolUse', matcher: '*', exitCode: 0, durationMs: noisy.length, decision: 'allow' })
    }
    expect(sourceDigest(log(noisy), noisy.length)).toBe(plain)
  })

  it('changes when user text or effective tool arguments change', () => {
    const plain = sourceDigest(log(baseRows()), CUTOFF)
    const editedUser = edit(baseRows(), 1, { content: 'hello!' })
    expect(sourceDigest(log(editedUser), CUTOFF)).not.toBe(plain)
    const editedArgs = edit(baseRows(), 3, { call: { id: 'c1', name: 'Read', args: { path: 'b.ts', limit: 10 } } })
    expect(sourceDigest(log(editedArgs), CUTOFF)).not.toBe(plain)
    const editedOutput = edit(baseRows(), 4, { output: 'other body' })
    expect(sourceDigest(log(editedOutput), CUTOFF)).not.toBe(plain)
  })

  it('covers only events through the cutoff', () => {
    const rows = [...baseRows(), { type: 'turn/start', turnId: 't2' }, { type: 'user/message', turnId: 't2', content: 'next' }]
    expect(sourceDigest(log(rows), CUTOFF)).toBe(sourceDigest(log(baseRows()), CUTOFF))
  })
})

describe('snapshotHash', () => {
  it('is canonical: key order does not matter, content does', () => {
    const events = log(baseRows())
    const snapshot = makeSnapshot(events)
    // Same data with every object's keys inserted in reverse order.
    const reverseKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reverseKeys)
      if (value === null || typeof value !== 'object') return value
      return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)]))
    }
    const reordered = reverseKeys(snapshot) as EffectiveCompactionSnapshot
    expect(Object.keys(reordered)).not.toEqual(Object.keys(snapshot))
    expect(snapshotHash(reordered)).toBe(snapshotHash(snapshot))
    expect(snapshotHash({ ...snapshot, finalAnswer: { role: 'assistant', content: 'changed' } })).not.toBe(snapshotHash(snapshot))
  })
})

describe('validateSnapshot', () => {
  it('accepts a snapshot matching the log, schema and an eligible projection', () => {
    const events = log(baseRows())
    expect(validateSnapshot(makeSnapshot(events), events)).toEqual({ ok: true })
  })

  it('refuses a stale source digest, unsupported schema or policy, and a wrong cutoff', () => {
    const events = log(baseRows())
    const snapshot = makeSnapshot(events)
    expect(validateSnapshot({ ...snapshot, sourceDigest: 'stale' }, events)).toEqual({ ok: false, reason: 'source-digest-mismatch' })
    expect(validateSnapshot({ ...snapshot, v: 2 } as unknown as EffectiveCompactionSnapshot, events)).toEqual({ ok: false, reason: 'unsupported-schema' })
    expect(validateSnapshot({ ...snapshot, policyVersion: 2 } as unknown as EffectiveCompactionSnapshot, events)).toEqual({ ok: false, reason: 'unsupported-schema' })
    expect(validateSnapshot({ ...snapshot, cutoff: 6 }, events)).toEqual({ ok: false, reason: 'cutoff-not-completed' })
  })

  it('refuses a projection that is not eligible for compaction', () => {
    const events = log(baseRows())
    const snapshot = makeSnapshot(events)
    const hole = { ...snapshot, projection: { ...snapshot.projection, sources: snapshot.projection.sources.slice(1) } }
    expect(validateSnapshot(hole, events)).toEqual({ ok: false, reason: 'uncovered-history' })
  })

  it('refuses a snapshot whose seed differs from the canonical checkpoint', () => {
    const rows: Row[] = [
      ...baseRows(),
      { type: 'compaction/start', trigger: 'manual' }, // 8
      { type: 'compaction/end', trigger: 'manual', coversSeq: 7, summaryChars: 3, durationMs: 1, summary: 'abc' }, // 9
      { type: 'turn/start', turnId: 't2' }, // 10
      { type: 'user/message', turnId: 't2', content: 'q2' }, // 11
      { type: 'assistant/message', stepId: 's3', content: 'a2' }, // 12
      { type: 'turn/end', turnId: 't2', reason: 'completed' }, // 13
    ]
    const events = log(rows)
    const projection: CompactionProjection = {
      v: 1, policyVersion: 1, history: 'compact',
      sources: [{ messageIndex: 1, seq: 11, turnId: 't2' }, { messageIndex: 2, seq: 12, turnId: 't2' }],
      losses: [],
    }
    const snapshot = makeSnapshot(events, { cutoff: 13, turnId: 't2', sourceDigest: sourceDigest(events, 13), projection })
    // The projection carries no seed although the log has a canonical checkpoint.
    expect(validateSnapshot(snapshot, events)).toEqual({ ok: false, reason: 'missing-prior-seed' })
  })

  it('rejects malformed or secret-bearing fields outside the allowlist', () => {
    const events = log(baseRows())
    const snapshot = makeSnapshot(events)
    const withExtra = { ...snapshot, authorization: 'Bearer secret' } as unknown as EffectiveCompactionSnapshot
    expect(validateSnapshot(withExtra, events)).toEqual({ ok: false, reason: 'unsupported-schema' })
    const requestExtra = { ...snapshot, request: { ...snapshot.request, assemblySignal: {} } } as unknown as EffectiveCompactionSnapshot
    expect(validateSnapshot(requestExtra, events)).toEqual({ ok: false, reason: 'unsupported-schema' })
  })
})

describe('CompactionSnapshotStore', () => {
  let root: string
  let store: CompactionSnapshotStore
  const dirFor = (id: string): string => path.join(root, id, 'snapshots')

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'dnt-snapshot-'))
    store = new CompactionSnapshotStore(dirFor)
  })
  afterEach(async () => {
    await store.close()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('persists atomically and loads back only against a matching reference and log', async () => {
    const events = log(baseRows())
    const snapshot = makeSnapshot(events)
    const ref = await store.put(snapshot)
    expect(ref).toEqual({ id: snapshot.id, hash: snapshotHash(snapshot) })
    // No temp residue after a completed put.
    const names = await fs.readdir(dirFor(snapshot.sessionId))
    expect(names).toEqual([`${snapshot.id}.json`])
    expect(await store.load(snapshot.sessionId, ref, events)).toEqual(snapshot)
  })

  it('returns undefined for a missing, corrupt, tampered or stale sidecar', async () => {
    const events = log(baseRows())
    const snapshot = makeSnapshot(events)
    const ref = await store.put(snapshot)
    const file = path.join(dirFor(snapshot.sessionId), `${snapshot.id}.json`)
    // Stale: the log moved on in a way that changes covered content.
    const edited = edit(baseRows(), 1, { content: 'rewritten' })
    expect(await store.load(snapshot.sessionId, ref, log(edited))).toBeUndefined()
    // Wrong hash in the reference.
    expect(await store.load(snapshot.sessionId, { id: ref.id, hash: 'f'.repeat(64) }, events)).toBeUndefined()
    // Tampered payload: hash no longer matches the reference.
    const text = await fs.readFile(file, 'utf8')
    await fs.writeFile(file, text.replace('"done"', '"DONE"'))
    expect(await store.load(snapshot.sessionId, ref, events)).toBeUndefined()
    // Corrupt JSON.
    await fs.writeFile(file, '{not json')
    expect(await store.load(snapshot.sessionId, ref, events)).toBeUndefined()
    // Missing.
    await fs.rm(file)
    expect(await store.load(snapshot.sessionId, ref, events)).toBeUndefined()
  })

  it('refuses path-bearing ids and never touches files outside its directory', async () => {
    const events = log(baseRows())
    const snapshot = makeSnapshot(events)
    await expect(store.put({ ...snapshot, id: '../escape' })).rejects.toThrow(/invalid snapshot id/)
    await expect(store.put({ ...snapshot, sessionId: '../other' })).rejects.toThrow(/invalid session id/)
    expect(await store.load(snapshot.sessionId, { id: '../escape', hash: 'x' }, events)).toBeUndefined()
    expect(await fs.readdir(root)).toEqual([])
  })

  it('keeps secrets and handles out of the sidecar', async () => {
    const events = log(baseRows())
    const snapshot = makeSnapshot(events)
    await store.put(snapshot)
    const text = await fs.readFile(path.join(dirFor(snapshot.sessionId), `${snapshot.id}.json`), 'utf8')
    expect(text).not.toMatch(/assemblySignal|authorization|apiKey|Bearer/i)
  })

  it('prunes everything except the kept ids and leaves unrelated files alone', async () => {
    const events = log(baseRows())
    const first = makeSnapshot(events)
    const second = makeSnapshot(events, { id: '22222222-2222-4222-8222-222222222222' })
    await store.put(first)
    await store.put(second)
    const stray = path.join(dirFor(first.sessionId), 'notes.txt')
    await fs.writeFile(stray, 'keep me')
    await store.prune(first.sessionId, new Set([second.id]))
    expect((await fs.readdir(dirFor(first.sessionId))).sort()).toEqual([`${second.id}.json`, 'notes.txt'])
  })

  it('close() drains in-flight writes and refuses new ones', async () => {
    const events = log(baseRows())
    const snapshot = makeSnapshot(events)
    const pending = store.put(snapshot)
    await store.close()
    await expect(pending).resolves.toEqual({ id: snapshot.id, hash: snapshotHash(snapshot) })
    await expect(store.put(makeSnapshot(events, { id: '33333333-3333-4333-8333-333333333333' }))).rejects.toThrow(/closing/)
  })

  it('a failed write leaves no partial sidecar and the log untouched', async () => {
    const events = log(baseRows())
    const snapshot = makeSnapshot(events)
    // Make the session directory unusable: a regular file where the directory should be.
    await fs.mkdir(path.join(root, snapshot.sessionId), { recursive: true })
    await fs.writeFile(path.join(root, snapshot.sessionId, 'snapshots'), 'not a directory')
    await expect(store.put(snapshot)).rejects.toThrow()
    expect(await fs.readFile(path.join(root, snapshot.sessionId, 'snapshots'), 'utf8')).toBe('not a directory')
  })
})
