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
