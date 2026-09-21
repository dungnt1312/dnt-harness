/**
 * The `Host` allowlist: a DNS-rebinding defence that applies to the whole
 * host, not just one route family.
 *
 * Binding to loopback does not stop a browser from reaching this server — an
 * attacker's name can resolve to 127.0.0.1, and the page then treats the
 * response as same-origin. What stops it is refusing `Host` values this
 * server does not answer to, which is why the check sits before routing and
 * covers static assets as well as the API.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWebServer, type WebServer } from 'mini-dsh'

let server: WebServer | undefined
let home = ''

afterEach(async () => {
  await server?.close()
  server = undefined
  if (home !== '') await fs.rm(home, { recursive: true, force: true })
  home = ''
})

async function start(extra: Partial<Parameters<typeof createWebServer>[0]> = {}): Promise<string> {
  home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-host-guard-'))
  server = await createWebServer({
    home,
    configFile: path.join(home, 'providers.json'),
    ...extra,
  })
  return server.url
}

/**
 * Request with an explicit `Host`, the way a rebound name would arrive.
 *
 * Raw `node:http`, not `fetch`: `Host` is a forbidden header name, so fetch
 * silently drops it and would send the real address instead — a test written
 * that way passes while proving nothing.
 */
async function withHost(
  baseUrl: string,
  pathname: string,
  host: string | null,
): Promise<{ status: number; body: string }> {
  const { request } = await import('node:http')
  const url = new URL(baseUrl)
  return new Promise((resolve, reject) => {
    const client = request(
      {
        host: url.hostname,
        port: url.port,
        path: pathname,
        method: 'GET',
        setHost: false,
        ...(host === null ? {} : { headers: { host } }),
      },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => { body += chunk })
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
      },
    )
    client.on('error', reject)
    client.end()
  })
}

describe('host allowlist', () => {
  it('serves the loopback names it is bound to', async () => {
    const baseUrl = await start()
    const port = new URL(baseUrl).port
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      expect((await withHost(baseUrl, '/api/workspaces', host)).status).toBe(200)
    }
  })

  it('refuses a rebound name, on the API and on the page itself', async () => {
    const baseUrl = await start()
    const port = new URL(baseUrl).port

    const api = await withHost(baseUrl, '/api/workspaces', `evil.example:${port}`)
    expect(api.status).toBe(403)
    expect(api.body).toMatch(/does not answer to/)

    // The page matters as much as the API: it is what would carry the script.
    expect((await withHost(baseUrl, '/', `evil.example:${port}`)).status).toBe(403)
  })

  it('answers to a name the operator explicitly allowed', async () => {
    const baseUrl = await start({ allowedHosts: ['dev.internal'] })
    const port = new URL(baseUrl).port
    expect((await withHost(baseUrl, '/api/workspaces', `dev.internal:${port}`)).status).toBe(200)
    expect((await withHost(baseUrl, '/api/workspaces', `other.internal:${port}`)).status).toBe(403)
  })

  it('refuses a request carrying no Host at all', async () => {
    const baseUrl = await start()
    // Node's own parser rejects a HTTP/1.1 request with no Host before the
    // handler sees it, so the refusal is a 400 rather than this guard's 403.
    // What matters is that it is refused, not which layer refuses it.
    expect((await withHost(baseUrl, '/api/workspaces', null)).status).toBe(400)
  })
})
