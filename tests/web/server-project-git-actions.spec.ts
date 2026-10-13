/**
 * Writable Git HTTP API: the trust PATCH, the NDJSON operation stream and the
 * askpass answer route, against real repositories (hooks stand in for a
 * credential prompt: they call `$GIT_ASKPASS` like git itself would).
 */
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { request as httpRequest, type ClientRequest } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createWebServer, type WebServer } from 'dnt-harness'

type Headers = Record<string, string>
type Frame = Record<string, unknown>

let scratch = ''
const saved: Record<string, string | undefined> = {}
let counter = 0
let server: WebServer | undefined

beforeAll(async () => {
  scratch = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-git-actions-')))
  await fs.mkdir(path.join(scratch, 'login-home'))
  // A hermetic login shell: the project git environment never reads the developer's rc files.
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

async function installHook(dir: string, name: string, script: string): Promise<void> {
  const file = path.join(dir, '.git', 'hooks', name)
  await fs.writeFile(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 })
}

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; body: string }

function raw(method: string, pathname: string, headers: Headers = {}, body?: unknown): Promise<Reply> {
  const target = new URL(server!.url)
  const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const client = httpRequest({
      host: target.hostname,
      port: target.port,
      path: pathname,
      method,
      headers: { ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { text += chunk })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text }))
    })
    client.on('error', reject)
    if (payload !== undefined) client.write(payload)
    client.end()
  })
}

/** An NDJSON response read line by line, with the means to wait for a frame or hang up. */
interface Stream {
  readonly status: Promise<number>
  readonly headers: Promise<Record<string, string | string[] | undefined>>
  readonly frames: Frame[]
  next(predicate: (frame: Frame) => boolean): Promise<Frame>
  finished: Promise<Frame[]>
  abort(): void
}

function openStream(pathname: string, headers: Headers, body: unknown): Stream {
  const target = new URL(server!.url)
  const frames: Frame[] = []
  const waiters: { predicate: (frame: Frame) => boolean; resolve: (frame: Frame) => void }[] = []
  let status!: (code: number) => void
  let responseHeaders!: (value: Record<string, string | string[] | undefined>) => void
  const statusPromise = new Promise<number>((resolve) => { status = resolve })
  const headersPromise = new Promise<Record<string, string | string[] | undefined>>((resolve) => { responseHeaders = resolve })
  let client!: ClientRequest
  const finished = new Promise<Frame[]>((resolve, reject) => {
    client = httpRequest({
      host: target.hostname,
      port: target.port,
      path: pathname,
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
    }, (response) => {
      status(response.statusCode ?? 0)
      responseHeaders(response.headers)
      let buffer = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        buffer += chunk
        for (let cut = buffer.indexOf('\n'); cut >= 0; cut = buffer.indexOf('\n')) {
          const line = buffer.slice(0, cut)
          buffer = buffer.slice(cut + 1)
          if (line === '') continue
          const frame = JSON.parse(line) as Frame
          frames.push(frame)
          for (const waiter of [...waiters]) {
            if (waiter.predicate(frame)) {
              waiters.splice(waiters.indexOf(waiter), 1)
              waiter.resolve(frame)
            }
          }
        }
      })
      response.on('end', () => resolve(frames))
      response.on('error', () => resolve(frames))
      response.on('aborted', () => resolve(frames))
    })
    client.on('error', (error) => { if ((error as NodeJS.ErrnoException).code === 'ECONNRESET') resolve(frames); else reject(error) })
    client.end(JSON.stringify(body))
  })
  return {
    status: statusPromise,
    headers: headersPromise,
    frames,
    finished,
    next: (predicate) => {
      const seen = frames.find(predicate)
      if (seen !== undefined) return Promise.resolve(seen)
      return new Promise<Frame>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no matching frame; saw ${JSON.stringify(frames)}`)), 15_000)
        waiters.push({ predicate, resolve: (frame) => { clearTimeout(timer); resolve(frame) } })
      })
    },
    abort: () => client.destroy(),
  }
}

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch { return false }
}

interface Context { wsId: string; projectId: string; root: string; project: string; actions: string; headers: Headers }

/** A server (no control-plane auth) with one registered repository. */
async function plainContext(): Promise<Context> {
  const home = path.join(scratch, `home-${++counter}`)
  await fs.mkdir(home)
  server = await createWebServer({ home, configFile: path.join(home, 'providers.json') })
  const wsId = ((await (await fetch(`${server.url}/api/workspaces`)).json()) as { id: string }[])[0]!.id
  const root = await makeRepo()
  const created = await raw('POST', `/api/workspaces/${wsId}/projects`, {}, { name: 'Git', path: root })
  const projectId = (JSON.parse(created.body) as { id: string }).id
  const project = `/api/workspaces/${wsId}/projects/${projectId}`
  return { wsId, projectId, root, project, actions: `${project}/git`, headers: {} }
}

async function pairBrowser(live: WebServer): Promise<Headers> {
  const paired = await raw('POST', '/api/auth/pair', { origin: live.auth.canonicalOrigin }, { code: live.auth.issuePairingCode().code })
  return {
    cookie: String(paired.headers['set-cookie']).split(';')[0] ?? '',
    origin: live.auth.canonicalOrigin,
    'x-dnt-harness-csrf': (JSON.parse(paired.body) as { csrf: string }).csrf,
  }
}

/** A control-plane-auth server with a paired browser, a bearer and one trusted repository. */
async function authContext(): Promise<Context & { bearer: Headers; other: Headers }> {
  const home = path.join(scratch, `home-${++counter}`)
  await fs.mkdir(home)
  server = await createWebServer({ home, configFile: path.join(home, 'providers.json'), controlPlaneAuth: true })
  const browser = await pairBrowser(server)
  // A second paired browser (pairing again would revoke the first by bumping the generation).
  const second = server.auth.openBrowserSession()
  const other = {
    cookie: server.auth.cookieHeader(second.id).split(';')[0] ?? '',
    origin: server.auth.canonicalOrigin,
    'x-dnt-harness-csrf': second.csrf,
  }
  const bearer = { authorization: `Bearer ${server.auth.issueBearer(['sessions']).token}` }
  const wsId = (JSON.parse((await raw('GET', '/api/workspaces', browser)).body) as { id: string }[])[0]!.id
  const root = await makeRepo()
  const projectId = (JSON.parse((await raw('POST', `/api/workspaces/${wsId}/projects`, browser, { name: 'Git', path: root })).body) as { id: string }).id
  const project = `/api/workspaces/${wsId}/projects/${projectId}`
  expect((await raw('PATCH', project, browser, { gitTrusted: true })).status).toBe(200)
  return { wsId, projectId, root, project, actions: `${project}/git`, headers: browser, bearer, other }
}

describe('PATCH gitTrusted', () => {
  it('stores a boolean on the project and only the browser may set it', async () => {
    const home = path.join(scratch, `home-${++counter}`)
    await fs.mkdir(home)
    server = await createWebServer({ home, configFile: path.join(home, 'providers.json'), controlPlaneAuth: true })
    const browser = await pairBrowser(server)
    const bearer = { authorization: `Bearer ${server.auth.issueBearer(['sessions']).token}` }
    const wsId = (JSON.parse((await raw('GET', '/api/workspaces', browser)).body) as { id: string }[])[0]!.id
    const root = await makeRepo()
    const projectId = (JSON.parse((await raw('POST', `/api/workspaces/${wsId}/projects`, browser, { name: 'Git', path: root })).body) as { id: string }).id
    const project = `/api/workspaces/${wsId}/projects/${projectId}`

    expect((await raw('PATCH', project, bearer, { gitTrusted: true })).status).toBe(401)
    const listed = async (): Promise<{ gitTrusted?: boolean }> =>
      (JSON.parse((await raw('GET', `/api/workspaces/${wsId}/projects`, browser)).body) as { id: string; gitTrusted?: boolean }[]).find((row) => row.id === projectId)!
    expect((await listed()).gitTrusted).toBeUndefined()

    expect((await raw('PATCH', project, browser, { gitTrusted: 'yes' })).status).toBe(400)
    const trusted = await raw('PATCH', project, browser, { gitTrusted: true })
    expect(trusted.status).toBe(200)
    expect(JSON.parse(trusted.body)).toMatchObject({ gitTrusted: true, name: 'Git' })
    expect((await listed()).gitTrusted).toBe(true)
    expect(JSON.parse((await raw('PATCH', project, browser, { gitTrusted: false })).body)).toMatchObject({ gitTrusted: false })
  })

  it('a refused trust change applies no rename', async () => {
    const ctx = await plainContext()
    const refused = await raw('PATCH', ctx.project, {}, { name: 'Renamed', gitTrusted: 'maybe' })
    expect(refused.status).toBe(400)
    const listed = JSON.parse((await raw('GET', `/api/workspaces/${ctx.wsId}/projects`)).body) as { id: string; name: string }[]
    expect(listed.find((row) => row.id === ctx.projectId)?.name).toBe('Git')
  })

  it('retargeting the folder clears trust unless the same PATCH sets it', async () => {
    const ctx = await plainContext()
    const other = await makeRepo()
    const third = await makeRepo()
    expect(JSON.parse((await raw('PATCH', ctx.project, {}, { gitTrusted: true })).body)).toMatchObject({ gitTrusted: true })

    const moved = await raw('PATCH', ctx.project, {}, { path: other })
    expect(moved.status).toBe(200)
    expect(JSON.parse(moved.body).gitTrusted).not.toBe(true)
    const listed = JSON.parse((await raw('GET', `/api/workspaces/${ctx.wsId}/projects`)).body) as { id: string; gitTrusted?: boolean }[]
    expect(listed.find((row) => row.id === ctx.projectId)?.gitTrusted).not.toBe(true)

    // Re-targeting to the same folder keeps what was granted for it.
    await raw('PATCH', ctx.project, {}, { gitTrusted: true })
    expect(JSON.parse((await raw('PATCH', ctx.project, {}, { path: other })).body)).toMatchObject({ gitTrusted: true })
    // An explicit decision in the same PATCH wins.
    expect(JSON.parse((await raw('PATCH', ctx.project, {}, { path: third, gitTrusted: true })).body)).toMatchObject({ path: third, gitTrusted: true })
  })

  it('status and diff run hooks-aware git only for a trusted project', async () => {
    const ctx = await plainContext()
    await fs.writeFile(path.join(ctx.root, 'a.txt'), 'changed\n')
    const before = JSON.parse((await raw('GET', ctx.actions)).body) as { changes: { path: string }[] }
    expect(before.changes.map((change) => change.path)).toEqual(['a.txt'])
    await raw('PATCH', ctx.project, {}, { gitTrusted: true })
    const after = await raw('GET', ctx.actions)
    expect(after.status).toBe(200)
    expect((JSON.parse(after.body) as { changes: unknown[] }).changes).toHaveLength(1)
  })
})

describe('git action routes', () => {
  it('rejects unknown actions, wrong methods and invalid requests before streaming', async () => {
    const ctx = await plainContext()
    expect((await raw('POST', `${ctx.actions}/frobnicate`, {}, {})).status).toBe(404)
    expect((await raw('GET', `${ctx.actions}/stage`)).status).toBe(405)
    expect((await raw('GET', `${ctx.actions}/askpass/abc`)).status).toBe(405)

    for (const [action, body] of [
      ['stage', { paths: ['../outside.txt'] }],
      ['stage', { paths: [path.join(scratch, 'elsewhere')] }],
      ['stage', {}],
      ['stage', { paths: [1] }],
      ['commit', { message: 5 }],
      ['commit', { message: 'm', amend: 'yes' }],
      ['fetch', { remote: 'nope' }],
      ['fetch', { remote: '--upload-pack=x' }],
      ['pull', { remote: 'nope' }],
      ['push', { remote: 'nope', branch: 'main' }],
      ['push', { remote: 'nope' }],
      ['remotes', { branch: '--bad' }],
      ['remotes', {}],
    ] as const) {
      const reply = await raw('POST', `${ctx.actions}/${action}`, {}, body)
      expect(reply.status, `${action} ${JSON.stringify(body)}`).toBe(400)
      expect(reply.headers['content-type']).toContain('application/json')
      expect(JSON.parse(reply.body)).toHaveProperty('error')
    }
  })

  it('never echoes a malformed request body, for askpass answers or operations', async () => {
    const ctx = await plainContext()
    for (const [action, body, secret] of [
      ['askpass/abc', '{"password":s3cret}', 's3cret'],
      ['askpass/abc', '{"password":"s3cret"', 's3cret'],
      ['commit', '{"message":s3cret}', 's3cret'],
      ['commit', '["s3cret"]', 's3cret'],
    ] as const) {
      const reply = await raw('POST', `${ctx.actions}/${action}`, {}, body)
      expect(reply.status, `${action} ${body}`).toBe(400)
      expect(reply.body).not.toContain(secret)
      expect(JSON.parse(reply.body)).toEqual({ error: 'invalid request body' })
    }
  })

  it('answers 404 for a project of another workspace and refuses Git on an archived workspace', async () => {
    const ctx = await plainContext()
    expect((await raw('POST', `/api/workspaces/${ctx.wsId}/projects/nope/git/stage-all`, {}, {})).status).toBe(404)
    const second = JSON.parse((await raw('POST', '/api/workspaces', {}, { name: 'Other' })).body) as { id: string }
    expect((await raw('POST', `/api/workspaces/${second.id}/projects/${ctx.projectId}/git/stage-all`, {}, {})).status).toBe(404)

    expect((await raw('PATCH', `/api/workspaces/${ctx.wsId}`, {}, { archived: true })).status).toBe(200)
    await fs.writeFile(path.join(ctx.root, 'new.txt'), 'n\n')
    const refused = await raw('POST', `${ctx.actions}/stage-all`, {}, {})
    expect(refused.status).toBe(404)
    expect(git(ctx.root, 'status', '--porcelain')).toContain('?? new.txt')
    await raw('PATCH', `/api/workspaces/${ctx.wsId}`, {}, { archived: false })
    expect((await raw('POST', `${ctx.actions}/stage-all`, {}, {})).status).toBe(200)
  })

  it('streams NDJSON ending in a done frame with the new status', async () => {
    const ctx = await plainContext()
    await fs.writeFile(path.join(ctx.root, 'new.txt'), 'n\n')
    const stream = openStream(`${ctx.actions}/stage`, {}, { paths: ['new.txt'] })
    expect(await stream.status).toBe(200)
    expect((await stream.headers)['content-type']).toBe('application/x-ndjson; charset=utf-8')
    expect((await stream.headers)['cache-control']).toBe('no-store')
    const frames = await stream.finished
    expect(frames.at(-1)).toEqual({ type: 'done', ok: true, stdout: '', stderr: '', status: expect.any(Object) })
    const status = frames.at(-1)!['status'] as { changes: { path: string; staging: string }[] }
    expect(status.changes.find((change) => change.path === 'new.txt')?.staging).toBe('staged')
    expect(git(ctx.root, 'diff', '--cached', '--name-only').trim()).toBe('new.txt')

    const out = await openStream(`${ctx.actions}/unstage-all`, {}, {}).finished
    expect(out.at(-1)).toMatchObject({ type: 'done', ok: true })
    expect(git(ctx.root, 'diff', '--cached', '--name-only').trim()).toBe('')
  })

  it('a failing commit hook is HTTP 200 with done.ok false and the hook output', async () => {
    const ctx = await plainContext()
    expect((await raw('PATCH', ctx.project, {}, { gitTrusted: true })).status).toBe(200)
    await installHook(ctx.root, 'pre-commit', 'echo "hook says no" >&2\nexit 1')
    await fs.writeFile(path.join(ctx.root, 'a.txt'), 'changed\n')
    await openStream(`${ctx.actions}/stage`, {}, { paths: ['a.txt'] }).finished

    const stream = openStream(`${ctx.actions}/commit`, {}, { message: 'blocked', amend: false, signoff: false, noVerify: false, tracked: false })
    expect(await stream.status).toBe(200)
    const last = (await stream.finished).at(-1)!
    expect(last).toMatchObject({ type: 'done', ok: false })
    expect(String(last['stderr'])).toContain('hook says no')
    expect(git(ctx.root, 'log', '--format=%s')).toBe('init\n')
  })

  it('an untrusted project does not run its hooks', async () => {
    const ctx = await plainContext()
    await installHook(ctx.root, 'pre-commit', 'echo "hook says no" >&2\nexit 1')
    await fs.writeFile(path.join(ctx.root, 'a.txt'), 'changed\n')
    await openStream(`${ctx.actions}/stage`, {}, { paths: ['a.txt'] }).finished
    const last = (await openStream(`${ctx.actions}/commit`, {}, { message: 'goes through' }).finished).at(-1)!
    expect(last).toMatchObject({ type: 'done', ok: true })
    expect(git(ctx.root, 'log', '--format=%s', '-1')).toBe('goes through\n')
  })

  it('returns remotes and pushed-to in the done frame', async () => {
    const ctx = await plainContext()
    const bare = path.join(scratch, `bare-${++counter}.git`)
    git(scratch, 'init', '-q', '--bare', '-b', 'main', bare)
    git(ctx.root, 'remote', 'add', 'origin', bare)
    const remotes = (await openStream(`${ctx.actions}/remotes`, {}, { branch: 'main', push: true }).finished).at(-1)!
    expect(remotes).toMatchObject({ type: 'done', ok: true, remotes: ['origin'] })

    expect((await openStream(`${ctx.actions}/pushed-to`, {}, {}).finished).at(-1)).toMatchObject({ ok: true, pushedTo: [] })
    const pushed = (await openStream(`${ctx.actions}/push`, {}, { remote: 'origin', branch: 'main', upstreamBranch: 'main', setUpstream: true, force: false }).finished).at(-1)!
    expect(pushed).toMatchObject({ type: 'done', ok: true })
    expect((await openStream(`${ctx.actions}/pushed-to`, {}, {}).finished).at(-1)).toMatchObject({ ok: true, pushedTo: ['refs/remotes/origin/main'] })
  })
})

describe('askpass over HTTP', () => {
  const PROMPTING_HOOK = [
    'echo $$ > "$(dirname "$0")/hook.pid"',
    'answer=$("$GIT_ASKPASS" "Password:") || exit 1',
    '[ "$answer" = "s3cret" ] || { echo "wrong password" >&2; exit 1; }',
    'echo "$answer" > "$(dirname "$0")/hook.got"',
  ].join('\n')

  async function stagedChange(ctx: Context): Promise<void> {
    await installHook(ctx.root, 'pre-commit', PROMPTING_HOOK)
    await fs.writeFile(path.join(ctx.root, 'a.txt'), 'changed\n')
    await openStream(`${ctx.actions}/stage`, ctx.headers, { paths: ['a.txt'] }).finished
  }

  const commitBody = { message: 'asks', amend: false, signoff: false, noVerify: false, tracked: false }

  it('streams the prompt, takes the owning browser\'s answer and completes', async () => {
    const ctx = await authContext()
    await stagedChange(ctx)
    const stream = openStream(`${ctx.actions}/commit`, ctx.headers, commitBody)
    const prompt = await stream.next((frame) => frame['type'] === 'askpass')
    expect(prompt).toMatchObject({ type: 'askpass', operation: 'commit', prompt: expect.stringContaining('Password') })
    const promptId = String(prompt['promptId'])
    const answerUrl = `${ctx.actions}/askpass/${promptId}`

    // Not the browser that owns the workspace: a bearer, or another paired browser.
    expect((await raw('POST', answerUrl, (ctx as unknown as { bearer: Headers }).bearer, { password: 's3cret' })).status).toBe(401)
    expect((await raw('POST', answerUrl, (ctx as unknown as { other: Headers }).other, { password: 's3cret' })).status).toBe(401)
    // Wrong shapes never reach git, and never echo the secret.
    for (const bad of [{}, { password: 1 }, { password: 'x', cancel: true }, { password: 'x', extra: 1 }, { cancel: false }]) {
      const reply = await raw('POST', answerUrl, ctx.headers, bad)
      expect(reply.status).toBe(400)
      expect(reply.body).not.toContain('"x"')
    }
    const answered = await raw('POST', answerUrl, ctx.headers, { password: 's3cret' })
    expect(answered.status).toBe(200)
    expect(answered.body).not.toContain('s3cret')

    const last = (await stream.finished).at(-1)!
    expect(last).toMatchObject({ type: 'done', ok: true })
    expect(JSON.stringify(stream.frames)).not.toContain('s3cret')
    expect(git(ctx.root, 'log', '--format=%s', '-1')).toBe('asks\n')
    expect((await fs.readFile(path.join(ctx.root, '.git', 'hooks', 'hook.got'), 'utf8')).trim()).toBe('s3cret')
    // The prompt is gone once the operation ended.
    expect((await raw('POST', answerUrl, ctx.headers, { password: 's3cret' })).status).toBe(404)
  })

  it('a wrong password is a normal stream with done.ok false', async () => {
    const ctx = await authContext()
    await stagedChange(ctx)
    const stream = openStream(`${ctx.actions}/commit`, ctx.headers, commitBody)
    const prompt = await stream.next((frame) => frame['type'] === 'askpass')
    expect((await raw('POST', `${ctx.actions}/askpass/${String(prompt['promptId'])}`, ctx.headers, { password: 'nope' })).status).toBe(200)
    expect(await stream.status).toBe(200)
    const last = (await stream.finished).at(-1)!
    expect(last).toMatchObject({ type: 'done', ok: false })
    expect(String(last['stderr'])).toContain('wrong password')
  })

  it('cancelling a prompt ends the stream with done { ok: false, cancelled: true }', async () => {
    const ctx = await authContext()
    await stagedChange(ctx)
    const stream = openStream(`${ctx.actions}/commit`, ctx.headers, commitBody)
    const prompt = await stream.next((frame) => frame['type'] === 'askpass')
    expect((await raw('POST', `${ctx.actions}/askpass/${String(prompt['promptId'])}`, ctx.headers, { cancel: true })).status).toBe(200)
    expect((await stream.finished).at(-1)).toMatchObject({ type: 'done', ok: false, cancelled: true })
    expect(git(ctx.root, 'log', '--format=%s', '-1')).toBe('init\n')
  })

  it('a client that disconnects cancels the operation: the process dies and a late answer is 404', async () => {
    const ctx = await authContext()
    await stagedChange(ctx)
    const stream = openStream(`${ctx.actions}/commit`, ctx.headers, commitBody)
    const prompt = await stream.next((frame) => frame['type'] === 'askpass')
    const pidFile = path.join(ctx.root, '.git', 'hooks', 'hook.pid')
    const pid = Number((await fs.readFile(pidFile, 'utf8')).trim())
    expect(alive(pid)).toBe(true)

    stream.abort()
    await until(async () => !alive(pid), 'the hook process to be killed')
    const late = await raw('POST', `${ctx.actions}/askpass/${String(prompt['promptId'])}`, ctx.headers, { password: 's3cret' })
    expect(late.status).toBe(404)
    expect(git(ctx.root, 'log', '--format=%s', '-1')).toBe('init\n')
    // The repository queue is free again for the next operation.
    const next = await openStream(`${ctx.actions}/unstage-all`, ctx.headers, {}).finished
    expect(next.at(-1)).toMatchObject({ type: 'done', ok: true })
  })

  it('refuses Git actions from a bearer or an unpaired caller', async () => {
    const ctx = await authContext()
    const bearer = (ctx as unknown as { bearer: Headers }).bearer
    expect((await raw('POST', `${ctx.actions}/stage-all`, bearer, {})).status).toBe(401)
    expect((await raw('POST', `${ctx.actions}/stage-all`, {}, {})).status).toBe(401)
    expect((await raw('POST', `${ctx.actions}/askpass/abc`, bearer, { cancel: true })).status).toBe(401)
    expect((await raw('POST', `${ctx.actions}/stage-all`, ctx.headers, {})).status).toBe(200)
  })
})
