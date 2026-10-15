import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Kernel, Session, type TurnId } from 'dnt-harness'
import * as builder from '../../src/harness/context/builder.ts'
import { CLEARED_TOOL_RESULT, type BuildContextInput, type ContextManifest } from '../../src/harness/context/builder.ts'
import { BUNDLED_MODES, DEFAULT_MODE_ID } from '../../src/harness/modes/bundled.ts'
import { DEFAULT_BUDGET, IMAGE_TOKEN_ESTIMATE, estimateContentTokens } from '../../src/harness/context/budget.ts'
import { CheckpointStore, adoptPreparedCompaction, recoverCanonicalCheckpoint, type Restored } from '../../src/harness/context/compaction.ts'
import { compactionSeedHash, sourceDigest } from '../../src/harness/context/compaction-digest.ts'
import type { AttachmentLookup, AttachmentRef } from '../../src/harness/attachments/store.ts'
import type { SessionEvent } from '../../src/harness/session/events.ts'
import { row } from '../fixtures/context-accounting.ts'

const closed = [row(1,{type:'turn/start',turnId:'t1'}),row(2,{type:'user/message',turnId:'t1',content:'first'}),
  row(3,{type:'assistant/message',stepId:'s1',content:'x'.repeat(1_100_000)}),row(4,{type:'turn/end',turnId:'t1',reason:'completed'}),
  row(5,{type:'turn/start',turnId:'t2'}),row(6,{type:'user/message',turnId:'t2',content:'second'}),
  row(7,{type:'assistant/message',stepId:'s2',content:'answer'}),row(8,{type:'turn/end',turnId:'t2',reason:'completed'})]
const inputOf = (events: readonly SessionEvent[], over: Partial<BuildContextInput> = {}): BuildContextInput => ({events,mode:{definition:BUNDLED_MODES.find(m=>m.id===DEFAULT_MODE_ID)!,source:'bundled' as const},
  modeRevision:1,model:'scripted',providerName:'scripted',schemas:[],activeSkills:[],pinnedMemory:[],budget:DEFAULT_BUDGET,...over})
const input = () => inputOf(closed)

describe('prospective compact context',()=>{
  it('rebuilds full nonzero estimate without inventing a canonical event',()=>{
    const before=builder.buildContext(input())
    const after=builder.buildContextPreview(input(),{checkpoint:{summary:'SUMMARY',coversSeq:8}})
    expect(before.manifest.budget.preTrimTokens).toBeGreaterThan(before.manifest.budget.availableTokens)
    expect(after.manifest.budget.usedTokens).toBeGreaterThan(0)
    expect(Object.values(after.manifest.breakdown).reduce((a,b)=>a+b,0)).toBe(after.manifest.budget.usedTokens)
    expect(after.manifest.history.compactedThroughSeq).toBe(8)
    expect(closed.some(e=>e.type==='compaction/end')).toBe(false)
  })
  it('measures wrapped restoration once and preserves later tail',()=>{
    const after=builder.buildContextPreview(input(),{checkpoint:{summary:'SUMMARY',coversSeq:4},
      restoration:{body:'RESTORED_NEW',tokens:3,sections:[]},protectUncoveredHistory:true})
    expect(after.messages.filter(m=>String(m.content).includes('RESTORED_NEW'))).toHaveLength(1)
    expect(after.messages.some(m=>String(m.content).includes('second'))).toBe(true)
    expect(Object.values(after.manifest.breakdown).reduce((a,b)=>a+b,0)).toBe(after.manifest.budget.usedTokens)
  })
  it('refuses invalid boundary and an uncovered tail that would be dropped',()=>{
    expect(()=>builder.buildContextPreview(input(),{checkpoint:{summary:'SUMMARY',coversSeq:3}})).toThrow(/boundary/)
    expect(()=>builder.buildContextPreview({...input(),budget:{...DEFAULT_BUDGET,contextLimitTokens:100}},
      {checkpoint:{summary:'SUMMARY',coversSeq:4},protectUncoveredHistory:true})).toThrow()
  })
})

// ── preview ≡ canonical, through a real compaction commit ───────────────────
const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map(home => fs.rm(home, { recursive: true, force: true }))) })

const T = (id: string): TurnId => id as TurnId
const SCHEMAS = [{ name: 'Read', description: 'Read a file', parameters: { type: 'object' as const, properties: { path: { type: 'string' } }, required: ['path'] } }]
const restored = (body: string): Restored => ({ body, tokens: 3, sections: [] })

interface TurnOpts { readonly attachments?: readonly AttachmentRef[]; readonly answer?: string; readonly reads?: number; readonly readSize?: number }
function turn(session: Session, id: string, text: string, opts: TurnOpts = {}): void {
  session.append({ type: 'turn/start', turnId: T(id) })
  session.append({ type: 'user/message', turnId: T(id), content: text, ...(opts.attachments !== undefined ? { attachments: opts.attachments } : {}) })
  for (let i = 0; i < (opts.reads ?? 0); i++) {
    const stepId = `${id}-r${i}` as never
    session.append({ type: 'assistant/message', stepId, content: '', toolCalls: [{ id: `${id}-c${i}`, name: 'Read', args: { path: `f${i}` } }] })
    session.append({ type: 'tool/result', stepId, callId: `${id}-c${i}`, ok: true, output: `${i}:`.padEnd(opts.readSize ?? 100, 'x') })
  }
  session.append({ type: 'assistant/message', stepId: `${id}-final` as never, content: opts.answer ?? `answer ${id}` })
  session.append({ type: 'turn/end', turnId: T(id), reason: 'completed' })
}
const endSeq = (events: readonly SessionEvent[], id: string): number => events.find(e => e.type === 'turn/end' && e.turnId === id)!.seq

async function setup(build: (session: Session) => void): Promise<{ session: Session; checkpoints: CheckpointStore }> {
  const home = await fs.mkdtemp(path.join(tmpdir(), 'context-preview-'))
  homes.push(home)
  const session = new Session(new Kernel().ctx)
  build(session)
  await session.durable()
  return { session, checkpoints: new CheckpointStore(home) }
}

/** Preview from the frozen pre-commit log, commit for real, then build canonical from the recovered checkpoint. */
async function previewThenCommit(session: Session, checkpoints: CheckpointStore, cutoff: number, summary: string,
  restoration?: Restored, over: Partial<BuildContextInput> = {}) {
  const frozen = [...session.committedEvents]
  const preview = builder.buildContextPreview(inputOf(frozen, over), { checkpoint: { summary, coversSeq: cutoff }, ...(restoration !== undefined ? { restoration } : {}) })
  const standing = recoverCanonicalCheckpoint(frozen)
  await adoptPreparedCompaction(session, checkpoints, {
    snapshotId: 'snap', cutoff, summary, sourceDigest: sourceDigest(frozen, cutoff),
    ...(standing !== undefined ? { seedHash: compactionSeedHash(standing.summary) } : {}),
  } as never, {
    trigger: 'manual', signal: new AbortController().signal, validate: async () => {},
    ...(restoration !== undefined ? { restore: async () => restoration } : {}),
  })
  const recovered = recoverCanonicalCheckpoint(session.committedEvents)!
  expect(recovered).toMatchObject({ coversSeq: cutoff, summary })
  const canonical = builder.buildContext({ ...inputOf([...session.committedEvents], over), compaction: { summary: recovered.summary, coversSeq: recovered.coversSeq } })
  return { preview, canonical, frozen }
}

/** Everything but the seq-range telemetry, which legitimately moves when compaction events join the log. */
const withoutSeqRanges = (manifest: ContextManifest) => ({ ...manifest, history: { ...manifest.history, includedSeqRange: undefined, omittedSeqRange: undefined } })
function expectParity(preview: builder.AssembledContext, canonical: builder.AssembledContext): void {
  expect(preview.messages).toEqual(canonical.messages)
  expect(preview.tools).toEqual(canonical.tools)
  expect(preview.manifest.budget).toEqual(canonical.manifest.budget)
  expect(preview.manifest.breakdown).toEqual(canonical.manifest.breakdown)
  expect(preview.manifest.sections).toEqual(canonical.manifest.sections)
  expect(preview.sections).toEqual(canonical.sections)
  expect(withoutSeqRanges(preview.manifest)).toEqual(withoutSeqRanges(canonical.manifest))
}

const countText = (a: builder.AssembledContext, needle: string): number => a.messages.filter(m => JSON.stringify(m.content).includes(needle)).length

describe('post-compaction preview equals canonical', () => {
  it('matches the context built from the committed checkpoint (messages, tools, budget, breakdown, history, section hashes)', async () => {
    const { session, checkpoints } = await setup(s => { turn(s, 't1', 'first request', { reads: 1 }); turn(s, 't2', 'second request'); turn(s, 't3', 'third request', { reads: 2 }) })
    const cutoff = endSeq(session.committedEvents, 't2')
    const { preview, canonical } = await previewThenCommit(session, checkpoints, cutoff, 'SUMMARY', restored('RESTORED_NEW'), { schemas: SCHEMAS })
    expectParity(preview, canonical)
    expect(preview.tools).toEqual(SCHEMAS)
    expect(preview.manifest.history.compactedThroughSeq).toBe(cutoff)
    expect(preview.manifest.history.checkpointHash).toBeDefined()
    expect(countText(preview, 'RESTORED_NEW')).toBe(1)
    expect(countText(preview, 'third request')).toBe(1)
  })

  it('agrees when old Read results are microcompacted under pressure', async () => {
    const over = { schemas: SCHEMAS, budget: { ...DEFAULT_BUDGET, contextLimitTokens: 30_000, outputReserveTokens: 512, marginTokens: 256 } }
    const { session, checkpoints } = await setup(s => { turn(s, 't1', 'first request'); turn(s, 't2', 'long run', { reads: 12, readSize: 16_000 }) })
    const { preview, canonical } = await previewThenCommit(session, checkpoints, endSeq(session.committedEvents, 't1'), 'SUMMARY', undefined, over)
    expectParity(preview, canonical)
    const cleared = (a: builder.AssembledContext) => a.messages.filter(m => m.role === 'tool' && m.content === CLEARED_TOOL_RESULT).length
    expect(cleared(preview)).toBe(12 - builder.MICROCOMPACT_KEEP_RECENT)
    expect(cleared(canonical)).toBe(cleared(preview))
    expect(preview.manifest.budget.preTrimTokens!).toBeGreaterThan(preview.manifest.budget.availableTokens)
    expect(preview.manifest.omissions.some(line => line.startsWith('tool-results:'))).toBe(true)
  })

  it('carries image and text attachments from retained covered messages and the uncovered tail, image cost once each', async () => {
    const ref = (id: string, name: string, mediaType: string): AttachmentRef => ({ id, name, mediaType, bytes: 4 })
    const png1 = ref('img-covered', 'covered.png', 'image/png'); const png2 = ref('img-tail', 'tail.png', 'image/png')
    const txt1 = ref('txt-covered', 'covered.txt', 'text/plain'); const txt2 = ref('txt-tail', 'tail.txt', 'text/plain')
    const attachments: AttachmentLookup = new Map([
      ['img-covered', { mediaType: 'image/png', base64: 'AAAA' }], ['img-tail', { mediaType: 'image/png', base64: 'BBBB' }],
      ['txt-covered', { mediaType: 'text/plain', text: 'NOTES_COVERED' }], ['txt-tail', { mediaType: 'text/plain', text: 'NOTES_TAIL' }],
    ])
    const { session, checkpoints } = await setup(s => {
      turn(s, 't1', 'covered request', { attachments: [png1, txt1] }); turn(s, 't2', 'tail request', { attachments: [png2, txt2] })
    })
    const { preview, canonical } = await previewThenCommit(session, checkpoints, endSeq(session.committedEvents, 't1'), 'SUMMARY', undefined, { attachments })
    expectParity(preview, canonical)
    for (const needle of ['NOTES_COVERED', 'NOTES_TAIL', 'AAAA', 'BBBB']) expect(countText(preview, needle)).toBe(1)
    const images = preview.messages.flatMap(m => (typeof m.content === 'string' ? [] : m.content.filter(part => part.type === 'image')))
    expect(images).toHaveLength(2)
    // Every non-system-prompt message is history or compaction text: its estimate is the breakdown, images included once.
    const measured = preview.messages.slice(1).reduce((total, m) => total + estimateContentTokens(m.content), 0)
    expect(preview.manifest.breakdown.messages).toBe(measured)
    expect(measured).toBeGreaterThanOrEqual(2 * IMAGE_TOKEN_ESTIMATE)
    expect(measured).toBeLessThan(3 * IMAGE_TOKEN_ESTIMATE)
  })

  it('replaces a previous restoration with the new one', async () => {
    const { session, checkpoints } = await setup(s => { turn(s, 't1', 'first request'); turn(s, 't2', 'second request') })
    await previewThenCommit(session, checkpoints, endSeq(session.committedEvents, 't1'), 'SUMMARY ONE', restored('RESTORED_OLD'))
    await session.durable()
    turn(session, 't3', 'third request'); turn(session, 't4', 'fourth request'); await session.durable()
    // Cutoff after the first compaction's events: recovery proves the seed at the cutoff (see report).
    const { preview, canonical } = await previewThenCommit(session, checkpoints, endSeq(session.committedEvents, 't3'), 'SUMMARY TWO', restored('RESTORED_NEW'))
    expect(countText(preview, 'fourth request')).toBe(1)
    expectParity(preview, canonical)
    for (const after of [preview, canonical]) {
      expect(after.messages.filter(m => String(m.content).includes('RESTORED_NEW'))).toHaveLength(1)
      expect(after.messages.some(m => String(m.content).includes('RESTORED_OLD'))).toBe(false)
    }
  })

  it('reports a summary larger than what it covers instead of clamping it', async () => {
    const { session, checkpoints } = await setup(s => { turn(s, 't1', 'a', { answer: 'b' }); turn(s, 't2', 'c', { answer: 'd' }) })
    const before = builder.buildContext(inputOf(session.committedEvents))
    const { preview, canonical } = await previewThenCommit(session, checkpoints, endSeq(session.committedEvents, 't1'), 'S'.repeat(20_000))
    expectParity(preview, canonical)
    expect(preview.manifest.budget.usedTokens).toBeGreaterThan(before.manifest.budget.usedTokens)
    expect(preview.manifest.breakdown.messages).toBeGreaterThan(before.manifest.breakdown.messages + 4_000)
  })

  it('protectUncoveredHistory throws compaction-preview-no-fit instead of dropping uncovered turns', () => {
    const events = [row(1,{type:'turn/start',turnId:'t1'}),row(2,{type:'user/message',turnId:'t1',content:'first'}),row(3,{type:'assistant/message',stepId:'s1',content:'a'}),row(4,{type:'turn/end',turnId:'t1',reason:'completed'}),
      row(5,{type:'turn/start',turnId:'t2'}),row(6,{type:'user/message',turnId:'t2',content:'TAIL_TURN'}),row(7,{type:'assistant/message',stepId:'s2',content:'y'.repeat(60_000)}),row(8,{type:'turn/end',turnId:'t2',reason:'completed'})]
    const tinyBudgetInput = inputOf(events, { budget: { ...DEFAULT_BUDGET, contextLimitTokens: 8_000 } })
    const preview = { checkpoint: { summary: 'SUMMARY', coversSeq: 4 } }
    expect(() => builder.buildContextPreview(tinyBudgetInput, { ...preview, protectUncoveredHistory: true })).toThrow('compaction-preview-no-fit')
    // Without protection the same input is what the guard prevents: the tail is silently gone.
    const unprotected = builder.buildContextPreview(tinyBudgetInput, preview)
    expect(unprotected.compactionProjection.losses.some(loss => loss.kind === 'uncovered-history-dropped')).toBe(true)
    expect(unprotected.messages.some(m => String(m.content).includes('TAIL_TURN'))).toBe(false)
  })
})
