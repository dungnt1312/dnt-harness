/**
 * The Git v2 routes: parsing/validation (400s before the stream) for every new
 * operation, the `branches` query, and the `commit-message` NDJSON stream
 * (fake provider, no model configured, bearer refused).
 */
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { request as httpRequest, type ClientRequest } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createWebServer, type WebServer } from 'dnt-harness'
import type { LlmProvider, ModelRequest, StreamEvent } from '../../src/harness/llm/types.ts'

type Headers = Record<string, string>
type Frame = Record<string, unknown>

let scratch = ''
const saved: Record<string, string | undefined> = {}
let counter = 0
let server: WebServer | undefined

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

async function makeRepo(): Promise<string> {
  counter += 1
  const dir = path.join(scratch, `repo-${counter}`)
  await fs.mkdir(dir)
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 't@t')
  git(dir, 'config', 'user.name', 't')
  await fs.writeFile(path.join(dir, 'a.txt'), 'a\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'init')
  return dir
}

beforeAll(async () => {
  scratch = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-git-v2-')))
  await fs.mkdir(path.join(scratch, 'login-home'))
  for (const key of ['HOME', 'SHELL']) saved[key] = process.env[key]
  process.env['HOME'] = path.join(scratch, 'login-home')
  process.env['SHELL'] = '/bin/bash'
})

afterAll(async () => {
  for (const key of ['HOME', 'SHELL']) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  await fs.rm(scratch, { recursive: true, force: true })
})

afterEach(async () => {
  await server?.close()
  server = undefined
})

/** POST one JSON body, read the NDJSON stream to its end (or the JSON error). */
function post(url: string, body: unknown, headers: Headers = {}): Promise<{ status: number; frames: Frame[]; json: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body))
    const req = httpRequest(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(payload.length), ...headers } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        const contentType = String(res.headers['content-type'] ?? '')
        if (contentType.includes('ndjson')) {
          resolve({ status: res.statusCode ?? 0, frames: text.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Frame), json: undefined })
          return
        }
        resolve({ status: res.statusCode ?? 0, frames: [], json: text === '' ? undefined : JSON.parse(text) })
      })
    })
    req.on('error', reject)
    req.end(payload)
  })
}

async function raw(method: string, url: string, body: unknown, headers: Headers = {}): Promise<{ status: number; body: string; headers: Record<string, string | string[]> }> {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method, headers: { ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(payload.length) }), ...headers } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers as Record<string, string | string[]> }))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

/** A paired browser's cookie + CSRF for a live server. */
async function pairBrowser(live: WebServer): Promise<Headers> {
  const paired = await raw('POST', `${live.url}/api/auth/pair`, { code: live.auth.issuePairingCode().code }, { origin: live.auth.canonicalOrigin })
  return {
    cookie: String(paired.headers['set-cookie']).split(';')[0] ?? '',
    origin: live.auth.canonicalOrigin,
    'x-dnt-harness-csrf': (JSON.parse(paired.body) as { csrf: string }).csrf,
  }
}

/** A one-shot fake provider whose stream yields fixed text deltas. */
function fakeProvider(name = 'fake'): LlmProvider {
  return {
    name,
    models: ['m'],
    stream: async function* (_request: ModelRequest): AsyncGenerator<StreamEvent> {
      yield { type: 'delta', delta: 'Add a' }
      yield { type: 'delta', delta: ' widget' }
      yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
    },
  }
}

interface Context { root: string; project: string; actions: string; headers: Headers }

/** A no-auth server with one registered repository and paired-browser headers. */
async function context(providers: readonly LlmProvider[] = []): Promise<Context> {
  const home = path.join(scratch, `home-${++counter}`)
  await fs.mkdir(home)
  server = await createWebServer({ home, configFile: path.join(home, 'providers.json'), ...(providers.length === 0 ? {} : { providers }) })
  const wsId = ((await (await fetch(`${server.url}/api/workspaces`)).json()) as { id: string }[])[0]!.id
  const root = await makeRepo()
  const created = await raw('POST', `${server.url}/api/workspaces/${wsId}/projects`, { name: 'Git', path: root })
  const projectId = (JSON.parse(created.body) as { id: string }).id
  return { root, project: `${server.url}/api/workspaces/${wsId}/projects/${projectId}`, actions: `${server.url}/api/workspaces/${wsId}/projects/${projectId}/git`, headers: {} }
}

describe('operation bodies are validated before the stream', () => {
  it('refuses a malformed body of every new op with the exact message', async () => {
    const ctx = await context()
    const cases: readonly [string, unknown, string][] = [
      ['switch-branch', {}, 'name must be a string'],
      ['create-branch', { name: 'x', base: 1 }, 'base must be a string'],
      ['delete-branch', { name: 'x', remote: 'no' }, 'remote must be a boolean'],
      ['stage-hunk', { path: 'a', hunk: { oldStart: '1' } }, 'hunk must be { oldStart, oldLines, newStart, newLines, fingerprint }'],
      ['resolve-conflict', { path: 'a', index: 0, fingerprint: 'f', choice: 'mine' }, 'choice must be ours, theirs or both'],
      ['ignore', { paths: 'a' }, 'paths must be an array of strings'],
    ]
    for (const [op, body, message] of cases) {
      const answer = await post(`${ctx.actions}/${op}`, body, ctx.headers)
      expect(answer.status, op).toBe(400)
      expect((answer.json as { error: string }).error, op).toBe(message)
    }
  })

  it('answers the branches query in one done frame', async () => {
    const ctx = await context()
    git(ctx.root, 'branch', 'feature')
    const answer = await post(`${ctx.actions}/branches`, {}, ctx.headers)
    expect(answer.status).toBe(200)
    const done = answer.frames.at(-1)!
    expect(done['type']).toBe('done')
    expect((done['branches'] as { name: string }[]).map((branch) => branch.name).sort()).toEqual(['feature', 'main'])
  })
})

describe('commit-message', () => {
  it('answers 400 when no model is configured', async () => {
    const ctx = await context()
    const answer = await post(`${ctx.actions}/commit-message`, {}, ctx.headers)
    expect(answer.status).toBe(400)
    expect((answer.json as { error: string }).error).toBe('No commit message model is configured.')
  })

  it('streams deltas then done once the pair is set', async () => {
    const home = path.join(scratch, `home-stream-${++counter}`)
    await fs.mkdir(home)
    // The pair is a file beside providers.json, read at boot: an injected provider is not in the PUT-able config list.
    await fs.writeFile(path.join(home, 'commit-message.json'), JSON.stringify({ provider: 'fake', model: 'm' }))
    server = await createWebServer({ home, configFile: path.join(home, 'providers.json'), controlPlaneAuth: true, providers: [fakeProvider()] })
    const browser = await pairBrowser(server)
    const wsId = ((await (await fetch(`${server.url}/api/workspaces`, { headers: browser })).json()) as { id: string }[])[0]!.id
    const root = await makeRepo()
    const created = await raw('POST', `${server.url}/api/workspaces/${wsId}/projects`, { name: 'Git', path: root }, browser)
    const projectId = (JSON.parse(created.body) as { id: string }).id
    const actions = `${server.url}/api/workspaces/${wsId}/projects/${projectId}/git`
    const answer = await post(`${actions}/commit-message`, { subject: 'Add' }, browser)
    expect(answer.status, JSON.stringify(answer.json)).toBe(200)
    expect(answer.frames.map((frame) => frame['type'])).toEqual(['start', 'delta', 'delta', 'done'])
    expect(answer.frames[1]).toMatchObject({ type: 'delta', text: 'Add a' })
    expect(answer.frames.at(-1)).toMatchObject({ type: 'done', ok: true })
  })

  it('refuses a bearer-token caller', async () => {
    const home = path.join(scratch, `home-auth-${++counter}`)
    await fs.mkdir(home)
    server = await createWebServer({ home, configFile: path.join(home, 'providers.json'), controlPlaneAuth: true })
    const browser = await pairBrowser(server)
    const wsId = ((await (await fetch(`${server.url}/api/workspaces`, { headers: browser })).json()) as { id: string }[])[0]!.id
    const root = await makeRepo()
    const created = await raw('POST', `${server.url}/api/workspaces/${wsId}/projects`, { name: 'Git', path: root }, browser)
    const projectId = (JSON.parse(created.body) as { id: string }).id
    const actions = `${server.url}/api/workspaces/${wsId}/projects/${projectId}/git`
    const bearer = { authorization: `Bearer ${server.auth.issueBearer(['sessions']).token}` }
    for (const op of ['commit-message', 'branches']) {
      const answer = await post(`${actions}/${op}`, {}, bearer)
      expect(answer.status, op).toBe(401)
    }
    // A paired browser reaches it.
    const ok = await post(`${actions}/branches`, {}, browser)
    expect(ok.frames.at(-1)).toMatchObject({ type: 'done' })
  })
})
