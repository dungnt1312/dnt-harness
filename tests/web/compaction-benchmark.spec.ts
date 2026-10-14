/**
 * Deterministic latency and continuity gate for compaction, through the real web
 * server and a scripted provider.
 *
 * What this proves: how many model requests a compaction takes, that the request
 * carries what the model last saw, and that the facts of a fixed synthetic session
 * reach the checkpoint and the next request. What it CANNOT prove: how long a real
 * provider takes or whether a real model writes a faithful summary. Those need the
 * live procedure in docs/harness.md and an approved provider; until then the live
 * gate is pending, not passing.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createWebServer, type LlmProvider, type WebServer } from 'dnt-harness'
import type { ModelRequest, StreamEvent } from '../../src/harness/llm/types.ts'
import type { HarnessLimits } from '../../src/harness/limits.ts'
import { COMPACTION_HANDOFF_MARKER } from '../../src/web/compaction-generator.ts'
import fixture from '../fixtures/compaction/continuation-cases.json' with { type: 'json' }

const LEGACY_MARK = 'Primary Request and Intent'
const text = (request: ModelRequest): string => request.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')

interface Turn { readonly user: string; readonly assistant: string; readonly padChars: number }
const turns = fixture.turns as readonly Turn[]
const FACTS = fixture.facts as readonly string[]

/**
 * Chat turns answer from the fixture, padded to its size. A summary request echoes back the
 * facts it can SEE in its own input: a request that carries the whole session therefore
 * yields a summary with every fact, and one that does not, yields a summary without.
 */
function scripted() {
  const requests: ModelRequest[] = []
  let turn = 0
  const llm: LlmProvider = {
    name: 'scripted',
    // A 1M-token catalog model: the fixture's raw log (~375k tokens) must fit the window, or the builder
    // trims old turns, the request stops being lossless and no snapshot is (rightly) promoted.
    models: ['gpt-5.6'],
    stream(request) {
      requests.push(request)
      const input = text(request)
      const summary = input.includes(COMPACTION_HANDOFF_MARKER) || input.includes(LEGACY_MARK)
      return (async function* (): AsyncIterable<StreamEvent> {
        if (summary) {
          const seen = FACTS.filter((fact) => input.includes(fact))
          yield { type: 'delta', delta: `HANDOFF — facts: ${seen.join(' | ')}` }
        } else {
          const t = turns[turn++ % turns.length]!
          yield { type: 'delta', delta: `${t.assistant}\n${'x'.repeat(t.padChars)}` }
        }
        yield { type: 'usage', usage: { inputTokens: 1_000, outputTokens: 20 } }
        yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
      })()
    },
  }
  return { llm, requests }
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

async function session(limits: Partial<HarnessLimits>) {
  const s = scripted()
  const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-benchmark-'))
  const server = await createWebServer({ home, providers: [s.llm], configFile: path.join(home, 'p.json'), limits })
  servers.push(server)
  homes.set(server, home)
  const base = server.url
  const wsId = (await (await fetch(`${base}/api/workspaces`)).json() as { id: string }[])[0]!.id
  const { id } = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`, { method: 'POST' })).json() as { id: string }
  const logPath = path.join(home, 'workspaces', wsId, 'sessions', id, 'events.jsonl')
  const waitFor = async (turnsDone: number): Promise<void> => {
    const deadline = Date.now() + 20_000
    for (;;) {
      const log = await fs.readFile(logPath, 'utf8').catch(() => '')
      const ended = log.trim().split('\n').filter((line) => line !== '' && JSON.parse(line).type === 'turn/end').length
      const rows = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`)).json() as { id: string; status: string }[]
      if (ended === turnsDone && rows.find((row) => row.id === id)?.status === 'idle') return
      if (Date.now() > deadline) throw new Error('turn did not settle')
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  const say = async (content: string, nth: number): Promise<void> => {
    const response = await fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }) })
    expect(response.ok).toBe(true)
    await waitFor(nth)
  }
  const compact = (): Promise<Response> => fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/compact`, { method: 'POST' })
  const run = async (): Promise<void> => { for (const [index, t] of turns.entries()) await say(t.user, index + 1) }
  const log = async (): Promise<Record<string, unknown>[]> =>
    (await fs.readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
  return { ...s, say, compact, run, log }
}

describe('compaction latency and continuity (scripted provider)', () => {
  it('the baseline fold needs many sequential requests for this session; effective compaction needs exactly one', async () => {
    const baseline = await session({})
    await baseline.run()
    const before = baseline.requests.length
    expect((await baseline.compact()).status).toBe(200)
    const foldRequests = baseline.requests.length - before

    const effective = await session({ compactionEffectiveEnabled: true })
    await effective.run()
    const mark = effective.requests.length
    expect((await effective.compact()).status).toBe(200)
    const oneRequests = effective.requests.length - mark

    // The fixture's raw log is ~1.5 MB; the fold sends it in chunks of at most 200 000 characters.
    expect(foldRequests).toBeGreaterThanOrEqual(7)
    expect(oneRequests).toBe(1)
    // No cumulative chunk outputs: the one request is the final answer's request, not a chain of summaries.
    const handoff = effective.requests.at(-1)!
    expect(text(handoff)).not.toContain('Summary of earlier chunks')
    expect(text(handoff)).not.toContain('<conversation>')
  })

  it('every fact of the session reaches the checkpoint and the next request, and the cutoff is the last exchange', async () => {
    const s = await session({ compactionEffectiveEnabled: true })
    await s.run()
    expect((await s.compact()).status).toBe(200)
    const log = await s.log()
    const end = log.findLast((event) => event.type === 'compaction/end') as { summary: string; coversSeq: number }
    for (const fact of FACTS) expect(end.summary).toContain(fact)
    const lastTurnEnd = log.findLast((event) => event.type === 'turn/end') as { seq: number }
    expect(end.coversSeq).toBe(lastTurnEnd.seq)

    await s.say('Tiếp tục với việc còn lại.', turns.length + 1)
    const next = text(s.requests.at(-1)!)
    for (const fact of FACTS) expect(next).toContain(fact)
    expect(next).toContain('Tiếp tục với việc còn lại.')
  })

  it('a ready background candidate makes the compaction itself cost zero requests', async () => {
    const s = await session({ compactionEffectiveEnabled: true, compactionPrecomputeEnabled: true, compactionPrecomputePressure: 0.0001, compactionRetainTokens: 0 })
    await s.run()
    // Wait for the background summary to finish: it is the one request that carries the handoff marker.
    const deadline = Date.now() + 10_000
    while (!s.requests.some((request) => text(request).includes(COMPACTION_HANDOFF_MARKER))) {
      if (Date.now() > deadline) throw new Error('no candidate was written')
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
    const mark = s.requests.length
    expect((await s.compact()).status).toBe(200)
    expect(s.requests.length - mark).toBeLessThanOrEqual(0)
    const end = (await s.log()).findLast((event) => event.type === 'compaction/end') as { summary: string }
    expect(end.summary).toContain('HANDOFF')
  })
})
