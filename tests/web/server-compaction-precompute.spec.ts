/**
 * Precomputed compaction through the real web server: a summary is written in
 * the background right after a turn settles, while the conversation goes on, and
 * a later compaction adopts it instead of waiting for a new one. Real server,
 * real log, scripted provider whose summary request is held by a gate.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createWebServer, type LlmProvider, type WebServer } from 'dnt-harness'
import type { ModelRequest, StreamEvent } from '../../src/harness/llm/types.ts'
import type { HarnessLimits } from '../../src/harness/limits.ts'
import { COMPACTION_HANDOFF_MARKER } from '../../src/web/compaction-generator.ts'

const SUMMARY = 'BACKGROUND SUMMARY'

interface Handoff { request: ModelRequest; release(): void; ended: boolean }

/**
 * Chat turns answer at once. A handoff (summary) request waits on its own gate, so
 * a test decides when it finishes; it stops, like a real provider, when its signal aborts.
 */
function gatedProvider(options: { holdFirstHandoff?: boolean; longAnswers?: boolean } = {}) {
  const requests: ModelRequest[] = []
  const handoffs: Handoff[] = []
  let active = 0
  let maxActive = 0
  let turn = 0
  const llm: LlmProvider = {
    name: 'scripted',
    models: ['scripted'],
    stream(request, streamOptions) {
      requests.push(request)
      const text = request.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
      const isHandoff = text.includes(COMPACTION_HANDOFF_MARKER)
      return (async function* (): AsyncIterable<StreamEvent> {
        if (isHandoff) {
          const handoff: Handoff = { request, release: () => {}, ended: false }
          handoffs.push(handoff)
          active++
          maxActive = Math.max(maxActive, active)
          try {
            const hold = options.holdFirstHandoff === true && handoffs.length === 1
            if (hold) {
              await new Promise<void>((resolve, reject) => {
                handoff.release = resolve
                streamOptions?.signal?.addEventListener('abort', () => reject(streamOptions.signal?.reason), { once: true })
              })
            }
            yield { type: 'delta', delta: SUMMARY }
            yield { type: 'usage', usage: { inputTokens: 800, outputTokens: 25 } }
            yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
          } finally {
            active--
            handoff.ended = true
          }
          return
        }
        yield { type: 'delta', delta: `answer ${++turn} ${'filler '.repeat(options.longAnswers === true ? 700 : 0)}` }
        yield { type: 'usage', usage: { inputTokens: 500, outputTokens: 10 } }
        yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
      })()
    },
  }
  return { llm, requests, handoffs, maxConcurrentHandoffs: () => maxActive }
}

const servers: WebServer[] = []
const homes = new Map<WebServer, string>()
afterAll(async () => {
  for (const server of servers) await server.close().catch(() => {})
  for (const server of servers) {
    const home = homes.get(server)
    if (home !== undefined) await fs.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

// Retaining no covered text verbatim makes the checkpoint's saving the whole covered turn,
// so a candidate over a few long answers clears the minimum gain the way a real one would.
const ON: Partial<HarnessLimits> = { compactionEffectiveEnabled: true, compactionPrecomputeEnabled: true, compactionPrecomputePressure: 0.0001, compactionRetainTokens: 0 }

async function start(llm: LlmProvider, limits: Partial<HarnessLimits>) {
  const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-precompute-'))
  const server = await createWebServer({ home, providers: [llm], configFile: path.join(home, 'p.json'), limits })
  servers.push(server)
  homes.set(server, home)
  const wsId = (await (await fetch(`${server.url}/api/workspaces`)).json() as { id: string }[])[0]!.id
  const { id } = await (await fetch(`${server.url}/api/workspaces/${wsId}/sessions`, { method: 'POST' })).json() as { id: string }
  return { server, home, base: server.url, wsId, id, logPath: path.join(home, 'workspaces', wsId, 'sessions', id, 'events.jsonl') }
}

async function until<T>(probe: () => T | undefined | Promise<T | undefined>, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('condition not met before deadline')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function chat(s: { base: string; wsId: string; id: string; logPath: string }, content: string, turns: number): Promise<void> {
  const response = await fetch(`${s.base}/api/workspaces/${s.wsId}/sessions/${s.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }) })
  expect(response.ok).toBe(true)
  await until(async () => {
    const log = await fs.readFile(s.logPath, 'utf8').catch(() => '')
    const ended = log.trim().split('\n').filter((line) => line !== '' && JSON.parse(line).type === 'turn/end').length
    const sessions = await (await fetch(`${s.base}/api/workspaces/${s.wsId}/sessions`)).json() as { id: string; status: string }[]
    return ended === turns && sessions.find((session) => session.id === s.id)?.status === 'idle' ? true : undefined
  })
}

const readLog = async (logPath: string): Promise<Record<string, unknown>[]> =>
  (await fs.readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
const compact = (s: { base: string; wsId: string; id: string }) => fetch(`${s.base}/api/workspaces/${s.wsId}/sessions/${s.id}/compact`, { method: 'POST' })
const joined = (request: ModelRequest): string => request.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')

describe('precomputed compaction through the web server', () => {
  it('writes the summary in the background after a turn settles, without blocking the next turn, and a later compaction adopts it with no new summary request', async () => {
    const p = gatedProvider({ holdFirstHandoff: true, longAnswers: true })
    const s = await start(p.llm, ON)
    await chat(s, 'first question', 1)
    // The candidate started on its own and is held at the provider.
    await until(() => (p.handoffs.length === 1 ? true : undefined))
    // The conversation is not blocked behind it: another turn completes while it is pending.
    await chat(s, 'second question', 2)
    expect(p.handoffs).toHaveLength(1)
    expect(p.handoffs[0]!.ended).toBe(false)
    p.handoffs[0]!.release()
    await until(() => (p.handoffs[0]!.ended ? true : undefined))

    const calls = p.requests.length
    const response = await compact(s)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ summaryChars: SUMMARY.length, path: 'exact' })
    // No further summary request: the background one was adopted.
    expect(p.requests.length).toBe(calls)
    expect(p.handoffs).toHaveLength(1)

    const log = await readLog(s.logPath)
    const end = log.findLast((event) => event.type === 'compaction/end') as { coversSeq: number; summary: string }
    expect(end.summary).toBe(SUMMARY)
    // It covers the first exchange only; the second ended later and is still verbatim.
    const turnEnds = log.filter((event) => event.type === 'turn/end').map((event) => event.seq as number)
    expect(end.coversSeq).toBe(turnEnds[0])
    expect(end.coversSeq).toBeLessThan(turnEnds[1]!)
    // Background work never opened a turn of its own.
    expect(log.filter((event) => event.type === 'turn/start')).toHaveLength(2)

    await chat(s, 'third question', 3)
    const next = joined(p.requests.at(-1)!)
    expect(next).toContain(SUMMARY)
    expect(next).toContain('second question')
    expect(next).toContain('answer 2')
  })

  it('a compaction asked while the candidate is still pending waits for it, then adopts it', async () => {
    const p = gatedProvider({ holdFirstHandoff: true, longAnswers: true })
    const s = await start(p.llm, { ...ON, compactionCandidateWaitMs: 5_000 })
    await chat(s, 'only question', 1)
    await until(() => (p.handoffs.length === 1 ? true : undefined))
    const pending = compact(s)
    await new Promise((resolve) => setTimeout(resolve, 100))
    p.handoffs[0]!.release()
    const response = await pending
    expect(response.status).toBe(200)
    expect(p.handoffs).toHaveLength(1)
    expect((await readLog(s.logPath)).findLast((event) => event.type === 'compaction/end')).toMatchObject({ summary: SUMMARY })
  })

  it('past the wait the pending candidate is cancelled first, and only then is a fresh summary requested: the two never overlap', async () => {
    const p = gatedProvider({ holdFirstHandoff: true, longAnswers: true })
    const s = await start(p.llm, { ...ON, compactionCandidateWaitMs: 150 })
    await chat(s, 'only question', 1)
    await until(() => (p.handoffs.length === 1 ? true : undefined))
    const response = await compact(s)
    expect(response.status).toBe(200)
    expect(p.handoffs).toHaveLength(2)
    expect(p.handoffs[0]!.ended).toBe(true)
    expect(p.maxConcurrentHandoffs()).toBe(1)
    expect((await readLog(s.logPath)).findLast((event) => event.type === 'compaction/end')).toMatchObject({ summary: SUMMARY })
  })

  it('does nothing in the background when the rollout switch for precompute is off', async () => {
    const p = gatedProvider()
    const s = await start(p.llm, { compactionEffectiveEnabled: true, compactionPrecomputePressure: 0.0001 })
    await chat(s, 'first question', 1)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(p.handoffs).toHaveLength(0)
  })

  it('does not start below the pressure threshold', async () => {
    const p = gatedProvider()
    const s = await start(p.llm, { ...ON, compactionPrecomputePressure: 1 })
    await chat(s, 'first question', 1)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(p.handoffs).toHaveLength(0)
  })

  it('a finished candidate that would save almost nothing is not adopted: compaction summarizes on demand instead', async () => {
    // Short answers: the summary is larger than what it replaces, so adopting it would grow the context.
    const p = gatedProvider()
    const s = await start(p.llm, ON)
    await chat(s, 'tiny question', 1)
    await until(() => (p.handoffs.length === 1 && p.handoffs[0]!.ended ? true : undefined))
    const response = await compact(s)
    expect(response.status).toBe(200)
    // The background summary was discarded, so a second one was requested for the real compaction.
    expect(p.handoffs).toHaveLength(2)
  })

  it('deleting the session cancels a pending candidate and waits for its stream to end', async () => {
    const p = gatedProvider({ holdFirstHandoff: true, longAnswers: true })
    const s = await start(p.llm, ON)
    await chat(s, 'first question', 1)
    await until(() => (p.handoffs.length === 1 ? true : undefined))
    const removed = await fetch(`${s.base}/api/workspaces/${s.wsId}/sessions/${s.id}`, { method: 'DELETE' })
    expect(removed.status).toBeLessThan(300)
    await until(() => (p.handoffs[0]!.ended ? true : undefined))
  })
})
