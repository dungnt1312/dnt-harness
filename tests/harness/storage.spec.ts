/**
 * Durable storage (G1): JSONL round-trips, torn-tail repair with quarantine,
 * middle-corruption refusal, summary projections, boot listing with lazy
 * load, restart recovery (interrupted turns, unknown tool outcomes,
 * invalidated approvals), pending-input tracking, fork persistence, and the
 * poisoned-writer contract.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  FileSessionStore,
  Kernel,
  SessionsService,
  fileSessions,
  type SessionEvent,
  type SessionId,
} from 'dnt-harness'

let dataDir = ''

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-storage-'))
})

afterAll(async () => {
  await fs.rm(dataDir, { recursive: true, force: true })
})

/** Encode one stamped record the way the canonical log stores it. */
function line(seq: number, event: Record<string, unknown>): string {
  return `${JSON.stringify({ v: 1, seq, timestamp: 1_700_000_000_000 + seq, ...event })}\n`
}

/** Crafted logs live in a fixed test workspace inside the data home. */
function logPath(id: string): string {
  return path.join(dataDir, 'workspaces', 'ws-crafted', 'sessions', id, 'events.jsonl')
}

/**
 * A service over a data dir — fresh per call by default (so listing tests
 * stay exact), or an explicit dir when the test crafted logs there.
 */
async function service(explicitDir?: string): Promise<{ kernel: Kernel; sessions: SessionsService; dir: string }> {
  const dir = explicitDir ?? (await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-storage-svc-')))
  const kernel = new Kernel()
  kernel.ctx.plugin(fileSessions(dir))
  return { kernel, sessions: kernel.ctx.sessions, dir }
}

describe('file session store', () => {
  it('appends durably, reopens with identical history, and continues the sequence', async () => {
    const store = new FileSessionStore({ dir: dataDir })
    await store.init()
    const id = 'session-store-a' as SessionId
    await store.replace(id, [])
    const now = 1_700_000_000_000
    const event = (seq: number, extra: Record<string, unknown>): SessionEvent =>
      ({ v: 1, seq, timestamp: now + seq, type: 'user/message', turnId: 't1', content: `m${seq}`, ...extra }) as unknown as SessionEvent
    await store.append(id, event(1, {}))
    await store.append(id, event(2, {}))
    await store.flush(id)

    const read = await store.read(id)
    expect(read.events.map((e) => e.seq)).toEqual([1, 2])
    expect(read.events[1]?.type).toBe('user/message')
    expect(read.truncatedTail).toBe(false)
  })

  it('defers a relaxed append sync to the checkpoint that batches the prefix', async () => {
    const store = new FileSessionStore({ dir: dataDir })
    await store.init()
    const id = 'session-relaxed' as SessionId
    await store.replace(id, [])
    const event = (seq: number): SessionEvent =>
      ({ v: 1, seq, timestamp: 1_700_000_000_000 + seq, type: 'assistant/chunk', stepId: 's1', delta: `d${seq}` }) as unknown as SessionEvent
    await store.append(id, event(1), { relaxed: true })
    await store.append(id, event(2), { relaxed: true })
    // One checkpoint syncs the whole written prefix.
    await store.checkpoint(id)
    const fresh = new FileSessionStore({ dir: dataDir })
    expect((await fresh.read(id)).events.map((e) => e.seq)).toEqual([1, 2])
    // Nothing is deferred anymore, so further flushes are immediate no-ops.
    await store.flush(id)
    await store.checkpoint(id)
  })

  it('a strict append after relaxed ones keeps flush covering the whole prefix', async () => {
    const store = new FileSessionStore({ dir: dataDir })
    await store.init()
    const id = 'session-mixed' as SessionId
    await store.replace(id, [])
    const event = (seq: number, type: string): SessionEvent =>
      ({ v: 1, seq, timestamp: 1_700_000_000_000 + seq, type }) as unknown as SessionEvent
    await store.append(id, event(1, 'assistant/chunk'), { relaxed: true })
    await store.append(id, event(2, 'assistant/message'))
    await store.flush(id)
    const fresh = new FileSessionStore({ dir: dataDir })
    expect((await fresh.read(id)).events.map((e) => e.type)).toEqual(['assistant/chunk', 'assistant/message'])
  })

  it('repairs a torn final record, quarantines it, and keeps the good prefix', async () => {
    const id = 'session-torn' as SessionId
    const good = line(1, { type: 'turn/start', turnId: 't1' }) + line(2, { type: 'user/message', turnId: 't1', content: 'hi' })
    const torn = '{"v":1,"seq":3,"type":"user/mess'
    await fs.mkdir(path.dirname(logPath(id)), { recursive: true })
    await fs.writeFile(logPath(id), good + torn, 'utf8')

    const store = new FileSessionStore({ dir: dataDir, workspaceId: 'ws-crafted' as never })
    const read = await store.read(id)
    expect(read.events.map((e) => e.seq)).toEqual([1, 2])
    expect(read.truncatedTail).toBe(true)
    // The torn bytes survive verbatim next to the log.
    const dirEntries = await fs.readdir(path.dirname(logPath(id)))
    expect(dirEntries.some((name) => name.startsWith('events.jsonl.partial-'))).toBe(true)
    // The log itself is repaired to the good prefix and stays appendable.
    const onDisk = await fs.readFile(logPath(id), 'utf8')
    expect(onDisk).toBe(good)
  })

  it('repairs to the exact good prefix when the torn final line ends with a newline', async () => {
    const id = 'session-torn-nl' as SessionId
    const good = line(1, { type: 'turn/start', turnId: 't1' })
    await fs.mkdir(path.dirname(logPath(id)), { recursive: true })
    await fs.writeFile(logPath(id), `${good}{"v":1,"seq":2,"ty\n`, 'utf8')

    const store = new FileSessionStore({ dir: dataDir, workspaceId: 'ws-crafted' as never })
    const read = await store.read(id)
    expect(read.events.map((e) => e.seq)).toEqual([1])
    expect(read.truncatedTail).toBe(true)
    expect(await fs.readFile(logPath(id), 'utf8')).toBe(good)
  })

  it('terminates a complete final record missing its newline so the next append stays separate', async () => {
    const id = 'session-no-nl' as SessionId
    const first = line(1, { type: 'turn/start', turnId: 't1' })
    await fs.mkdir(path.dirname(logPath(id)), { recursive: true })
    await fs.writeFile(logPath(id), first.trimEnd(), 'utf8')

    const store = new FileSessionStore({ dir: dataDir, workspaceId: 'ws-crafted' as never })
    expect((await store.read(id)).events.map((e) => e.seq)).toEqual([1])
    const second = JSON.parse(line(2, { type: 'user/message', turnId: 't1', content: 'x' })) as SessionEvent
    await store.append(id, second)
    await store.flush(id)
    const fresh = new FileSessionStore({ dir: dataDir, workspaceId: 'ws-crafted' as never })
    const read = await fresh.read(id)
    expect(read.events.map((e) => e.seq)).toEqual([1, 2])
    expect(read.truncatedTail).toBe(false)
  })

  it('a read queued behind appends never interleaves with them', async () => {
    const store = new FileSessionStore({ dir: dataDir })
    await store.init()
    const id = 'session-read-race' as SessionId
    const event = (seq: number): SessionEvent =>
      ({ v: 1, seq, timestamp: 1_700_000_000_000 + seq, type: 'user/message', turnId: 't1', content: 'y'.repeat(20_000) }) as unknown as SessionEvent
    const writes: Promise<void>[] = []
    const reads: Promise<{ events: SessionEvent[]; truncatedTail: boolean }>[] = []
    for (let seq = 1; seq <= 20; seq++) {
      writes.push(store.append(id, event(seq)))
      if (seq % 4 === 0) reads.push(store.read(id))
    }
    await Promise.all(writes)
    for (const read of await Promise.all(reads)) expect(read.truncatedTail).toBe(false)
    expect((await store.read(id)).events.map((e) => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
  })

  it('middle corruption blocks continuation with a line-numbered error', async () => {
    const id = 'session-corrupt' as SessionId
    const raw = line(1, { type: 'turn/start', turnId: 't1' }) + 'not json at all\n' + line(3, { type: 'turn/end', turnId: 't1', reason: 'completed' })
    await fs.mkdir(path.dirname(logPath(id)), { recursive: true })
    await fs.writeFile(logPath(id), raw, 'utf8')

    const store = new FileSessionStore({ dir: dataDir, workspaceId: 'ws-crafted' as never })
    await expect(store.read(id)).rejects.toThrow(/corrupt record at line 2/)
  })

  it('sequence gaps are corruption, not something to skip', async () => {
    const id = 'session-gap' as SessionId
    const raw = line(1, { type: 'turn/start', turnId: 't1' }) + line(3, { type: 'turn/end', turnId: 't1', reason: 'completed' })
    await fs.mkdir(path.dirname(logPath(id)), { recursive: true })
    await fs.writeFile(logPath(id), raw, 'utf8')
    const store = new FileSessionStore({ dir: dataDir, workspaceId: 'ws-crafted' as never })
    await expect(store.read(id)).rejects.toThrow(/sequence break/)
  })

  it('summary.json is a rebuildable projection for every durable event, written after the log', async () => {
    const { kernel, sessions, dir } = await service()
    const session = sessions.create('ws-summary' as never)
    session.append({ type: 'user/message', turnId: 't1' as never, content: 'hello' })
    session.append({ type: 'turn/end', turnId: 't1' as never, reason: 'completed' })
    await session.durable()
    await sessions.flushSummary(session)

    const store = new FileSessionStore({ dir, workspaceId: 'ws-summary' as never })
    const summary = await store.readSummary(session.id)
    expect(summary?.title).toBeNull()
    // The custom title is null, but the derived one comes from the first user
    // message — that is what makes a listed session show a real name.
    expect(summary?.derivedTitle).toBe('hello')
    expect(summary?.eventCount).toBe(2)
    expect(summary?.lastSeq).toBe(2)
    expect((await store.read(session.id)).events).toHaveLength(2)
    void kernel.stop()
  })

  it('a title derived from the first user message survives a restart without any rename', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-title-restart-'))
    let sessionId = ''
    {
      const { kernel, sessions } = await service(dir)
      const session = sessions.create('ws-title' as never)
      session.append({ type: 'user/message', turnId: 't1' as never, content: 'Explain the storage layer' })
      await session.durable()
      await sessions.flushSummary(session)
      sessionId = session.id
      await kernel.stop()
    }
    // Fresh process over the same home: nothing is loaded in memory, so the
    // listing can only use what the summary projected from events.jsonl.
    const { kernel, sessions } = await service(dir)
    await sessions.boot()
    const listed = sessions.summaries().find((row) => row.id === sessionId)
    expect(listed?.title).toBeNull()
    expect(listed?.derivedTitle).toBe('Explain the storage layer')
    await kernel.stop()
  })

  it('derives a truncated title from a long first message and skips blank ones', async () => {
    const { kernel, sessions } = await service()
    const session = sessions.create('ws-title' as never)
    session.append({ type: 'user/message', turnId: 't1' as never, content: '   ' })
    session.append({ type: 'user/message', turnId: 't1' as never, content: 'x'.repeat(80) })
    await session.durable()
    await sessions.flushSummary(session)
    const summary = sessions.summary(session.id)
    // Blank messages never title a conversation; the collapsed 80-char message
    // truncates to 48 characters plus an ellipsis.
    expect(summary?.derivedTitle).toBe(`${'x'.repeat(48)}…`)
    await kernel.stop()
  })

  it('does not resolve an earlier concurrent durable barrier before its append prefix', async () => {
    const kernel = new Kernel()
    const writes: number[] = []
    let releaseFirst: (() => void) | undefined
    const firstWrite = new Promise<void>((resolve) => { releaseFirst = resolve })
    const store = {
      append: async (_id: SessionId, event: SessionEvent) => {
        writes.push(event.seq)
        if (event.seq === 1) await firstWrite
      },
      flush: async () => {},
      read: async () => ({ events: [] as SessionEvent[], truncatedTail: false }),
      replace: async () => {},
      writeSummary: async () => {},
      readSummary: async () => undefined,
      list: async () => [] as SessionId[],
      remove: async () => {},
    }
    kernel.ctx.plugin((ctx) => { new SessionsService(ctx, 'sessions', { store }) })
    const session = kernel.ctx.sessions.create()
    session.append({ type: 'user/message', turnId: 't1' as never, content: 'one' })
    const first = session.durable()
    session.append({ type: 'turn/end', turnId: 't1' as never, reason: 'completed' })
    const second = session.durable()
    let firstDone = false
    void first.then(() => { firstDone = true })
    await Promise.resolve()
    expect(firstDone).toBe(false)
    expect(writes).toEqual([1])
    releaseFirst?.()
    await first
    expect(writes).toEqual([1, 2])
    await second
    void kernel.stop()
  })
})

describe('sessions service over files', () => {
  it('boot rebuilds stale or missing metadata from canonical tail while keeping history lazy', async () => {
    const { kernel, sessions, dir: shared } = await service()
    await sessions.boot()
    const first = sessions.create('default' as never)
    first.append({ type: 'user/message', turnId: 't1' as never, content: 'remember me' })
    await first.durable()
    await sessions.flushSummary(first)
    const store = new FileSessionStore({ dir: shared, workspaceId: 'default' as never })
    await store.writeSummary(first.id, {
      id: first.id,
      createdAt: 0,
      updatedAt: 0,
      eventCount: 0,
      lastSeq: 0,
      title: null,
    })
    await kernel.stop()

    const second = await service(shared)
    await second.sessions.boot()
    const known = second.sessions.summaries()
    expect(known).toHaveLength(1)
    expect(known[0]?.lastSeq).toBe(1)
    expect(known[0]?.eventCount).toBe(1)
    expect(() => second.sessions.get(first.id)).toThrow(/no session/)
    const resumed = await second.sessions.load(first.id)
    expect(resumed.deriveMessages()).toEqual([{ role: 'user', content: 'remember me' }])
    await fs.rm(path.join(shared, 'workspaces', 'default', 'sessions', first.id, 'summary.json'))
    await second.kernel.stop()

    const third = await service(shared)
    await third.sessions.boot()
    expect(third.sessions.summary(first.id)?.lastSeq).toBe(1)
    await third.kernel.stop()
  })

  it('boot repairs an old summary without projectId from its canonical binding without loading the session', async () => {
    const { kernel, sessions, dir } = await service()
    await sessions.boot()
    const session = sessions.create('ws-summary-project' as never)
    session.append({ type: 'session/project', projectId: 'project-summary' })
    await session.durable()
    await sessions.flushSummary(session)
    const store = new FileSessionStore({ dir, workspaceId: 'ws-summary-project' as never })
    // This is the exact v1 shape written before project bindings joined the
    // rebuildable projection: the canonical prefix is current but incomplete.
    await store.writeSummary(session.id, {
      id: session.id,
      createdAt: session.events[0]!.timestamp,
      updatedAt: session.events[0]!.timestamp,
      eventCount: 1,
      lastSeq: 1,
      title: null,
    })
    await kernel.stop()

    const restarted = await service(dir)
    await restarted.sessions.boot()
    expect(restarted.sessions.summary(session.id)?.projectId).toBe('project-summary')
    expect(() => restarted.sessions.get(session.id)).toThrow(/no session/)
    expect((await store.readSummary(session.id))?.projectId).toBe('project-summary')
    await restarted.kernel.stop()
  })

  it('projects an explicit project unbind as null after restart', async () => {
    const { kernel, sessions, dir } = await service()
    await sessions.boot()
    const session = sessions.create('ws-summary-unbind' as never)
    session.append({ type: 'session/project', projectId: 'project-former' })
    session.append({ type: 'session/project', projectId: null })
    await session.durable()
    await sessions.flushSummary(session)
    await kernel.stop()

    const restarted = await service(dir)
    await restarted.sessions.boot()
    expect(restarted.sessions.summary(session.id)?.projectId).toBeNull()
    expect(() => restarted.sessions.get(session.id)).toThrow(/no session/)
    await restarted.kernel.stop()
  })

  it('projects subagent parentage and the spawn-time project binding from child-meta', async () => {
    const { kernel, sessions, dir } = await service()
    await sessions.boot()
    const child = sessions.create('ws-summary-child' as never)
    child.append({ type: 'session/child-meta', parentSessionId: 'root-summary-1', parentTurnId: 't1', definition: 'explore', projectId: 'project-child' })
    child.append({ type: 'assistant/message', stepId: 's1' as never, content: 'done' })
    await child.durable()
    await sessions.flushSummary(child)
    await kernel.stop()

    const restarted = await service(dir)
    await restarted.sessions.boot()
    const summary = restarted.sessions.summary(child.id)
    expect(summary?.parentSessionId).toBe('root-summary-1')
    expect(summary?.projectId).toBe('project-child')
    expect(() => restarted.sessions.get(child.id)).toThrow(/no session/)

    // A summary written before subagent listing joined the projection
    // rebuilds from the canonical log instead of reporting an unparented row.
    const store = new FileSessionStore({ dir, workspaceId: 'ws-summary-child' as never })
    await store.writeSummary(child.id, {
      id: child.id,
      createdAt: summary!.createdAt,
      updatedAt: summary!.updatedAt,
      eventCount: 2,
      lastSeq: 2,
      title: null,
    })
    await restarted.kernel.stop()

    const third = await service(dir)
    await third.sessions.boot()
    expect(third.sessions.summary(child.id)?.parentSessionId).toBe('root-summary-1')
    expect(third.sessions.summary(child.id)?.projectId).toBe('project-child')
    await third.kernel.stop()
  })

  it('boot lists stored sessions; load runs lazily and preserves history', async () => {
    const { kernel, sessions, dir: shared } = await service()
    await sessions.boot()
    const first = sessions.create('default' as never)
    first.append({ type: 'user/message', turnId: 't1' as never, content: 'remember me' })
    await first.durable()
    // The summary write is async; land it before the kernel goes away.
    await sessions.flushSummary(first)
    await kernel.stop()

    {
      const second = await service(shared)
      // A fresh process knows the session before loading it.
      await second.sessions.boot()
      const known = second.sessions.summaries()
      expect(known.length).toBe(1)
      // get() alone refuses an unloaded session…
      expect(() => second.sessions.get(known[0]!.id)).toThrow(/no session/)
      // …and load() restores the full history.
      const resumed = await second.sessions.load(known[0]!.id)
      expect(resumed.deriveMessages()).toEqual([{ role: 'user', content: 'remember me' }])
      await second.kernel.stop()
    }
  })

  it('restart recovery marks open turns interrupted and unknown tool outcomes stay unknown', async () => {
    const id = 'session-recover' as SessionId
    const raw =
      line(1, { type: 'turn/start', turnId: 't1' }) +
      line(2, { type: 'step/start', turnId: 't1', stepId: 's1' }) +
      line(3, { type: 'user/message', turnId: 't1', content: 'run it' }) +
      line(4, { type: 'assistant/message', stepId: 's1', content: '', toolCalls: [{ id: 'call-9', name: 'Bash', args: { command: 'rm -rf /' } }] }) +
      line(5, { type: 'tool/call', stepId: 's1', call: { id: 'call-9', name: 'Bash', args: { command: 'rm -rf /' } } }) +
      line(6, { type: 'approval/request', approvalId: 'approval-1', call: { id: 'call-9', name: 'Bash', args: { command: 'rm -rf /' } } })
    await fs.mkdir(path.dirname(logPath(id)), { recursive: true })
    await fs.writeFile(logPath(id), raw, 'utf8')

    const { kernel, sessions } = await service(dataDir)
    await sessions.boot()
    const session = await sessions.load(id)
    // Synthesized recovery records, explicitly identified — not fake results.
    const recovered = session.events.find((e) => e.type === 'tool/result' && e.recovery === true)
    expect(recovered).toBeDefined()
    expect(recovered?.type === 'tool/result' && recovered.output).toMatch(/outcome unknown/)
    // Undecided approval invalidated.
    const decision = session.events.find((e) => e.type === 'approval/decision')
    expect(decision?.type === 'approval/decision' && decision.decision).toBe('invalidated')
    // Open turn closed as interrupted — after the recovery records.
    const end = session.events.at(-1)
    expect(end?.type).toBe('turn/end')
    expect(end?.type === 'turn/end' && end.reason).toBe('interrupted')
    // The unknown outcome projects into history so the next turn can inspect
    // real state; nothing was replayed.
    const messages = session.deriveMessages()
    expect(messages.filter((m) => m.role === 'tool')).toEqual([
      { role: 'tool', toolCallId: 'call-9', content: expect.stringMatching(/outcome unknown/) },
    ])
    void kernel.stop()
  })

  it('relaxed streaming appends batch their sync into the next durable barrier', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-relaxed-'))
    try {
      const kernel = new Kernel()
      kernel.ctx.plugin(fileSessions(dir, { relaxedStreamingAppends: true }))
      const sessions = kernel.ctx.sessions
      const session = sessions.create('ws-relaxed' as never)
      for (let seq = 1; seq <= 50; seq++) {
        session.append({ type: 'assistant/chunk', stepId: 's1' as never, delta: `token ${seq} ` })
      }
      session.append({ type: 'assistant/message', stepId: 's1' as never, content: 'the assembled answer' })
      await session.durable()
      await sessions.flushSummary(session)
      // The shutdown checkpoint syncs any remaining deferred prefix before
      // handles close; afterwards the canonical log must be complete on disk.
      await kernel.stop()
      const fresh = new FileSessionStore({ dir, workspaceId: 'ws-relaxed' as never })
      const read = await fresh.read(session.id)
      expect(read.events.filter((event) => event.type === 'assistant/chunk')).toHaveLength(50)
      expect(read.events.at(-1)?.type).toBe('assistant/message')
      await fresh.close?.()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('legacy limit records remain closed and readable after restart', async () => {
    const id = 'session-legacy-limit' as SessionId
    const raw =
      line(1, { type: 'turn/start', turnId: 't1' }) +
      line(2, { type: 'step/start', turnId: 't1', stepId: 's1' }) +
      line(3, { type: 'user/message', turnId: 't1', content: 'old limited turn' }) +
      line(4, { type: 'turn/error', turnId: 't1', kind: 'limit', message: 'turn deadline exceeded' }) +
      line(5, { type: 'turn/end', turnId: 't1', reason: 'limit' })
    await fs.mkdir(path.dirname(logPath(id)), { recursive: true })
    await fs.writeFile(logPath(id), raw, 'utf8')

    const { kernel, sessions } = await service(dataDir)
    await sessions.boot()
    const session = await sessions.load(id)
    const ends = session.events.filter((event) => event.type === 'turn/end')
    expect(ends).toHaveLength(1)
    expect(ends[0]?.type === 'turn/end' && ends[0].reason).toBe('limit')
    expect(session.events.some((event) => event.type === 'turn/end' && event.reason === 'interrupted')).toBe(false)
    expect(session.events.some((event) => event.type === 'turn/error' && event.kind === 'limit')).toBe(true)
    void kernel.stop()
  })

  it('recovery pairs legacy repeated call ids within their own step and turn', async () => {
    const id = 'session-legacy-repeated-call' as SessionId
    const raw =
      line(1, { type: 'turn/start', turnId: 't1' }) +
      line(2, { type: 'step/start', turnId: 't1', stepId: 's1' }) +
      line(3, { type: 'tool/call', stepId: 's1', call: { id: 'c1', name: 'Read', args: { path: 'a' } } }) +
      line(4, { type: 'tool/result', stepId: 's1', callId: 'c1', ok: true, output: 'old answer' }) +
      line(5, { type: 'step/end', turnId: 't1', stepId: 's1' }) +
      line(6, { type: 'turn/end', turnId: 't1', reason: 'completed' }) +
      line(7, { type: 'turn/start', turnId: 't2' }) +
      line(8, { type: 'step/start', turnId: 't2', stepId: 's2' }) +
      line(9, { type: 'tool/call', stepId: 's2', call: { id: 'c1', name: 'Read', args: { path: 'b' } } })
    await fs.mkdir(path.dirname(logPath(id)), { recursive: true })
    await fs.writeFile(logPath(id), raw, 'utf8')

    const { kernel, sessions } = await service(dataDir)
    await sessions.boot()
    const session = await sessions.load(id)
    const recovered = session.events.filter((event) => event.type === 'tool/result' && event.recovery === true)
    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toMatchObject({ stepId: 's2', callId: 'c1', ok: false })
    await kernel.stop()
  })

  it('queued inputs stay pending across a restart and are never auto-executed', async () => {
    const id = 'session-queue' as SessionId
    const raw =
      line(1, { type: 'input/queued', inputId: 'input-a', content: 'first pending' }) +
      line(2, { type: 'turn/start', turnId: 't1' }) +
      line(3, { type: 'user/message', turnId: 't1', content: 'consumed one', inputId: 'input-a' }) +
      line(4, { type: 'turn/end', turnId: 't1', reason: 'completed' }) +
      line(5, { type: 'input/queued', inputId: 'input-b', content: 'still waiting' })
    await fs.mkdir(path.dirname(logPath(id)), { recursive: true })
    await fs.writeFile(logPath(id), raw, 'utf8')

    const { kernel, sessions } = await service(dataDir)
    await sessions.boot()
    const session = await sessions.load(id)
    const pending = sessions.pendingInputs(session)
    expect(pending.map((item) => item.inputId)).toEqual(['input-b'])
    expect(pending[0]?.content).toBe('still waiting')
    void kernel.stop()
  })

  it('fork persists the child log; a fresh service loads it independently', async () => {
    const { kernel, sessions, dir } = await service()
    const parent = sessions.create('ws-fork' as never)
    parent.append({ type: 'user/message', turnId: 't1' as never, content: 'kept' })
    const child = await sessions.fork(parent)
    child.append({ type: 'user/message', turnId: 't9' as never, content: 'child only' })
    await child.durable()

    const fresh = new FileSessionStore({ dir, workspaceId: 'ws-fork' as never })
    const read = await fresh.read(child.id)
    expect(read.events.map((e) => e.seq)).toEqual([1, 2])
    expect(read.events[1]?.type === 'user/message' && read.events[1].content).toBe('child only')
    void kernel.stop()
  })

  it('delete prevents a concurrent load from recovering, caching, or recreating storage', async () => {
    const kernel = new Kernel()
    const id = 'session-load-delete' as SessionId
    let beginRead: (() => void) | undefined
    let releaseRead: (() => void) | undefined
    const readStarted = new Promise<void>((resolve) => { beginRead = resolve })
    const continueRead = new Promise<void>((resolve) => { releaseRead = resolve })
    const remove = vi.fn(async () => {})
    const store = {
      append: async () => {},
      flush: async () => {},
      read: async () => {
        beginRead?.()
        await continueRead
        return { events: [] as SessionEvent[], truncatedTail: false }
      },
      replace: async () => {},
      writeSummary: vi.fn(async () => {}),
      readSummary: async () => ({ id, createdAt: 1, updatedAt: 1, eventCount: 0, lastSeq: 0, title: null, derivedTitle: null, projectId: null, parentSessionId: null }),
      list: async () => [id],
      remove,
    }
    kernel.ctx.plugin((ctx) => { new SessionsService(ctx, 'sessions', { store: store as never }) })
    const sessions = kernel.ctx.sessions
    await sessions.boot()
    const load = sessions.load(id)
    await readStarted
    const deletion = sessions.delete(id)
    releaseRead?.()
    await expect(load).rejects.toThrow(/deleted/)
    await deletion
    expect(remove).toHaveBeenCalledWith(id)
    expect(sessions.has(id)).toBe(false)
    expect(() => sessions.get(id)).toThrow(/no session/)
    expect(store.writeSummary).not.toHaveBeenCalled()
    await kernel.stop()
  })

  it('shutdown drains pending canonical appends before closing the store and rejects late appends', async () => {
    const kernel = new Kernel()
    let beginAppend: (() => void) | undefined
    let releaseAppend: (() => void) | undefined
    const appendStarted = new Promise<void>((resolve) => { beginAppend = resolve })
    const gate = new Promise<void>((resolve) => { releaseAppend = resolve })
    const close = vi.fn(async () => {})
    const store = {
      append: async () => {
        beginAppend?.()
        await gate
      },
      flush: async () => {},
      read: async () => ({ events: [] as SessionEvent[], truncatedTail: false }),
      replace: async () => {},
      writeSummary: async () => {},
      readSummary: async () => undefined,
      list: async () => [] as SessionId[],
      remove: async () => {},
      close,
    }
    kernel.ctx.plugin((ctx) => { new SessionsService(ctx, 'sessions', { store: store as never }) })
    const session = kernel.ctx.sessions.create()
    session.append({ type: 'user/message', turnId: 't1' as never, content: 'drain me' })
    await appendStarted
    const stopping = kernel.stop()
    await Promise.resolve()
    expect(close).not.toHaveBeenCalled()
    releaseAppend?.()
    await stopping
    expect(close).toHaveBeenCalledTimes(1)
    expect(() => session.append({ type: 'turn/end', turnId: 't1' as never, reason: 'completed' })).toThrow(/closing/)
  })

  it('summary uses the title inside its durable prefix, not a later live title', async () => {
    const kernel = new Kernel()
    let releaseFirst: (() => void) | undefined
    const firstWrite = new Promise<void>((resolve) => { releaseFirst = resolve })
    const summaries: Array<{ lastSeq: number; title: string | null }> = []
    const store = {
      append: async (_id: SessionId, event: SessionEvent) => {
        if (event.seq === 1) await firstWrite
      },
      flush: async () => {},
      read: async () => ({ events: [] as SessionEvent[], truncatedTail: false }),
      replace: async () => {},
      writeSummary: async (_id: SessionId, summary: { lastSeq: number; title: string | null }) => { summaries.push(summary) },
      readSummary: async () => undefined,
      list: async () => [] as SessionId[],
      remove: async () => {},
    }
    kernel.ctx.plugin((ctx) => { new SessionsService(ctx, 'sessions', { store: store as never }) })
    const session = kernel.ctx.sessions.create()
    session.append({ type: 'user/message', turnId: 't1' as never, content: 'first' })
    const firstBarrier = session.durable()
    session.append({ type: 'session/title', title: 'later title' })
    releaseFirst?.()
    await firstBarrier
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(summaries).toContainEqual(expect.objectContaining({ lastSeq: 1, title: null }))
    await kernel.stop()
  })

  it('delete drains a queued append before removing storage so it cannot be recreated', async () => {
    const kernel = new Kernel()
    let beginAppend: (() => void) | undefined
    let releaseAppend: (() => void) | undefined
    const appendStarted = new Promise<void>((resolve) => { beginAppend = resolve })
    const appendGate = new Promise<void>((resolve) => { releaseAppend = resolve })
    const order: string[] = []
    let storageExists = false
    const store = {
      append: async () => {
        order.push('append:start')
        beginAppend?.()
        await appendGate
        // This models FileSessionStore.append(), which creates the session
        // directory when a queued write reaches its filesystem operation.
        storageExists = true
        order.push('append:finish')
      },
      flush: async () => {},
      read: async () => ({ events: [] as SessionEvent[], truncatedTail: false }),
      replace: async () => {},
      writeSummary: async () => {},
      readSummary: async () => undefined,
      list: async () => [] as SessionId[],
      remove: async () => {
        order.push('remove')
        storageExists = false
      },
    }
    kernel.ctx.plugin((ctx) => { new SessionsService(ctx, 'sessions', { store }) })
    const sessions = kernel.ctx.sessions
    const session = sessions.create()
    session.append({ type: 'user/message', turnId: 't1' as never, content: 'queued before delete' })
    await appendStarted

    const deletion = sessions.delete(session.id)
    await Promise.resolve()
    expect(order).toEqual(['append:start'])
    expect(storageExists).toBe(false)

    releaseAppend?.()
    await deletion
    expect(order).toEqual(['append:start', 'append:finish', 'remove'])
    expect(storageExists).toBe(false)
    await kernel.stop()
  })

  it('delete removes stored history and blocks a late writer from recreating it', async () => {
    const { kernel, sessions, dir } = await service()
    const session = sessions.create('ws-delete' as never)
    session.append({ type: 'user/message', turnId: 't1' as never, content: 'gone soon' })
    await session.durable()
    const pendingProjection = sessions.flushSummary(session)
    await sessions.delete(session.id)
    await pendingProjection.catch(() => {})
    expect(() => session.append({ type: 'turn/end', turnId: 't1' as never, reason: 'completed' })).toThrow(/deleted/)
    const store = new FileSessionStore({ dir, workspaceId: 'ws-delete' as never })
    expect(await store.list()).not.toContain(session.id)
    void kernel.stop()
  })
})

describe('poisoned writer', () => {
  it('a storage failure rejects the durability barrier and poisons the session', async () => {
    const kernel = new Kernel()
    const boom = new Error('disk on fire')
    const failingStore = {
      append: () => Promise.reject(boom),
      flush: () => Promise.resolve(),
      read: () => Promise.resolve({ events: [] as SessionEvent[], truncatedTail: false }),
      replace: () => Promise.resolve(),
      writeSummary: () => Promise.resolve(),
      readSummary: () => Promise.resolve(undefined),
      list: () => Promise.resolve([]),
      remove: () => Promise.resolve(),
    }
    kernel.ctx.plugin((ctx) => {
      new SessionsService(ctx, 'sessions', { store: failingStore as never })
    })
    const session = kernel.ctx.sessions.create()
    // The append lands in memory but the durable barrier must refuse.
    expect(() => session.append({ type: 'user/message', turnId: 't1' as never, content: 'unsaved' })).not.toThrow()
    await expect(session.durable()).rejects.toThrow(/disk on fire/)
    // Poisoned: later appends throw, because nothing can be claimed durable.
    expect(session.poisoned).toBe(true)
    expect(() => session.append({ type: 'user/message', turnId: 't1' as never, content: 'more' })).toThrow(/disk on fire/)
    void kernel.stop()
  })
})
