import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWebServer, type LlmProvider, type WebServer } from 'dnt-harness'

const servers: WebServer[] = []
const homes: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })))
})

async function start(providers: readonly LlmProvider[]): Promise<{ server: WebServer; base: string; home: string }> {
  const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-session-model-'))
  homes.push(home)
  const server = await createWebServer({ home, providers, configFile: path.join(home, 'providers.json') })
  servers.push(server)
  return { server, base: server.url, home }
}

async function firstWorkspace(base: string): Promise<string> {
  return ((await (await fetch(`${base}/api/workspaces`)).json()) as { id: string }[])[0]!.id
}

async function post(base: string, pathname: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}

async function put(base: string, pathname: string, body: unknown): Promise<Response> {
  return fetch(`${base}${pathname}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

function provider(name: string, models: readonly string[], seen: { model?: string; provider?: string; thinkingLevel?: string }[]): LlmProvider {
  return {
    name,
    models,
    async *stream(request) {
      seen.push({
        ...(request.model !== undefined ? { model: request.model } : {}),
        ...(request.providerName !== undefined ? { provider: request.providerName } : {}),
        ...(request.thinkingLevel !== undefined ? { thinkingLevel: request.thinkingLevel } : {}),
      })
      yield { type: 'delta', delta: 'ok' }
    },
  }
}

async function settle(base: string, workspaceId: string, sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const sessions = (await (await fetch(`${base}/api/workspaces/${workspaceId}/sessions`)).json()) as { id: string; status: string }[]
    if (sessions.find((session) => session.id === sessionId)?.status === 'idle') return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('session did not settle')
}

describe('workspace session model controls', () => {
  it('snapshots workspace defaults at creation, isolates sessions, and leaves existing sessions unchanged', async () => {
    const seen: { model?: string; provider?: string; thinkingLevel?: string }[] = []
    const { base } = await start([provider('alpha', ['a1', 'a2'], seen), provider('beta', ['b1'], seen)])
    const workspaceId = await firstWorkspace(base)
    await put(base, `/api/workspaces/${workspaceId}/model`, { provider: 'alpha', model: 'a1' })
    await put(base, `/api/workspaces/${workspaceId}/thinking`, { level: 'high' })
    const a = (await (await post(base, `/api/workspaces/${workspaceId}/sessions`)).json()) as { id: string }
    const b = (await (await post(base, `/api/workspaces/${workspaceId}/sessions`)).json()) as { id: string }

    expect(await (await fetch(`${base}/api/workspaces/${workspaceId}/sessions/${a.id}/model`)).json()).toEqual({ provider: 'alpha', model: 'a1', thinkingLevel: 'high', source: 'session' })
    await put(base, `/api/workspaces/${workspaceId}/sessions/${a.id}/model`, { provider: 'beta', model: 'b1', thinkingLevel: null })
    expect(await (await fetch(`${base}/api/workspaces/${workspaceId}/sessions/${b.id}/model`)).json()).toEqual({ provider: 'alpha', model: 'a1', thinkingLevel: 'high', source: 'session' })

    await put(base, `/api/workspaces/${workspaceId}/model`, { provider: 'alpha', model: 'a2' })
    await put(base, `/api/workspaces/${workspaceId}/thinking`, { level: 'low' })
    expect(await (await fetch(`${base}/api/workspaces/${workspaceId}/sessions/${a.id}/model`)).json()).toEqual({ provider: 'beta', model: 'b1', thinkingLevel: null, source: 'session' })
    expect(await (await fetch(`${base}/api/workspaces/${workspaceId}/sessions/${b.id}/model`)).json()).toEqual({ provider: 'alpha', model: 'a1', thinkingLevel: 'high', source: 'session' })

    await post(base, `/api/workspaces/${workspaceId}/sessions/${a.id}/messages`, { content: 'a' })
    await settle(base, workspaceId, a.id)
    await post(base, `/api/workspaces/${workspaceId}/sessions/${b.id}/messages`, { content: 'b' })
    await settle(base, workspaceId, b.id)
    expect(seen).toEqual([
      { provider: 'beta', model: 'b1' },
      { provider: 'alpha', model: 'a1', thinkingLevel: 'high' },
    ])
  })

  it('keeps an explicit blank snapshot blank when workspace settings appear later', async () => {
    const { base } = await start([])
    const workspaceId = await firstWorkspace(base)
    const { id } = (await (await post(base, `/api/workspaces/${workspaceId}/sessions`)).json()) as { id: string }
    await post(base, '/api/providers', { name: 'Alpha', baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', models: ['a1'] })
    await put(base, `/api/workspaces/${workspaceId}/model`, { provider: 'alpha', model: 'a1' })
    await put(base, `/api/workspaces/${workspaceId}/thinking`, { level: 'high' })

    expect(await (await fetch(`${base}/api/workspaces/${workspaceId}/sessions/${id}/model`)).json()).toEqual({ provider: null, model: null, thinkingLevel: null, source: 'session' })
    expect((await post(base, `/api/workspaces/${workspaceId}/sessions/${id}/messages`, { content: 'must reject' })).status).toBe(400)
  })

  it('accepts explicit blanks, rejects partial pairs, and validates complete pairs without changing workspace controls', async () => {
    const seen: { model?: string; provider?: string; thinkingLevel?: string }[] = []
    const { base } = await start([provider('alpha', ['a1'], seen), provider('beta', ['b1'], seen)])
    const workspaceId = await firstWorkspace(base)
    await put(base, `/api/workspaces/${workspaceId}/model`, { provider: 'alpha', model: 'a1' })
    const { id } = (await (await post(base, `/api/workspaces/${workspaceId}/sessions`)).json()) as { id: string }

    expect((await put(base, `/api/workspaces/${workspaceId}/sessions/${id}/model`, { provider: 'missing' })).status).toBe(400)
    expect((await put(base, `/api/workspaces/${workspaceId}/sessions/${id}/model`, { provider: 'beta', model: 'a1' })).status).toBe(400)
    expect((await put(base, `/api/workspaces/${workspaceId}/sessions/${id}/model`, { thinkingLevel: 'invalid' })).status).toBe(400)
    expect((await put(base, `/api/workspaces/${workspaceId}/sessions/${id}/model`, { provider: null })).status).toBe(400)
    expect((await put(base, `/api/workspaces/${workspaceId}/sessions/${id}/model`, { provider: null, model: null })).status).toBe(200)
    expect(await (await fetch(`${base}/api/workspaces/${workspaceId}/sessions/${id}/model`)).json()).toEqual({ provider: null, model: null, thinkingLevel: null, source: 'session' })
    expect((await (await fetch(`${base}/api/workspaces/${workspaceId}/meta`)).json()) as { provider: string; model: string }).toMatchObject({ provider: 'alpha', model: 'a1' })
  })

  it('uses a child model override consistently for context manifest and request', async () => {
    const seen: { model?: string; provider?: string; thinkingLevel?: string }[] = []
    const { base, home } = await start([provider('alpha', ['a1', 'a2'], seen)])
    const workspaceId = await firstWorkspace(base)
    await put(base, `/api/workspaces/${workspaceId}/model`, { provider: 'alpha', model: 'a1' })
    await fs.mkdir(path.join(home, 'workspaces', workspaceId, 'agents'), { recursive: true })
    await fs.writeFile(path.join(home, 'workspaces', workspaceId, 'agents', 'modeler.md'), '---\ndescription: model override\ntools: []\nmodel: a2\n---\nReply briefly.', 'utf8')
    const root = (await (await post(base, `/api/workspaces/${workspaceId}/sessions`)).json()) as { id: string }
    const spawned = await post(base, `/api/workspaces/${workspaceId}/agents/modeler`, { rootSessionId: root.id, task: { objective: 'test override' } })
    expect(spawned.status).toBe(202)
    const { childSessionId } = (await spawned.json()) as { childSessionId: string }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const child = (await (await fetch(`${base}/api/workspaces/${workspaceId}/children/${childSessionId}?waitMs=50`)).json()) as { status: string }
      if (child.status === 'completed') break
    }
    const manifest = (await (await fetch(`${base}/api/workspaces/${workspaceId}/sessions/${childSessionId}/manifest`)).json()) as { model: string; provider: string }
    expect(manifest).toMatchObject({ model: 'a2', provider: 'alpha' })
    expect(seen).toEqual([{ provider: 'alpha', model: 'a2' }])
  })

  it('uses a session model update for the next request of an active multi-step turn', async () => {
    const seen: string[] = []
    let releaseFirst: (() => void) | undefined
    const firstStarted = new Promise<void>((resolve) => { releaseFirst = resolve })
    let streamCount = 0
    const stepped: LlmProvider = {
      name: 'alpha', models: ['a1', 'a2'],
      async *stream(request) {
        seen.push(request.model ?? '')
        streamCount += 1
        if (streamCount === 1) {
          await firstStarted
          yield { type: 'toolCalls', calls: [{ id: 'read', name: 'Read', args: { path: 'missing.txt' } }] }
          return
        }
        yield { type: 'delta', delta: 'done' }
      },
    }
    const { base } = await start([stepped])
    const workspaceId = await firstWorkspace(base)
    await put(base, `/api/workspaces/${workspaceId}/model`, { provider: 'alpha', model: 'a1' })
    await fetch(`${base}/api/workspaces/${workspaceId}/mode`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modeId: 'full-access' }) })
    const { id } = (await (await post(base, `/api/workspaces/${workspaceId}/sessions`)).json()) as { id: string }
    const queued = post(base, `/api/workspaces/${workspaceId}/sessions/${id}/messages`, { content: 'go' })
    await new Promise<void>((resolve) => {
      const poll = (): void => {
        if (streamCount === 1) { resolve(); return }
        setTimeout(poll, 5)
      }
      poll()
    })
    expect((await put(base, `/api/workspaces/${workspaceId}/sessions/${id}/model`, { model: 'a2' })).status).toBe(200)
    releaseFirst?.()
    expect((await queued).status).toBe(202)
    await settle(base, workspaceId, id)
    expect(seen).toEqual(['a1', 'a2'])
  })

  it('rejects messages before queuing when a configured provider is disabled', async () => {
    const { base } = await start([])
    const workspaceId = await firstWorkspace(base)
    await post(base, '/api/providers', { name: 'Alpha', baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', models: ['a1'] })
    await put(base, `/api/workspaces/${workspaceId}/model`, { provider: 'alpha', model: 'a1' })
    const { id } = (await (await post(base, `/api/workspaces/${workspaceId}/sessions`)).json()) as { id: string }
    await fetch(`${base}/api/providers/alpha`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) })

    expect((await post(base, `/api/workspaces/${workspaceId}/sessions/${id}/messages`, { content: 'must not queue' })).status).toBe(400)
    expect((await (await fetch(`${base}/api/workspaces/${workspaceId}/sessions`)).json()) as { id: string; pendingInputs: number }[])
      .toContainEqual(expect.objectContaining({ id, pendingInputs: 0 }))

    await fetch(`${base}/api/providers/alpha`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, models: ['other'] }) })
    expect((await post(base, `/api/workspaces/${workspaceId}/sessions/${id}/messages`, { content: 'must reject stale catalog' })).status).toBe(400)
  })

  it('rejects a poisoned session after durable model update failure', async () => {
    const seen: { model?: string; provider?: string; thinkingLevel?: string }[] = []
    const { server, base } = await start([provider('alpha', ['a1', 'a2'], seen)])
    const workspaceId = await firstWorkspace(base)
    await put(base, `/api/workspaces/${workspaceId}/model`, { provider: 'alpha', model: 'a1' })
    const { id } = (await (await post(base, `/api/workspaces/${workspaceId}/sessions`)).json()) as { id: string }
    const session = await server.kernel.ctx.sessions.load(id as never)
    const originalDurable = session.durable.bind(session)
    Object.assign(session, { durable: async () => { throw new Error('injected disk failure') } })

    expect((await put(base, `/api/workspaces/${workspaceId}/sessions/${id}/model`, { model: 'a2' })).status).toBe(500)
    expect((await fetch(`${base}/api/workspaces/${workspaceId}/sessions/${id}/model`)).status).toBe(503)
    expect((await post(base, `/api/workspaces/${workspaceId}/sessions/${id}/messages`, { content: 'must not queue' })).status).toBe(503)
    Object.assign(session, { durable: originalDurable })
  })

  it('replays durable overrides after restart and falls back for legacy sessions', async () => {
    const seen: { model?: string; provider?: string; thinkingLevel?: string }[] = []
    const { base, home } = await start([provider('alpha', ['a1', 'a2'], seen)])
    const workspaceId = await firstWorkspace(base)
    await put(base, `/api/workspaces/${workspaceId}/model`, { provider: 'alpha', model: 'a1' })
    const { id } = (await (await post(base, `/api/workspaces/${workspaceId}/sessions`)).json()) as { id: string }
    await put(base, `/api/workspaces/${workspaceId}/sessions/${id}/model`, { model: 'a2', thinkingLevel: null })
    const legacy = (await (await post(base, `/api/workspaces/${workspaceId}/sessions`)).json()) as { id: string }
    await servers.pop()!.close()
    await fs.writeFile(path.join(home, 'workspaces', workspaceId, 'sessions', legacy.id, 'events.jsonl'), '', 'utf8')

    const restarted = await createWebServer({ home, providers: [provider('alpha', ['a1', 'a2'], seen)], configFile: path.join(home, 'providers.json') })
    servers.push(restarted)
    expect(await (await fetch(`${restarted.url}/api/workspaces/${workspaceId}/sessions/${id}/model`)).json()).toEqual({ provider: 'alpha', model: 'a2', thinkingLevel: null, source: 'session' })
    // A legacy log holds no preference, so it reads the global default — which
    // now follows the model last chosen, i.e. the a2 this conversation adopted.
    expect(await (await fetch(`${restarted.url}/api/workspaces/${workspaceId}/sessions/${legacy.id}/model`)).json()).toEqual({ provider: 'alpha', model: 'a2', thinkingLevel: null, source: 'global' })
  })
})

describe('global durable model defaults', () => {
  it('persists one global default across restart and every workspace while retaining old snapshots', async () => {
    const seen: { model?: string; provider?: string; thinkingLevel?: string }[] = []
    const { server, base, home } = await start([provider('alpha', ['a1', 'a2'], seen), provider('beta', ['b1'], seen)])
    const first = await firstWorkspace(base)
    expect(await (await fetch(`${base}/api/model-defaults`)).json()).toEqual({ provider: 'alpha', model: 'a1', thinkingLevel: null })
    await put(base, `/api/workspaces/${first}/model`, { provider: 'alpha', model: 'a1' })
    const old = (await (await post(base, `/api/workspaces/${first}/sessions`)).json()) as { id: string }
    expect((await put(base, '/api/model-defaults', { provider: 'beta', model: 'b1', thinkingLevel: 'high' })).status).toBe(200)
    const second = (await (await post(base, '/api/workspaces', { name: 'Second' })).json()) as { id: string }
    expect((await (await fetch(`${base}/api/workspaces/${second.id}/meta`)).json()) as { provider: string; model: string; thinkingLevel: string })
      .toMatchObject({ provider: 'beta', model: 'b1', thinkingLevel: 'high' })
    const fresh = (await (await post(base, `/api/workspaces/${second.id}/sessions`)).json()) as { id: string }
    expect(await (await fetch(`${base}/api/workspaces/${first}/sessions/${old.id}/model`)).json()).toMatchObject({ provider: 'alpha', model: 'a1', source: 'session' })
    expect(await (await fetch(`${base}/api/workspaces/${second.id}/sessions/${fresh.id}/model`)).json()).toMatchObject({ provider: 'beta', model: 'b1', thinkingLevel: 'high', source: 'session' })
    await server.close(); servers.splice(servers.indexOf(server), 1)
    const restarted = await createWebServer({ home, providers: [provider('alpha', ['a1', 'a2'], seen), provider('beta', ['b1'], seen)], configFile: path.join(home, 'providers.json') })
    servers.push(restarted)
    expect(await (await fetch(`${restarted.url}/api/model-defaults`)).json()).toEqual({ provider: 'beta', model: 'b1', thinkingLevel: 'high' })
  })

  it('opens the next conversation on the model last chosen in any conversation', async () => {
    const seen: { model?: string; provider?: string; thinkingLevel?: string }[] = []
    const { base } = await start([provider('alpha', ['a1', 'a2'], seen)])
    const workspaceId = await firstWorkspace(base)
    await put(base, `/api/workspaces/${workspaceId}/model`, { provider: 'alpha', model: 'a1' })

    const first = (await (await post(base, `/api/workspaces/${workspaceId}/sessions`)).json()) as { id: string }
    expect(await (await fetch(`${base}/api/workspaces/${workspaceId}/sessions/${first.id}/model`)).json())
      .toMatchObject({ provider: 'alpha', model: 'a1' })

    // Adopting a model inside a conversation repoints the global pointer, so
    // the operator never re-picks for the next one.
    await put(base, `/api/workspaces/${workspaceId}/sessions/${first.id}/model`, { model: 'a2' })
    expect(await (await fetch(`${base}/api/model-defaults`)).json()).toMatchObject({ provider: 'alpha', model: 'a2' })
    const second = (await (await post(base, `/api/workspaces/${workspaceId}/sessions`)).json()) as { id: string }
    expect(await (await fetch(`${base}/api/workspaces/${workspaceId}/sessions/${second.id}/model`)).json())
      .toMatchObject({ provider: 'alpha', model: 'a2', source: 'session' })

    // A thinking-only edit is conversation-scoped: it must not move the model.
    await put(base, `/api/workspaces/${workspaceId}/sessions/${second.id}/model`, { thinkingLevel: 'high' })
    expect(await (await fetch(`${base}/api/model-defaults`)).json()).toMatchObject({ provider: 'alpha', model: 'a2' })
    expect(await (await fetch(`${base}/api/workspaces/${workspaceId}/sessions/${first.id}/model`)).json())
      .toMatchObject({ provider: 'alpha', model: 'a2' })
  })

  it('validates complete global pairs and repairs defaults after provider mutations without rewriting snapshots', async () => {
    const { base } = await start([])
    const workspaceId = await firstWorkspace(base)
    await post(base, '/api/providers', { name: 'Alpha', baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', models: ['a1', 'a2'] })
    await post(base, '/api/providers', { name: 'Beta', baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', models: ['b1'] })
    expect(await (await fetch(`${base}/api/model-defaults`)).json()).toMatchObject({ provider: 'alpha', model: 'a1' })
    expect((await put(base, '/api/model-defaults', { provider: 'alpha' })).status).toBe(400)
    expect((await put(base, '/api/model-defaults', { provider: null, model: 'a1' })).status).toBe(400)
    expect((await put(base, '/api/model-defaults', { provider: 'alpha', model: 'a2' })).status).toBe(200)
    const session = (await (await post(base, `/api/workspaces/${workspaceId}/sessions`)).json()) as { id: string }
    expect((await fetch(`${base}/api/providers/alpha`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) })).status).toBe(200)
    expect(await (await fetch(`${base}/api/model-defaults`)).json()).toMatchObject({ provider: 'beta', model: 'b1' })
    expect(await (await fetch(`${base}/api/workspaces/${workspaceId}/sessions/${session.id}/model`)).json()).toMatchObject({ provider: 'alpha', model: 'a2', source: 'session' })
  })
})

describe('provider/default transaction boundary', () => {
  it('serializes concurrent provider/default/thinking mutations without losing committed fields', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-provider-transaction-'))
    homes.push(home)
    const server = await createWebServer({ home, configFile: path.join(home, 'providers.json') })
    servers.push(server)
    const base = server.url
    const workspaceId = await firstWorkspace(base)
    const createAlpha = post(base, '/api/providers', { name: 'Alpha', baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', models: ['a1'] })
    const createBeta = post(base, '/api/providers', { name: 'Beta', baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', models: ['b1'] })
    await Promise.all([createAlpha, createBeta])
    await Promise.all([
      put(base, '/api/model-defaults', { provider: 'alpha', model: 'a1', thinkingLevel: null }),
      put(base, `/api/workspaces/${workspaceId}/thinking`, { level: 'high' }),
      fetch(`${base}/api/providers/beta`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Beta updated' }) }),
    ])
    const defaults = await (await fetch(`${base}/api/model-defaults`)).json() as { provider: string; model: string; thinkingLevel: string }
    expect(defaults).toEqual({ provider: 'alpha', model: 'a1', thinkingLevel: 'high' })
    const providers = await (await fetch(`${base}/api/providers`)).json() as { id: string; name: string }[]
    expect(providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'alpha', name: 'Alpha' }),
      expect.objectContaining({ id: 'beta', name: 'Beta updated' }),
    ]))
    const onDisk = JSON.parse(await fs.readFile(path.join(home, 'providers.json'), 'utf8')) as { version: number; providers: unknown[]; defaults: unknown }
    expect(onDisk.version).toBe(2); expect(Array.isArray(onDisk.providers)).toBe(true); expect(onDisk.defaults).toEqual(defaults)
  })

  it('does not publish provider/default or registration changes when durable commit fails', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-provider-failure-'))
    homes.push(home)
    let failWrites = false
    const writer = async (file: string, store: import('../../src/web/provider-store.ts').ProviderStore): Promise<void> => {
      if (failWrites) throw new Error('injected write failure')
      const { saveProviderStore } = await import('../../src/web/provider-store.ts')
      await saveProviderStore(file, store)
    }
    const injected = provider('injected', ['i1'], [])
    const server = await createWebServer({ home, providers: [injected], configFile: path.join(home, 'providers.json'), providerStoreWriter: writer })
    servers.push(server)
    const base = server.url
    const beforeProviders = await (await fetch(`${base}/api/providers`)).json()
    const beforeDefaults = await (await fetch(`${base}/api/model-defaults`)).json()
    failWrites = true
    expect((await post(base, '/api/providers', { name: 'Broken', baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', models: ['x'] })).status).toBe(500)
    expect((await put(base, '/api/model-defaults', { provider: null, model: null })).status).toBe(500)
    expect(await (await fetch(`${base}/api/providers`)).json()).toEqual(beforeProviders)
    expect(await (await fetch(`${base}/api/model-defaults`)).json()).toEqual(beforeDefaults)
    const workspaceId = await firstWorkspace(base)
    expect((await (await fetch(`${base}/api/workspaces/${workspaceId}/meta`)).json()) as { provider: string; model: string }).toMatchObject({ provider: 'injected', model: 'i1' })
  })

  it('uses activeModel as a validated process-local startup override without overwriting disk defaults', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-active-model-'))
    homes.push(home)
    const file = path.join(home, 'providers.json')
    const alpha = provider('alpha', ['a1'], [])
    const beta = provider('beta', ['b1'], [])
    const first = await createWebServer({ home, providers: [alpha, beta], configFile: file, activeModel: { provider: 'beta', model: 'b1' } })
    servers.push(first)
    expect(await (await fetch(`${first.url}/api/model-defaults`)).json()).toMatchObject({ provider: 'beta', model: 'b1' })
    await first.close(); servers.splice(servers.indexOf(first), 1)
    const second = await createWebServer({ home, providers: [alpha, beta], configFile: file })
    servers.push(second)
    expect(await (await fetch(`${second.url}/api/model-defaults`)).json()).toMatchObject({ provider: 'alpha', model: 'a1' })
  })
})

describe('runtime override durability and patch serialization', () => {
  it('keeps activeModel pair process-local when thinking persists, then restores durable pair after restart', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-active-thinking-'))
    homes.push(home)
    const file = path.join(home, 'providers.json')
    const alpha = provider('alpha', ['a1'], [])
    const beta = provider('beta', ['b1'], [])
    const server = await createWebServer({ home, providers: [alpha, beta], configFile: file, activeModel: { provider: 'beta', model: 'b1' } })
    servers.push(server)
    expect((await put(server.url, '/api/thinking', { level: 'high' })).status).toBe(200)
    expect(await (await fetch(`${server.url}/api/model-defaults`)).json()).toEqual({ provider: 'beta', model: 'b1', thinkingLevel: 'high' })
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toMatchObject({ defaults: { provider: 'alpha', model: 'a1', thinkingLevel: 'high' } })
    await server.close(); servers.splice(servers.indexOf(server), 1)
    const restarted = await createWebServer({ home, providers: [alpha, beta], configFile: file })
    servers.push(restarted)
    expect(await (await fetch(`${restarted.url}/api/model-defaults`)).json()).toEqual({ provider: 'alpha', model: 'a1', thinkingLevel: 'high' })
  })

  it('merges delayed concurrent patches in transaction acceptance order and returns committed projections', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-patch-race-'))
    homes.push(home)
    const writer = async (file: string, store: import('../../src/web/provider-store.ts').ProviderStore): Promise<void> => {
      if (store.providers.some((entry) => entry.name === 'Renamed')) {
        await new Promise<void>((resolve) => setTimeout(resolve, 40))
      }
      const { saveProviderStore } = await import('../../src/web/provider-store.ts')
      await saveProviderStore(file, store)
    }
    const server = await createWebServer({ home, configFile: path.join(home, 'providers.json'), providerStoreWriter: writer })
    servers.push(server)
    await post(server.url, '/api/providers', { name: 'Alpha', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'old', models: ['a1'] })
    const first = fetch(`${server.url}/api/providers/alpha`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Renamed' }) })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const second = fetch(`${server.url}/api/providers/alpha`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: 'new' }) })
    expect((await first).status).toBe(200); expect((await second).status).toBe(200)
    const row = (await (await fetch(`${server.url}/api/providers`)).json() as { name: string; keyMasked: string }[])[0]!
    expect(row).toMatchObject({ name: 'Renamed', keyMasked: '••••' })
    const onDisk = JSON.parse(await fs.readFile(path.join(home, 'providers.json'), 'utf8')) as { providers: { name: string; apiKey: string }[] }
    expect(onDisk.providers[0]).toMatchObject({ name: 'Renamed', apiKey: 'new' })
  })
})

describe('runtime override invalidation after provider commits', () => {
  const mutationCases: readonly { readonly name: string; readonly mutate: (base: string) => Promise<Response> }[] = [
    { name: 'delete', mutate: (base) => fetch(`${base}/api/providers/beta`, { method: 'DELETE' }) },
    { name: 'disable', mutate: (base) => fetch(`${base}/api/providers/beta`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) }) },
    { name: 'patch model removal', mutate: (base) => fetch(`${base}/api/providers/beta`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ models: ['b2'] }) }) },
  ]

  for (const scenario of mutationCases) {
    it(`clears activeModel override after ${scenario.name}; existing session remains snapshot-isolated`, async () => {
      const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-runtime-invalidation-'))
      homes.push(home)
      const file = path.join(home, 'providers.json')
      const server = await createWebServer({ home, providers: [], configFile: file })
      servers.push(server)
      await post(server.url, '/api/providers', { name: 'Alpha', baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', models: ['a1'] })
      await post(server.url, '/api/providers', { name: 'Beta', baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', models: ['b1', 'b2'] })
      await server.close(); servers.splice(servers.indexOf(server), 1)
      const overridden = await createWebServer({ home, configFile: file, activeModel: { provider: 'beta', model: 'b1' } })
      servers.push(overridden)
      const workspaceId = await firstWorkspace(overridden.url)
      const existing = (await (await post(overridden.url, `/api/workspaces/${workspaceId}/sessions`)).json()) as { id: string }
      expect((await scenario.mutate(overridden.url)).status).toBe(200)
      expect(await (await fetch(`${overridden.url}/api/model-defaults`)).json()).toMatchObject({ provider: 'alpha', model: 'a1' })
      expect(await (await fetch(`${overridden.url}/api/workspaces/${workspaceId}/sessions/${existing.id}/model`)).json()).toMatchObject({ provider: 'beta', model: 'b1', source: 'session' })
      const fresh = (await (await post(overridden.url, `/api/workspaces/${workspaceId}/sessions`)).json()) as { id: string }
      expect(await (await fetch(`${overridden.url}/api/workspaces/${workspaceId}/sessions/${fresh.id}/model`)).json()).toMatchObject({ provider: 'alpha', model: 'a1', source: 'session' })
    })
  }

  it('clears activeModel override after sync removes its model', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-runtime-sync-invalidation-'))
    homes.push(home)
    const { createServer } = await import('node:http')
    const endpoint = await new Promise<{ server: import('node:http').Server; baseUrl: string }>((resolve) => {
      const stub = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'b2' }] })) })
      stub.listen(0, '127.0.0.1', () => { const address = stub.address() as import('node:net').AddressInfo; resolve({ server: stub, baseUrl: `http://127.0.0.1:${address.port}/v1` }) })
    })
    const file = path.join(home, 'providers.json')
    const seed = await createWebServer({ home, configFile: file })
    servers.push(seed)
    await post(seed.url, '/api/providers', { name: 'Alpha', baseUrl: endpoint.baseUrl, apiKey: '', models: ['a1'] })
    await post(seed.url, '/api/providers', { name: 'Beta', baseUrl: endpoint.baseUrl, apiKey: '', models: ['b1', 'b2'] })
    await seed.close(); servers.splice(servers.indexOf(seed), 1)
    const server = await createWebServer({ home, configFile: file, activeModel: { provider: 'beta', model: 'b1' } })
    servers.push(server)
    expect((await post(server.url, '/api/providers/beta/sync')).status).toBe(200)
    expect(await (await fetch(`${server.url}/api/model-defaults`)).json()).toMatchObject({ provider: 'alpha', model: 'a1' })
    await new Promise<void>((resolve) => endpoint.server.close(() => resolve()))
  })
})
