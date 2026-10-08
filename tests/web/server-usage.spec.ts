/**
 * Settings → Usage end to end: a provider's `usage` event is recorded to
 * `<home>/usage.jsonl` and served by `GET /api/usage`, across a restart.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWebServer, type LlmProvider, type WebServer } from 'dnt-harness'
import type { ModelRequest, StreamEvent } from '../../src/harness/llm/types.ts'

class UsageLlm implements LlmProvider {
  readonly name = 'scripted'
  readonly models: readonly string[] = ['scripted']
  async *stream(_request: ModelRequest): AsyncIterable<StreamEvent> {
    yield { type: 'delta', delta: 'hello' }
    // A provider may report usage twice; only the last report counts.
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'usage', usage: { inputTokens: 1200, cachedInputTokens: 800, outputTokens: 34 } }
    yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
  }
}

interface UsageBody {
  days: { date: string; model: string; input: number; cached: number; output: number; requests: number }[]
  longestSessionMs: number
  today: string
}

let home = ''
let server: WebServer | undefined

beforeEach(async () => { home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-usage-')) })
afterEach(async () => {
  await server?.close()
  server = undefined
  await fs.rm(home, { recursive: true, force: true })
})

const boot = async (): Promise<WebServer> => {
  server = await createWebServer({ home, providers: [new UsageLlm()], configFile: path.join(home, 'providers.json') })
  return server
}

async function waitForUsage(url: string): Promise<UsageBody> {
  const deadline = Date.now() + 5_000
  for (;;) {
    const body = await (await fetch(`${url}/api/usage`)).json() as UsageBody
    if (body.days.length > 0 || Date.now() > deadline) return body
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe('GET /api/usage', () => {
  it('starts empty, records a turn and survives a restart', async () => {
    const first = await boot()
    const empty = await (await fetch(`${first.url}/api/usage`)).json() as UsageBody
    expect(empty.days).toEqual([])
    expect(empty.today).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    const created = await fetch(`${first.url}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const { id } = await created.json() as { id: string }
    await fetch(`${first.url}/api/sessions/${id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'hi' }) })

    const body = await waitForUsage(first.url)
    expect(body.days).toHaveLength(1)
    expect(body.days[0]).toMatchObject({ date: body.today, input: 1200, cached: 800, output: 34, requests: 1 })

    await first.close()
    server = undefined
    const raw = await fs.readFile(path.join(home, 'usage.jsonl'), 'utf8')
    expect(JSON.parse(raw.trim())).toMatchObject({ v: 1, kind: 'turn', sessionId: id, rootSessionId: id, input: 1200 })

    const second = await boot()
    const again = await (await fetch(`${second.url}/api/usage`)).json() as UsageBody
    expect(again.days).toEqual(body.days)
  })
})
