import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWebServer, type LlmProvider, type WebServer } from 'dnt-harness'

const servers: WebServer[] = []
const homes: string[] = []
const post = (base: string, route: string, body?: unknown) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
const patch = (base: string, route: string, body: unknown) => fetch(`${base}${route}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const put = (base: string, route: string, body: unknown) => fetch(`${base}${route}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

async function boot(providers: readonly LlmProvider[]) {
  const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-alias-spawn-'))
  homes.push(home)
  const server = await createWebServer({ home, providers, configFile: path.join(home, 'providers.json') })
  servers.push(server)
  const wsId = (await (await fetch(`${server.url}/api/workspaces`)).json() as { id: string }[])[0]!.id
  return { server, base: server.url, home, wsId }
}

async function createAlias(base: string, name: string, provider: string, model: string, thinkingLevel: string | null = null) {
  const response = await post(base, '/api/model-aliases', { name, provider, model, thinkingLevel })
  expect(response.status).toBe(201)
  return response.json() as Promise<{ revision: number }>
}

async function waitIdle(base: string, wsId: string, id: string): Promise<void> {
  await expect.poll(async () => {
    const rows = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`)).json() as { id: string; status: string }[]
    return rows.find((row) => row.id === id)?.status
  }, { timeout: 10_000 }).toBe('idle')
}

async function snapshot(base: string, wsId: string, id: string): Promise<{ type: string; [key: string]: unknown }[]> {
  const response = await fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/events`)
  const reader = response.body!.getReader(); const decoder = new TextDecoder(); let buffer = ''
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) return []
      buffer += decoder.decode(chunk.value, { stream: true })
      const boundary = buffer.indexOf('\n\n'); if (boundary < 0) continue
      const line = buffer.slice(0, boundary).split('\n').find((part) => part.startsWith('data: '))
      if (line === undefined) { buffer = buffer.slice(boundary + 2); continue }
      const envelope = JSON.parse(line.slice(6)) as { kind: string; events?: { type: string }[] }
      if (envelope.kind === 'snapshot') return envelope.events ?? []
      buffer = buffer.slice(boundary + 2)
    }
  } finally { void reader.cancel() }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })))
})

describe('model alias spawn integration', () => {
  it('manual spawn applies explicit > role, preserves null thinking, and alias edits affect only future children', async () => {
    const stall = async function* () { await new Promise(() => {}); yield { type: 'delta' as const, delta: 'never' } }
    const { base, home, wsId } = await boot([
      { name: 'alpha', models: ['a1', 'a2'], stream: stall },
      { name: 'beta', models: ['b1'], stream: stall },
    ])
    await createAlias(base, 'role-model', 'alpha', 'a1', null)
    const explicit = await createAlias(base, 'explicit-model', 'beta', 'b1', null)
    await fs.mkdir(path.join(home, 'workspaces', wsId, 'agents'), { recursive: true })
    await fs.writeFile(path.join(home, 'workspaces', wsId, 'agents', 'alias-worker.md'), '---\ndescription: alias worker\nmodel: role-model\ntools: []\n---\nWork.', 'utf8')
    const root = await (await post(base, `/api/workspaces/${wsId}/sessions`)).json() as { id: string }

    const roleSpawn = await post(base, `/api/workspaces/${wsId}/agents/alias-worker`, { rootSessionId: root.id, task: { prompt: 'role alias' }, keepOpen: true })
    expect(roleSpawn.status).toBe(202)
    const roleChild = await roleSpawn.json() as { model: string; parentTurnId: string }
    expect(roleChild).toMatchObject({ model: 'alpha:a1' })

    const first = await post(base, `/api/workspaces/${wsId}/agents/alias-worker`, { rootSessionId: root.id, parentTurnId: roleChild.parentTurnId, task: { prompt: 'explicit alias' }, model: 'explicit-model', keepOpen: true })
    expect(first.status).toBe(202)
    const firstChild = await first.json() as { childSessionId: string; model: string; parentTurnId: string }
    expect(firstChild.model).toBe('beta:b1')
    expect(await (await fetch(`${base}/api/workspaces/${wsId}/sessions/${firstChild.childSessionId}/model`)).json()).toMatchObject({ provider: 'beta', model: 'b1', thinkingLevel: null })

    expect((await patch(base, '/api/model-aliases/explicit-model', { expectedRevision: explicit.revision, name: 'explicit-model', provider: 'alpha', model: 'a2', thinkingLevel: null })).status).toBe(200)
    const second = await post(base, `/api/workspaces/${wsId}/agents/alias-worker`, { rootSessionId: root.id, parentTurnId: firstChild.parentTurnId, task: { prompt: 'future alias' }, model: 'explicit-model' })
    expect(second.status).toBe(202)
    const secondChild = await second.json() as { childSessionId: string; model: string }
    expect(secondChild.model).toBe('alpha:a2')
    expect(await (await fetch(`${base}/api/workspaces/${wsId}/sessions/${firstChild.childSessionId}/model`)).json()).toMatchObject({ provider: 'beta', model: 'b1', thinkingLevel: null })
    await post(base, `/api/workspaces/${wsId}/sessions/${root.id}/stop`)
  }, 20_000)

  it('Agent tool resolves a plain alias, while an invalid alias fails before publishing a child', async () => {
    let phase: 'valid' | 'invalid' = 'valid'
    let spawnNext = true
    let waitNext = false
    let callId = 0
    const scripted: LlmProvider = {
      name: 'scripted', models: ['root', 'child'],
      async *stream(request) {
        if (request.model === 'child') {
          yield { type: 'delta', delta: 'child done' }
          yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
          return
        }
        if (spawnNext) {
          spawnNext = false
          waitNext = phase === 'valid'
          callId += 1
          yield { type: 'toolCalls', calls: [{ id: `spawn-${callId}`, name: 'Agent', args: { action: 'spawn', definition: 'explorer', prompt: phase, model: phase === 'valid' ? 'tool-alias' : 'broken-alias' } }] }
          yield { type: 'completion', finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }
          return
        }
        if (waitNext) {
          waitNext = false
          callId += 1
          yield { type: 'toolCalls', calls: [{ id: `wait-${callId}`, name: 'Agent', args: { action: 'wait', timeoutMs: 5000 } }] }
          yield { type: 'completion', finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }
          return
        }
        yield { type: 'delta', delta: 'root done' }
        yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
      },
    }
    const { base, wsId } = await boot([scripted])
    await createAlias(base, 'tool-alias', 'scripted', 'child', null)
    await put(base, `/api/workspaces/${wsId}/mode`, { modeId: 'full-access' })
    const root = await (await post(base, `/api/workspaces/${wsId}/sessions`)).json() as { id: string }
    await put(base, `/api/workspaces/${wsId}/sessions/${root.id}/model`, { provider: 'scripted', model: 'root', thinkingLevel: null })
    const validTurn = await post(base, `/api/workspaces/${wsId}/sessions/${root.id}/messages`, { content: 'spawn valid' })
    expect(validTurn.status).toBe(202)
    await waitIdle(base, wsId, root.id)
    let children = await (await fetch(`${base}/api/workspaces/${wsId}/agents/children?root=${root.id}`)).json() as { model?: string }[]
    expect(children).toHaveLength(1)
    expect(children[0]?.model).toBe('scripted:child')

    await post(base, '/api/providers', { name: 'Configured', baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', models: ['c1'] })
    await createAlias(base, 'broken-alias', 'configured', 'c1', null)
    await patch(base, '/api/providers/configured', { enabled: false })
    phase = 'invalid'
    spawnNext = true
    await post(base, `/api/workspaces/${wsId}/sessions/${root.id}/messages`, { content: 'spawn invalid' })
    await waitIdle(base, wsId, root.id)
    children = await (await fetch(`${base}/api/workspaces/${wsId}/agents/children?root=${root.id}`)).json() as { model?: string }[]
    expect(children).toHaveLength(1)
    const events = await snapshot(base, wsId, root.id)
    expect(events.filter((event) => event.type === 'agent/child-spawn')).toHaveLength(1)
    expect(JSON.stringify(events)).toMatch(/broken-alias.*no usable provider|no usable provider.*broken-alias/)
  }, 20_000)
})
