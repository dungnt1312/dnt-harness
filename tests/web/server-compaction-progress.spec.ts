/**
 * What the user can see and do while a compaction runs: its stages are durable
 * `compaction/job` events (so every client and a reload see them), and Stop
 * cancels it. Real server, real log, scripted provider whose summary request
 * waits until the test lets it finish — or until it is aborted, like a real one.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createWebServer, type LlmProvider, type WebServer } from 'dnt-harness'
import type { ModelRequest, StreamEvent } from '../../src/harness/llm/types.ts'
import type { HarnessLimits } from '../../src/harness/limits.ts'
import { COMPACTION_HANDOFF_MARKER } from '../../src/web/compaction-generator.ts'

const SUMMARY = 'PROGRESS SUMMARY'

interface Handoff { release(): void; ended: boolean; aborted: boolean }

function provider(options: { hold?: boolean; failHandoff?: boolean } = {}) {
  const requests: ModelRequest[] = []
  const handoffs: Handoff[] = []
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
          const handoff: Handoff = { release: () => {}, ended: false, aborted: false }
          handoffs.push(handoff)
          try {
            if (options.failHandoff === true) throw new Error('provider exploded')
            if (options.hold === true) {
              await new Promise<void>((resolve, reject) => {
                handoff.release = resolve
                streamOptions?.signal?.addEventListener('abort', () => { handoff.aborted = true; reject(streamOptions.signal?.reason) }, { once: true })
              })
            }
            yield { type: 'delta', delta: SUMMARY }
            yield { type: 'usage', usage: { inputTokens: 800, outputTokens: 25 } }
            yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
          } finally { handoff.ended = true }
          return
        }
        yield { type: 'delta', delta: `answer ${++turn}` }
        yield { type: 'usage', usage: { inputTokens: 500, outputTokens: 10 } }
        yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
      })()
    },
  }
  return { llm, requests, handoffs }
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

async function start(llm: LlmProvider, limits: Partial<HarnessLimits>) {
  const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-progress-'))
  const server = await createWebServer({ home, providers: [llm], configFile: path.join(home, 'p.json'), limits })
  servers.push(server)
  homes.set(server, home)
  const wsId = (await (await fetch(`${server.url}/api/workspaces`)).json() as { id: string }[])[0]!.id
  const { id } = await (await fetch(`${server.url}/api/workspaces/${wsId}/sessions`, { method: 'POST' })).json() as { id: string }
  return { base: server.url, wsId, id, route: `${server.url}/api/workspaces/${wsId}/sessions/${id}`, logPath: path.join(home, 'workspaces', wsId, 'sessions', id, 'events.jsonl') }
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

type S = Awaited<ReturnType<typeof start>>
const readLog = async (s: S): Promise<Record<string, unknown>[]> =>
  (await fs.readFile(s.logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
const jobs = async (s: S): Promise<Record<string, unknown>[]> => (await readLog(s)).filter((event) => event.type === 'compaction/job')
const stages = async (s: S): Promise<string[]> => (await jobs(s)).map((job) => `${job['stage']}${job['outcome'] !== undefined ? `:${job['outcome']}` : ''}`)

async function chat(s: S, content: string, turns: number): Promise<void> {
  const response = await fetch(`${s.route}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }) })
  expect(response.ok).toBe(true)
  await until(async () => {
    const ended = (await readLog(s)).filter((event) => event.type === 'turn/end').length
    const rows = await (await fetch(`${s.base}/api/workspaces/${s.wsId}/sessions`)).json() as { id: string; status: string }[]
    return ended === turns && rows.find((row) => row.id === s.id)?.status === 'idle' ? true : undefined
  })
}

const compact = (s: S): Promise<Response> => fetch(`${s.route}/compact`, { method: 'POST' })
const stop = (s: S): Promise<Response> => fetch(`${s.route}/stop`, { method: 'POST' })
const EFFECTIVE: Partial<HarnessLimits> = { compactionEffectiveEnabled: true }

describe('compaction progress and cancel', () => {
  it('Stop cancels a compaction that is waiting for the model: the request is aborted, nothing is written, and the session works again', async () => {
    const p = provider({ hold: true })
    const s = await start(p.llm, EFFECTIVE)
    await chat(s, 'first question', 1)
    const pending = compact(s)
    await until(() => (p.handoffs.length === 1 ? true : undefined))

    expect((await stop(s)).status).toBe(202)
    const response = await pending
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ cancelled: true })
    expect(p.handoffs[0]!.aborted).toBe(true)
    await until(() => (p.handoffs[0]!.ended ? true : undefined))

    const log = await readLog(s)
    expect(log.some((event) => event.type === 'compaction/start')).toBe(false)
    expect(log.some((event) => event.type === 'compaction/end')).toBe(false)
    // The conversation is not left stuck behind the cancelled compaction.
    await chat(s, 'after the cancel', 2)
  })

  it('the stages are durable events, in order, and the end says how it ended', async () => {
    const p = provider()
    const s = await start(p.llm, EFFECTIVE)
    await chat(s, 'first question', 1)
    expect((await compact(s)).status).toBe(200)
    expect(await stages(s)).toEqual(['preparing', 'generating', 'applying', 'ended:compacted'])
    // They bracket the canonical lifecycle and carry the trigger and how the summary was made.
    const log = await readLog(s)
    const order = log.map((event) => String(event.type)).filter((type) => type.startsWith('compaction/'))
    expect(order).toEqual(['compaction/job', 'compaction/job', 'compaction/job', 'compaction/start', 'compaction/end', 'compaction/job'])
    expect((await jobs(s)).at(-1)).toMatchObject({ stage: 'ended', outcome: 'compacted', trigger: 'manual', path: 'exact' })
  })

  it('a cancelled compaction ends as cancelled, not as a failure', async () => {
    const p = provider({ hold: true })
    const s = await start(p.llm, EFFECTIVE)
    await chat(s, 'first question', 1)
    const pending = compact(s)
    await until(() => (p.handoffs.length === 1 ? true : undefined))
    await stop(s)
    await pending
    await until(async () => ((await stages(s)).at(-1) === 'ended:cancelled' ? true : undefined))
    expect(await stages(s)).toEqual(['preparing', 'generating', 'ended:cancelled'])
  })

  it('a compaction that fails ends as failed and carries the reason', async () => {
    const p = provider({ failHandoff: true })
    const s = await start(p.llm, EFFECTIVE)
    await chat(s, 'first question', 1)
    const response = await compact(s)
    expect(response.status).toBeGreaterThanOrEqual(400)
    const last = (await jobs(s)).at(-1)!
    expect(last).toMatchObject({ stage: 'ended', outcome: 'failed' })
    expect(typeof last['error']).toBe('string')
  })

  it('compacting what is already compacted shows no lasting row: it ends as a no-op', async () => {
    const p = provider()
    const s = await start(p.llm, EFFECTIVE)
    await chat(s, 'only exchange', 1)
    await compact(s)
    const before = (await jobs(s)).length
    expect((await compact(s)).status).toBe(200)
    expect((await stages(s)).slice(before)).toEqual(['preparing', 'ended:noop'])
  })

  it('the old fold (switch off) reports its job too, so every compaction has a visible lifecycle', async () => {
    const p = provider()
    const s = await start(p.llm, {})
    await chat(s, 'first question', 1)
    expect((await compact(s)).status).toBe(200)
    expect(await stages(s)).toEqual(['preparing', 'ended:compacted'])
  })
})
