/**
 * Boot-time child recovery decides from session summaries which children are
 * settled, and reads canonical logs only for the rest. The verdicts must be
 * exactly what reading every log would produce.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChildExecutor, FileSessionStore, Kernel, SessionsService, fileSessions } from 'dnt-harness'
import { childRecoveryFacts } from '../../src/harness/session/child-recovery-facts.ts'
import type { SessionEvent } from '../../src/harness/session/events.ts'
import type { SessionId, WorkspaceId } from '../../src/util/brand.ts'

const WS = 'ws-main' as WorkspaceId
const FOREIGN = 'ws-foreign' as WorkspaceId

type Appended = Parameters<ReturnType<SessionsService['create']>['append']>[0]

const dirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function tempDir(label: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), `dnt-harness-child-recovery-${label}-`))
  dirs.push(dir)
  return dir
}

interface Fixture {
  readonly dir: string
  readonly ids: Record<string, SessionId>
}

/**
 * Every recovery shape on one store: settled (plain, project-bound, reported
 * background, resumed-then-settled), crash after spawn, a turn-less crash, an
 * owed background report, a resumed run that crashed, a missing parent, a
 * foreign workspace, an uncommitted spawn and a project mismatch.
 */
async function buildFixture(): Promise<Fixture> {
  const dir = await tempDir('fixture')
  const kernel = new Kernel()
  kernel.ctx.plugin(fileSessions(dir))
  await kernel.ctx.sessions.boot()
  const sessions = kernel.ctx.sessions
  const ids: Record<string, SessionId> = {}

  const root = sessions.create(WS)
  const boundRoot = sessions.create(WS)
  ids['root'] = root.id
  ids['boundRoot'] = boundRoot.id
  boundRoot.append({ type: 'session/project', projectId: 'proj-1' })
  root.append({ type: 'user/message', turnId: 'turn-1' as never, content: 'delegate' })
  boundRoot.append({ type: 'user/message', turnId: 'turn-1' as never, content: 'delegate' })

  const child = async (
    name: string,
    parent: SessionId,
    options: { readonly ws?: WorkspaceId; readonly background?: true; readonly projectId?: string; readonly events?: readonly Appended[] } = {},
  ): Promise<SessionId> => {
    const session = sessions.create(options.ws ?? WS)
    session.append({
      type: 'session/child-meta',
      parentSessionId: parent,
      parentTurnId: 'turn-1',
      definition: 'explorer',
      brief: name,
      ...(options.background !== undefined ? { background: true } : {}),
      ...(options.projectId !== undefined ? { projectId: options.projectId } : {}),
    })
    for (const event of options.events ?? []) session.append(event)
    await session.durable()
    ids[name] = session.id
    return session.id
  }
  const completedTurn = (turnId: string): Appended[] => [
    { type: 'turn/start', turnId: turnId as never },
    { type: 'assistant/message', stepId: `${turnId}-s` as never, content: `${turnId} done`, toolCalls: [] },
    { type: 'turn/end', turnId: turnId as never, reason: 'completed' },
  ]
  const spawn = (id: SessionId): Appended => ({ type: 'agent/child-spawn', childSessionId: id, parentTurnId: 'turn-1', definition: 'explorer', brief: 'x' })
  const result = (id: SessionId, status = 'completed'): Appended => ({ type: 'agent/child-result', childSessionId: id, parentTurnId: 'turn-1', status })
  const report = (id: SessionId): Appended => ({ type: 'input/queued', inputId: `report-${id}`, content: 'report', origin: 'child', childSessionId: id })

  const settled = await child('settled', root.id, { events: completedTurn('c1') })
  root.append(spawn(settled))
  root.append(result(settled))

  const crashed = await child('crashed', root.id, {
    events: [{ type: 'turn/start', turnId: 'c2' as never }, { type: 'assistant/message', stepId: 'c2-s' as never, content: 'mid-run', toolCalls: [] }],
  })
  root.append(spawn(crashed))
  const neverRan = await child('neverRan', root.id)
  root.append(spawn(neverRan))

  const owed = await child('owedBackground', root.id, { background: true, events: completedTurn('c3') })
  root.append(spawn(owed))
  root.append(result(owed))
  const reported = await child('reportedBackground', root.id, { background: true, events: completedTurn('c4') })
  root.append(spawn(reported))
  root.append(result(reported))
  root.append(report(reported))

  const resumedSettled = await child('resumedSettled', root.id, {
    events: [...completedTurn('c5a'), { type: 'input/queued', inputId: 'resume-5', content: 'again' }, ...completedTurn('c5b')],
  })
  root.append(spawn(resumedSettled))
  root.append(result(resumedSettled))
  root.append({ type: 'agent/child-resume', childSessionId: resumedSettled, parentTurnId: 'turn-1', inputId: 'resume-5' })
  root.append(result(resumedSettled))

  const resumedCrashed = await child('resumedCrashed', root.id, {
    events: [...completedTurn('c6a'), { type: 'input/queued', inputId: 'resume-6', content: 'again' }, { type: 'turn/start', turnId: 'c6b' as never }],
  })
  root.append(spawn(resumedCrashed))
  root.append(result(resumedCrashed))
  root.append({ type: 'agent/child-resume', childSessionId: resumedCrashed, parentTurnId: 'turn-1', inputId: 'resume-6' })

  // A terminal child turn with no parent result stays uncertain: never reconciled.
  const uncertain = await child('uncertain', root.id, { events: completedTurn('c7') })
  root.append(spawn(uncertain))

  await child('missingParent', 'session-gone' as SessionId, { events: completedTurn('c8') })
  const foreign = await child('foreign', root.id, { ws: FOREIGN, events: completedTurn('c9') })
  root.append(spawn(foreign))
  root.append(result(foreign))
  await child('uncommitted', root.id, { events: completedTurn('c10') })
  const mismatch = await child('projectMismatch', root.id, { projectId: 'proj-other', events: completedTurn('c11') })
  root.append(spawn(mismatch))
  root.append(result(mismatch))

  const boundSettled = await child('boundSettled', boundRoot.id, { projectId: 'proj-1', events: completedTurn('c12') })
  boundRoot.append(spawn(boundSettled))
  boundRoot.append(result(boundSettled))
  // A summary written before the recovery facts were projected.
  const legacy = await child('legacySummary', boundRoot.id, { projectId: 'proj-1', events: completedTurn('c13') })
  boundRoot.append(spawn(legacy))
  boundRoot.append(result(legacy))

  await root.durable()
  await boundRoot.durable()
  await sessions.flushSummary(root)
  await sessions.flushSummary(boundRoot)
  await kernel.stop()

  const legacyStore = new FileSessionStore({ dir, workspaceId: WS })
  const current = await legacyStore.readSummary(legacy)
  if (current === undefined) throw new Error('fixture: missing summary')
  const { childRecovery: _dropped, ...older } = current as typeof current & { childRecovery?: unknown }
  await legacyStore.writeSummary(legacy, older)
  return { dir, ids }
}

async function copyStore(source: string): Promise<string> {
  const target = await tempDir('copy')
  await fs.cp(source, target, { recursive: true })
  return target
}

interface Outcome {
  readonly recovered: number
  readonly index: Record<string, string[]>
  readonly owed: Record<string, string[]>
  readonly reconciled: string[]
  readonly warnings: string[]
  readonly results: Record<string, string[]>
  readonly reads: string[]
}

/** Boot a store and run recovery; `canonicalOnly` hides every summary verdict (the read-everything path). */
async function recover(dir: string, options: { readonly canonicalOnly?: boolean } = {}): Promise<Outcome> {
  const kernel = new Kernel()
  kernel.ctx.plugin(fileSessions(dir))
  await kernel.ctx.sessions.boot()
  const sessions = kernel.ctx.sessions
  if (options.canonicalOnly === true) vi.spyOn(sessions, 'durableSummary').mockReturnValue(undefined)
  const reads: string[] = []
  let recording = true
  const read = sessions.readCanonicalEvents.bind(sessions)
  vi.spyOn(sessions, 'readCanonicalEvents').mockImplementation(async (id) => {
    if (recording) reads.push(id)
    return read(id)
  })
  const warnings: string[] = []
  vi.spyOn(console, 'warn').mockImplementation((message: unknown) => { warnings.push(String(message)) })
  const executor = new ChildExecutor(kernel.ctx)
  const reconcile = vi.spyOn(executor, 'reconcile')
  const recovered = await executor.recoverFromStorage()
  recording = false
  const indexMap = (executor as unknown as { childIdsByRoot: Map<string, Set<string>> }).childIdsByRoot
  const index: Record<string, string[]> = {}
  const owed: Record<string, string[]> = {}
  const results: Record<string, string[]> = {}
  for (const summary of sessions.summaries()) {
    const children = indexMap.get(summary.id)
    if (children !== undefined) index[summary.id] = [...children].sort()
    const pending = executor.owedChildrenOfTurn(summary.id, 'any-turn')
    if (pending.length > 0) owed[summary.id] = [...pending].sort()
    if (typeof summary.parentSessionId !== 'string') {
      const events: readonly SessionEvent[] = await read(summary.id) ?? []
      const records = events.flatMap((event) => event.type === 'agent/child-result' ? [`${event.childSessionId}:${event.status}`] : [])
      if (records.length > 0) results[summary.id] = records
    }
  }
  const reconciled = reconcile.mock.calls.map(([workspace, id]) => `${workspace}:${id}`)
  vi.restoreAllMocks()
  await kernel.stop()
  return { recovered, index, owed, reconciled, warnings: warnings.filter((line) => line.startsWith('agents:')).sort(), results, reads }
}

describe('child recovery from summaries', () => {
  it('produces the same index, owed reports, reconciles and warnings as reading every log', async () => {
    const { dir, ids } = await buildFixture()
    const canonical = await recover(await copyStore(dir), { canonicalOnly: true })
    const fast = await recover(await copyStore(dir))

    // The read-everything path is the reference; pin its verdicts too.
    expect(canonical.recovered).toBe(10)
    expect(canonical.index[ids['root']!]).toEqual([
      ids['settled'], ids['crashed'], ids['neverRan'], ids['owedBackground'], ids['reportedBackground'],
      ids['resumedSettled'], ids['resumedCrashed'], ids['uncertain'],
    ].sort())
    expect(canonical.index[ids['boundRoot']!]).toEqual([ids['boundSettled'], ids['legacySummary']].sort())
    expect(canonical.owed).toEqual({ [ids['root']!]: [ids['owedBackground']] })
    expect([...canonical.reconciled].sort()).toEqual([ids['crashed'], ids['neverRan'], ids['resumedCrashed']].map((id) => `${WS}:${id}`).sort())
    expect(canonical.warnings).toEqual([
      `agents: skipped child ${ids['missingParent']}: its parent session is missing`,
      `agents: skipped child ${ids['foreign']}: its parent belongs to another workspace`,
      `agents: skipped child ${ids['uncommitted']}: its parent never recorded the spawn`,
      `agents: skipped child ${ids['projectMismatch']}: its parent is bound to another project`,
    ].sort())

    const { reads: _canonicalReads, ...expected } = canonical
    const { reads, ...actual } = fast
    expect(actual).toEqual(expected)

    // Settled children are decided without touching their logs, and a parent
    // whose children are all settled is not read either.
    for (const name of ['settled', 'reportedBackground', 'resumedSettled', 'boundSettled', 'legacySummary']) {
      expect(reads).not.toContain(ids[name])
    }
    expect(reads).not.toContain(ids['boundRoot'])
    for (const name of ['crashed', 'neverRan', 'owedBackground', 'resumedCrashed', 'uncertain', 'missingParent', 'foreign', 'uncommitted', 'projectMismatch', 'root']) {
      expect(reads).toContain(ids[name])
    }
  }, 30_000)

  it('reads nothing on the next boot once crashed children are reconciled and reports delivered', async () => {
    const { dir, ids } = await buildFixture()
    const store = await copyStore(dir)
    await recover(store)
    const again = await recover(store)
    expect(again.reconciled).toEqual([])
    expect(again.owed).toEqual({ [ids['root']!]: [ids['owedBackground']] })
    // Still read: the owed report, the uncertain run and the skipped children.
    expect([...again.reads].sort()).toEqual([
      ids['root'], ids['owedBackground'], ids['uncertain'], ids['missingParent'], ids['foreign'], ids['uncommitted'], ids['projectMismatch'],
    ].sort())
  }, 30_000)

  it('rebuilds a summary without recovery facts at boot and projects them', async () => {
    const { dir, ids } = await buildFixture()
    const kernel = new Kernel()
    kernel.ctx.plugin(fileSessions(dir))
    await kernel.ctx.sessions.boot()
    const facts = kernel.ctx.sessions.durableSummary(ids['legacySummary']!)?.childRecovery
    expect(facts).toEqual({ meta: { background: false, projectId: 'proj-1' }, boundProjectId: null, children: {} })
    const onDisk = await new FileSessionStore({ dir, workspaceId: WS }).readSummary(ids['legacySummary']!)
    expect(onDisk?.childRecovery).toEqual(facts)
    expect(kernel.ctx.sessions.durableSummary(ids['root']!)?.childRecovery?.children).toMatchObject({
      [ids['settled']!]: 'settled',
      [ids['crashed']!]: 'open',
      [ids['owedBackground']!]: 'settled',
      [ids['reportedBackground']!]: 'reported',
      [ids['resumedSettled']!]: 'settled',
      [ids['resumedCrashed']!]: 'open',
    })
    expect(kernel.ctx.sessions.durableSummary(ids['boundRoot']!)?.childRecovery?.boundProjectId).toBe('proj-1')
    await kernel.stop()
  }, 30_000)

  it('treats a loaded session as unknown: its summary may describe writes not yet durable', async () => {
    const { dir, ids } = await buildFixture()
    const kernel = new Kernel()
    kernel.ctx.plugin(fileSessions(dir))
    await kernel.ctx.sessions.boot()
    expect(kernel.ctx.sessions.durableSummary(ids['root']!)).toBeDefined()
    await kernel.ctx.sessions.load(ids['root']!)
    expect(kernel.ctx.sessions.durableSummary(ids['root']!)).toBeUndefined()
    await kernel.stop()
  }, 30_000)
})

describe('child recovery facts', () => {
  let seq = 0
  const stamp = (event: Record<string, unknown>): SessionEvent => ({ ...event, seq: ++seq, timestamp: seq }) as unknown as SessionEvent

  it('judges only the current run and only a report queued after its result', () => {
    const facts = childRecoveryFacts([
      stamp({ type: 'agent/child-result', childSessionId: 'early', parentTurnId: 't', status: 'completed' }),
      stamp({ type: 'agent/child-spawn', childSessionId: 'early', parentTurnId: 't', definition: 'd' }),
      stamp({ type: 'agent/child-spawn', childSessionId: 'resumed', parentTurnId: 't', definition: 'd' }),
      stamp({ type: 'agent/child-result', childSessionId: 'resumed', parentTurnId: 't', status: 'completed' }),
      stamp({ type: 'input/queued', inputId: 'r1', content: 'r', origin: 'child', childSessionId: 'resumed' }),
      stamp({ type: 'agent/child-resume', childSessionId: 'resumed', parentTurnId: 't', inputId: 'i' }),
      stamp({ type: 'agent/child-spawn', childSessionId: 'stale-report', parentTurnId: 't', definition: 'd' }),
      stamp({ type: 'input/queued', inputId: 'r2', content: 'r', origin: 'child', childSessionId: 'stale-report' }),
      stamp({ type: 'agent/child-result', childSessionId: 'stale-report', parentTurnId: 't', status: 'failed' }),
      stamp({ type: 'agent/child-spawn', childSessionId: 'nonterminal', parentTurnId: 't', definition: 'd' }),
      stamp({ type: 'agent/child-result', childSessionId: 'nonterminal', parentTurnId: 't', status: 'running' }),
      stamp({ type: 'agent/child-result', childSessionId: 'never-spawned', parentTurnId: 't', status: 'completed' }),
    ])
    expect(facts).toEqual({
      meta: null,
      boundProjectId: null,
      children: { early: 'open', resumed: 'open', 'stale-report': 'settled', nonterminal: 'open' },
    })
  })

  it('leaves out a value the canonical read would treat differently', () => {
    const facts = childRecoveryFacts([
      stamp({ type: 'session/child-meta', parentSessionId: 'p', parentTurnId: 't', definition: 'd', projectId: null }),
      stamp({ type: 'session/project', projectId: 7 }),
    ])
    expect(facts).toEqual({ children: {} })
    expect(childRecoveryFacts([
      stamp({ type: 'session/project', projectId: 'a' }),
      stamp({ type: 'session/project', projectId: null }),
      stamp({ type: 'session/child-meta', parentSessionId: 'p', parentTurnId: 't', definition: 'd', background: true }),
    ])).toEqual({ meta: { background: true, projectId: null }, boundProjectId: null, children: {} })
  })
})

