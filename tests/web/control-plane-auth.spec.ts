/**
 * Local control-plane auth: default deny, single-use pairing, CSRF plus
 * canonical Origin on cookie mutations, separate bearer credentials, and
 * generation fencing after logout.
 */
import { promises as fs } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWebServer, type WebServer } from 'mini-dsh'
import { OPERATOR_HEADER, readOperatorChannel } from '../../src/web/operator-channel.ts'

let server: WebServer | undefined
let home = ''

afterEach(async () => {
  await server?.close()
  server = undefined
  if (home !== '') await fs.rm(home, { recursive: true, force: true })
  home = ''
})

async function start(): Promise<WebServer> {
  home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-auth-'))
  server = await createWebServer({
    home,
    configFile: path.join(home, 'providers.json'),
    controlPlaneAuth: true,
  })
  return server
}

function raw(
  base: string,
  method: string,
  pathname: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const url = new URL(base)
  return new Promise((resolve, reject) => {
    const client = httpRequest({
      host: url.hostname,
      port: url.port,
      path: pathname,
      method,
      headers,
    }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { text += chunk })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text }))
    })
    client.on('error', reject)
    if (body !== undefined) client.write(body)
    client.end()
  })
}

describe('control-plane authentication', () => {
  it('denies privileged routes until a pairing code is redeemed', async () => {
    const live = await start()
    const denied = await raw(live.url, 'GET', '/api/workspaces')
    expect(denied.status).toBe(401)

    const health = await raw(live.url, 'GET', '/api/health')
    expect(health.status).toBe(200)
    expect(JSON.parse(health.body)).toEqual({ ok: true })

    const code = live.auth.issuePairingCode().code
    const paired = await raw(live.url, 'POST', '/api/auth/pair', {
      'content-type': 'application/json',
      origin: live.auth.canonicalOrigin,
    }, JSON.stringify({ code }))
    expect(paired.status).toBe(200)
    const cookie = String(paired.headers['set-cookie'])
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    const csrf = (JSON.parse(paired.body) as { csrf: string }).csrf

    const reused = await raw(live.url, 'POST', '/api/auth/pair', {
      'content-type': 'application/json',
    }, JSON.stringify({ code }))
    expect(reused.status).toBe(401)

    const listed = await raw(live.url, 'GET', '/api/workspaces', { cookie: cookie.split(';')[0] ?? '' })
    expect(listed.status).toBe(200)
    const sessionCookie = cookie.split(';')[0] ?? ''

    const missingOrigin = await raw(live.url, 'POST', '/api/workspaces', {
      cookie: sessionCookie,
      'content-type': 'application/json',
      'x-mini-dsh-csrf': csrf,
    }, JSON.stringify({ name: 'x' }))
    expect(missingOrigin.status).toBe(403)

    const foreign = await raw(live.url, 'POST', '/api/workspaces', {
      cookie: sessionCookie,
      origin: 'http://evil.example',
      'content-type': 'application/json',
      'x-mini-dsh-csrf': csrf,
    }, JSON.stringify({ name: 'x' }))
    expect(foreign.status).toBe(403)

    const created = await raw(live.url, 'POST', '/api/workspaces', {
      cookie: sessionCookie,
      origin: live.auth.canonicalOrigin,
      'content-type': 'application/json',
      'x-mini-dsh-csrf': csrf,
    }, JSON.stringify({ name: 'Work' }))
    expect(created.status).toBe(201)
  })

  it('reports pairing per browser, restores CSRF after a reload, and clears a stale cookie', async () => {
    const live = await start()
    const before = await raw(live.url, 'GET', '/api/auth/state')
    expect(JSON.parse(before.body)).toEqual({ required: true, paired: false })

    const code = live.auth.issuePairingCode().code
    const paired = await raw(live.url, 'POST', '/api/auth/pair', {
      'content-type': 'application/json',
      origin: live.auth.canonicalOrigin,
    }, JSON.stringify({ code }))
    const sessionCookie = String(paired.headers['set-cookie']).split(';')[0] ?? ''
    const csrf = (JSON.parse(paired.body) as { csrf: string }).csrf

    // A reloaded page recovers its CSRF token from the session it still holds.
    const reloaded = await raw(live.url, 'GET', '/api/auth/state', { cookie: sessionCookie })
    expect(JSON.parse(reloaded.body)).toEqual({ required: true, paired: true, csrf })

    // Another browser is not paired just because someone else redeemed a code.
    const other = await raw(live.url, 'GET', '/api/auth/state')
    expect(JSON.parse(other.body)).toEqual({ required: true, paired: false })

    // An expired or revoked session cookie is cleared, so the browser can pair again.
    const stale = await raw(live.url, 'GET', '/api/auth/state', { cookie: 'mini-dsh-session=expired-session' })
    expect(JSON.parse(stale.body)).toEqual({ required: true, paired: false })
    expect(String(stale.headers['set-cookie'])).toContain('Max-Age=0')

    // So is one refused mid-use by any privileged route.
    live.auth.logoutAll()
    const refused = await raw(live.url, 'GET', '/api/workspaces', { cookie: sessionCookie })
    expect(refused.status).toBe(401)
    expect(String(refused.headers['set-cookie'])).toContain('Max-Age=0')
  })

  it('lets the operator who can read the data home mint a fresh pairing code, and nobody else', async () => {
    const live = await start()
    const channel = await readOperatorChannel(home)
    expect(channel.url).toBe(live.url)

    const anonymous = await raw(live.url, 'POST', '/api/auth/pairing-code')
    expect(anonymous.status).toBe(403)
    const wrong = await raw(live.url, 'POST', '/api/auth/pairing-code', { [OPERATOR_HEADER]: 'not-the-key' })
    expect(wrong.status).toBe(403)

    const minted = await raw(live.url, 'POST', '/api/auth/pairing-code', { [OPERATOR_HEADER]: channel.key })
    expect(minted.status).toBe(200)
    const { code } = JSON.parse(minted.body) as { code: string }
    const paired = await raw(live.url, 'POST', '/api/auth/pair', { 'content-type': 'application/json' }, JSON.stringify({ code }))
    expect(paired.status).toBe(200)

    // The channel is retired with the host, so a stale file never outlives it.
    await live.close()
    server = undefined
    await expect(readOperatorChannel(home)).rejects.toThrow()
  })

  it('rejects a bearer mixed with a cookie and fences the old generation after logout', async () => {
    const live = await start()
    const code = live.auth.issuePairingCode().code
    const paired = await raw(live.url, 'POST', '/api/auth/pair', {
      'content-type': 'application/json',
    }, JSON.stringify({ code }))
    const csrf = (JSON.parse(paired.body) as { csrf: string }).csrf
    const sessionCookie = String(paired.headers['set-cookie']).split(';')[0] ?? ''
    const bearer = live.auth.issueBearer(['sessions'])

    const mixed = await raw(live.url, 'GET', '/api/workspaces', {
      cookie: sessionCookie,
      authorization: `Bearer ${bearer.token}`,
    })
    expect(mixed.status).toBe(403)

    const authed = await raw(live.url, 'GET', '/api/workspaces', { authorization: `Bearer ${bearer.token}` })
    expect(authed.status).toBe(200)

    const loggedOut = await raw(live.url, 'POST', '/api/auth/logout', {
      cookie: sessionCookie,
      origin: live.auth.canonicalOrigin,
      'x-mini-dsh-csrf': csrf,
    })
    expect(loggedOut.status).toBe(200)

    const stale = await raw(live.url, 'GET', '/api/workspaces', {
      cookie: sessionCookie,
      'last-event-id': 'gen=1',
    })
    expect(stale.status).toBe(401)
  })

  it('ships no test bootstrap: no runtime switch in src/ can mint a session or skip auth', async () => {
    // Tests mint codes through the in-process handle; operators through stdout
    // or the operator channel. An env/test flag would be a production bypass.
    const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', 'src')
    const offenders: string[] = []
    let scanned = 0
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) await walk(full)
        else if (entry.name.endsWith('.ts')) {
          scanned += 1
          const text = await fs.readFile(full, 'utf8')
          if (/\bVITEST\b|PLAYWRIGHT|NODE_ENV|MINI_DSH_TEST|testBootstrap/.test(text)) offenders.push(path.relative(root, full))
        }
      }
    }
    await walk(root)
    expect(scanned).toBeGreaterThan(50)
    expect(offenders).toEqual([])
  })

  it('refuses a non-loopback bind because there is no authenticated TLS profile', async () => {
    home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-auth-'))
    await expect(createWebServer({
      home,
      configFile: path.join(home, 'providers.json'),
      host: '0.0.0.0',
      controlPlaneAuth: true,
      unsafeNetworkBind: true,
    })).rejects.toThrow(/authenticated TLS profile/)
  })

  it('rejects a Last-Event-ID from an older session generation before the stream opens', async () => {
    const live = await start()
    const code = live.auth.issuePairingCode().code
    const paired = await raw(live.url, 'POST', '/api/auth/pair', {
      'content-type': 'application/json',
    }, JSON.stringify({ code }))
    const sessionCookie = String(paired.headers['set-cookie']).split(';')[0] ?? ''
    const created = await raw(live.url, 'POST', '/api/workspaces', {
      cookie: sessionCookie,
      origin: live.auth.canonicalOrigin,
      'content-type': 'application/json',
      'x-mini-dsh-csrf': (JSON.parse(paired.body) as { csrf: string }).csrf,
    }, JSON.stringify({ name: 'Work' }))
    const wsId = (JSON.parse(created.body) as { id: string }).id
    const session = await raw(live.url, 'POST', `/api/workspaces/${wsId}/sessions`, {
      cookie: sessionCookie,
      origin: live.auth.canonicalOrigin,
      'content-type': 'application/json',
      'x-mini-dsh-csrf': (JSON.parse(paired.body) as { csrf: string }).csrf,
    }, '{}')
    expect(session.status).toBe(201)
    const sessionId = (JSON.parse(session.body) as { id: string }).id
    const stale = await raw(live.url, 'GET', `/api/workspaces/${wsId}/sessions/${sessionId}/events`, {
      cookie: sessionCookie,
      'last-event-id': 'gen=0',
    })
    expect(stale.status).toBe(401)
    expect(stale.headers['content-type']).toContain('application/json')
  })

  it('does not treat an approval id as a credential', async () => {
    const live = await start()
    const answered = await raw(live.url, 'POST', '/api/approvals/not-a-session', {
      'content-type': 'application/json',
    }, JSON.stringify({ allow: true }))
    expect(answered.status).toBe(401)
  })
})
