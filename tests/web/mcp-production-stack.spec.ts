/**
 * Real HTTP stack: default-deny, save does not activate, one stdio dispatch.
 */
import { promises as fs } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createWebServer, type WebServer } from 'dnt-harness'

let server: WebServer | undefined
let home = ''
const fixture = fileURLToPath(new URL('../fixtures/mcp-stdio-server.mjs', import.meta.url))

afterEach(async () => {
  await server?.close()
  server = undefined
  if (home !== '') await fs.rm(home, { recursive: true, force: true })
  home = ''
})

function raw(base: string, method: string, pathname: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  const url = new URL(base)
  return new Promise((resolve, reject) => {
    const client = httpRequest({ host: url.hostname, port: url.port, path: pathname, method, headers }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { text += chunk })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text, headers: response.headers }))
    })
    client.on('error', reject)
    if (body !== undefined) client.write(body)
    client.end()
  })
}

describe('mcp production stack', () => {
  it('refuses a second host on the same data home', async () => {
    home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-stack-'))
    server = await createWebServer({ home, configFile: path.join(home, 'providers.json') })
    await expect(createWebServer({ home, configFile: path.join(home, 'providers.json') })).rejects.toThrow(/live owner/)
  })

  it('keeps a saved server disabled until enable, then serves one stdio call', async () => {
    home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-stack-'))
    const countFile = path.join(home, 'calls.txt')
    server = await createWebServer({ home, configFile: path.join(home, 'providers.json'), controlPlaneAuth: true })
    const denied = await raw(server.url, 'GET', '/api/workspaces')
    expect(denied.status).toBe(401)
    const code = server.auth.issuePairingCode().code
    const paired = await raw(server.url, 'POST', '/api/auth/pair', { 'content-type': 'application/json', origin: server.auth.canonicalOrigin }, JSON.stringify({ code }))
    expect(paired.status).toBe(200)
    const cookie = String(paired.headers['set-cookie']).split(';')[0] ?? ''
    const csrf = (JSON.parse(paired.body) as { csrf: string }).csrf
    const headers = { cookie, origin: server.auth.canonicalOrigin, 'content-type': 'application/json', 'x-dnt-harness-csrf': csrf }
    const created = await raw(server.url, 'POST', '/api/workspaces', headers, JSON.stringify({ name: 'Work' }))
    expect(created.status).toBe(201)
    const wsId = (JSON.parse(created.body) as { id: string }).id
    const saved = await raw(server.url, 'POST', `/api/workspaces/${wsId}/mcp/fixture`, headers, JSON.stringify({
      transport: 'stdio', command: process.execPath, args: [fixture], env: { CALL_COUNT_FILE: countFile }, enabled: true,
    }))
    expect(saved.status).toBe(201)
    expect(JSON.parse(saved.body)).toMatchObject({ enabled: false, activated: false })
    const listed = await raw(server.url, 'GET', `/api/workspaces/${wsId}/mcp`, { cookie })
    const rows = JSON.parse(listed.body) as { name: string; enabled: boolean; auditFault: boolean; containment: string; discoveredTools: string[] }[]
    expect(rows.find((row) => row.name === 'fixture')).toMatchObject({ enabled: false, auditFault: false, discoveredTools: [] })
    expect(rows.find((row) => row.name === 'fixture')?.containment).toContain('not a sandbox')
    const revision = (rows.find((row) => row.name === 'fixture') as { revision?: string }).revision ?? ''
    const conflict = await raw(server.url, 'POST', `/api/workspaces/${wsId}/mcp/fixture`, headers, JSON.stringify({
      transport: 'stdio', command: process.execPath, args: [fixture], expectedRevision: 'stale-revision',
    }))
    expect(conflict.status).toBe(409)
    const tested = await raw(server.url, 'POST', `/api/workspaces/${wsId}/mcp/fixture/test`, headers, '{}')
    expect(tested.status).toBe(200)
    const testBody = JSON.parse(tested.body) as { published: boolean; enabled: boolean; tools: string[] }
    expect(testBody).toMatchObject({ published: false, enabled: false })
    expect(testBody.tools).toContain('query')
    const file = path.join(home, 'workspaces', wsId, 'mcp.json')
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as { servers: { fixture: { timeoutMs?: number } } }
    parsed.servers.fixture.timeoutMs = 12345
    await fs.writeFile(file, JSON.stringify(parsed))
    const current = JSON.parse((await raw(server.url, 'GET', `/api/workspaces/${wsId}/mcp`, { cookie })).body) as { stale?: boolean; revision?: string }[]
    // mcp.json is an operator-owned config file. A valid direct edit fences the
    // old runtime and becomes the next desired state without a Settings-only
    // acknowledgement step.
    expect(current[0]?.stale).toBe(false)
    expect(current[0]?.revision).not.toBe(revision)
    const enabled = await raw(server.url, 'POST', `/api/workspaces/${wsId}/mcp/fixture/enable`, headers, '{}')
    expect(enabled.status).toBe(200)
    await server.close()
    server = undefined
  }, 30_000)
})
