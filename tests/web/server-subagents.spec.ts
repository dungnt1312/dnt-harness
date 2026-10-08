/**
 * The subagent contract over HTTP: a child session is executor-only, the
 * spawn route takes a prose brief and opt-in inherited context with typed
 * 400s, a child request is assembled as its role within its ceiling, and the
 * writer boundary is exactly the documented asymmetric lease handoff.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createWebServer, type LlmProvider, type ModelRequest, type WebServer } from 'dnt-harness'

const servers: WebServer[] = []
const homes: string[] = []

afterAll(async () => {
  for (const server of servers) await server.close().catch(() => {})
  for (const home of homes) await fs.rm(home, { recursive: true, force: true })
})

async function post(base: string, pathname: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

async function boot(providers: LlmProvider[], mode?: string): Promise<{ server: WebServer; base: string; wsId: string; home: string }> {
  const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-subagents-'))
  homes.push(home)
  const strictProviders = providers.map((provider): LlmProvider => ({
    ...provider,
    async *stream(request, options) {
      let toolCalls = false
      for await (const event of provider.stream(request, options)) {
        if (event.type === 'toolCalls') toolCalls = true
        yield event
      }
      yield { type: 'completion', finishReason: toolCalls ? 'tool_calls' : 'stop', transport: 'done', policy: 'strict', transportSettled: true }
    },
  }))
  const server = await createWebServer({ home, providers: strictProviders, configFile: path.join(home, 'p.json') })
  servers.push(server)
  const base = server.url
  const wsId = (await (await fetch(`${base}/api/workspaces`)).json() as { id: string }[])[0]!.id
  if (mode !== undefined) {
    expect((await fetch(`${base}/api/workspaces/${wsId}/mode`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modeId: mode }),
    })).status).toBe(200)
  }
  return { server, base, wsId, home }
}

const systemText = (request: ModelRequest): string => {
  const first = request.messages[0]
  return typeof first?.content === 'string' ? first.content : ''
}
const isChild = (request: ModelRequest): boolean => systemText(request).includes('You are a subagent')

/** Full log of one session via its SSE snapshot. */
async function snapshot(base: string, wsId: string, sessionId: string): Promise<{ type: string; [key: string]: unknown }[]> {
  const response = await fetch(`${base}/api/workspaces/${wsId}/sessions/${sessionId}/events`)
  const reader = (response.body as ReadableStream).getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return []
      buffer += decoder.decode(chunk.value, { stream: true })
      const boundary = buffer.indexOf('\n\n')
      if (boundary < 0) continue
      const dataLine = buffer.slice(0, boundary).split('\n').find((line) => line.startsWith('data: '))
      if (dataLine === undefined) { buffer = buffer.slice(boundary + 2); continue }
      const envelope = JSON.parse(dataLine.slice('data: '.length)) as { kind: string; events?: { type: string }[] }
      if (envelope.kind === 'snapshot') return envelope.events ?? []
      buffer = buffer.slice(boundary + 2)
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}

describe('subagent contract over HTTP', () => {
  it('a child session refuses direct messages; its root still accepts them', async () => {
    const stall: LlmProvider = { name: 'scripted', models: ['scripted'], async *stream() { yield { type: 'delta', delta: 'ok' } } }
    const { base, wsId } = await boot([stall])
    const root = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
    const spawned = await post(base, `/api/workspaces/${wsId}/agents/explorer`, { rootSessionId: root.id, task: { prompt: 'Look around.' } })
    expect(spawned.status).toBe(202)
    const child = (await spawned.json()) as { childSessionId: string }
    await fetch(`${base}/api/workspaces/${wsId}/sessions/${root.id}/children/${child.childSessionId}?waitMs=5000`)

    const direct = await post(base, `/api/workspaces/${wsId}/sessions/${child.childSessionId}/messages`, { content: 'keep going' })
    expect(direct.status).toBe(409)
    expect(((await direct.json()) as { error: string }).error).toMatch(/executor-managed/)
    const legacy = await post(base, `/api/sessions/${child.childSessionId}/messages`, { content: 'keep going' })
    expect([404, 409]).toContain(legacy.status)
    expect((await post(base, `/api/workspaces/${wsId}/sessions/${root.id}/messages`, { content: 'hello' })).status).toBeLessThan(300)
  }, 20_000)

  it('deleting an idle root stops the children it still has running', async () => {
    let aborted = 0
    let started = false
    const stall: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream(_request, options) {
        started = true
        await new Promise<void>((resolve) => {
          const signal = (options as { signal?: AbortSignal } | undefined)?.signal
          if (signal === undefined) return
          signal.addEventListener('abort', () => { aborted += 1; resolve() }, { once: true })
        })
        yield { type: 'delta', delta: 'late' }
      },
    }
    const { base, wsId } = await boot([stall])
    const root = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
    const spawned = (await (await post(base, `/api/workspaces/${wsId}/agents/explorer`, { rootSessionId: root.id, task: { prompt: 'Wait.' } })).json()) as { childSessionId: string }
    for (let i = 0; i < 100 && !started; i++) await new Promise((resolve) => setTimeout(resolve, 20))
    expect(started).toBe(true)
    expect((await fetch(`${base}/api/workspaces/${wsId}/sessions/${root.id}`, { method: 'DELETE' })).status).toBe(200)
    expect(aborted).toBe(1)
    const child = await (await fetch(`${base}/api/workspaces/${wsId}/sessions/${root.id}/children/${spawned.childSessionId}?waitMs=10`)).json() as { status?: string }
    // The parent is gone, so the child is no longer a child of anything.
    expect(child.status === undefined || child.status === 'cancelled').toBe(true)
  }, 20_000)

  it('the spawn route takes a prose brief, validates it once, and reports inheritance', async () => {
    const provider: LlmProvider = { name: 'scripted', models: ['scripted'], async *stream() { yield { type: 'delta', delta: 'fine' } } }
    const { base, wsId } = await boot([provider])
    const root = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
    const route = `/api/workspaces/${wsId}/agents/explorer`

    const prose = await post(base, route, { rootSessionId: root.id, task: { prompt: 'Map the modules.', requiredResult: 'a list' }, keepOpen: true })
    expect(prose.status).toBe(202)
    const turnId = ((await prose.json()) as { parentTurnId: string }).parentTurnId

    const both = await post(base, route, { rootSessionId: root.id, parentTurnId: turnId, keepOpen: true, task: { prompt: 'Use this.', objective: 'Not this.' } })
    expect(both.status).toBe(202)
    expect(((await both.json()) as { note?: string }).note).toMatch(/the prompt is the brief/)

    const empty = await post(base, route, { rootSessionId: root.id, task: { prompt: '  ', requiredResult: 'x' } })
    expect(empty.status).toBe(400)
    expect(((await empty.json()) as { error: string }).error).toMatch(/'prompt'.*'objective'/)

    expect((await post(base, route, { rootSessionId: root.id, task: { prompt: 'x' }, inherit: 'everything' })).status).toBe(400)
    const inherited = await post(base, route, { rootSessionId: root.id, parentTurnId: turnId, task: { prompt: 'Continue the thread.' }, inherit: 'brief' })
    expect(inherited.status).toBe(202)
    expect(typeof ((await inherited.json()) as { inheritedChars?: number }).inheritedChars).toBe('number')

    // The durable spawn record carries the normalized brief.
    const rootLog = await snapshot(base, wsId, root.id)
    expect(rootLog.filter((event) => event.type === 'agent/child-spawn').map((event) => event['brief'])).toEqual([
      'Map the modules.', 'Use this.', 'Continue the thread.',
    ])
  }, 30_000)

  it('a child request is its role, within its ceiling, and its manifest says so', async () => {
    let childSystem = ''
    let childTools: string[] = []
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream(request) {
        if (isChild(request)) {
          childSystem = systemText(request)
          childTools = (request.tools ?? []).map((tool) => tool.name)
        }
        yield { type: 'delta', delta: 'Found it in src/index.ts:1.' }
      },
    }
    const { base, wsId } = await boot([provider], 'full-access')
    const root = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
    const spawned = await post(base, `/api/workspaces/${wsId}/agents/explorer`, { rootSessionId: root.id, task: { prompt: 'Where is the entry point?' } })
    const child = (await spawned.json()) as { childSessionId: string }
    const settled = await (await fetch(`${base}/api/workspaces/${wsId}/sessions/${root.id}/children/${child.childSessionId}?waitMs=8000`)).json() as { status: string; result?: { report: string } }
    expect(settled.status).toBe('completed')
    expect(settled.result?.report).toBe('Found it in src/index.ts:1.')

    expect(childSystem).toContain('Role — explorer:')
    expect(childSystem).toContain('Your FINAL message is the entire deliverable')
    expect(childSystem).not.toContain('shell commands run with host privileges')
    // Full access exposes Bash and Agent to a root; the explorer never sees them.
    expect(childTools.sort()).toEqual(['Glob', 'Grep', 'Read'])
    expect(childSystem).toContain('You may call: ')
    for (const hidden of ['Bash', 'Agent', 'Write']) expect(childSystem).not.toMatch(new RegExp(`You may call:[^.]*\\b${hidden}\\b`))

    const manifest = await (await fetch(`${base}/api/workspaces/${wsId}/sessions/${child.childSessionId}/manifest`)).json() as {
      sources: { child?: { definition: string; instructionsHash: string }; toolNames: string[] }
    }
    expect(manifest.sources.child?.definition).toBe('explorer')
    expect(manifest.sources.child?.instructionsHash).toMatch(/^[0-9a-f]{64}$/)
    expect(manifest.sources.toolNames.sort()).toEqual(['Glob', 'Grep', 'Read'])
  }, 20_000)

  it('pins an admitted HTTP child to the same owning root across Plan/Full transitions', async () => {
    async function scenario(rootMode: 'plan' | 'full-access', rootAfter: 'plan' | 'full-access') {
      let releaseChild: () => void = () => {}
      let markChildStarted: () => void = () => {}
      const childGate = new Promise<void>((resolve) => { releaseChild = resolve })
      const childStarted = new Promise<void>((resolve) => { markChildStarted = resolve })
      const childSchemas: string[][] = []
      let childStep = 0
      const provider: LlmProvider = {
        name: `mode-${rootMode}`, models: [`mode-${rootMode}`],
        async *stream(request) {
          if (!isChild(request)) { yield { type: 'delta', delta: 'root' }; return }
          childSchemas.push((request.tools ?? []).map((tool) => tool.name))
          childStep += 1
          if (childStep === 1) {
            markChildStarted()
            await childGate
            yield { type: 'toolCalls', calls: [{ id: 'fabricated-write', name: 'Write', args: { path: 'child-mode.txt', content: rootMode } }] }
            return
          }
          yield { type: 'delta', delta: 'done' }
        },
      }
      const { base, wsId } = await boot([provider], rootMode)
      const root = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
      const spawned = await post(base, `/api/workspaces/${wsId}/agents/worker`, { rootSessionId: root.id, task: { prompt: 'Try the fabricated write.' } })
      expect(spawned.status).toBe(202)
      const child = (await spawned.json()) as { childSessionId: string }
      await childStarted
      expect((await snapshot(base, wsId, root.id)).some((event) => event.type === 'agent/child-spawn' && event['childSessionId'] === child.childSessionId)).toBe(true)
      expect((await snapshot(base, wsId, child.childSessionId)).some((event) => event.type === 'session/child-meta' && event['parentSessionId'] === root.id)).toBe(true)
      expect((await fetch(`${base}/api/workspaces/${wsId}/sessions/${root.id}/mode`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modeId: rootAfter }),
      })).status).toBe(200)
      releaseChild()
      await fetch(`${base}/api/workspaces/${wsId}/sessions/${root.id}/children/${child.childSessionId}?waitMs=8000`)
      return { schemas: childSchemas[0] ?? [], events: await snapshot(base, wsId, child.childSessionId) }
    }

    const widened = await scenario('plan', 'full-access')
    expect(widened.schemas).not.toContain('Write')
    expect(widened.events.find((event) => event.type === 'tool/result')?.['output']).toMatch(/not exposed|does not expose|unknown tool/i)

    const narrowed = await scenario('full-access', 'plan')
    expect(narrowed.schemas).toContain('Write')
    expect(narrowed.events.find((event) => event.type === 'tool/result')?.['output']).toMatch(/not exposed|does not expose|unknown tool/i)
  }, 30_000)

  it('Agent-tool child admission is pinned and live-denied by transitions on the same owning root', async () => {
    async function scenario(rootMode: 'plan' | 'full-access', rootAfter: 'plan' | 'full-access') {
      let releaseChild: () => void = () => {}
      let markChildStarted: () => void = () => {}
      const childGate = new Promise<void>((resolve) => { releaseChild = resolve })
      const childStarted = new Promise<void>((resolve) => { markChildStarted = resolve })
      const childSchemas: string[][] = []
      let rootStep = 0
      let childStep = 0
      const provider: LlmProvider = {
        name: `agent-mode-${rootMode}`, models: [`agent-mode-${rootMode}`],
        async *stream(request) {
          if (isChild(request)) {
            childSchemas.push((request.tools ?? []).map((tool) => tool.name))
            childStep += 1
            if (childStep === 1) {
              markChildStarted()
              await childGate
              yield { type: 'toolCalls', calls: [{ id: 'fabricated-write', name: 'Write', args: { path: 'agent-child.txt', content: rootMode } }] }
              return
            }
            yield { type: 'delta', delta: 'child done' }
            return
          }
          rootStep += 1
          if (rootStep === 1) {
            yield { type: 'toolCalls', calls: [{ id: 'spawn-child', name: 'Agent', args: { action: 'spawn', definition: 'worker', prompt: 'Try the fabricated write.' } }] }
            return
          }
          yield { type: 'delta', delta: 'root done' }
        },
      }
      const { base, wsId } = await boot([provider], rootMode)
      const root = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
      const sent = post(base, `/api/workspaces/${wsId}/sessions/${root.id}/messages`, { content: 'Delegate it.' })
      await childStarted
      const admitted = await snapshot(base, wsId, root.id)
      const childId = admitted.find((event) => event.type === 'agent/child-spawn')?.['childSessionId']
      expect(typeof childId).toBe('string')
      expect((await snapshot(base, wsId, String(childId))).some((event) => event.type === 'session/child-meta' && event['parentSessionId'] === root.id)).toBe(true)
      expect((await fetch(`${base}/api/workspaces/${wsId}/sessions/${root.id}/mode`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modeId: rootAfter }),
      })).status).toBe(200)
      releaseChild()
      expect((await sent).status).toBe(202)
      const deadline = Date.now() + 12_000
      let rootEvents: { type: string; [key: string]: unknown }[] = []
      while (Date.now() < deadline) {
        rootEvents = await snapshot(base, wsId, root.id)
        if (rootEvents.some((event) => event.type === 'agent/child-result')) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      return { schemas: childSchemas[0] ?? [], events: await snapshot(base, wsId, String(childId)) }
    }

    const widened = await scenario('plan', 'full-access')
    expect(widened.schemas).not.toContain('Write')
    expect(widened.events.find((event) => event.type === 'tool/result')?.['output']).toMatch(/not exposed|does not expose|unknown tool/i)

    const narrowed = await scenario('full-access', 'plan')
    expect(narrowed.schemas).toContain('Write')
    expect(narrowed.events.find((event) => event.type === 'tool/result')?.['output']).toMatch(/not exposed|does not expose|unknown tool/i)
  }, 30_000)

  it('inherit:"brief" lets a child answer from the conversation, never from tool output', async () => {
    let childMessages = ''
    let rootStep = 0
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream(request) {
        if (isChild(request)) {
          childMessages = request.messages.map((message) => (typeof message.content === 'string' ? message.content : '')).join('\n')
          yield { type: 'delta', delta: 'The config lives in vite.config.ts.' }
          return
        }
        rootStep += 1
        if (rootStep === 1) {
          yield { type: 'delta', delta: 'I read it: the build config is vite.config.ts.' }
          return
        }
        yield { type: 'delta', delta: 'ok' }
      },
    }
    const { base, wsId } = await boot([provider])
    const root = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
    await post(base, `/api/workspaces/${wsId}/sessions/${root.id}/messages`, { content: 'Which file configures the build?' })
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline) {
      const log = await snapshot(base, wsId, root.id)
      if (log.some((event) => event.type === 'turn/end')) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const spawned = await post(base, `/api/workspaces/${wsId}/agents/explorer`, {
      rootSessionId: root.id,
      task: { prompt: 'Which file did we say configures the build?', references: ['docs/web.md'] },
      inherit: 'brief',
    })
    if (spawned.status !== 202) throw new Error(`spawn failed: ${spawned.status} ${await spawned.text()}`)
    const child = (await spawned.json()) as { childSessionId: string; inheritedChars: number }
    expect(child.inheritedChars).toBeGreaterThan(0)
    const settled = await (await fetch(`${base}/api/workspaces/${wsId}/sessions/${root.id}/children/${child.childSessionId}?waitMs=8000`)).json() as { result?: { report: string } }
    expect(settled.result?.report).toBe('The config lives in vite.config.ts.')
    expect(childMessages).toContain('kind="parent-context"')
    expect(childMessages).toContain('the build config is vite.config.ts')
    // References still ride in the brief beside the inherited slice.
    expect(childMessages).toContain('## References')
    expect(childMessages).toContain('- docs/web.md')
  }, 20_000)

  it('a manual spawn offered after the root turn ends is admitted', async () => {
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream(request) {
        yield { type: 'delta', delta: isChild(request) ? 'done' : 'ok' }
      },
    }
    const { base, wsId } = await boot([provider])
    const root = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
    await post(base, `/api/workspaces/${wsId}/sessions/${root.id}/messages`, { content: 'Say ok.' })
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline) {
      const log = await snapshot(base, wsId, root.id)
      if (log.some((event) => event.type === 'turn/end')) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    // `turn/end` is appended before the agent flips to idle, but manual-spawn
    // admission reads the durable log (rootBusy AND turnTerminal), so the
    // spawn must be admitted on the first attempt.
    const response = await post(base, `/api/workspaces/${wsId}/agents/explorer`, {
      rootSessionId: root.id,
      task: { prompt: 'x' },
      keepOpen: true,
    })
    if (response.status !== 202) throw new Error(`spawn failed: ${response.status} ${await response.text()}`)
    expect(response.status).toBe(202)
  }, 20_000)

  it('a root that spawns a child and ends its turn without waiting joins it: the child finishes, the root answers from its report', async () => {
    let rootStep = 0
    let childSteps = 0
    let rootSawReport = ''
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream(request) {
        if (isChild(request)) {
          childSteps += 1
          // A child that takes a while and then answers — long enough that a root
          // closing its turn at once would have cancelled it mid-work.
          await new Promise((resolve) => setTimeout(resolve, 400))
          yield { type: 'delta', delta: 'The build config is vite.config.ts.' }
          return
        }
        rootStep += 1
        if (rootStep === 1) {
          yield { type: 'toolCalls', calls: [{ id: 'spawn-1', name: 'Agent', args: { action: 'spawn', definition: 'explorer', prompt: 'Which file configures the build?' } }] }
          return
        }
        if (rootStep === 2) {
          // The model forgets to wait and just answers: the old behaviour cancelled the child here.
          yield { type: 'delta', delta: 'Delegated; I will answer when it reports.' }
          return
        }
        rootSawReport = request.messages.map((message) => (typeof message.content === 'string' ? message.content : '')).join('\n')
        yield { type: 'delta', delta: 'It is vite.config.ts.' }
      },
    }
    const { base, wsId } = await boot([provider], 'full-access')
    const root = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
    await post(base, `/api/workspaces/${wsId}/sessions/${root.id}/messages`, { content: 'Find the build config.' })
    let log: { type: string; [key: string]: unknown }[] = []
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      log = await snapshot(base, wsId, root.id)
      if (log.some((event) => event.type === 'turn/end')) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    const end = log.findLast((event) => event.type === 'turn/end')
    expect(end?.reason).toBe('completed')
    // The child ran to its end, was not cancelled, and its result is durable.
    expect(childSteps).toBe(1)
    const result = log.find((event) => event.type === 'agent/child-result')
    expect(result?.status).toBe('completed')
    // The root got one more step, with the child's report in it.
    expect(rootStep).toBe(3)
    expect(rootSawReport).toContain('Delegated agents you left running have finished')
    expect(rootSawReport).toContain('The build config is vite.config.ts.')
    expect(log.filter((event) => event.type === 'step/start')).toHaveLength(3)
  }, 30_000)

  it('writer boundary: the handoff precedes the child write, the child holds no whole-run lease, and the root can write again', async () => {
    const project = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-subagents-proj-'))
    homes.push(project)
    let releaseChild: () => void = () => {}
    const childParked = new Promise<void>((resolve) => { releaseChild = resolve })
    let childWrote: () => void = () => {}
    const childWroteOnce = new Promise<void>((resolve) => { childWrote = resolve })
    let rootStep = 0
    let childStep = 0
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream(request) {
        if (isChild(request)) {
          childStep += 1
          if (childStep === 1) {
            yield { type: 'toolCalls', calls: [{ id: 'cw', name: 'Write', args: { path: 'child.txt', content: 'child' } }] }
            return
          }
          // Parked between calls: the child holds no lease here.
          childWrote()
          await childParked
          yield { type: 'delta', delta: 'Wrote child.txt.' }
          return
        }
        rootStep += 1
        if (rootStep === 1) {
          yield { type: 'toolCalls', calls: [{ id: 'r1', name: 'Write', args: { path: 'root-a.txt', content: 'a' } }] }
          return
        }
        if (rootStep === 2) {
          yield { type: 'toolCalls', calls: [{ id: 'r2', name: 'Agent', args: { action: 'spawn', definition: 'worker', prompt: 'Write child.txt.' } }] }
          return
        }
        if (rootStep === 3) {
          await childWroteOnce
          yield { type: 'toolCalls', calls: [{ id: 'r3', name: 'Write', args: { path: 'root-b.txt', content: 'b' } }] }
          return
        }
        if (rootStep === 4) {
          releaseChild()
          yield { type: 'toolCalls', calls: [{ id: 'r4', name: 'Agent', args: { action: 'wait', timeoutMs: 5000 } }] }
          return
        }
        yield { type: 'delta', delta: 'all written' }
      },
    }
    const { base, wsId } = await boot([provider], 'full-access')
    const created = (await (await post(base, `/api/workspaces/${wsId}/projects`, { name: 'Lease', path: project })).json()) as { id: string }
    const root = (await (await post(base, `/api/workspaces/${wsId}/sessions`, { projectId: created.id })).json()) as { id: string }
    await post(base, `/api/workspaces/${wsId}/sessions/${root.id}/messages`, { content: 'write the files' })

    const deadline = Date.now() + 15_000
    let log: { type: string; [key: string]: unknown }[] = []
    while (Date.now() < deadline) {
      log = await snapshot(base, wsId, root.id)
      if (log.some((event) => event.type === 'turn/end')) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const outputs = log.filter((event) => event.type === 'tool/result').map((event) => String(event['output']))
    expect(outputs.some((output) => /project busy/.test(output))).toBe(false)
    // The root wrote again while its writer child was still alive.
    expect(await fs.readFile(path.join(project, 'root-a.txt'), 'utf8')).toBe('a')
    expect(await fs.readFile(path.join(project, 'child.txt'), 'utf8')).toBe('child')
    expect(await fs.readFile(path.join(project, 'root-b.txt'), 'utf8')).toBe('b')
    expect(rootStep).toBe(5)
  }, 30_000)
})
