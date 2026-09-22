import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWebServer, type WebServer } from 'mini-dsh'
import { DEFAULT_CONFIG } from '../../src/harness/guard/defaults.ts'

let home = ''
const servers: WebServer[] = []

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-guard-web-'))
})

afterAll(async () => {
  for (const s of servers) await s.close().catch(() => {})
  await fs.rm(home, { recursive: true, force: true })
})

async function start(): Promise<WebServer> {
  const h = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-guard-home-'))
  const server = await createWebServer({ home: h, providers: [], configFile: path.join(h, 'providers.json') })
  servers.push(server)
  return server
}

async function wsId(server: WebServer): Promise<string> {
  const rows = (await (await fetch(`${server.url}/api/workspaces`)).json()) as { id: string }[]
  return rows[0]!.id
}

describe('guard REST API', () => {
  it('GET workspace returns default config + hash and PUT round-trips', async () => {
    const server = await start()
    const wid = await wsId(server)

    // GET default
    let res = await fetch(`${server.url}/api/guard/dangerous-commands?workspaceId=${wid}`)
    expect(res.status).toBe(200)
    let body = (await res.json()) as { config: typeof DEFAULT_CONFIG; hash: string }
    expect(body.config.v).toBe(1)
    expect(body.hash).toMatch(/^[0-9a-f]{64}$/)
    const hash0 = body.hash

    // PUT modified
    const modified = { ...DEFAULT_CONFIG, presets: { ...DEFAULT_CONFIG.presets, fsDestructive: 'off' as const } }
    res = await fetch(`${server.url}/api/guard/dangerous-commands`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: wid, config: modified }),
    })
    expect(res.status).toBe(200)
    body = (await res.json()) as { config: typeof DEFAULT_CONFIG; hash: string }
    expect(body.config.presets.fsDestructive).toBe('off')
    expect(body.hash).not.toBe(hash0)

    // GET again reflects saved
    res = await fetch(`${server.url}/api/guard/dangerous-commands?workspaceId=${wid}`)
    body = (await res.json()) as { config: typeof DEFAULT_CONFIG; hash: string }
    expect(body.config.presets.fsDestructive).toBe('off')
  })

  it('PUT workspace 409 on stale hash', async () => {
    const server = await start()
    const wid = await wsId(server)
    const first = (await (await fetch(`${server.url}/api/guard/dangerous-commands?workspaceId=${wid}`)).json()) as { hash: string }
    const cfg = { ...DEFAULT_CONFIG, presets: { ...DEFAULT_CONFIG.presets, fsDestructive: 'off' as const } }
    let res = await fetch(`${server.url}/api/guard/dangerous-commands`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: wid, config: cfg, expectedHash: first.hash }),
    })
    expect(res.status).toBe(200)
    // stale hash
    res = await fetch(`${server.url}/api/guard/dangerous-commands`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: wid, config: DEFAULT_CONFIG, expectedHash: first.hash }),
    })
    expect(res.status).toBe(409)
  })

  it('PUT workspace 400 on invalid regex', async () => {
    const server = await start()
    const wid = await wsId(server)
    const bad = {
      ...DEFAULT_CONFIG,
      customRules: [{ id: 'cr-1', pattern: '[', isRegex: true, action: 'deny' as const }],
    }
    const res = await fetch(`${server.url}/api/guard/dangerous-commands`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: wid, config: bad }),
    })
    expect(res.status).toBe(400)
  })

  it('GET/PUT global round-trips and 409 on stale hash', async () => {
    const server = await start()

    let res = await fetch(`${server.url}/api/guard/dangerous-commands/global`)
    expect(res.status).toBe(200)
    let body = (await res.json()) as { config: typeof DEFAULT_CONFIG; hash: string }
    const hash0 = body.hash

    const modified = { ...DEFAULT_CONFIG, presets: { ...DEFAULT_CONFIG.presets, systemPriv: 'off' as const } }
    res = await fetch(`${server.url}/api/guard/dangerous-commands/global`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: modified, expectedHash: hash0 }),
    })
    expect(res.status).toBe(200)
    body = (await res.json()) as { config: typeof DEFAULT_CONFIG; hash: string }
    expect(body.config.presets.systemPriv).toBe('off')

    // stale hash conflict
    res = await fetch(`${server.url}/api/guard/dangerous-commands/global`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: DEFAULT_CONFIG, expectedHash: hash0 }),
    })
    expect(res.status).toBe(409)
  })

  it('400 on invalid regex for global PUT', async () => {
    const server = await start()
    const bad = {
      ...DEFAULT_CONFIG,
      customRules: [{ id: 'cr-1', pattern: '[', isRegex: true, action: 'deny' as const }],
    }
    const res = await fetch(`${server.url}/api/guard/dangerous-commands/global`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: bad }),
    })
    expect(res.status).toBe(400)
  })

  it('404 on unknown workspace', async () => {
    const server = await start()
    const res = await fetch(`${server.url}/api/guard/dangerous-commands?workspaceId=does-not-exist-zzz`)
    expect(res.status).toBe(404)
    const res2 = await fetch(`${server.url}/api/guard/dangerous-commands`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'does-not-exist-zzz', config: DEFAULT_CONFIG }),
    })
    expect(res2.status).toBe(404)
  })

  it('400 on empty pattern and unknown preset', async () => {
    const server = await start()
    const wid = await wsId(server)
    const emptyPattern = {
      ...DEFAULT_CONFIG,
      customRules: [{ id: 'cr-1', pattern: '', isRegex: false, action: 'deny' as const }],
    }
    let res = await fetch(`${server.url}/api/guard/dangerous-commands`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: wid, config: emptyPattern }),
    })
    expect(res.status).toBe(400)

    const unknownPreset = {
      v: 1 as const,
      presets: { ...(DEFAULT_CONFIG.presets as Record<string, string>), unknownPreset: 'deny' } as unknown as typeof DEFAULT_CONFIG.presets,
      customRules: [],
    }
    res = await fetch(`${server.url}/api/guard/dangerous-commands`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: wid, config: unknownPreset }),
    })
    expect(res.status).toBe(400)
  })

  it('400 when workspaceId missing on GET/PUT', async () => {
    const server = await start()
    let res = await fetch(`${server.url}/api/guard/dangerous-commands`)
    expect(res.status).toBe(400)
    res = await fetch(`${server.url}/api/guard/dangerous-commands`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: DEFAULT_CONFIG }),
    })
    expect(res.status).toBe(400)
  })
})
