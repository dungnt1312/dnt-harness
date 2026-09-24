/**
 * G4 over HTTP: agent definition routes, spawn/wait/cancel lifecycle,
 * one-level enforcement, and root Stop cleaning up children.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWebServer, type LlmProvider, type WebServer } from 'mini-dsh'

let root = ''
const servers: WebServer[] = []

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g4-web-'))
})

afterAll(async () => {
  for (const server of servers) await server.close().catch(() => {})
  await fs.rm(root, { recursive: true, force: true })
})

async function post(base: string, pathname: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

/** The first tool result in a session's snapshot matching `needle`. */
async function toolResultMatching(base: string, wsId: string, sessionId: string, needle: RegExp): Promise<string> {
  const response = await fetch(`${base}/api/workspaces/${wsId}/sessions/${sessionId}/events`)
  const reader = (response.body as ReadableStream).getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + 5_000
  try {
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), deadline - Date.now())),
      ])
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      const boundary = buffer.indexOf('\n\n')
      if (boundary < 0) continue
      const dataLine = buffer.slice(0, boundary).split('\n').find((line) => line.startsWith('data: '))
      if (dataLine === undefined) continue
      const envelope = JSON.parse(dataLine.slice('data: '.length)) as { kind: string; events?: { type: string; output?: string }[] }
      if (envelope.kind !== 'snapshot') continue
      return (envelope.events ?? []).find((event) => event.type === 'tool/result' && needle.test(event.output ?? ''))?.output ?? ''
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  return ''
}

describe('G4 HTTP surface', () => {
  it('spawns a child from a root session, lists children, and root Stop cancels them', async () => {
    // The child provider stalls forever so children are provably RUNNING
    // when the lifecycle operations fire (no completion race).
    const gate: LlmProvider = {
      name: 'scripted',
      models: ['scripted'],
      async *stream() {
        await new Promise(() => {})
        yield { type: 'delta', delta: 'never' }
      },
    }
    const home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g4-home-'))
    const server = await createWebServer({ home, providers: [gate], configFile: path.join(home, 'p.json') })
    servers.push(server)
    const base = server.url
    const wsId = (await (await fetch(`${base}/api/workspaces`)).json() as { id: string }[])[0]!.id

    const rootSession = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
    const spawned = await post(base, `/api/workspaces/${wsId}/agents/worker`, {
      rootSessionId: rootSession.id,
      task: { objective: 'do a unit of work', constraints: ['stay minimal'], requiredResult: 'summary' },
    })
    expect(spawned.status).toBe(202)
    const handle = (await spawned.json()) as { childSessionId: string; status: string }
    expect(handle.status).toBe('running')

    // Children listed under the root.
    const children = (await (await fetch(`${base}/api/workspaces/${wsId}/agents/children?root=${rootSession.id}`)).json()) as { status: string }[]
    expect(children.length).toBe(1)

    // Cancel via the lifecycle route.
    const cancelled = await post(base, `/api/workspaces/${wsId}/children/${handle.childSessionId}/cancel`)
    expect(cancelled.status).toBe(200)
    expect(((await cancelled.json()) as { status: string }).status).toBe('cancelled')

    // A second spawn + root Stop cleans it up.
    await post(base, `/api/workspaces/${wsId}/agents/worker`, {
      rootSessionId: rootSession.id,
      task: { objective: 'another unit', constraints: [], requiredResult: 'summary' },
    })
    const stop = await post(base, `/api/workspaces/${wsId}/sessions/${rootSession.id}/stop`)
    expect(stop.status).toBe(202)
    expect(((await stop.json()) as { childrenCancelled?: number }).childrenCancelled).toBe(1)

    // Unknown definition 404s.
    expect((await post(base, `/api/workspaces/${wsId}/agents/no-such-role`, {
      rootSessionId: rootSession.id,
      task: { objective: 'x' },
    })).status).toBe(404)
    await server.close()
  }, 20_000)

  it('reconciles only a child owned by the addressed non-default workspace parent session', async () => {
    const stall: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream() { await new Promise(() => {}); yield { type: 'delta', delta: 'never' } },
    }
    const home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g4-reconcile-http-'))
    const server = await createWebServer({ home, providers: [stall], configFile: path.join(home, 'p.json') })
    servers.push(server)
    const base = server.url
    const workspace = await (await post(base, '/api/workspaces', { name: 'Non-default reconcile workspace' })).json() as { id: string }
    const parent = await (await post(base, `/api/workspaces/${workspace.id}/sessions`)).json() as { id: string }
    const otherParent = await (await post(base, `/api/workspaces/${workspace.id}/sessions`)).json() as { id: string }
    const spawned = await post(base, `/api/workspaces/${workspace.id}/agents/worker`, {
      rootSessionId: parent.id, task: { objective: 'wait', requiredResult: 'summary' },
    })
    const child = await spawned.json() as { childSessionId: string; status: string }
    expect(child.status).toBe('running')

    const foreign = await post(base, `/api/workspaces/${workspace.id}/sessions/${otherParent.id}/children/${child.childSessionId}/reconcile`)
    expect(foreign.status).toBe(404)
    const owned = await post(base, `/api/workspaces/${workspace.id}/sessions/${parent.id}/children/${child.childSessionId}/reconcile`)
    expect(owned.status).toBe(200)
    expect((await owned.json()) as { childSessionId: string }).toMatchObject({ childSessionId: child.childSessionId })
    // Legacy default-workspace clients retain their original route.
    const legacy = await post(base, `/api/sessions/${parent.id}/children/${child.childSessionId}/reconcile`)
    expect(legacy.status).toBe(404)
    await post(base, `/api/workspaces/${workspace.id}/sessions/${parent.id}/stop`)
    await server.close()
  }, 20_000)

  it('the child definition ceiling denies Bash for an Explorer even in Full access', async () => {
    // Full access exposes Bash at the MODE level; the Explorer definition
    // ceiling must still deny it — the trust boundary under test.
    let requests = 0
    const bash: LlmProvider = {
      name: 'scripted',
      models: ['scripted'],
      async *stream() {
        requests += 1
        if (requests === 1) {
          yield { type: 'toolCalls', calls: [{ id: 'c1', name: 'Bash', args: { command: 'echo hacked > hacked.txt' } }] }
          return
        }
        yield { type: 'delta', delta: 'Bash was denied; stopping without retrying.' }
      },
    }
    const home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g4-ceil-'))
    const server = await createWebServer({ home, providers: [bash], configFile: path.join(home, 'p.json') })
    servers.push(server)
    const base = server.url
    const wsId = (await (await fetch(`${base}/api/workspaces`)).json() as { id: string }[])[0]!.id
    expect((await fetch(`${base}/api/workspaces/${wsId}/mode`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modeId: 'full-access' }),
    })).status).toBe(200)

    const rootSession = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
    const spawned = await post(base, `/api/workspaces/${wsId}/agents/explorer`, {
      rootSessionId: rootSession.id,
      task: { objective: 'run bash', constraints: [], requiredResult: 'summary' },
    })
    expect(spawned.status).toBe(202)
    const handle = (await spawned.json()) as { childSessionId: string }

    // Wait for the child turn to settle, then read the durable log.
    const settled = await (await fetch(`${base}/api/workspaces/${wsId}/children/${handle.childSessionId}?waitMs=8000`)).json() as { status: string }
    expect(settled.status).toBe('completed')

    const response = await fetch(`${base}/api/workspaces/${wsId}/sessions/${handle.childSessionId}/events`)
    const reader = (response.body as ReadableStream).getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const deadline = Date.now() + 5_000
    let denial = ''
    try {
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now()
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), remaining)),
        ])
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        const boundary = buffer.indexOf('\n\n')
        if (boundary >= 0) {
          const frame = buffer.slice(0, boundary)
          const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
          if (dataLine === undefined) continue
          const envelope = JSON.parse(dataLine.slice('data: '.length)) as { kind: string; events?: { type: string; output?: string }[] }
          if (envelope.kind === 'snapshot' && envelope.events !== undefined) {
            for (const event of envelope.events) {
              if (event.type === 'tool/result' && (event.output ?? '').includes('does not expose')) {
                denial = event.output ?? ''
                break
              }
            }
            break
          }
        }
      }
    } finally {
      reader.cancel().catch(() => {})
    }
    expect(denial).toMatch(/agent 'explorer' does not expose 'Bash'/)
    expect(requests).toBe(2)
    // The command never executed: no side effect file exists.
    await expect(fs.readFile(path.join(root, 'hacked.txt'), 'utf8')).rejects.toThrow()
    await server.close()
  }, 20_000)

  it('one-level delegation: a child session cannot spawn a grandchild', async () => {
    const stall: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream() { await new Promise(() => {}); yield { type: 'delta', delta: 'never' } },
    }
    const home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g4-depth-'))
    const server = await createWebServer({ home, providers: [stall], configFile: path.join(home, 'p.json') })
    servers.push(server)
    const base = server.url
    const wsId = (await (await fetch(`${base}/api/workspaces`)).json() as { id: string }[])[0]!.id

    const rootSession = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
    const child = await post(base, `/api/workspaces/${wsId}/agents/worker`, {
      rootSessionId: rootSession.id,
      task: { objective: 'child task', constraints: [], requiredResult: 'summary' },
    })
    expect(child.status).toBe(202)
    const childHandle = (await child.json()) as { childSessionId: string }

    // The CHILD session attempts to spawn: refused by durable depth check.
    const grandchild = await post(base, `/api/workspaces/${wsId}/agents/worker`, {
      rootSessionId: childHandle.childSessionId,
      task: { objective: 'grandchild task', constraints: [], requiredResult: 'summary' },
    })
    expect(grandchild.status).toBe(404)
    expect(((await grandchild.json()) as { error: string }).error).toMatch(/one-level|child/)
    await post(base, `/api/workspaces/${wsId}/sessions/${rootSession.id}/stop`)
    await server.close()
  }, 20_000)

  it('a child runs on the resolved pair: spawn choice > role model > parent session', async () => {
    // Two providers so the cross-provider case is real: the model the caller
    // names does not exist on the parent's provider at all.
    const stall = async function* (): AsyncGenerator<{ type: 'delta'; delta: string }> {
      await new Promise(() => {})
      yield { type: 'delta', delta: 'never' }
    }
    const home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g4-model-'))
    const server = await createWebServer({
      home,
      providers: [
        { name: 'house', models: ['house-small', 'house-large'], stream: stall } as LlmProvider,
        { name: 'far', models: ['gpt-luna'], stream: stall } as LlmProvider,
      ],
      configFile: path.join(home, 'p.json'),
    })
    servers.push(server)
    const base = server.url
    const wsId = (await (await fetch(`${base}/api/workspaces`)).json() as { id: string }[])[0]!.id
    const rootSession = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }

    // The conversation pins its own pair; a child must inherit THAT, not the
    // global default (the defect this resolution order fixes).
    expect((await fetch(`${base}/api/workspaces/${wsId}/sessions/${rootSession.id}/model`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'house', model: 'house-large' }),
    })).status).toBe(200)

    const inherited = await post(base, `/api/workspaces/${wsId}/agents/explorer`, {
      rootSessionId: rootSession.id,
      task: { objective: 'inherit the conversation model' },
    })
    expect(inherited.status).toBe(202)
    expect(((await inherited.json()) as { model?: string }).model).toBe('house:house-large')

    // An explicit choice on another provider wins, provider included.
    const chosen = await post(base, `/api/workspaces/${wsId}/agents/explorer`, {
      rootSessionId: rootSession.id,
      task: { objective: 'research a b c' },
      model: 'far:gpt-luna',
    })
    expect(chosen.status).toBe(202)
    expect(((await chosen.json()) as { model?: string }).model).toBe('far:gpt-luna')

    // A bare name resolves to the one provider that offers it.
    const bare = await post(base, `/api/workspaces/${wsId}/agents/explorer`, {
      rootSessionId: rootSession.id,
      task: { objective: 'bare name' },
      model: 'gpt-luna',
    })
    expect(bare.status).toBe(202)
    expect(((await bare.json()) as { model?: string }).model).toBe('far:gpt-luna')

    await post(base, `/api/workspaces/${wsId}/sessions/${rootSession.id}/stop`)

    // An unknown model is a 400 that names what exists, not a host error and
    // not a child that dies at its first request.
    const unknown = await post(base, `/api/workspaces/${wsId}/agents/explorer`, {
      rootSessionId: rootSession.id,
      task: { objective: 'bad model' },
      model: 'no-such-model',
    })
    expect(unknown.status).toBe(400)
    expect(((await unknown.json()) as { error: string }).error).toMatch(/unknown model 'no-such-model'/)
    await server.close()
  }, 20_000)

  it('the model delegates for itself: two children run at once on the model it named', async () => {
    // Children answer on their own provider and overlap deliberately, so the
    // peak counter proves real concurrency rather than a fast sequence.
    let active = 0
    let peak = 0
    const far: LlmProvider = {
      name: 'far', models: ['gpt-luna'],
      async *stream() {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 200))
        active -= 1
        yield { type: 'delta', delta: 'child inspected src/index.ts' }
      },
    }
    let step = 0
    const house: LlmProvider = {
      name: 'house', models: ['house-1'],
      async *stream() {
        step += 1
        if (step === 1) {
          yield {
            type: 'toolCalls',
            calls: [
              { id: 'a1', name: 'Agent', args: { action: 'spawn', definition: 'explorer', objective: 'research a', model: 'far:gpt-luna' } },
              { id: 'a2', name: 'Agent', args: { action: 'spawn', definition: 'explorer', objective: 'research b', model: 'far:gpt-luna' } },
            ],
          }
          return
        }
        if (step === 2) {
          yield { type: 'toolCalls', calls: [{ id: 'a3', name: 'Agent', args: { action: 'wait', timeoutMs: 5000 } }] }
          return
        }
        yield { type: 'delta', delta: 'both children reported back' }
      },
    }
    const home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g4-tool-'))
    const server = await createWebServer({ home, providers: [house, far], configFile: path.join(home, 'p.json') })
    servers.push(server)
    const base = server.url
    const wsId = (await (await fetch(`${base}/api/workspaces`)).json() as { id: string }[])[0]!.id
    expect((await fetch(`${base}/api/workspaces/${wsId}/mode`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modeId: 'full-access' }),
    })).status).toBe(200)

    const rootSession = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
    await fetch(`${base}/api/workspaces/${wsId}/sessions/${rootSession.id}/model`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'house', model: 'house-1' }),
    })
    await post(base, `/api/workspaces/${wsId}/sessions/${rootSession.id}/messages`, { content: 'research a and b' })

    const deadline = Date.now() + 15_000
    let children: { status: string; model?: string }[] = []
    while (Date.now() < deadline) {
      children = await (await fetch(`${base}/api/workspaces/${wsId}/agents/children?root=${rootSession.id}`)).json() as typeof children
      if (children.length === 2 && children.every((child) => child.status === 'completed')) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(children.map((child) => child.status)).toEqual(['completed', 'completed'])
    // The model's own choice, provider included — not the conversation's pair.
    expect(children.map((child) => child.model)).toEqual(['far:gpt-luna', 'far:gpt-luna'])
    expect(peak).toBe(2)

    // The root saw both digests through one wait call.
    const waited = await toolResultMatching(base, wsId, rootSession.id, /child inspected/)
    expect(waited).toContain('child inspected src/index.ts')
    // The wait result is durable before the root takes its next step.
    await expect.poll(() => step, { timeout: 5_000 }).toBe(3)
    await server.close()
  }, 30_000)

  it('a child is denied Agent even when its definition lists it', async () => {
    let childRequests = 0
    const scripted: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream() {
        childRequests += 1
        if (childRequests === 1) {
          yield { type: 'toolCalls', calls: [{ id: 'd1', name: 'Agent', args: { action: 'spawn', definition: 'explorer', objective: 'grandchild' } }] }
          return
        }
        yield { type: 'delta', delta: 'delegation was denied; stopping' }
      },
    }
    const home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g4-nodeleg-'))
    const server = await createWebServer({ home, providers: [scripted], configFile: path.join(home, 'p.json') })
    servers.push(server)
    const base = server.url
    const wsId = (await (await fetch(`${base}/api/workspaces`)).json() as { id: string }[])[0]!.id
    expect((await fetch(`${base}/api/workspaces/${wsId}/mode`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modeId: 'full-access' }),
    })).status).toBe(200)

    // A definition that asks for Agent explicitly — the ceiling alone would
    // let this through, so the gate's one-level deny is what is under test.
    expect((await post(base, `/api/workspaces/${wsId}/agents/delegator/import`, {
      content: `---\nname: delegator\ndescription: tries to delegate\ntools: ["Agent", "Read"]\n---\n\nTry to delegate.`,
    })).status).toBe(201)

    const rootSession = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
    const spawned = await post(base, `/api/workspaces/${wsId}/agents/delegator`, {
      rootSessionId: rootSession.id,
      task: { objective: 'delegate further' },
      grantTools: ['Agent', 'Read'],
    })
    expect(spawned.status).toBe(202)
    const handle = (await spawned.json()) as { childSessionId: string }
    const settled = await (await fetch(`${base}/api/workspaces/${wsId}/children/${handle.childSessionId}?waitMs=8000`)).json() as { status: string }
    expect(settled.status).toBe('completed')

    const denial = await toolResultMatching(base, wsId, handle.childSessionId, /one-level delegation/)
    expect(denial).toMatch(/one-level delegation: a child agent cannot delegate/)
    // No grandchild exists: the root still owns exactly one child.
    const children = await (await fetch(`${base}/api/workspaces/${wsId}/agents/children?root=${rootSession.id}`)).json() as unknown[]
    expect(children.length).toBe(1)
    await server.close()
  }, 20_000)

  it('child approvals relay onto the root SSE stream and the workspace badge', async () => {
    let step = 0
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream() {
        step += 1
        if (step === 1) {
          yield { type: 'toolCalls', calls: [{ id: 'w1', name: 'Write', args: { path: 'x.txt', content: 'x' } }] }
          return
        }
        yield { type: 'delta', delta: 'done' }
      },
    }
    const home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g4-appr-'))
    const server = await createWebServer({ home, providers: [provider], configFile: path.join(home, 'p.json') })
    servers.push(server)
    const base = server.url
    const wsId = (await (await fetch(`${base}/api/workspaces`)).json() as { id: string }[])[0]!.id
    const rootSession = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
    const spawned = await post(base, `/api/workspaces/${wsId}/agents/worker`, {
      rootSessionId: rootSession.id,
      task: { objective: 'write a file', constraints: [], requiredResult: 'summary' },
    })
    expect(spawned.status).toBe(202)
    const handle = (await spawned.json()) as { childSessionId: string }

    const response = await fetch(`${base}/api/workspaces/${wsId}/sessions/${rootSession.id}/events`)
    const reader = (response.body as ReadableStream).getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const deadline = Date.now() + 8_000
    let found: { approvalId: string; childSessionId?: string } | undefined
    try {
      while (Date.now() < deadline && found === undefined) {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), deadline - Date.now())),
        ])
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          boundary = buffer.indexOf('\n\n')
          const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
          if (dataLine === undefined) continue
          const envelope = JSON.parse(dataLine.slice('data: '.length)) as {
            kind: string
            approvalId?: string
            childSessionId?: string
          }
          if (envelope.kind === 'approval' && envelope.approvalId !== undefined) {
            found = {
              approvalId: envelope.approvalId,
              ...(envelope.childSessionId !== undefined ? { childSessionId: envelope.childSessionId } : {}),
            }
            break
          }
        }
      }
    } finally {
      reader.cancel().catch(() => {})
    }
    expect(found?.childSessionId).toBe(handle.childSessionId)
    const rows = (await (await fetch(`${base}/api/workspaces`)).json()) as { id: string; approvals?: number }[]
    expect(rows.find((row) => row.id === wsId)?.approvals).toBeGreaterThan(0)
    expect((await post(base, `/api/approvals/${found?.approvalId ?? ''}`, { allow: true })).status).toBe(200)
    await server.close()
  }, 20_000)

  it('Claude import over HTTP reports blocked fields and prevents activation', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g4-imp-'))
    const server = await createWebServer({
      home,
      providers: [{ name: 'scripted', models: ['scripted'], async *stream() { yield { type: 'delta', delta: 'x' } } }],
      configFile: path.join(home, 'p.json'),
    })
    servers.push(server)
    const base = server.url
    const wsId = (await (await fetch(`${base}/api/workspaces`)).json() as { id: string }[])[0]!.id
    const imported = await post(base, `/api/workspaces/${wsId}/agents/from-claude/import`, {
      content: `---
name: auditor
description: audits
tools: ["Read"]
hooks:
  PreToolUse: x
---

body`,
    })
    // Blocked content is QUARANTINED (422): never saved as executable.
    expect(imported.status).toBe(422)
    const body = (await imported.json()) as { blocked: string[]; preview: { name: string } }
    expect(body.blocked).toContain('hooks')
    expect(body.preview.name).toBe('auditor')
    // A clean import (no blocking fields) saves and activates.
    const clean = await post(base, `/api/workspaces/${wsId}/agents/from-claude/import`, {
      content: `---
name: cleaner
description: clean import
tools: ["Read"]
---

body`,
    })
    expect(clean.status).toBe(201)
    expect(((await clean.json()) as { active: boolean }).active).toBe(true)
    const catalog = await (await fetch(`${base}/api/workspaces/${wsId}/agents`)).json() as { definition: { name: string } }[]
    expect(catalog.map(row => row.definition.name)).toContain('from-claude')
    expect((await fetch(`${base}/api/workspaces/${wsId}/agents/from-claude`)).status).toBe(200)
    const session = await (await post(base, `/api/workspaces/${wsId}/sessions`)).json() as { id: string }
    expect((await post(base, `/api/workspaces/${wsId}/agents/from-claude`, { rootSessionId: session.id, task: { objective: 'Inspect only' } })).status).toBe(202)
    expect((await fetch(`${base}/api/workspaces/${wsId}/agents/from-claude`, { method: 'DELETE' })).status).toBe(200)
    const remaining = await (await fetch(`${base}/api/workspaces/${wsId}/agents`)).json() as typeof catalog
    expect(remaining.map(row => row.definition.name)).not.toContain('from-claude')
    await server.close()
  }, 15_000)
})
