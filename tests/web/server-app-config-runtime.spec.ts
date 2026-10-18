/**
 * Global limits on a live web host: one app-config file per data home,
 * layered over host defaults and under explicit options, applied by each
 * operation at its own boundary — uploads, admissions, joins, compaction and
 * context assembly — without replacing any service.
 */
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWebServer, WEB_LIMIT_DEFAULTS, type LlmProvider, type WebServer, type WebServerOptions } from 'dnt-harness'
import { ChildExecutor } from '../../src/harness/agents/executor.ts'
import { DEFAULT_LIMITS, type HarnessLimits } from '../../src/harness/limits.ts'
import { LIMIT_FIELDS, type LimitKey } from '../../src/harness/limits-config.ts'
import type { ModelRequest, StreamEvent } from '../../src/harness/llm/types.ts'

const servers: WebServer[] = []
const dirs: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0)) await server.close().catch(() => {})
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
})

async function tempDir(prefix = 'dnt-harness-app-config-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

async function start(options: WebServerOptions): Promise<WebServer> {
  const server = await createWebServer(options)
  servers.push(server)
  return server
}

/** Persist and publish field overrides through the coordinator's one update path. */
async function setLimits(server: WebServer, values: Partial<HarnessLimits>): Promise<void> {
  const view = await server.appConfig.describe()
  const edits = Object.entries(values).map(([key, value]) => ({ op: 'set' as const, key: key as LimitKey, value: value as number }))
  await server.appConfig.edit(edits, view.hash!)
}

function post(url: string, body?: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

function upload(base: string, wsId: string, name: string, bytes: Buffer): Promise<Response> {
  return fetch(`${base}/api/workspaces/${wsId}/attachments`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(name) },
    body: new Uint8Array(bytes),
  })
}

/** Oversized bodies are refused by closing the connection, or by a 400 from store validation. */
async function uploadRefused(base: string, wsId: string, name: string, bytes: Buffer): Promise<boolean> {
  try {
    const response = await upload(base, wsId, name, bytes)
    return response.status === 400
  } catch {
    return true
  }
}

async function defaultWorkspace(server: WebServer): Promise<string> {
  return ((await (await fetch(`${server.url}/api/workspaces`)).json()) as { id: string }[])[0]!.id
}

async function until<T>(probe: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('condition not met before deadline')
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
}

interface LoggedEvent { readonly type: string; readonly turnId?: string; readonly reason?: string; readonly [key: string]: unknown }

async function eventLog(home: string, wsId: string, sessionId: string): Promise<LoggedEvent[]> {
  const raw = await fs.readFile(path.join(home, 'workspaces', wsId, 'sessions', sessionId, 'events.jsonl'), 'utf8').catch(() => '')
  return raw.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as LoggedEvent)
}

async function idle(server: WebServer, wsId: string, sessionId: string): Promise<void> {
  await until(async () => {
    const rows = (await (await fetch(`${server.url}/api/workspaces/${wsId}/sessions`)).json()) as { id: string; status: string }[]
    return rows.find((row) => row.id === sessionId)?.status === 'idle' ? true : undefined
  })
}

/** Send one message and wait until its turn ended and the session is idle. */
async function completedTurn(server: WebServer, home: string, wsId: string, sessionId: string, body: Record<string, unknown>): Promise<void> {
  const before = (await eventLog(home, wsId, sessionId)).filter((event) => event.type === 'turn/end').length
  const response = await post(`${server.url}/api/workspaces/${wsId}/sessions/${sessionId}/messages`, body)
  expect(response.status).toBe(202)
  await until(async () => (await eventLog(home, wsId, sessionId)).filter((event) => event.type === 'turn/end').length > before ? true : undefined)
  await idle(server, wsId, sessionId)
}

/** A provider whose calls park until aborted: holds a turn open on demand. */
function hangProvider(): LlmProvider {
  return {
    name: 'hang',
    models: ['hang'],
    async *stream(_request, options) {
      await new Promise<void>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
      yield { type: 'delta', delta: 'never' }
    },
  }
}

const done: StreamEvent = { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }

describe('host composition', () => {
  it('two workspaces share one active config and keep their service identities', async () => {
    const home = await tempDir()
    const server = await start({ home, providers: [hangProvider()], configFile: path.join(home, 'p.json') })
    const first = await defaultWorkspace(server)
    const second = ((await (await post(`${server.url}/api/workspaces`, { name: 'Second' })).json()) as { id: string }).id
    const ctx = server.kernel.ctx
    const identities = [ctx.agents, ctx.tools, ctx.sessions, ctx.get('limits')]
    const startup = ctx.get('limits') as HarnessLimits
    expect(ctx.get('limits-reader')).toBe(server.appConfig)
    expect(ctx.get('app-config')).toBe(server.appConfig)

    const bytes = Buffer.from('0123456789')
    for (const wsId of [first, second]) expect((await upload(server.url, wsId, 'ten.txt', bytes)).status).toBe(201)
    await setLimits(server, { maxAttachmentBytes: 4 })
    for (const wsId of [first, second]) {
      expect(await uploadRefused(server.url, wsId, 'ten.txt', bytes)).toBe(true)
      // Under the new cap a small upload still lands in either workspace.
      expect((await upload(server.url, wsId, 'four.txt', Buffer.from('0123'))).status).toBe(201)
    }
    expect(server.appConfig.read()).toMatchObject({ revision: 1, values: { maxAttachmentBytes: 4 } })
    expect([ctx.agents, ctx.tools, ctx.sessions, ctx.get('limits')]).toEqual(identities)
    identities.forEach((service, index) => expect([ctx.agents, ctx.tools, ctx.sessions, ctx.get('limits')][index]).toBe(service))
    // The legacy static value stays the startup snapshot.
    expect(startup.maxAttachmentBytes).toBe(10 * 1024 * 1024)
  })

  it('layers library, host profile, file and explicit overrides', async () => {
    const dir = await tempDir()
    const file = path.join(dir, 'app-config.json')
    await fs.writeFile(file, JSON.stringify({ v: 1, limits: { automaticCompactionPressure: 0.7 } }))
    const pressure = (server: WebServer): number => server.appConfig.read().values.automaticCompactionPressure

    expect(pressure(await start({ providers: [] }))).toBe(0)
    expect(pressure(await start({ providers: [], limitDefaults: WEB_LIMIT_DEFAULTS }))).toBe(0.85)
    expect(pressure(await start({ providers: [], limitDefaults: WEB_LIMIT_DEFAULTS, appConfigFile: file }))).toBe(0.7)
    const locked = await start({ providers: [], limitDefaults: WEB_LIMIT_DEFAULTS, appConfigFile: file, limits: { automaticCompactionPressure: 0.9 } })
    expect(pressure(locked)).toBe(0.9)
    const field = (await locked.appConfig.describe()).fields.find((entry) => entry.key === 'automaticCompactionPressure')
    expect(field).toMatchObject({ source: 'explicit', locked: true, shadowed: true, fileValue: 0.7 })
    const fallthrough = await start({ providers: [], limitDefaults: WEB_LIMIT_DEFAULTS, appConfigFile: file, limits: { automaticCompactionPressure: -1 } })
    expect(pressure(fallthrough)).toBe(0.7)
  })

  it('keeps the provider config file separate from the app-config file', async () => {
    const home = await tempDir()
    const providerDir = await tempDir()
    const providerFile = path.join(providerDir, 'providers.json')
    await fs.writeFile(path.join(home, 'app-config.json'), JSON.stringify({ v: 1, limits: { toolTimeoutMs: 1234 } }))
    const server = await start({ home, providers: [], configFile: providerFile })
    expect(server.appConfig.read().values.toolTimeoutMs).toBe(1234)
    await setLimits(server, { approvalExpiryMs: 4321 })
    expect(JSON.parse(await fs.readFile(path.join(home, 'app-config.json'), 'utf8'))).toEqual({ v: 1, limits: { approvalExpiryMs: 4321, toolTimeoutMs: 1234 } })
    // The provider store is neither read for limits nor written by limit edits.
    await expect(fs.readFile(providerFile, 'utf8')).rejects.toThrow()
  })

  it('a refused boot releases what it acquired so the data home is usable again', async () => {
    const home = await tempDir()
    const file = path.join(home, 'app-config.json')
    await fs.writeFile(file, JSON.stringify({ v: 2 }))
    await expect(createWebServer({ home, providers: [], configFile: path.join(home, 'p.json') })).rejects.toThrow(/unsupported app-config version/)
    await expect(fs.stat(path.join(home, 'mcp-owner.lock'))).rejects.toThrow()

    // A failure after the lock was taken (the port is busy) still releases it.
    await fs.writeFile(file, JSON.stringify({ v: 1 }))
    const holder = await start({ providers: [] })
    await expect(createWebServer({ home, providers: [], configFile: path.join(home, 'p.json'), port: holder.port })).rejects.toThrow(/EADDRINUSE/)
    await expect(fs.stat(path.join(home, 'mcp-owner.lock'))).rejects.toThrow()
    const recovered = await start({ home, providers: [], configFile: path.join(home, 'p.json') })
    expect(recovered.appConfig.read().revision).toBe(0)
  })

  it('a memory-mode boot refused by its app-config seam removes its temp home', async () => {
    const before = new Set((await fs.readdir(tmpdir())).filter((name) => name.startsWith('dnt-harness-resources-')))
    let seen = ''
    await expect(createWebServer({
      providers: [],
      appConfigIo: { read: async (file) => { seen = file; return '{"v":1,"limits":{"bogus":1}}' } },
    })).rejects.toThrow(/unknown limit key: bogus/)
    expect(path.basename(seen)).toBe('app-config.json')
    expect(before.has(path.basename(path.dirname(seen)))).toBe(false)
    await expect(fs.stat(path.dirname(seen))).rejects.toThrow()
  })
})

describe('admissions', () => {
  it('an upload started before an update keeps one cap for its body read and store', async () => {
    const home = await tempDir()
    const server = await start({ home, providers: [], configFile: path.join(home, 'p.json') })
    const wsId = await defaultWorkspace(server)
    const url = new URL(`${server.url}/api/workspaces/${wsId}/attachments`)
    // Barrier: the upload handler's first limits read is its cap capture.
    const read = server.appConfig.read.bind(server.appConfig)
    let captured: () => void = () => {}
    const capture = new Promise<void>((resolve) => { captured = resolve })
    server.appConfig.read = () => { const snapshot = read(); captured(); return snapshot }
    const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest({
        host: url.hostname, port: url.port, path: url.pathname, method: 'POST',
        headers: { 'content-type': 'text/plain', 'x-file-name': 'held.txt', 'transfer-encoding': 'chunked' },
      }, (res) => {
        let body = ''
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      req.on('error', reject)
      req.write('01234')
      // The body is held while the cap is lowered below its eventual size.
      void capture
        .then(() => { server.appConfig.read = read; return setLimits(server, { maxAttachmentBytes: 4 }) })
        .then(() => req.end('56789'), reject)
    })
    const settled = await response
    expect(settled.status).toBe(201)
    expect(JSON.parse(settled.body)).toMatchObject({ name: 'held.txt', bytes: 10 })
    expect(await uploadRefused(server.url, wsId, 'late.txt', Buffer.from('0123456789'))).toBe(true)
  })

  it('a lowered queue bound refuses new inputs without dropping accepted ones', async () => {
    const server = await start({ providers: [hangProvider()] })
    const { id } = (await (await post(`${server.url}/api/sessions`)).json()) as { id: string }
    const message = (content: string, clientRequestId?: string) =>
      post(`${server.url}/api/sessions/${id}/messages`, { content, ...(clientRequestId !== undefined ? { clientRequestId } : {}) })
    const pending = async (): Promise<number> => {
      const rows = (await (await fetch(`${server.url}/api/sessions`)).json()) as { id: string; pendingInputs: number }[]
      return rows.find((row) => row.id === id)?.pendingInputs ?? -1
    }
    expect((await message('one')).status).toBe(202)
    await until(async () => (await pending()) === 0 ? true : undefined)
    const accepted = (await (await message('two', 'retry-me')).json()) as { inputId: string }
    expect((await message('three')).status).toBe(202)
    expect((await message('four')).status).toBe(202)
    expect(await pending()).toBe(3)

    await setLimits(server, { maxPendingInputs: 2 })
    const refused = await message('five')
    expect(refused.status).toBe(429)
    expect(((await refused.json()) as { error: string }).error).toContain('limit 2')
    const retry = await message('two', 'retry-me')
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual({ inputId: accepted.inputId, duplicate: true })
    expect(await pending()).toBe(3)

    await setLimits(server, { maxPendingInputs: 10 })
    expect((await message('six')).status).toBe(202)
    expect(await pending()).toBe(4)
  })

  it('a changed attachment count applies to the next message only', async () => {
    const home = await tempDir()
    const provider: LlmProvider = { name: 'quick', models: ['quick'], async *stream() { yield { type: 'delta', delta: 'ok' }; yield done } }
    const server = await start({ home, providers: [provider], configFile: path.join(home, 'p.json') })
    const wsId = await defaultWorkspace(server)
    const refs = await Promise.all(['a', 'b'].map(async (name) => (await (await upload(server.url, wsId, `${name}.txt`, Buffer.from(name))).json()) as Record<string, unknown>))
    const { id } = (await (await post(`${server.url}/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
    await completedTurn(server, home, wsId, id, { content: 'two files', attachments: refs })

    await setLimits(server, { maxAttachmentsPerMessage: 1 })
    const refused = await post(`${server.url}/api/workspaces/${wsId}/sessions/${id}/messages`, { content: 'again', attachments: refs })
    expect(refused.status).toBe(400)
    expect(((await refused.json()) as { error: string }).error).toContain('at most 1 attachments')
    await completedTurn(server, home, wsId, id, { content: 'one file', attachments: [refs[0]] })
    const messages = (await eventLog(home, wsId, id)).filter((event) => event.type === 'user/message')
    expect(messages.map((event) => (event['attachments'] as unknown[] | undefined)?.length)).toEqual([2, 1])
  })
})

const textOf = (message: ModelRequest['messages'][number] | undefined): string =>
  message === undefined ? '' : typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
const isChild = (request: ModelRequest): boolean => textOf(request.messages[0]).includes('You are a subagent')

describe('delegation join', () => {
  it('an active join keeps its deadline; the next join captures the new one', async () => {
    const home = await tempDir()
    let delegated = 0
    const provider: LlmProvider = {
      name: 'scripted',
      models: ['scripted'],
      async *stream(request, options) {
        if (isChild(request)) {
          await new Promise<void>((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          })
          return
        }
        const last = request.messages.at(-1)
        const text = textOf(last)
        if (last?.role === 'user' && text.includes('go-')) {
          yield { type: 'toolCalls', calls: [{ id: `spawn-${text}`, name: 'Agent', args: { action: 'spawn', definition: 'explorer', prompt: 'Look around.' } }] }
          yield { type: 'completion', finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }
          return
        }
        if (!text.includes('Delegated agents')) delegated += 1
        yield { type: 'delta', delta: text.includes('Delegated agents') ? 'reported' : 'delegated' }
        yield done
      },
    }
    // Record each join's captured deadline and whether it has finished.
    const joins: { timeoutMs: number; settled: boolean }[] = []
    const join = ChildExecutor.prototype.joinTurnChildren
    vi.spyOn(ChildExecutor.prototype, 'joinTurnChildren').mockImplementation(function (this: ChildExecutor, ...args) {
      const record = { timeoutMs: args[3].timeoutMs, settled: false }
      joins.push(record)
      return join.apply(this, args).finally(() => { record.settled = true })
    })
    const server = await start({ home, providers: [provider], configFile: path.join(home, 'p.json') })
    const wsId = await defaultWorkspace(server)
    expect((await fetch(`${server.url}/api/workspaces/${wsId}/mode`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modeId: 'full-access' }),
    })).status).toBe(200)
    const { id } = (await (await post(`${server.url}/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
    const turnEnds = async (): Promise<number> => (await eventLog(home, wsId, id)).filter((event) => event.type === 'turn/end').length

    // Turn one joins under the default (30 minute) deadline.
    expect((await post(`${server.url}/api/workspaces/${wsId}/sessions/${id}/messages`, { content: 'go-1' })).status).toBe(202)
    await until(async () => delegated === 1 && joins.length === 1 ? true : undefined)
    await setLimits(server, { delegationJoinMs: 150 })
    expect(joins[0]).toEqual({ timeoutMs: 30 * 60_000, settled: false })
    expect(await turnEnds()).toBe(0)
    await post(`${server.url}/api/workspaces/${wsId}/sessions/${id}/stop`)
    await until(async () => (await turnEnds()) === 1 ? true : undefined)
    await idle(server, wsId, id)

    // Turn two captures 150ms at its own join start, cancels the child and completes.
    expect((await post(`${server.url}/api/workspaces/${wsId}/sessions/${id}/messages`, { content: 'go-2' })).status).toBe(202)
    await until(async () => (await turnEnds()) === 2 ? true : undefined, 8_000)
    const end = (await eventLog(home, wsId, id)).findLast((event) => event.type === 'turn/end')
    expect(end?.reason).toBe('completed')
    expect(delegated).toBe(2)
    // The first join kept 30 minutes; every join after the update (including the
    // continuation check after the reports step) captured 150ms.
    expect(joins[0]!.timeoutMs).toBe(30 * 60_000)
    expect(joins.length).toBeGreaterThanOrEqual(2)
    expect(joins.slice(1).every((entry) => entry.timeoutMs === 150)).toBe(true)
  }, 30_000)
})

const SUMMARY_TEXT = 'CHECKPOINT SUMMARY TEXT'
const COMPACT_MARK = 'Primary Request and Intent'
const isSummary = (request: ModelRequest): boolean => request.messages.some((message) => typeof message.content === 'string' && message.content.includes(COMPACT_MARK))

describe('compaction and context assembly', () => {
  it('capture the current policy at each decision and assembly without cancelling a running compaction', async () => {
    const home = await tempDir()
    const turns: ModelRequest[] = []
    let gate: Promise<void> | undefined
    let summaryCalls = 0
    const provider: LlmProvider = {
      name: 'scripted',
      models: ['scripted'],
      async *stream(request) {
        if (isSummary(request)) {
          summaryCalls += 1
          await gate
          yield { type: 'delta', delta: SUMMARY_TEXT }
          yield done
          return
        }
        turns.push(request)
        yield { type: 'delta', delta: 'turn reply' }
        yield done
      },
    }
    const server = await start({ home, providers: [provider], configFile: path.join(home, 'p.json') })
    const wsId = await defaultWorkspace(server)
    const { id } = (await (await post(`${server.url}/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
    const checkpoints = async (): Promise<string[]> => (await fs.readdir(path.join(home, 'compaction', id, 'checkpoints')).catch(() => [])).sort()
    const lastTurn = (): string => JSON.stringify(turns.at(-1)?.messages ?? [])

    // Attachment text follows the limit current at each assembly.
    const ref = (await (await upload(server.url, wsId, 'letters.txt', Buffer.from('abcdefgh'))).json()) as Record<string, unknown>
    await setLimits(server, { attachmentTextLimit: 3 })
    await completedTurn(server, home, wsId, id, { content: 'read it', attachments: [ref] })
    expect(lastTurn()).toContain('abc')
    expect(lastTurn()).not.toContain('abcd')
    await setLimits(server, { attachmentTextLimit: 8 })
    await completedTurn(server, home, wsId, id, { content: 'read it again' })
    expect(lastTurn()).toContain('abcdefgh')
    // The library pressure (0) scheduled nothing so far.
    expect(summaryCalls).toBe(0)
    expect(await checkpoints()).toEqual([])

    // The next settled decision reads the raised threshold.
    await setLimits(server, { automaticCompactionPressure: 0.00001 })
    await completedTurn(server, home, wsId, id, { content: 'push pressure' })
    await until(async () => (await checkpoints()).length === 1 ? true : undefined)

    // A compaction already running survives a threshold and tail update.
    let release: () => void = () => {}
    gate = new Promise<void>((resolve) => { release = resolve })
    const callsBefore = summaryCalls
    expect((await post(`${server.url}/api/workspaces/${wsId}/sessions/${id}/messages`, { content: 'TAIL-MARKER turn' })).status).toBe(202)
    // The automatic compaction is parked inside its summary request.
    await until(async () => summaryCalls > callsBefore ? true : undefined)
    await setLimits(server, { automaticCompactionPressure: 0, compactionRetainTokens: 0 })
    release()
    await until(async () => (await checkpoints()).length === 2 ? true : undefined)
    await idle(server, wsId, id)

    // Retained tokens are read per assembly: nothing covered kept raw, then the covered messages again.
    await completedTurn(server, home, wsId, id, { content: 'after compaction' })
    expect(lastTurn()).toContain(SUMMARY_TEXT)
    expect(lastTurn()).not.toContain('TAIL-MARKER')
    await setLimits(server, { compactionRetainTokens: 20_000 })
    await completedTurn(server, home, wsId, id, { content: 'with a tail' })
    expect(lastTurn()).toContain('TAIL-MARKER')
    // Pressure 0 scheduled no further compaction.
    expect(await checkpoints()).toHaveLength(2)
  }, 40_000)
})

describe('whole-slice publication', () => {
  it('an HTTP edit reaches the next operation in every workspace while a running one keeps its policy', async () => {
    if (process.platform === 'win32') return
    const home = await tempDir()
    const providerFile = path.join(home, 'providers.json')
    const providerBytes = '{"providers":[]}\n'
    await fs.writeFile(providerFile, providerBytes)
    await fs.writeFile(path.join(home, 'app-config.json'), JSON.stringify({ v: 1, limits: { toolOutputLimit: 60 } }))
    // Each workspace's project is its Bash root; operation A blocks on a FIFO
    // until the test opens it for writing, after the edit was published.
    const projectA = await tempDir('dnt-harness-app-config-project-a-')
    const projectB = await tempDir('dnt-harness-app-config-project-b-')
    const fifo = path.join(projectA, 'gate')
    execFileSync('mkfifo', [fifo])
    const commands: Record<string, string> = {
      'run-A': "touch started && cat gate >/dev/null && head -c 100 /dev/zero | tr '\\0' a",
      'run-B': "head -c 100 /dev/zero | tr '\\0' b",
      'run-C': "head -c 100 /dev/zero | tr '\\0' c",
    }
    const results = new Map<string, string>()
    const provider: LlmProvider = {
      name: 'scripted',
      models: ['scripted'],
      async *stream(request) {
        const last = request.messages.at(-1)
        const text = textOf(last)
        const key = Object.keys(commands).find((name) => text.includes(name))
        if (last?.role === 'user' && key !== undefined) {
          yield { type: 'toolCalls', calls: [{ id: `call-${key}`, name: 'Bash', args: { command: commands[key] } }] }
          yield { type: 'completion', finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }
          return
        }
        if (last?.role === 'tool') {
          const letter = /([abc])\1{4,}/.exec(text)?.[1]
          if (letter !== undefined) results.set(letter, text)
        }
        yield { type: 'delta', delta: 'done' }
        yield done
      },
    }
    const server = await start({ home, providers: [provider], configFile: providerFile })
    const ctx = server.kernel.ctx
    const identities = [ctx.agents, ctx.tools, ctx.sessions, ctx.get('processes'), ctx.get('limits'), ctx.get('limits-reader')]
    const first = await defaultWorkspace(server)
    const second = ((await (await post(`${server.url}/api/workspaces`, { name: 'Second' })).json()) as { id: string }).id
    const sessionIn = async (wsId: string, projectDir: string): Promise<string> => {
      expect((await fetch(`${server.url}/api/workspaces/${wsId}/mode`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modeId: 'full-access' }),
      })).status).toBe(200)
      const project = (await (await post(`${server.url}/api/workspaces/${wsId}/projects`, { path: projectDir })).json()) as { id: string }
      return ((await (await post(`${server.url}/api/workspaces/${wsId}/sessions`, { projectId: project.id })).json()) as { id: string }).id
    }
    const sessionA = await sessionIn(first, projectA)
    const sessionB = await sessionIn(second, projectB)
    expect(server.appConfig.read()).toMatchObject({ revision: 0, values: { toolOutputLimit: 60 } })

    // Operation A dispatches under revision 0 and parks inside its command.
    expect((await post(`${server.url}/api/workspaces/${first}/sessions/${sessionA}/messages`, { content: 'run-A' })).status).toBe(202)
    await until(async () => (await fs.stat(path.join(projectA, 'started')).catch(() => undefined)) !== undefined ? true : undefined)

    // Revision 1 is published through the authenticated HTTP edit route.
    const described = (await (await fetch(`${server.url}/api/app-config`)).json()) as { hash: string }
    const patched = await fetch(`${server.url}/api/app-config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedHash: described.hash, edits: [{ op: 'set', key: 'toolOutputLimit', value: 10 }] }),
    })
    expect(patched.status).toBe(200)
    expect(((await patched.json()) as { active: { revision: number } }).active.revision).toBe(1)
    const revisionB = server.appConfig.read()
    expect(revisionB).toMatchObject({ revision: 1, values: { toolOutputLimit: 10 } })

    // Operation B in the other workspace runs to completion under revision 1
    // while A is still held.
    await completedTurn(server, home, second, sessionB, { content: 'run-B' })
    expect(results.has('a')).toBe(false)
    expect(results.get('b')).toContain(`${'b'.repeat(10)}\n… [truncated 90 chars]`)
    expect(results.get('b')).not.toContain('b'.repeat(11))

    // Releasing A: its output is shaped by the policy it captured at dispatch.
    await fs.writeFile(fifo, 'go')
    await until(async () => results.has('a') ? true : undefined)
    expect(results.get('a')).toContain(`${'a'.repeat(60)}\n… [truncated 40 chars]`)
    expect(results.get('a')).not.toContain('a'.repeat(61))
    await idle(server, first, sessionA)

    // The next operation in A's workspace reads the same active snapshot as B's.
    expect(server.appConfig.read()).toBe(revisionB)
    await completedTurn(server, home, first, sessionA, { content: 'run-C' })
    expect(results.get('c')).toContain(`${'c'.repeat(10)}\n… [truncated 90 chars]`)

    // No service was replaced; the legacy reader keeps its startup value.
    const after = [ctx.agents, ctx.tools, ctx.sessions, ctx.get('processes'), ctx.get('limits'), ctx.get('limits-reader')]
    identities.forEach((service, index) => expect(after[index]).toBe(service))
    expect((ctx.get('limits') as HarnessLimits).toolOutputLimit).toBe(60)
    // The slice adds no subagent-count limit, and never touches the provider file.
    expect(LIMIT_FIELDS.map((field) => field.key).filter((key) => /subagent/i.test(key))).toEqual(['subagentBackgroundBashMaxMs'])
    expect(Object.keys(DEFAULT_LIMITS).filter((key) => /max.*(subagent|agent|child)/i.test(key))).toEqual([])
    expect(await fs.readFile(providerFile, 'utf8')).toBe(providerBytes)
    expect(JSON.parse(await fs.readFile(path.join(home, 'app-config.json'), 'utf8'))).toEqual({ v: 1, limits: { toolOutputLimit: 10 } })
  }, 30_000)
})
