/**
 * After a restart the in-memory capture is gone. What survives is the durable
 * `context/snapshot` reference in the log and the sidecar it names. Loading
 * trusts neither blindly: the reference must name the exact hash, and the
 * snapshot must still validate against the committed log.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionEvent } from '../../src/harness/session/events.ts'
import { sourceDigest } from '../../src/harness/context/compaction-digest.ts'
import { snapshotHash, type EffectiveCompactionSnapshot } from '../../src/harness/context/compaction-snapshot.ts'
import { CompactionSnapshotStore } from '../../src/harness/storage/compaction-snapshot-store.ts'
import { loadReferencedSnapshot, newestSnapshotReference } from '../../src/web/compaction-restart.ts'

type Row = { type: string; [key: string]: unknown }
const log = (rows: Row[]): SessionEvent[] => rows.map((row, index) => ({ seq: index + 1, timestamp: 1000 + index, ...row })) as unknown as SessionEvent[]

const turn = (id: string, text: string, answer: string): Row[] => [
  { type: 'turn/start', turnId: id },
  { type: 'user/message', turnId: id, content: text },
  { type: 'assistant/message', stepId: `s-${id}`, content: answer },
  { type: 'turn/end', turnId: id, reason: 'completed' },
]

function snapshot(events: readonly SessionEvent[], cutoff: number, id = 'snap-1'): EffectiveCompactionSnapshot {
  const sources: { messageIndex: number; seq: number; turnId: string }[] = []
  let turnId = ''
  for (const event of events) {
    if (event.seq > cutoff) break
    if (event.type === 'turn/start') turnId = event.turnId
    if (event.type === 'user/message' || event.type === 'assistant/message') sources.push({ messageIndex: sources.length + 1, seq: event.seq, turnId })
  }
  return {
    id, v: 1, policyVersion: 1, sessionId: 'session-a', cutoff, turnId,
    request: { messages: [{ role: 'user', content: 'q' }] },
    finalAnswer: { role: 'assistant', content: 'a' },
    projection: { v: 1, policyVersion: 1, history: 'compact', sources, losses: [] },
    sourceDigest: sourceDigest(events, cutoff),
    identity: { provider: 'p', model: 'm', modeHash: 'mode', grantsHash: 'g', providerGeneration: 1, policyVersion: 1, prefixHash: 'x' },
  }
}

const reference = (snap: EffectiveCompactionSnapshot): Row => ({ type: 'context/snapshot', snapshotId: snap.id, hash: snapshotHash(snap), cutoff: snap.cutoff, schema: 1 })

describe('newestSnapshotReference', () => {
  it('returns the newest reference in the log, or nothing', () => {
    const base = log(turn('t1', 'q', 'a'))
    expect(newestSnapshotReference(base)).toBeUndefined()
    const snapA = snapshot(base, 4, 'a')
    const events = log([...turn('t1', 'q', 'a'), reference(snapA), ...turn('t2', 'q2', 'a2'), { type: 'context/snapshot', snapshotId: 'b', hash: 'f'.repeat(64), cutoff: 8, schema: 1 }])
    expect(newestSnapshotReference(events)).toEqual({ id: 'b', hash: 'f'.repeat(64), cutoff: 8 })
  })
})

describe('loadReferencedSnapshot', () => {
  let root: string
  let store: CompactionSnapshotStore
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'dnt-restart-'))
    store = new CompactionSnapshotStore((id) => path.join(root, id, 'snapshots'))
  })
  afterEach(async () => {
    await store.close()
    await fs.rm(root, { recursive: true, force: true })
  })

  async function persisted(rows: Row[], cutoff: number): Promise<{ events: SessionEvent[]; snap: EffectiveCompactionSnapshot }> {
    const bare = log(rows)
    const snap = snapshot(bare, cutoff)
    await store.put(snap)
    return { events: log([...rows, reference(snap)]), snap }
  }

  it('reloads the snapshot the newest reference names', async () => {
    const { events, snap } = await persisted(turn('t1', 'q', 'a'), 4)
    expect(await loadReferencedSnapshot(store, 'session-a', events)).toEqual(snap)
  })

  it('still reloads an OLDER snapshot when later turns closed afterwards (they stay verbatim)', async () => {
    const { events, snap } = await persisted(turn('t1', 'q', 'a'), 4)
    const later = log([...events.map(({ seq: _seq, timestamp: _timestamp, ...rest }) => rest as unknown as Row), ...turn('t2', 'q2', 'a2')])
    expect((await loadReferencedSnapshot(store, 'session-a', later))?.cutoff).toBe(snap.cutoff)
  })

  it('returns undefined when there is no reference', async () => {
    expect(await loadReferencedSnapshot(store, 'session-a', log(turn('t1', 'q', 'a')))).toBeUndefined()
  })

  it('returns undefined when the sidecar is missing, tampered or corrupt — it asks for recovery instead of guessing', async () => {
    const { events, snap } = await persisted(turn('t1', 'q', 'a'), 4)
    const file = path.join(root, 'session-a', 'snapshots', `${snap.id}.json`)
    const text = await fs.readFile(file, 'utf8')
    await fs.writeFile(file, text.replace('"a"', '"TAMPERED"'))
    expect(await loadReferencedSnapshot(store, 'session-a', events)).toBeUndefined()
    await fs.writeFile(file, '{broken')
    expect(await loadReferencedSnapshot(store, 'session-a', events)).toBeUndefined()
    await fs.rm(file)
    expect(await loadReferencedSnapshot(store, 'session-a', events)).toBeUndefined()
  })

  it('returns undefined when the covered log changed since the snapshot was taken', async () => {
    const { events } = await persisted(turn('t1', 'q', 'a'), 4)
    const edited = events.map((event) => (event.type === 'user/message' ? { ...event, content: 'rewritten' } : event)) as SessionEvent[]
    expect(await loadReferencedSnapshot(store, 'session-a', edited)).toBeUndefined()
  })

  it('does not trust a reference whose hash differs from the sidecar', async () => {
    const { events } = await persisted(turn('t1', 'q', 'a'), 4)
    const forged = events.map((event) => (event.type === 'context/snapshot' ? { ...event, hash: '0'.repeat(64) } : event)) as SessionEvent[]
    expect(await loadReferencedSnapshot(store, 'session-a', forged)).toBeUndefined()
  })
})
