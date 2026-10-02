/**
 * Folder grants are standing pre-approvals, so with control-plane auth on
 * only the paired browser may change them: a bearer (CLI/headless) client is
 * refused on both the session grant route and a project's
 * `additionalDirectories`, and a refused project update applies nothing.
 */
import { promises as fs } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWebServer, type WebServer } from 'dnt-harness'

let server: WebServer | undefined
let base = ''

afterEach(async () => {
  await server?.close()
  server = undefined
  if (base !== '') await fs.rm(base, { recursive: true, force: true })
  base = ''
})

function raw(url: string, method: string, pathname: string, headers: Record<string, string> = {}, body?: unknown): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const target = new URL(url)
  const payload = body === undefined ? undefined : JSON.stringify(body)
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

describe('folder grants under control-plane auth', () => {
  it('only the paired browser can change session or project folder grants', async () => {
    base = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-grants-auth-')))
    const home = path.join(base, 'home')
    const primary = path.join(base, 'primary')
    const shared = path.join(base, 'shared')
    for (const dir of [home, primary, shared]) await fs.mkdir(dir, { recursive: true })
    server = await createWebServer({ home, configFile: path.join(home, 'providers.json'), controlPlaneAuth: true })
    const live = server

    const paired = await raw(live.url, 'POST', '/api/auth/pair', { origin: live.auth.canonicalOrigin }, { code: live.auth.issuePairingCode().code })
    const browser = {
      cookie: String(paired.headers['set-cookie']).split(';')[0] ?? '',
      origin: live.auth.canonicalOrigin,
      'x-dnt-harness-csrf': (JSON.parse(paired.body) as { csrf: string }).csrf,
    }
    const bearer = { authorization: `Bearer ${live.auth.issueBearer(['sessions']).token}` }

    const wsId = (JSON.parse((await raw(live.url, 'GET', '/api/workspaces', browser)).body) as { id: string }[])[0]!.id
    const projectId = (JSON.parse((await raw(live.url, 'POST', `/api/workspaces/${wsId}/projects`, browser, { name: 'Main', path: primary })).body) as { id: string }).id
    const sessionId = (JSON.parse((await raw(live.url, 'POST', `/api/workspaces/${wsId}/sessions`, browser, { projectId })).body) as { id: string }).id
    const grants = `/api/workspaces/${wsId}/sessions/${sessionId}/grants`
    const roots = [{ path: shared, access: 'write' }]

    // The bearer can reach the route family, but may not widen a session.
    expect((await raw(live.url, 'GET', grants, bearer)).status).toBe(200)
    expect((await raw(live.url, 'PUT', grants, bearer, { expectedRevision: 0, roots })).status).toBe(401)
    const project = `/api/workspaces/${wsId}/projects/${projectId}`
    const refused = await raw(live.url, 'PATCH', project, bearer, { name: 'Renamed', additionalDirectories: [{ kind: 'path', path: shared, access: 'read' }] })
    expect(refused.status).toBe(401)
    const listed = JSON.parse((await raw(live.url, 'GET', `/api/workspaces/${wsId}/projects`, browser)).body) as { id: string; name: string; additionalDirectories?: unknown }[]
    const record = listed.find((row) => row.id === projectId)
    expect(record?.name).toBe('Main')
    expect(record?.additionalDirectories).toBeUndefined()

    // The paired browser can.
    expect((await raw(live.url, 'PUT', grants, browser, { expectedRevision: 0, roots })).status).toBe(200)
    expect((await raw(live.url, 'PATCH', project, browser, { additionalDirectories: [{ kind: 'path', path: shared, access: 'read' }] })).status).toBe(200)
  })
})
