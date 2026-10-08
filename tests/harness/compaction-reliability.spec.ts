import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Kernel, Session, type TurnId, type StepId } from 'dnt-harness'
import { CheckpointStore, compactSession } from '../../src/harness/context/compaction.ts'
import type { SessionStore } from '../../src/harness/storage/file-session-store.ts'

const homes: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(homes.splice(0).map(home => fs.rm(home, { recursive: true, force: true }))) })
async function setup(content = 'source') {
  const home = await fs.mkdtemp(path.join(tmpdir(), 'compact-reliability-'))
  homes.push(home)
  const session = new Session(new Kernel().ctx)
  session.append({ type: 'turn/start', turnId: 't' as TurnId })
  session.append({ type: 'user/message', turnId: 't' as TurnId, content })
  session.append({ type: 'turn/end', turnId: 't' as TurnId, reason: 'completed' })
  return { session, store: new CheckpointStore(home), home }
}
function deferredStore() {
  let release!: () => void
  let reject!: (error: Error) => void
  const gate = new Promise<void>((resolve, fail) => { release = resolve; reject = fail })
  const flush = vi.fn(async () => {})
  const backing = { append: vi.fn(async () => {}), flush } as unknown as SessionStore
  return { backing, flush, gate, release, reject }
}

describe('canonical compaction reliability', () => {
  it('does not authorize or cache an appended end until the captured prefix is durable', async () => {
    const { session: history, store } = await setup()
    const deferred = deferredStore()
    const session = new Session(new Kernel().ctx, { store: deferred.backing })
    session.adoptHistory(history.events)
    expect(session.committedSeq).toBe(3)
    const snapshot = session.committedEvents
    deferred.flush.mockImplementationOnce(async () => {}).mockImplementationOnce(() => deferred.gate)
    const transaction = compactSession(session, store, async () => 'committed summary')
    await vi.waitFor(() => expect(deferred.flush).toHaveBeenCalledTimes(2))
    expect(session.events.at(-1)?.type).toBe('compaction/end')
    expect(session.committedSeq).toBe(4)
    const save = vi.spyOn(store, 'save')
    expect(await store.latest(session.id, session.committedEvents)).toBeUndefined()
    expect(save).not.toHaveBeenCalled()
    expect(snapshot).toHaveLength(3)
    deferred.release()
    const checkpoint = await transaction
    expect(session.committedSeq).toBe(5)
    expect(await store.latest(session.id, session.committedEvents)).toEqual(checkpoint)
  })
  it('settles durable success after late Stop, retains ownership through flush, and skips cache publication', async () => {
    const { session: history, store } = await setup()
    const deferred = deferredStore()
    const session = new Session(new Kernel().ctx, { store: deferred.backing })
    session.adoptHistory(history.events)
    deferred.flush.mockImplementationOnce(async () => {}).mockImplementationOnce(() => deferred.gate)
    const save = vi.spyOn(store, 'save')
    const controller = new AbortController()
    const transaction = compactSession(session, store, async () => 'late success', { trigger: 'manual', signal: controller.signal })
    await vi.waitFor(() => expect(deferred.flush).toHaveBeenCalledTimes(2))
    controller.abort()
    await expect(compactSession(session, store, async () => 'overlap')).rejects.toThrow(/progress/)
    expect(save).not.toHaveBeenCalled()
    deferred.release()
    const checkpoint = await transaction
    expect(checkpoint.summary).toBe('late success')
    expect(save).not.toHaveBeenCalled()
    expect(session.events.filter(e => e.type === 'compaction/end')).toHaveLength(1)
    expect(session.events.at(-1)).not.toHaveProperty('error')
    expect(await store.latest(session.id, session.committedEvents)).toEqual(checkpoint)
    await compactSession(session, store, async () => 'next')
  })
  it('waits for the completed source prefix before summarization', async () => {
    const { session: history, store } = await setup()
    const deferred = deferredStore()
    const session = new Session(new Kernel().ctx, { store: deferred.backing })
    for (const { seq: _seq, timestamp: _timestamp, ...event } of history.events) session.append(event)
    deferred.flush.mockImplementationOnce(() => deferred.gate)
    const summarize = vi.fn(async () => 'summary')
    const transaction = compactSession(session, store, summarize)
    await vi.waitFor(() => expect(deferred.flush).toHaveBeenCalledTimes(1))
    expect(summarize).not.toHaveBeenCalled()
    expect(session.committedSeq).toBe(0)
    deferred.release()
    await transaction
    expect(summarize).toHaveBeenCalledOnce()
  })
  it('does not advance the committed snapshot on a failed barrier', async () => {
    const deferred = deferredStore()
    const session = new Session(new Kernel().ctx, { store: deferred.backing })
    session.append({ type: 'session/title', title: 'first' })
    await session.durable()
    const snapshot = session.committedEvents
    session.append({ type: 'session/title', title: 'not durable' })
    deferred.flush.mockRejectedValueOnce(new Error('flush failed'))
    await expect(session.durable()).rejects.toThrow('flush failed')
    expect(session.committedSeq).toBe(1)
    expect(session.committedEvents).toEqual(snapshot)
    expect(snapshot).toHaveLength(1)
  })
  it.each(['', '   ', 'x'.repeat(24001)])('rejects invalid custom summary (length %s)', async summary => {
    const { session, store } = await setup()
    await expect(compactSession(session, store, async () => summary)).rejects.toThrow()
    expect(await store.latest(session.id)).toBeUndefined()
  })
  it('rejects empty source before calling a custom summarizer', async () => {
    const { session, store } = await setup('')
    const summarize = vi.fn(async () => 'invented')
    await expect(compactSession(session, store, summarize)).rejects.toThrow(/empty/)
    expect(summarize).not.toHaveBeenCalled()
  })
  it('excludes concurrent core transactions and releases ownership', async () => {
    const { session, store } = await setup()
    let release!: (value: string) => void
    const first = compactSession(session, store, () => new Promise(resolve => { release = resolve }))
    await vi.waitFor(() => expect(release).toBeDefined())
    await expect(compactSession(session, store, async () => 'duplicate')).rejects.toThrow(/progress|concurrent/)
    release('first')
    await first
    await compactSession(session, store, async () => 'next')
  })
  it('checks cancellation after summary and never publishes', async () => {
    const { session, store } = await setup()
    const controller = new AbortController()
    await expect(compactSession(session, store, async () => { controller.abort(); return 'summary' }, { trigger: 'manual', signal: controller.signal })).rejects.toThrow(/cancel|abort/i)
    expect(await store.latest(session.id)).toBeUndefined()
  })
  it('canonical success survives failed cache and rebuilds missing or corrupt cache', async () => {
    const { session, store, home } = await setup()
    const save = vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('cache failed'))
    const checkpoint = await compactSession(session, store, async () => 'durable summary')
    expect(session.events.filter(e => e.type === 'compaction/end')).toHaveLength(1)
    expect(session.events.at(-1)).not.toHaveProperty('error')
    save.mockRestore()
    expect(await store.latest(session.id, session.events)).toEqual(checkpoint)
    await fs.writeFile(path.join(home, session.id, 'checkpoints', '3.json'), '{broken')
    expect(await store.latest(session.id, session.events)).toEqual(checkpoint)
  })
  it('rejects unchecked, future, mismatched and dangling canonical facts', async () => {
    const { session, store, home } = await setup()
    const checkpoint = { v: 1 as const, coversSeq: 3, summary: 'unsafe', provenance: { createdAt: 1, trigger: 'manual' as const } }
    await store.save(session.id, checkpoint)
    expect(await store.latest(session.id, session.events)).toBeUndefined()
    await fs.writeFile(path.join(home, session.id, 'checkpoints', '4.json'), JSON.stringify(checkpoint))
    session.append({ type: 'compaction/start', trigger: 'manual' })
    expect(await store.latest(session.id, session.events)).toBeUndefined()
    session.append({ type: 'compaction/end', trigger: 'manual', coversSeq: 99, summary: 'future', summaryChars: 6, durationMs: 1 })
    expect(await store.latest(session.id, session.events)).toBeUndefined()
  })
  it.each(['writeFile', 'sync', 'rename'] as const)('atomic cache %s failure preserves previous bytes and cleans temp files', async operation => {
    const { session, store, home } = await setup()
    const previous = await compactSession(session, store, async () => 'previous')
    const dir = path.join(home, session.id, 'checkpoints')
    const before = await fs.readFile(path.join(dir, '3.json'))
    if (operation === 'rename') vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('rename failed'))
    else {
      const open = fs.open.bind(fs)
      vi.spyOn(fs, 'open').mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
        const file = await open(...args)
        vi.spyOn(file, operation).mockRejectedValueOnce(new Error(`${operation} failed`))
        return file
      })
    }
    await expect(store.save(session.id, { ...previous, summary: 'replacement' })).rejects.toThrow(/failed/)
    expect((await fs.readFile(path.join(dir, '3.json'))).equals(before)).toBe(true)
    expect(await fs.readdir(dir)).toEqual(['3.json'])
  })
  it('recovers legacy end only with sufficient existing facts', async () => {
    const { session, store } = await setup()
    session.append({ type: 'compaction/start', trigger: 'manual' })
    session.append({ type: 'compaction/end', trigger: 'manual', coversSeq: 3, summary: 'legacy', summaryChars: 6, durationMs: 1 })
    expect((await store.latest(session.id, session.events))?.summary).toBe('legacy')
  })
  it('projects rewritten calls and bounded attachment content with explicit image references', async () => {
    const { session, store } = await setup()
    session.append({ type: 'turn/start', turnId: 't2' as TurnId })
    session.append({ type: 'user/message', turnId: 't2' as TurnId, content: 'files', attachments: [
      { id: 'text', name: 'requirements.txt', mediaType: 'text/plain', bytes: 10 },
      { id: 'image', name: 'screen.png', mediaType: 'image/png', bytes: 10 },
    ] })
    session.append({ type: 'assistant/message', stepId: 's' as StepId, content: '', toolCalls: [{ id: 'c', name: 'Read', args: { path: 'old' } }] })
    session.append({ type: 'tool/call', stepId: 's' as StepId, call: { id: 'c', name: 'Read', args: { path: 'effective.ts' } } })
    session.append({ type: 'tool/result', stepId: 's' as StepId, callId: 'c', ok: true, output: 'result' })
    session.append({ type: 'turn/end', turnId: 't2' as TurnId, reason: 'completed' })
    const attachments = new Map([['text', { mediaType: 'text/plain', text: 'MUST KEEP REQUIREMENT' }], ['image', { mediaType: 'image/png', base64: 'AAAA' }]])
    let source = ''
    await compactSession(session, store, async ({ text }) => { source = text; return 'summary' }, { trigger: 'manual', attachments })
    expect(source).toContain('effective.ts')
    expect(source).not.toContain('"old"')
    expect(source).toContain('MUST KEEP REQUIREMENT')
    expect(source).toContain('screen.png')
    expect(source).toMatch(/pixels|not inspected|not summarized/)
    expect(source).not.toContain('AAAA')
  })
})

describe('incremental seed folding', () => {
  /** Two completed turns: t1 (seq 1-4) then t2 (seq 5-8). */
  async function setupTwoTurns() {
    const { session, store } = await setup('first turn content')
    session.append({ type: 'turn/start', turnId: 't2' as TurnId })
    session.append({ type: 'user/message', turnId: 't2' as TurnId, content: 'second turn content' })
    session.append({ type: 'assistant/message', stepId: 's2' as StepId, content: 'second answer' })
    session.append({ type: 'turn/end', turnId: 't2' as TurnId, reason: 'completed' })
    return { session, store }
  }

  it('projects only the delta beyond a valid seed and passes the seed summary through', async () => {
    const { session, store } = await setupTwoTurns()
    await compactSession(session, store, async () => 'SEED SUMMARY', { trigger: 'manual' })
    session.append({ type: 'turn/start', turnId: 't3' as TurnId })
    session.append({ type: 'user/message', turnId: 't3' as TurnId, content: 'third request' })
    session.append({ type: 'turn/end', turnId: 't3' as TurnId, reason: 'completed' })
    let source = ''
    let seedSummary: string | undefined
    const checkpoint = await compactSession(session, store, async ({ text, seed }) => {
      source = text
      seedSummary = seed?.summary
      return `${seed?.summary ?? ''} merged with delta`
    }, { trigger: 'manual', seed: (await store.latest(session.id, session.events))! })
    expect(source).toBe('user: third request')
    expect(source).not.toContain('first turn content')
    expect(seedSummary).toBe('SEED SUMMARY')
    expect(checkpoint.coversSeq).toBe(12)
    expect(checkpoint.summary).toBe('SEED SUMMARY merged with delta')
  })

  it('rejects an invalid seed instead of silently folding from scratch', async () => {
    const { session, store } = await setupTwoTurns()
    for (const seed of [
      { summary: '', coversSeq: 4 },
      { summary: 'x'.repeat(24_001), coversSeq: 4 },
      { summary: 'valid summary', coversSeq: 0 },
      { summary: 'valid summary', coversSeq: 6 },
      { summary: 'valid summary', coversSeq: 99 },
    ]) {
      await expect(compactSession(session, store, async () => 'never', {
        trigger: 'manual',
        seed: { v: 1, summary: seed.summary, coversSeq: seed.coversSeq, provenance: { createdAt: 1, trigger: 'manual' } },
      })).rejects.toThrow(/seed/i)
    }
    // Nothing was appended: no lifecycle events from the rejected seeds.
    expect(session.events.some(event => event.type === 'compaction/start')).toBe(false)
  })

  it('an unchanged boundary with a valid seed is an idempotent no-op', async () => {
    const { session, store } = await setupTwoTurns()
    const first = await compactSession(session, store, async () => 'SEED SUMMARY', { trigger: 'manual' })
    const eventsBefore = [...session.events]
    const summarize = vi.fn(async () => 'should not run')
    const checkpoint = await compactSession(session, store, summarize, { trigger: 'manual', seed: first })
    expect(checkpoint.summary).toBe('SEED SUMMARY')
    expect(checkpoint.coversSeq).toBe(first.coversSeq)
    expect(checkpoint.provenance.createdAt).toBe(first.provenance.createdAt)
    expect(summarize).not.toHaveBeenCalled()
    // No compaction/start appended for the no-op.
    const starts = session.events.filter(event => event.type === 'compaction/start')
    expect(starts).toHaveLength(1)
    expect(session.events.length).toBe(eventsBefore.length)
    expect(await store.latest(session.id, session.events)).toEqual(checkpoint)
  })

  it('an extractive run that cannot fit seed + delta fails before any lifecycle event', async () => {
    const { session, store } = await setupTwoTurns()
    const seed = await compactSession(session, store, async () => 'x'.repeat(23_990), { trigger: 'manual' })
    session.append({ type: 'turn/start', turnId: 't3' as TurnId })
    session.append({ type: 'user/message', turnId: 't3' as TurnId, content: 'third request that no longer fits' })
    session.append({ type: 'turn/end', turnId: 't3' as TurnId, reason: 'completed' })
    await session.durable()
    const before = session.events.length
    const summarize = vi.fn(async () => 'never')
    await expect(compactSession(session, store, summarize, { trigger: 'automatic', seed, extractiveCap: 24_000 }))
      .rejects.toThrow(/extractive capacity/)
    expect(summarize).not.toHaveBeenCalled()
    expect(session.events.length).toBe(before)
  })

  it('an unseeded extractive run over the cap also refuses before lifecycle events', async () => {
    const { session, store } = await setup('z'.repeat(24_500))
    await session.durable()
    const summarize = vi.fn(async () => 'never')
    await expect(compactSession(session, store, summarize, { trigger: 'automatic', extractiveCap: 24_000 })).rejects.toThrow(/extractive capacity/)
    expect(summarize).not.toHaveBeenCalled()
    expect(session.events.some(event => event.type.startsWith('compaction/'))).toBe(false)
  })

  it('an extractive run that fits proceeds normally', async () => {
    const { session, store } = await setupTwoTurns()
    const seed = await compactSession(session, store, async () => 'SEED', { trigger: 'manual' })
    session.append({ type: 'turn/start', turnId: 't3' as TurnId })
    session.append({ type: 'user/message', turnId: 't3' as TurnId, content: 'third' })
    session.append({ type: 'turn/end', turnId: 't3' as TurnId, reason: 'completed' })
    await session.durable()
    const checkpoint = await compactSession(session, store, async ({ text, seed: s }) => `${s?.summary}\n\n${text}`, { trigger: 'manual', seed, extractiveCap: 24_000 })
    expect(checkpoint.summary).toBe('SEED\n\nuser: third')
  })

  it('rejects a seed covering a different boundary than a completed turn', async () => {
    const { session, store } = await setupTwoTurns()
    // seq 6 is a user message inside t2, not a completed boundary.
    await expect(compactSession(session, store, async () => 'never', {
      trigger: 'manual', seed: { v: 1, summary: 'valid summary', coversSeq: 6, provenance: { createdAt: 1, trigger: 'manual' } },
    })).rejects.toThrow(/seed/i)
  })
})
