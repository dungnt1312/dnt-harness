import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWebServer, type LlmProvider, type WebServer } from 'dnt-harness'
import type { ProviderStore } from '../../src/web/provider-store.ts'
import { saveProviderStore } from '../../src/web/provider-store.ts'

const servers: WebServer[] = []
const homes: string[] = []

const provider = (name: string, models: readonly string[]): LlmProvider => ({
  name, models,
  async *stream() { yield { type: 'delta', delta: 'ok' } },
})

async function boot(options: { home?: string; providers?: readonly LlmProvider[]; writer?: (file: string, store: ProviderStore) => Promise<void> } = {}) {
  const home = options.home ?? await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-model-alias-http-'))
  if (options.home === undefined) homes.push(home)
  const file = path.join(home, 'providers.json')
  const server = await createWebServer({ home, configFile: file, providers: options.providers ?? [provider('alpha', ['a1', 'a2']), provider('beta', ['b1'])], ...(options.writer === undefined ? {} : { providerStoreWriter: options.writer }) })
  servers.push(server)
  return { server, base: server.url, home, file }
}

const json = (base: string, method: string, route: string, body?: unknown) => fetch(`${base}${route}`, {
  method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const create = (base: string, body: unknown) => json(base, 'POST', '/api/model-aliases', body)
const patch = (base: string, name: string, body: unknown) => json(base, 'PATCH', `/api/model-aliases/${encodeURIComponent(name)}`, body)
const remove = (base: string, name: string, revision: number) => json(base, 'DELETE', `/api/model-aliases/${encodeURIComponent(name)}`, { expectedRevision: revision })
const list = async (base: string) => (await (await fetch(`${base}/api/model-aliases`)).json()) as { name: string; provider: string; model: string; thinkingLevel: string | null; revision: number; status: string; warnings: string[] }[]

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })))
})

describe('global model alias HTTP CRUD', () => {
  it('creates, lists globally, renames, deletes, and survives restart', async () => {
    const { server, base, home, file } = await boot()
    const workspaces = await (await fetch(`${base}/api/workspaces`)).json() as { id: string }[]
    await json(base, 'POST', '/api/workspaces', { name: 'Second' })
    expect(workspaces).toHaveLength(1)

    const created = await create(base, { name: '  fast  ', provider: 'alpha', model: 'a2', thinkingLevel: null })
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({ name: 'fast', provider: 'alpha', model: 'a2', thinkingLevel: null, revision: 1, status: 'valid' })
    expect(await list(base)).toHaveLength(1)

    const renamed = await patch(base, 'fast', { expectedRevision: 1, name: 'quick', provider: 'beta', model: 'b1', thinkingLevel: null })
    expect(renamed.status).toBe(200)
    expect(await renamed.json()).toMatchObject({ name: 'quick', revision: 2, provider: 'beta', model: 'b1' })
    expect((await list(base)).map((row) => row.name)).toEqual(['quick'])

    await server.close(); servers.splice(servers.indexOf(server), 1)
    const restarted = await createWebServer({ home, configFile: file, providers: [provider('alpha', ['a1', 'a2']), provider('beta', ['b1'])] })
    servers.push(restarted)
    expect(await list(restarted.url)).toEqual([expect.objectContaining({ name: 'quick', provider: 'beta', model: 'b1', revision: 2 })])
    expect((await remove(restarted.url, 'quick', 2)).status).toBe(200)
    expect(await list(restarted.url)).toEqual([])
  })

  it('validates names and targets and reports collisions without rejecting them', async () => {
    const { base } = await boot({ providers: [provider('alpha', ['a1', 'sonnet'])] })
    for (const name of ['', ' ', 'two words', 'a:b', 'a@b', 'inherit', 'bad\u0001']) {
      expect((await create(base, { name, provider: 'alpha', model: 'a1', thinkingLevel: null })).status).toBe(400)
    }
    expect((await create(base, { name: 'missing-provider', provider: 'gone', model: 'a1', thinkingLevel: null })).status).toBe(400)
    expect((await create(base, { name: 'missing-model', provider: 'alpha', model: 'gone', thinkingLevel: null })).status).toBe(400)
    expect((await create(base, { name: 'bad-thinking', provider: 'alpha', model: 'a1', thinkingLevel: 'high' })).status).toBe(400)
    const collision = await create(base, { name: 'sonnet', provider: 'alpha', model: 'a1', thinkingLevel: null })
    expect(collision.status).toBe(201)
    expect((await collision.json() as { warnings: string[] }).warnings.join(' ')).toMatch(/shadows built-in|shadows advertised/)
    expect((await create(base, { name: 'sonnet', provider: 'alpha', model: 'a1', thinkingLevel: null })).status).toBe(409)
  })

  it('never reuses a revision after delete/recreate, including across restart', async () => {
    const { server, base, home, file } = await boot()
    const first = await create(base, { name: 'fast', provider: 'alpha', model: 'a1', thinkingLevel: null })
    const firstRow = await first.json() as { revision: number }
    await remove(base, 'fast', firstRow.revision)
    await server.close(); servers.splice(servers.indexOf(server), 1)
    const restarted = await createWebServer({ home, configFile: file, providers: [provider('alpha', ['a1', 'a2'])] })
    servers.push(restarted)
    const recreated = await create(restarted.url, { name: 'fast', provider: 'alpha', model: 'a1', thinkingLevel: null })
    const recreatedRow = await recreated.json() as { revision: number }
    expect(recreatedRow.revision).toBeGreaterThan(firstRow.revision)
    expect((await remove(restarted.url, 'fast', firstRow.revision)).status).toBe(409)
  })

  it('validates create targets inside the serialized transaction', async () => {
    const { base } = await boot({ providers: [] })
    expect((await json(base, 'POST', '/api/providers', { name: 'Alpha', baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', models: ['a1'] })).status).toBe(201)
    const disable = json(base, 'PATCH', '/api/providers/alpha', { enabled: false })
    const createAfter = create(base, { name: 'late', provider: 'alpha', model: 'a1', thinkingLevel: null })
    expect((await disable).status).toBe(200)
    expect((await createAfter).status).toBe(400)
    expect(await list(base)).toEqual([])
  })

  it('returns 409 for stale rename/delete revisions and keeps the committed row', async () => {
    const { base } = await boot()
    await create(base, { name: 'fast', provider: 'alpha', model: 'a1', thinkingLevel: null })
    expect((await patch(base, 'fast', { expectedRevision: 1, name: 'quick', provider: 'alpha', model: 'a2', thinkingLevel: null })).status).toBe(200)
    expect((await patch(base, 'quick', { expectedRevision: 1, name: 'stale', provider: 'alpha', model: 'a1', thinkingLevel: null })).status).toBe(409)
    expect((await remove(base, 'quick', 1)).status).toBe(409)
    expect(await list(base)).toEqual([expect.objectContaining({ name: 'quick', revision: 2 })])
  })

  it('serializes independent alias and provider/default mutations without losing fields', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-model-alias-http-'))
    homes.push(home)
    const file = path.join(home, 'providers.json')
    const initial: ProviderStore = {
      version: 2,
      defaults: { provider: 'alpha', model: 'a1', thinkingLevel: null },
      providers: [
        { id: 'alpha', name: 'Alpha', baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', models: ['a1', 'a2'], enabled: true },
        { id: 'beta', name: 'Beta', baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', models: ['b1'], enabled: true },
      ],
      aliases: [],
      aliasGeneration: 0,
    }
    await saveProviderStore(file, initial)
    const server = await createWebServer({ home, configFile: file })
    servers.push(server)
    const base = server.url
    await Promise.all([
      create(base, { name: 'one', provider: 'alpha', model: 'a1', thinkingLevel: null }),
      create(base, { name: 'two', provider: 'beta', model: 'b1', thinkingLevel: null }),
      json(base, 'PUT', '/api/model-defaults', { provider: 'alpha', model: 'a2', thinkingLevel: null }),
      json(base, 'PATCH', '/api/providers/beta', { name: 'Beta renamed' }),
    ])
    expect((await list(base)).map((row) => row.name).sort()).toEqual(['one', 'two'])
    expect(await (await fetch(`${base}/api/model-defaults`)).json()).toMatchObject({ provider: 'alpha', model: 'a2' })
    expect(await (await fetch(`${base}/api/providers`)).json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'beta', name: 'Beta renamed' })]))
    const disk = JSON.parse(await fs.readFile(file, 'utf8')) as { aliases: { name: string }[]; defaults: { model: string }; providers: { name: string }[] }
    expect(disk.aliases.map((row) => row.name).sort()).toEqual(['one', 'two'])
    expect(disk.defaults.model).toBe('a2')
    expect(disk.providers).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Beta renamed' })]))
  })

  it('does not publish an alias when its durable write fails', async () => {
    let fail = false
    const { base } = await boot({ writer: async (file, store) => { if (fail) throw new Error('injected alias write failure'); await saveProviderStore(file, store) } })
    await create(base, { name: 'kept', provider: 'alpha', model: 'a1', thinkingLevel: null })
    fail = true
    const response = await create(base, { name: 'leaked', provider: 'alpha', model: 'a2', thinkingLevel: null })
    expect(response.status).toBe(500)
    expect(await list(base)).toEqual([expect.objectContaining({ name: 'kept' })])
  })
})
