/**
 * G3 compaction: boundary enforcement (open turn refuses, completed
 * succeeds), byte-identical original log, checkpoint range/provenance, and
 * refusal surfaces instead of looping.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildContext,
  CheckpointStore,
  compactSession,
  DEFAULT_BUDGET,
  Kernel,
  fileSessions,
  messageText,
  WorkspaceService,
} from 'dnt-harness'
import type { ModeDefinition, SessionEvent, SessionId, StepId, TurnId } from 'dnt-harness'
import { createCompactionSummarizer } from '../../src/web/llm-summarizer.ts'

let home = ''
let checkpoints: CheckpointStore

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-g3-compact-'))
  checkpoints = new CheckpointStore(path.join(home, 'workspaces'))
})

afterAll(async () => {
  await fs.rm(home, { recursive: true, force: true })
})

async function sessionWithHistory(): Promise<{ sessionId: SessionId; logPath: string }> {
  const kernel = new Kernel()
  kernel.ctx.plugin(fileSessions(home))
  const sessions = kernel.ctx.sessions
  const ws = new WorkspaceService(home)
  await ws.boot()
  await sessions.boot()
  const session = sessions.create(ws.defaultWorkspace)
  session.append({ type: 'turn/start', turnId: 't1' as TurnId })
  session.append({ type: 'user/message', turnId: 't1' as TurnId, content: 'plan the deploy' })
  session.append({ type: 'assistant/message', stepId: 's1' as StepId, content: 'here is the plan' })
  session.append({ type: 'turn/end', turnId: 't1' as TurnId, reason: 'completed' })
  await session.durable()
  const wsId = ws.defaultWorkspace
  const logPath = path.join(home, 'workspaces', wsId as string, 'sessions', session.id as string, 'events.jsonl')
  await kernel.stop()
  return { sessionId: session.id, logPath }
}

describe('compaction', () => {
  it('an open turn refuses compaction; a completed boundary succeeds', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(fileSessions(home))
    const sessions = kernel.ctx.sessions
    const { sessionId } = await sessionWithHistory()
    await sessions.boot()
    const session = await sessions.load(sessionId)

    // Completed log: succeeds.
    const checkpoint = await compactSession(session, checkpoints, async ({ text }) => `SUMMARY:${text.split('\n').length} lines`, { trigger: 'manual' })
    expect(checkpoint.coversSeq).toBe(4)
    expect(checkpoint.summary).toMatch(/^SUMMARY:/)
    expect(checkpoint.provenance.trigger).toBe('manual')
    expect(typeof checkpoint.provenance.createdAt).toBe('number')

    // Open turn: refuses loudly.
    session.append({ type: 'turn/start', turnId: 't2' as TurnId })
    session.append({ type: 'user/message', turnId: 't2' as TurnId, content: 'new work' })
    await session.durable()
    await expect(compactSession(session, checkpoints, async ({ text }) => text, { trigger: 'manual' })).rejects.toThrow(/completed exchange boundary/)
    await kernel.stop()
  })

  it('compaction only appends: the original JSONL stays byte-identical as a prefix', async () => {
    const { sessionId, logPath } = await sessionWithHistory()
    const before = await fs.readFile(logPath, 'utf8')
    const kernel = new Kernel()
    kernel.ctx.plugin(fileSessions(home))
    await kernel.ctx.sessions.boot()
    const session = await kernel.ctx.sessions.load(sessionId)
    await compactSession(session, checkpoints, async ({ text }) => text.slice(0, 50), { trigger: 'manual' })
    const after = await fs.readFile(logPath, 'utf8')
    // Existing lines are never rewritten; the lifecycle appends follow them.
    expect(after.startsWith(before)).toBe(true)
    const appended = after.slice(before.length).trim().split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as { type: string })
    expect(appended.map((row) => row.type)).toEqual(['compaction/start', 'compaction/end'])
    // Checkpoint file exists beside the untouched log.
    const ckpt = await checkpoints.latest(sessionId)
    expect(ckpt?.coversSeq).toBe(4)
    await kernel.stop()
  })

  it('rejects an insufficient explicit source cap without publishing a checkpoint', async () => {
    const { sessionId, logPath } = await sessionWithHistory()
    const before = await fs.readFile(logPath)
    const kernel = new Kernel()
    kernel.ctx.plugin(fileSessions(home))
    await kernel.ctx.sessions.boot()
    const session = await kernel.ctx.sessions.load(sessionId)
    let calls = 0
    try {
      await expect(compactSession(session, checkpoints, async ({ text }) => {
        calls++
        return text
      }, { trigger: 'manual', maxChars: 10 })).rejects.toThrow(/maxChars/)
      expect(calls).toBe(0)
      expect(await checkpoints.latest(sessionId)).toBeUndefined()
      const after = await fs.readFile(logPath)
      expect(after.subarray(0, before.length).equals(before)).toBe(true)
      const appended = session.events.slice(-2)
      expect(appended.map((event) => event.type)).toEqual(['compaction/start', 'compaction/end'])
      const end = appended[1] as Extract<SessionEvent, { type: 'compaction/end' }>
      expect(end.error).toMatch(/maxChars/)
      expect(end.summary).toBeUndefined()
      expect(end.summaryChars).toBe(0)
    } finally { await kernel.stop() }
  })

  it('a second-chunk failure preserves the previous checkpoint and original JSONL prefix', async () => {
    const { sessionId, logPath } = await sessionWithHistory()
    const kernel = new Kernel()
    kernel.ctx.plugin(fileSessions(home))
    await kernel.ctx.sessions.boot()
    const session = await kernel.ctx.sessions.load(sessionId)
    try {
      const previous = await compactSession(session, checkpoints, async () => 'PREVIOUS CHECKPOINT')
      const checkpointDir = path.join(home, 'workspaces', sessionId, 'checkpoints')
      const namesBefore = await fs.readdir(checkpointDir)
      const checkpointBefore = await fs.readFile(path.join(checkpointDir, `${previous.coversSeq}.json`))
      session.append({ type: 'turn/start', turnId: 't2' as TurnId })
      session.append({ type: 'user/message', turnId: 't2' as TurnId, content: 'x'.repeat(300_000) })
      session.append({ type: 'turn/end', turnId: 't2' as TurnId, reason: 'completed' })
      await session.durable()
      const before = await fs.readFile(logPath)
      let calls = 0
      const summarize = createCompactionSummarizer(() => (async function* () {
        if (++calls === 2) throw new Error('second chunk failed')
        yield { type: 'delta', delta: 'PARTIAL SUMMARY' }
      })(), { providerName: 'test', model: 'test' })
      await expect(compactSession(session, checkpoints, summarize)).rejects.toThrow('second chunk failed')
      expect(calls).toBe(2)
      expect(await checkpoints.latest(sessionId)).toEqual(previous)
      expect(await fs.readdir(checkpointDir)).toEqual(namesBefore)
      expect((await fs.readFile(path.join(checkpointDir, `${previous.coversSeq}.json`))).equals(checkpointBefore)).toBe(true)
      const after = await fs.readFile(logPath)
      expect(after.subarray(0, before.length).equals(before)).toBe(true)
      const end = session.events.at(-1) as Extract<SessionEvent, { type: 'compaction/end' }>
      expect(end.type).toBe('compaction/end')
      expect(end.error).toBe('second chunk failed')
      expect(end.summary).toBeUndefined()
      expect(end.summaryChars).toBe(0)
    } finally { await kernel.stop() }
  })

  it('an empty projected source refuses compaction instead of publishing an empty checkpoint', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(fileSessions(home))
    const sessions = kernel.ctx.sessions
    const ws = new WorkspaceService(home)
    await ws.boot()
    await sessions.boot()
    // A completed turn with no projected messages: the source is empty, so
    // even the no-model fallback must refuse rather than authorize a drop.
    const session = sessions.create(ws.defaultWorkspace)
    session.append({ type: 'turn/start', turnId: 't-empty' as TurnId })
    session.append({ type: 'turn/end', turnId: 't-empty' as TurnId, reason: 'completed' })
    await session.durable()
    try {
      await expect(compactSession(session, checkpoints, createCompactionSummarizer(undefined as never, undefined))).rejects.toThrow(/empty/)
      expect(await checkpoints.latest(session.id)).toBeUndefined()
      const end = session.events.at(-1) as Extract<SessionEvent, { type: 'compaction/end' }>
      expect(end.error).toMatch(/empty/)
      expect(end.summary).toBeUndefined()
      expect(end.summaryChars).toBe(0)
    } finally { await kernel.stop() }
  })

  it('an opaque summarizer failure surfaces instead of retrying', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(fileSessions(home))
    const { sessionId } = await sessionWithHistory()
    await kernel.ctx.sessions.boot()
    const session = await kernel.ctx.sessions.load(sessionId)
    await expect(
      compactSession(session, checkpoints, async () => {
        throw new Error('summarizer exploded')
      }, { trigger: 'manual' }),
    ).rejects.toThrow(/summarizer exploded/)
    await kernel.stop()
  })

  it('the attempt is durably visible: start before, end with the summary after, error on failure', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(fileSessions(home))
    const { sessionId } = await sessionWithHistory()
    await kernel.ctx.sessions.boot()
    const session = await kernel.ctx.sessions.load(sessionId)

    const checkpoint = await compactSession(session, checkpoints, async () => 'THE SUMMARY', { trigger: 'manual', model: 'm-1' })
    const lifecycle = session.events.filter((event) => event.type === 'compaction/start' || event.type === 'compaction/end')
    expect(lifecycle).toHaveLength(2)
    const start = lifecycle[0] as Extract<SessionEvent, { type: 'compaction/start' }>
    const end = lifecycle[1] as Extract<SessionEvent, { type: 'compaction/end' }>
    expect(start.trigger).toBe('manual')
    expect(start.model).toBe('m-1')
    expect(start.seq).toBeLessThan(end.seq)
    expect(end.coversSeq).toBe(checkpoint.coversSeq)
    expect(end.summaryChars).toBe('THE SUMMARY'.length)
    expect(end.summary).toBe('THE SUMMARY')
    expect(end.error).toBeUndefined()
    expect(typeof end.durationMs).toBe('number')

    // The lifecycle never reaches the model: the projection ignores it.
    const { deriveMessages } = await import('dnt-harness')
    expect(deriveMessages(session.events)).toHaveLength(2) // user + assistant only

    // A failed attempt records the reason and leaves no new checkpoint.
    const latestBefore = (await checkpoints.latest(sessionId))?.coversSeq
    await expect(
      compactSession(session, checkpoints, async () => {
        throw new Error('boom')
      }, { trigger: 'automatic' }),
    ).rejects.toThrow(/boom/)
    const failedEnd = [...session.events].reverse().find((event) => event.type === 'compaction/end') as Extract<SessionEvent, { type: 'compaction/end' }>
    expect(failedEnd.error).toContain('boom')
    expect(failedEnd.trigger).toBe('automatic')
    expect((await checkpoints.latest(sessionId))?.coversSeq).toBe(latestBefore)
    await kernel.stop()
  })
})

// ── the compact history window ─────────────────────────────────────────────
// A checkpoint authorizes replacing covered history, optionally duplicated
// as a raw covered tail. All uncovered turns remain eligible; only budget
// pressure drops whole turns, so tool-call/result pairs never split.

let seqCounter = 0
const ev = (row: Record<string, unknown>): SessionEvent => ({ seq: ++seqCounter, timestamp: seqCounter, ...row }) as unknown as SessionEvent

/** Five turns: t1..t4 completed (t1 and t3 carry tool pairs), t5 open. */
const TAIL_LOG: SessionEvent[] = [
  ev({ type: 'turn/start', turnId: 't1' }),
  ev({ type: 'user/message', turnId: 't1', content: 'first request' }),
  ev({ type: 'assistant/message', stepId: 's1', content: 'first answer', toolCalls: [{ id: 'c1', name: 'Read', args: { path: 'a.ts' } }] }),
  ev({ type: 'tool/result', turnId: 't1', callId: 'c1', output: 'a.ts contents', ok: true }),
  ev({ type: 'turn/end', turnId: 't1', reason: 'completed' }),
  ev({ type: 'turn/start', turnId: 't2' }),
  ev({ type: 'user/message', turnId: 't2', content: 'second request' }),
  ev({ type: 'assistant/message', stepId: 's2', content: 'second answer' }),
  ev({ type: 'turn/end', turnId: 't2', reason: 'completed' }),
  ev({ type: 'turn/start', turnId: 't3' }),
  ev({ type: 'user/message', turnId: 't3', content: 'third request' }),
  ev({ type: 'assistant/message', stepId: 's3', content: 'third answer', toolCalls: [{ id: 'c3', name: 'Bash', args: { command: 'ls' } }] }),
  ev({ type: 'tool/result', turnId: 't3', callId: 'c3', output: 'files listed', ok: true }),
  ev({ type: 'turn/end', turnId: 't3', reason: 'completed' }),
  ev({ type: 'turn/start', turnId: 't4' }),
  ev({ type: 'user/message', turnId: 't4', content: 'fourth request' }),
  ev({ type: 'assistant/message', stepId: 's4', content: 'fourth answer' }),
  ev({ type: 'turn/end', turnId: 't4', reason: 'completed' }),
  ev({ type: 'turn/start', turnId: 't5' }),
  ev({ type: 'user/message', turnId: 't5', content: 'open work' }),
]

const COMPACT_WINDOW_MODE: ModeDefinition = {
  id: 'compact-window', name: 'Compact Window',
  instructions: '',
  sources: { history: 'compact', workspaceInstructions: false, skills: 'off', memoryPinned: false, memoryRetrieval: false },
  toolExposure: [],
  permissionDefaults: {},
}

function compactWindowBase(overrides: Partial<Parameters<typeof buildContext>[0]> = {}): Parameters<typeof buildContext>[0] {
  return {
    events: TAIL_LOG,
    mode: { definition: COMPACT_WINDOW_MODE, source: 'workspace' },
    modeRevision: 1,
    model: 'test-model',
    providerName: 'test-provider',
    schemas: [],
    activeSkills: [],
    pinnedMemory: [],
    budget: DEFAULT_BUDGET,
    ...overrides,
  }
}

const historyText = (assembled: ReturnType<typeof buildContext>): string =>
  assembled.messages.map((message) => messageText(message.content)).join('\n')

describe('compact history window', () => {
  it('a checkpoint duplicates the covered tail and retains all uncovered turns', () => {
    const assembled = buildContext(compactWindowBase({ compaction: { summary: 'CHECKPOINT SUMMARY', coversSeq: 14 }, compactionTailTurns: 2 }))
    const text = historyText(assembled)

    // The summary rides; t1's raw content is gone with it.
    expect(text).toContain('CHECKPOINT SUMMARY')
    expect(text).not.toContain('first request')
    // Covered tail is t2+t3; uncovered t4 and the open turn also survive.
    expect(text).toContain('second request')
    expect(text).toContain('second answer')
    expect(assembled.messages.find((message) => message.role === 'assistant' && message.toolCalls?.[0]?.id === 'c3')?.toolCalls).toEqual([{ id: 'c3', name: 'Bash', args: { command: 'ls' } }])
    expect(assembled.messages.find((message) => message.role === 'tool' && message.toolCallId === 'c3')?.content).toBe('files listed')
    expect(text).toContain('third answer')
    expect(text).toContain('files listed')
    expect(text).toContain('fourth request')
    expect(text).toContain('open work')

    expect(assembled.sections.some((section) => section.kind === 'compaction')).toBe(true)
    expect(assembled.manifest.history.compactedThroughSeq).toBe(14)
    expect(assembled.manifest.history.checkpointHash).toBeTypeOf('string')
    expect(assembled.manifest.history.includedSeqRange).toEqual([6, 20])
    expect(assembled.manifest.history.omittedSeqRange).toEqual([1, 5])
    expect(assembled.manifest.omissions.some((omission) => omission.includes('compaction tail dropped'))).toBe(false)
  })

  it('without a checkpoint the compact window keeps the full log', () => {
    const assembled = buildContext(compactWindowBase())
    const text = historyText(assembled)

    expect(text).toContain('first request')
    expect(text).toContain('second request')
    expect(text).toContain('third request')
    expect(text).toContain('fourth request')
    expect(text).toContain('open work')
    expect(assembled.sections.some((section) => section.kind === 'compaction')).toBe(false)
    expect(assembled.manifest.history.compactedThroughSeq).toBeUndefined()
    expect(assembled.manifest.omissions.some((omission) => omission.includes('compaction tail'))).toBe(false)
  })

  it('a checkpoint covering everything but the open turn keeps only the open turn', () => {
    const assembled = buildContext(compactWindowBase({ compaction: { summary: 'CHECKPOINT SUMMARY', coversSeq: 18 }, compactionTailTurns: 0 }))
    const text = historyText(assembled)

    expect(text).toContain('CHECKPOINT SUMMARY')
    expect(text).toContain('open work')
    expect(text).not.toContain('fourth request')
    expect(assembled.manifest.history.includedSeqRange).toEqual([19, 20])
    expect(assembled.manifest.omissions.some((omission) => omission.includes('compaction tail'))).toBe(false)
  })

  it('tail 0 removes covered duplication but keeps every uncovered turn', () => {
    const assembled = buildContext(compactWindowBase({ compaction: { summary: 'CHECKPOINT SUMMARY', coversSeq: 5 }, compactionTailTurns: 0 }))
    const text = historyText(assembled)

    expect(text).toContain('CHECKPOINT SUMMARY')
    expect(text).toContain('open work')
    expect(text).not.toContain('first request')
    for (const turn of ['second', 'third', 'fourth']) {
      expect(text).toContain(`${turn} request`)
      expect(text).toContain(`${turn} answer`)
    }
    expect(assembled.manifest.history.includedSeqRange).toEqual([6, 20])
    expect(assembled.manifest.omissions.some((omission) => omission.includes('compaction tail dropped'))).toBe(false)
  })

  it('tail 1 retains the latest covered completed turn from its start', () => {
    const assembled = buildContext(compactWindowBase({ compaction: { summary: 'CHECKPOINT SUMMARY', coversSeq: 18 }, compactionTailTurns: 1 }))
    const text = historyText(assembled)
    expect(text).toContain('fourth request')
    expect(text).toContain('fourth answer')
    expect(text).toContain('open work')
    expect(text).not.toContain('third request')
    expect(assembled.manifest.history.includedSeqRange).toEqual([15, 20])
    expect(assembled.manifest.omissions.some((omission) => omission.includes('compaction tail dropped'))).toBe(false)
  })

  function uncoveredLog(): SessionEvent[] {
    const rows: Record<string, unknown>[] = []
    for (let turn = 1; turn <= 7; turn++) {
      rows.push(
        { type: 'turn/start', turnId: `long-${turn}` },
        { type: 'user/message', turnId: `long-${turn}`, content: turn === 2 ? 'DECISION: keep the compatibility API' : `request ${turn}` },
        { type: 'assistant/message', stepId: `long-s${turn}`, content: `answer ${turn}: ${'x'.repeat(800)}` },
        { type: 'turn/end', turnId: `long-${turn}`, reason: 'completed' },
      )
    }
    rows.push({ type: 'turn/start', turnId: 'long-open' }, { type: 'user/message', turnId: 'long-open', content: 'OPEN TASK: finish compatibility tests' })
    return rows.map((row, index) => ({ ...row, seq: index + 1, timestamp: index + 1 }) as SessionEvent)
  }

  it('the default tail never discards an early decision among more than four uncovered turns', () => {
    const assembled = buildContext(compactWindowBase({ events: uncoveredLog(), compaction: { summary: 'covered first turn', coversSeq: 4 } }))
    expect(historyText(assembled)).toContain('DECISION: keep the compatibility API')
    expect(assembled.manifest.history.includedSeqRange).toEqual([1, 30])
    expect(assembled.manifest.omissions.some((omission) => omission.includes('compaction tail dropped'))).toBe(false)
  })

  it.each(['none', 'recent'] as const)('history %s ignores checkpoint and tail settings', (history) => {
    const mode = { definition: { ...COMPACT_WINDOW_MODE, sources: { ...COMPACT_WINDOW_MODE.sources, history } }, source: 'workspace' as const }
    const assembled = buildContext(compactWindowBase({ mode, compaction: { summary: 'CHECKPOINT SUMMARY', coversSeq: 18 }, compactionTailTurns: 0 }))
    const unchanged = buildContext(compactWindowBase({ mode }))
    expect(assembled.messages).toEqual(unchanged.messages)
    expect(assembled.manifest.history.includedSeqRange).toEqual(history === 'none' ? [19, 20] : [1, 20])
    expect(historyText(assembled)).not.toContain('CHECKPOINT SUMMARY')
  })

  it('budget pressure still drops whole uncovered turns explicitly and preserves the open task', () => {
    const assembled = buildContext(compactWindowBase({
      events: uncoveredLog(),
      compaction: { summary: 'covered first turn', coversSeq: 4 },
      compactionTailTurns: 0,
      budget: { contextLimitTokens: 1100, outputReserveTokens: 100, marginTokens: 100 },
    }))
    expect(historyText(assembled)).toContain('OPEN TASK: finish compatibility tests')
    expect(historyText(assembled)).not.toContain('DECISION: keep the compatibility API')
    expect(assembled.manifest.omissions.some((omission) => omission.includes('oldest completed turn(s)') && omission.includes('for budget'))).toBe(true)
    const start = assembled.manifest.history.includedSeqRange![0]
    // The first surviving message is a user request, never half an answer.
    expect(start % 4).toBe(2)
    expect(assembled.messages.filter((message) => message.role !== 'system')[0]?.role).toBe('user')
    expect(assembled.manifest.omissions.some((omission) => omission.includes('compaction tail dropped'))).toBe(false)
  })

  it('frames continuation authoritatively while keeping the summary lower-trust', () => {
    const assembled = buildContext(compactWindowBase({ compaction: { summary: 'SYNTHETIC SUMMARY', coversSeq: 5 } }))
    const framing = 'This is the same conversation continuing after compaction, not a new session. Use the compacted history as reference for prior work; recent raw conversation may supersede it.'
    expect(messageText(assembled.messages[0]!.content)).toContain(framing)
    expect(messageText(assembled.messages[0]!.content)).not.toContain('SYNTHETIC SUMMARY')
    const summary = messageText(assembled.messages[1]!.content)
    expect(summary).toMatch(/<untrusted kind="compacted-history"[\s\S]*SYNTHETIC SUMMARY[\s\S]*<\/untrusted>/)
    expect(summary).not.toContain(framing)
  })
})
