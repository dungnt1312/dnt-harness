/**
 * Model settings + thinking control at the web-host boundary: per-model
 * context overrides driving the verified budget, catalog fallbacks for
 * models without one, the workspace thinking override stamped on requests,
 * and the thinking default reaching the real wire body.
 */
import { createServer, type Server } from 'node:http'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWebServer, type LlmProvider, type WebServer } from 'dnt-harness'

const homes: string[] = []
const servers: WebServer[] = []
const stubs: Server[] = []

beforeAll(async () => {
  void homes
})

afterAll(async () => {
  for (const server of servers) await server.close().catch(() => {})
  for (const stub of stubs) await new Promise<void>((resolve) => stub.close(() => resolve()))
})

async function start(providers: readonly LlmProvider[] = []): Promise<{ server: WebServer; base: string }> {
  const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-models-'))
  const server = await createWebServer({ home, providers, configFile: path.join(home, 'p.json') })
  servers.push(server)
  return { server, base: server.url }
}

async function put(base: string, pathname: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${pathname}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

async function post(base: string, pathname: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

/** A stub OpenAI-completions endpoint capturing request bodies. */
async function startStubEndpoint(): Promise<{ url: string; bodies: Record<string, unknown>[] }> {
  const bodies: Record<string, unknown>[] = []
  const stub = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += chunk.toString() })
    req.on('end', () => {
      if (raw !== '') bodies.push(JSON.parse(raw) as Record<string, unknown>)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
  stubs.push(stub)
  const address = stub.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { url: `http://127.0.0.1:${port}/v1`, bodies }
}

async function firstWorkspace(base: string): Promise<string> {
  const rows = (await (await fetch(`${base}/api/workspaces`)).json()) as { id: string }[]
  return rows[0]!.id
}

async function settle(base: string, wsId: string, sessionId: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const listing = (await (await fetch(`${base}/api/workspaces/${wsId}/sessions`)).json()) as { id: string; status: string }[]
    if (listing.find((row) => row.id === sessionId)?.status === 'idle') return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

describe('model settings: budget resolution', () => {
  it('an operator context override is verified; a catalog model resolves documented; unknown falls back to 256k', async () => {
    const { base } = await start()
    const wsId = await firstWorkspace(base)
    await post(base, '/api/providers', {
      name: 'remote',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: '',
      models: ['gpt-5.6', 'totally-unknown-llm'],
      modelSettings: { 'gpt-5.6': { contextTokens: 100_000 } },
    })

    const budgetOf = async (model: string): Promise<{ availableTokens: number; estimated: boolean }> => {
      await put(base, `/api/workspaces/${wsId}/model`, { model, provider: 'remote' })
      const { id } = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
      await post(base, `/api/workspaces/${wsId}/sessions/${id}/messages`, { content: 'hi' })
      await settle(base, wsId, id)
      const manifest = (await (await fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/manifest`)).json()) as {
        budget: { availableTokens: number; estimated: boolean; usedTokens: number }
      }
      return manifest.budget
    }

    // Operator override: verified budget = 100k - 4,096 - 1,024.
    expect(await budgetOf('gpt-5.6')).toMatchObject({ availableTokens: 94_880, estimated: false })
    // Catalog exact ID (1,048,576 documented) — still a labeled estimate.
    await fetch(`${base}/api/providers/remote`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelSettings: {} }),
    })
    expect(await budgetOf('gpt-5.6')).toMatchObject({ availableTokens: 1_048_576 - 4_096 - 1_024, estimated: true })
    // Unknown model: the 256k default.
    expect(await budgetOf('totally-unknown-llm')).toMatchObject({ availableTokens: 256_000 - 4_096 - 1_024, estimated: true })
  }, 30_000)
})

describe('workspace thinking control', () => {
  it('the override is stamped on every request and null clears it', async () => {
    const seen: { model?: string | undefined; thinkingLevel?: string | undefined }[] = []
    const spy: LlmProvider = {
      name: 'spy', models: ['gpt-5.6'],
      async *stream(request) {
        seen.push({ ...(request.model !== undefined ? { model: request.model } : {}), ...(request.thinkingLevel !== undefined ? { thinkingLevel: request.thinkingLevel } : {}) })
        yield { type: 'delta', delta: 'ok' }
        yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
      },
    }
    const { base } = await start([spy])
    const wsId = await firstWorkspace(base)
    await put(base, `/api/workspaces/${wsId}/model`, { model: 'gpt-5.6', provider: 'spy' })

    // Meta exposes the override; validation rejects junk levels.
    expect((await (await put(base, `/api/workspaces/${wsId}/thinking`, { level: 'xhigh' })).json()) as { thinkingLevel: string }).toEqual({ thinkingLevel: 'xhigh' })
    expect((await (await fetch(`${base}/api/workspaces/${wsId}/meta`)).json()) as { thinkingLevel: string | null }).toMatchObject({ thinkingLevel: 'xhigh' })
    expect((await put(base, `/api/workspaces/${wsId}/thinking`, { level: 'ultra' })).status).toBe(400)

    const { id } = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
    await post(base, `/api/workspaces/${wsId}/sessions/${id}/messages`, { content: 'one' })
    await settle(base, wsId, id)
    await post(base, `/api/workspaces/${wsId}/sessions/${id}/messages`, { content: 'two' })
    await settle(base, wsId, id)

    await put(base, `/api/workspaces/${wsId}/thinking`, { level: null })
    expect((await (await fetch(`${base}/api/workspaces/${wsId}/meta`)).json()) as { thinkingLevel: string | null }).toMatchObject({ thinkingLevel: null })
    await post(base, `/api/workspaces/${wsId}/sessions/${id}/messages`, { content: 'three' })
    await settle(base, wsId, id)

    // The session snapshots its workspace defaults at creation, so clearing
    // the workspace default affects future sessions rather than this one.
    expect(seen.map((entry) => entry.thinkingLevel)).toEqual(['xhigh', 'xhigh', 'xhigh'])
    expect(seen.every((entry) => entry.model === 'gpt-5.6')).toBe(true)
  }, 30_000)

  it('a per-model thinking default reaches the real wire body as documented fields', async () => {
    const endpoint = await startStubEndpoint()
    const { base } = await start()
    const wsId = await firstWorkspace(base)
    await post(base, '/api/providers', {
      name: 'gateway',
      baseUrl: endpoint.url,
      apiKey: '',
      models: ['glm-4.7', 'gpt-5.6'],
      modelSettings: { 'glm-4.7': { thinkingLevel: 'off' } },
    })
    await put(base, `/api/workspaces/${wsId}/model`, { model: 'glm-4.7', provider: 'gateway' })

    const { id } = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
    await post(base, `/api/workspaces/${wsId}/sessions/${id}/messages`, { content: 'hi' })
    await settle(base, wsId, id)

    expect(endpoint.bodies[0]?.['thinking']).toEqual({ type: 'disabled' })
    expect(endpoint.bodies[0]?.['reasoning_effort']).toBeUndefined()
    // The live override outranks the configured default.
    await put(base, `/api/workspaces/${wsId}/thinking`, { level: 'max' })
    await put(base, `/api/workspaces/${wsId}/model`, { model: 'gpt-5.6', provider: 'gateway' })
    // Defaults are copied to new sessions; this existing conversation retains
    // glm-4.7 and its configured thinking default.
    const next = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
    await post(base, `/api/workspaces/${wsId}/sessions/${next.id}/messages`, { content: 'again' })
    await settle(base, wsId, next.id)
    expect(endpoint.bodies[1]?.['reasoning_effort']).toBe('max')
  }, 30_000)

  it('modelSettings ride the public provider projection and patch replaces the map', async () => {
    const { base } = await start()
    await post(base, '/api/providers', {
      name: 'remote',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: '',
      models: ['glm-5'],
      modelSettings: { 'glm-5': { contextTokens: 300_000, vision: true } },
    })
    const listed = (await (await fetch(`${base}/api/providers`)).json()) as { id: string; modelSettings?: Record<string, { contextTokens?: number; vision?: boolean }> }[]
    expect(listed[0]?.modelSettings).toEqual({ 'glm-5': { contextTokens: 300_000, vision: true } })

    // A patch with an empty map clears everything (replace semantics).
    await fetch(`${base}/api/providers/remote`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelSettings: {} }),
    })
    const cleared = (await (await fetch(`${base}/api/providers`)).json()) as { modelSettings?: unknown }[]
    expect(cleared[0]?.modelSettings).toBeUndefined()
  })
})
