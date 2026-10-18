/**
 * Desired-state reconciliation through the real web host: what a config or
 * secret mutation does to the runtime generation, to calls already in flight,
 * to later dispatches, and to callbacks of a runtime that was retired.
 */
import { promises as fs } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createWebServer, messageText, type LlmProvider, type ModelRequest, type WebServer } from 'dnt-harness'
import { startOAuthFixture, type OAuthFixture } from '../support/oauth-fixture.ts'

const fixturePath = fileURLToPath(new URL('../fixtures/mcp-stdio-server.mjs', import.meta.url))

let web: WebServer | undefined
let oauth: OAuthFixture | undefined
let http: Server | undefined
let home = ''
afterEach(async () => {
  await web?.close()
  web = undefined
  await oauth?.close()
  oauth = undefined
  if (http !== undefined) await new Promise<void>((resolve) => http!.close(() => resolve()))
  http = undefined
  if (home !== '') await fs.rm(home, { recursive: true, force: true })
  home = ''
})

/**
 * A model that does what the last user message says: `call <tool> <json>`
 * makes one tool call; anything else (including a tool result) ends the turn.
 */
function instructedProvider(requests: ModelRequest[]): LlmProvider {
  let calls = 0
  return {
    name: 'scripted', models: ['scripted'],
    async *stream(request) {
      requests.push(request)
      const last = request.messages.at(-1)
      const match = last?.role === 'user' ? /call (mcp__\S+) (\{.*\})/.exec(messageText(last.content)) : null
      if (match !== null) {
        calls += 1
        yield { type: 'toolCalls', calls: [{ id: `call-${calls}`, name: match[1]!, args: JSON.parse(match[2]!) as Record<string, unknown> }] }
        yield { type: 'completion', finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }
        return
      }
      yield { type: 'delta', delta: 'ok' }
      yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
    },
  }
}

type Row = { name: string; status: string; enabled: boolean; generation: number; lastError?: string; discoveredTools: string[]; auditFault: boolean; oauth?: { state: string } }

async function boot() {
  home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-mcp-reconcile-'))
  const requests: ModelRequest[] = []
  const provider = instructedProvider(requests)
  web = await createWebServer({ home, configFile: path.join(home, 'providers.json'), providers: [provider] })
  const firstWs = ((await (await fetch(`${web.url}/api/workspaces`)).json()) as { id: string }[])[0]!.id
  const ws = (wsId: string) => {
    const api = (route: string, body?: unknown, method = 'POST') => fetch(`${web!.url}/api/workspaces/${wsId}${route}`, {
      method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    })
    const rows = async () => (await (await api('/mcp', undefined, 'GET')).json()) as Row[]
    const row = async (name: string) => (await rows()).find((entry) => entry.name === name)
    const stored = async (name: string) => (await (await api(`/mcp/${name}`, undefined, 'GET')).json()) as Record<string, unknown>
    const session = async (): Promise<string> => ((await (await api('/sessions', { provider: 'scripted', model: 'scripted' })).json()) as { id: string }).id
    const turnEnds = async (sessionId: string): Promise<number> => {
      const raw = await fs.readFile(path.join(home, 'workspaces', wsId, 'sessions', sessionId, 'events.jsonl'), 'utf8').catch(() => '')
      return raw.split('"type":"turn/end"').length - 1
    }
    /** Post one message; resolves once that turn has ended. */
    const say = async (sessionId: string, content: string): Promise<void> => {
      const before = await turnEnds(sessionId)
      await api(`/sessions/${sessionId}/messages`, { content })
      await expect.poll(() => turnEnds(sessionId), { timeout: 15_000, interval: 50 }).toBeGreaterThan(before)
    }
    const journal = async () => (await fs.readFile(path.join(home, 'workspaces', wsId, 'mcp', 'executions.jsonl'), 'utf8').catch(() => ''))
      .trim().split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as { kind: string; invocationId: string; tool?: string; generation?: number; outcome?: string })
    return { wsId, api, rows, row, stored, session, say, journal }
  }
  const stdio = (env: Record<string, string> = {}) => ({ transport: 'stdio', command: process.execPath, args: [fixturePath], enabled: false, env })
  return { requests, ws, first: ws(firstWs), stdio }
}

const lines = async (file: string): Promise<string[]> => (await fs.readFile(file, 'utf8').catch(() => '')).trim().split('\n').filter((line) => line !== '')
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const livePids = async (file: string): Promise<number[]> => (await lines(file)).map(Number).filter(alive)

describe('MCP secret deletion', () => {
  it('fences every server that reads the secret and reports the local fence and remote revocation separately', async () => {
    const { first: ws, stdio } = await boot()
    const started = path.join(home, 'started.log')
    expect((await ws.api('/secrets/TOK', { value: 'one' }, 'PUT')).status).toBe(200)
    // The reference sits inside a longer value, as a header or a flag would.
    expect((await ws.api('/mcp/fx', stdio({ AUTH: 'Bearer ${TOK}', INIT_FILE: started }))).status).toBe(201)
    expect((await ws.api('/mcp/plain', stdio())).status).toBe(201)
    expect((await ws.api('/mcp/fx/enable')).status).toBe(200)
    expect(await livePids(started)).toHaveLength(1)

    // Rotation restarts the server that embeds the reference.
    const rotated = await (await ws.api('/secrets/TOK', { value: 'two' }, 'PUT')).json() as { reconnected: string[] }
    expect(rotated.reconnected).toEqual(['fx'])
    expect(await livePids(started)).toHaveLength(1)

    const deleted = await ws.api('/secrets/TOK', undefined, 'DELETE')
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toMatchObject({
      deleted: 'TOK',
      localFence: 'fenced',
      affectedServers: ['fx'],
      remoteRevocation: 'not_applicable',
    })
    // Nothing built from the deleted value is still running.
    expect(await livePids(started)).toEqual([])
    expect((await ws.row('fx'))?.status).toBe('idle')
    // The next start names what is missing instead of running without it.
    const sessionId = await ws.session()
    await ws.say(sessionId, 'hello')
    const row = await ws.row('fx')
    expect(row?.status).toBe('failed')
    expect(row?.lastError).toMatch(/TOK/)
  }, 30_000)

  it('deleting a managed OAuth server reports the provider revocation result beside the local one', async () => {
    oauth = await startOAuthFixture()
    const { first: ws } = await boot()
    const url = oauth.mcpUrl
    expect((await ws.api('/mcp/remote', { transport: 'http', url, enabled: false, auth: { type: 'managed_oauth', provider: new URL(url).host, resource: url } })).status).toBe(201)
    const begun = await (await ws.api('/mcp/remote/oauth/begin', {})).json() as { authorizationUrl: string; state: string }
    await fetch(await oauth.authorize(begun.authorizationUrl))
    expect((await ws.api('/mcp/remote/oauth/complete', { state: begun.state })).status).toBe(200)
    const deleted = await ws.api('/mcp/remote', undefined, 'DELETE')
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toEqual({ deleted: 'remote', revocation: { local: 'revoked', remote: 'succeeded' } })
  }, 30_000)
})

describe('MCP mutation linearization', () => {
  it('a call in flight keeps its old generation and is reported as possibly run; the first dispatch after the acknowledgment uses the new runtime', async () => {
    const { first: ws, stdio } = await boot()
    const started = path.join(home, 'started.log')
    const effects = path.join(home, 'effects.log')
    expect((await ws.api('/mode', { modeId: 'full-access' }, 'PUT')).ok).toBe(true)
    expect((await ws.api('/mcp/fx', { ...stdio({ INIT_FILE: started, SIDE_EFFECT_FILE: effects, SIDE_EFFECT_PID: '1' }), timeoutMs: 10_000 })).status).toBe(201)
    expect((await ws.api('/mcp/fx/enable')).status).toBe(200)
    const before = (await ws.row('fx'))!.generation
    const sessionId = await ws.session()

    // `hang` reaches the server (its side effect is recorded) and never answers.
    const inFlight = ws.say(sessionId, 'call mcp__fx__hang {}')
    await expect.poll(async () => (await lines(effects)).length, { timeout: 10_000, interval: 25 }).toBe(1)
    const [hangTool, hangPid] = (await lines(effects))[0]!.split(' ')
    expect(hangTool).toBe('hang')
    // An unrelated secret write fences the whole workspace. Once it answers,
    // the runtime that took the call is retired.
    expect((await ws.api('/secrets/UNRELATED', { value: 'x' }, 'PUT')).status).toBe(200)
    const after = (await ws.row('fx'))!.generation
    expect(after).toBeGreaterThan(before)
    expect(alive(Number(hangPid))).toBe(false)
    await inFlight

    const records = await ws.journal()
    const hangIntent = records.find((record) => record.kind === 'dispatch_intent' && record.tool === 'hang')!
    expect(hangIntent.generation).toBe(before)
    expect(records.find((record) => record.kind === 'terminal' && record.invocationId === hangIntent.invocationId)?.outcome).toBe('indeterminate')
    // The model is told the call may have run and was neither undone nor repeated.
    const transcript = await fs.readFile(path.join(home, 'workspaces', ws.wsId, 'sessions', sessionId, 'events.jsonl'), 'utf8')
    expect(transcript).toMatch(/changed while this call was in flight/)
    expect(transcript).toMatch(/not undone/)

    await ws.say(sessionId, 'call mcp__fx__query {"q":"next"}')
    const queryIntent = (await ws.journal()).find((record) => record.kind === 'dispatch_intent' && record.tool === 'query')!
    expect(queryIntent.generation).toBe(after)
    const effectLines = await lines(effects)
    expect(effectLines.filter((line) => line.startsWith('hang '))).toHaveLength(1)
    const queryPid = effectLines.find((line) => line.startsWith('query '))!.split(' ')[1]
    expect(queryPid).not.toBe(hangPid)
    expect(await livePids(started)).toEqual([Number(queryPid)])
  }, 40_000)
})

/** A plain Streamable HTTP MCP server that records the path and bearer of every request. */
async function startHttpMcp(): Promise<{ readonly origin: string; readonly seen: Array<{ path: string; auth: string }> }> {
  const seen: Array<{ path: string; auth: string }> = []
  http = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    req.on('end', () => {
      seen.push({ path: req.url ?? '', auth: req.headers.authorization ?? '' })
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      const rpc = JSON.parse(body) as { id?: number; method: string }
      if (rpc.id === undefined) { res.writeHead(202); res.end(); return }
      const result = rpc.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'http-fixture', version: '1' } }
        : { tools: [{ name: 'ping', inputSchema: { type: 'object', properties: {} } }] }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
    })
  })
  await new Promise<void>((resolve) => http!.listen(0, '127.0.0.1', resolve))
  const address = http.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { origin: `http://127.0.0.1:${address.port}`, seen }
}

describe('MCP config reconciliation', () => {
  it('command, env, limits, allowlist, transport, URL and auth changes each retire the old runtime and leave one current generation', async () => {
    const { first: ws, stdio } = await boot()
    const started = path.join(home, 'started.log')
    const remote = await startHttpMcp()
    expect((await ws.api('/secrets/TOK1', { value: 'one' }, 'PUT')).status).toBe(200)
    expect((await ws.api('/secrets/TOK2', { value: 'two' }, 'PUT')).status).toBe(200)
    const nodeLink = path.join(home, 'node-link')
    await fs.symlink(process.execPath, nodeLink)
    expect((await ws.api('/mcp/fx', stdio({ INIT_FILE: started }))).status).toBe(201)
    expect((await ws.api('/mcp/fx/enable')).status).toBe(200)
    let generation = (await ws.row('fx'))!.generation
    let runningPid = (await livePids(started))[0]!

    /** Save a change, check the old runtime is gone, then bring it back up once. */
    const change = async (patch: Record<string, unknown>): Promise<void> => {
      const current = await ws.stored('fx')
      expect((await ws.api('/mcp/fx', { ...current, ...patch })).status).toBe(201)
      const saved = await ws.row('fx')
      expect(saved?.generation).toBeGreaterThan(generation)
      expect(saved?.status).toBe('idle')
      expect(saved?.discoveredTools).toEqual([])
      if (runningPid !== 0) expect(alive(runningPid)).toBe(false)
      const reconnected = await ws.api('/mcp/fx/reconnect')
      expect(reconnected.status).toBe(200)
      const row = await ws.row('fx')
      expect(row?.status).toBe('ready')
      // Reconnecting does not move the generation: one runtime per committed config.
      expect(row?.generation).toBe(saved?.generation)
      generation = row!.generation
      const live = await livePids(started)
      expect(live.length).toBeLessThanOrEqual(1)
      runningPid = live[0] ?? 0
    }

    await change({ env: { INIT_FILE: started, EXTRA: 'a' } })
    await change({ command: nodeLink })
    await change({ resourceLimits: { maxLifetimeMs: 600_000, enforcement: 'best_effort' } })
    await change({ allowedTools: ['query'] })
    expect((await ws.row('fx'))?.discoveredTools).toContain('query')

    // stdio -> HTTP: the process is gone and only the HTTP runtime answers.
    await change({ transport: 'http', url: `${remote.origin}/a`, auth: { type: 'bearer', token: '${TOK1}' }, command: undefined, args: undefined, env: undefined, resourceLimits: undefined })
    expect(await livePids(started)).toEqual([])
    expect(remote.seen.some((request) => request.path === '/a' && request.auth === 'Bearer one')).toBe(true)

    let mark = remote.seen.length
    await change({ url: `${remote.origin}/b` })
    expect(remote.seen.slice(mark).length).toBeGreaterThan(0)
    expect(remote.seen.slice(mark).every((request) => request.path === '/b')).toBe(true)

    mark = remote.seen.length
    await change({ auth: { type: 'bearer', token: '${TOK2}' } })
    expect(remote.seen.slice(mark).length).toBeGreaterThan(0)
    expect(remote.seen.slice(mark).every((request) => request.auth === 'Bearer two')).toBe(true)
  }, 60_000)
})

describe('retired MCP runtimes', () => {
  it('list-change refreshes of a fenced, disabled or deleted runtime never republish its tools or restart it', async () => {
    const { first: ws, stdio, requests } = await boot()
    const busy = (name: string) => stdio({
      INIT_FILE: path.join(home, `${name}-started.log`), LIST_FILE: path.join(home, `${name}-lists.log`),
      LIST_CHANGED_EVERY_MS: '40', LIST_DELAY_MS: '150',
    })
    const listings = (name: string) => lines(path.join(home, `${name}-lists.log`))
    const started = (name: string) => path.join(home, `${name}-started.log`)
    for (const name of ['saved', 'off', 'gone']) {
      expect((await ws.api(`/mcp/${name}`, busy(name))).status).toBe(201)
      expect((await ws.api(`/mcp/${name}/enable`)).status).toBe(200)
      // Refreshes triggered by the notifications are now running.
      await expect.poll(async () => (await listings(name)).length, { timeout: 10_000, interval: 25 }).toBeGreaterThan(2)
    }

    // A save fences `saved`, a disable and a delete retire the other two, each
    // while a slow refresh of the old runtime is in flight.
    expect((await ws.api('/mcp/saved', { ...await ws.stored('saved'), timeoutMs: 20_000 })).status).toBe(201)
    expect((await ws.api('/mcp/off/disable')).status).toBe(200)
    expect((await ws.api('/mcp/gone', undefined, 'DELETE')).status).toBe(200)
    const counts = await Promise.all(['saved', 'off', 'gone'].map(async (name) => (await listings(name)).length))
    await new Promise((resolve) => setTimeout(resolve, 1_000))

    // Nothing of the old runtimes came back: no listing, no process, no client.
    expect(await Promise.all(['saved', 'off', 'gone'].map(async (name) => (await listings(name)).length))).toEqual(counts)
    for (const name of ['saved', 'off', 'gone']) expect(await livePids(started(name))).toEqual([])
    const rows = await ws.rows()
    expect(rows.find((row) => row.name === 'saved')).toMatchObject({ status: 'idle', discoveredTools: [] })
    expect(rows.find((row) => row.name === 'off')).toMatchObject({ status: 'disabled', discoveredTools: [] })
    expect(rows.some((row) => row.name === 'gone')).toBe(false)

    // A turn offers only what the current config starts: `saved` again, never `off` or `gone`.
    await ws.say(await ws.session(), 'hello')
    const offered = (requests.at(-1)?.tools ?? []).map((tool) => tool.name).filter((name) => name.startsWith('mcp__'))
    expect(offered.some((name) => name.startsWith('mcp__off__') || name.startsWith('mcp__gone__'))).toBe(false)
    expect(offered).toContain('mcp__saved__query')
  }, 60_000)
})
