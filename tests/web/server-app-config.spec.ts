/**
 * Global configuration API: a thin HTTP adapter over the app-config service.
 * Reads describe the disk and the active snapshot; edits are hash-checked
 * field batches; reload republishes a manual edit; errors map to statuses.
 */
import { promises as fs } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWebServer, type WebServer, type WebServerOptions } from 'dnt-harness'
import type { AppConfigService } from '../../src/harness/config/service.ts'
import type { AppConfigView } from '../../src/harness/config/types.ts'
import { DEFAULT_LIMITS } from '../../src/harness/limits.ts'
import { handleAppConfigApi } from '../../src/web/app-config-api.ts'

const servers: WebServer[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close().catch(() => {})
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
})

async function tempHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-app-config-api-'))
  dirs.push(dir)
  return dir
}

async function start(home: string, extra: Partial<WebServerOptions> = {}): Promise<WebServer> {
  const server = await createWebServer({ home, configFile: path.join(home, 'providers.json'), ...extra })
  servers.push(server)
  return server
}

async function stop(server: WebServer): Promise<void> {
  servers.splice(servers.indexOf(server), 1)
  await server.close()
}

function call(server: WebServer, method: string, route: string, body?: unknown): Promise<Response> {
  return fetch(`${server.url}${route}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })
}

async function view(server: WebServer): Promise<AppConfigView> {
  const response = await call(server, 'GET', '/api/app-config')
  expect(response.status).toBe(200)
  return (await response.json()) as AppConfigView
}

function configFile(home: string): string {
  return path.join(home, 'app-config.json')
}

describe('handleAppConfigApi', () => {
  it('declines routes it does not own without touching the request or service', async () => {
    const send = vi.fn()
    const readJson = vi.fn(async () => ({}))
    const service = {} as AppConfigService
    const req = { method: 'GET' } as IncomingMessage
    for (const pathname of ['/api/app-configs', '/api/app-config/', '/api/app-config/reload/x', '/api/model-defaults']) {
      expect(await handleAppConfigApi(req, pathname, service, send, readJson)).toBe(false)
    }
    expect(send).not.toHaveBeenCalled()
    expect(readJson).not.toHaveBeenCalled()
  })

  it('maps an unexpected service failure to 500', async () => {
    const send = vi.fn()
    const service = { describe: async () => { throw new Error('app-config service is not booted') } } as unknown as AppConfigService
    expect(await handleAppConfigApi({ method: 'GET' } as IncomingMessage, '/api/app-config', service, send, async () => ({}))).toBe(true)
    expect(send).toHaveBeenCalledWith(500, { error: 'app-config service is not booted' })
  })
})

describe('global configuration API', () => {
  it('describes fields, hash, the active revision and native defaults', async () => {
    const server = await start(await tempHome())
    const described = await view(server)
    expect(described.document).toEqual({ v: 1 })
    expect(typeof described.hash).toBe('string')
    expect(described.active.revision).toBe(0)
    expect(described.inherited.toolTimeoutMs).toBe(DEFAULT_LIMITS.toolTimeoutMs)
    const field = described.fields.find((entry) => entry.key === 'toolTimeoutMs')
    expect(field).toMatchObject({ unit: 'ms', source: 'library', locked: false, shadowed: false })
    expect(field?.fileValue).toBeUndefined()
    expect(described.outOfSync).toBe(false)
  })

  it('saves only the edited override, keeps it across restart, and resets it', async () => {
    const home = await tempHome()
    const first = await start(home)
    const before = await view(first)
    const saved = await call(first, 'PATCH', '/api/app-config', {
      expectedHash: before.hash,
      edits: [{ op: 'set', key: 'toolTimeoutMs', value: 300_000 }],
    })
    expect(saved.status).toBe(200)
    const afterSave = (await saved.json()) as AppConfigView
    expect(afterSave.document).toEqual({ v: 1, limits: { toolTimeoutMs: 300_000 } })
    expect(afterSave.active.revision).toBe(1)
    expect(afterSave.active.values.toolTimeoutMs).toBe(300_000)
    expect(JSON.parse(await fs.readFile(configFile(home), 'utf8'))).toEqual({ v: 1, limits: { toolTimeoutMs: 300_000 } })
    await stop(first)

    const second = await start(home)
    const restarted = await view(second)
    expect(restarted.document).toEqual({ v: 1, limits: { toolTimeoutMs: 300_000 } })
    expect(restarted.active.values.toolTimeoutMs).toBe(300_000)
    expect(restarted.fields.find((entry) => entry.key === 'toolTimeoutMs')).toMatchObject({ source: 'file', fileValue: 300_000 })

    const reset = await call(second, 'PATCH', '/api/app-config', {
      expectedHash: restarted.hash,
      edits: [{ op: 'unset', key: 'toolTimeoutMs' }],
    })
    expect(reset.status).toBe(200)
    const afterReset = (await reset.json()) as AppConfigView
    expect(afterReset.document).toEqual({ v: 1 })
    expect(afterReset.active.values.toolTimeoutMs).toBe(DEFAULT_LIMITS.toolTimeoutMs)
    expect(JSON.parse(await fs.readFile(configFile(home), 'utf8'))).toEqual({ v: 1 })
  })

  it('refuses a stale hash with 409', async () => {
    const server = await start(await tempHome())
    const before = await view(server)
    const edits = [{ op: 'set', key: 'toolTimeoutMs', value: 300_000 }]
    expect((await call(server, 'PATCH', '/api/app-config', { expectedHash: before.hash, edits })).status).toBe(200)
    const stale = await call(server, 'PATCH', '/api/app-config', { expectedHash: before.hash, edits: [{ op: 'unset', key: 'toolTimeoutMs' }] })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ code: 'conflict' })
    expect((await view(server)).document).toEqual({ v: 1, limits: { toolTimeoutMs: 300_000 } })
  })

  it('refuses an edit to a locked field with 409 naming the key', async () => {
    const server = await start(await tempHome(), { limits: { toolTimeoutMs: 1_000 } })
    const before = await view(server)
    const locked = await call(server, 'PATCH', '/api/app-config', {
      expectedHash: before.hash,
      edits: [{ op: 'set', key: 'toolTimeoutMs', value: 300_000 }],
    })
    expect(locked.status).toBe(409)
    expect(await locked.json()).toMatchObject({ code: 'locked', key: 'toolTimeoutMs' })
  })

  it('rejects invalid keys, values and request shapes with 400', async () => {
    const home = await tempHome()
    const server = await start(home)
    const { hash } = await view(server)
    const bodies: unknown[] = [
      { expectedHash: hash, edits: [{ op: 'set', key: 'notALimit', value: 1 }] },
      { expectedHash: hash, edits: [{ op: 'set', key: 'toolTimeoutMs', value: -1 }] },
      { expectedHash: hash, edits: [{ op: 'set', key: 'toolTimeoutMs', value: '300000' }] },
      { expectedHash: hash, edits: [] },
      { expectedHash: hash, edits: { op: 'unset', key: 'toolTimeoutMs' } },
      { edits: [{ op: 'unset', key: 'toolTimeoutMs' }] },
      { expectedHash: 7, edits: [{ op: 'unset', key: 'toolTimeoutMs' }] },
      { expectedHash: hash, edits: [{ op: 'unset', key: 'toolTimeoutMs' }], extra: true },
      '{not json',
      '[1]',
    ]
    for (const body of bodies) {
      const response = await call(server, 'PATCH', '/api/app-config', body)
      expect(response.status, JSON.stringify(body)).toBe(400)
    }
    const reloadWithKeys = await call(server, 'POST', '/api/app-config/reload', { force: true })
    expect(reloadWithKeys.status).toBe(400)
    await expect(fs.access(configFile(home))).rejects.toThrow()
    expect((await view(server)).active.revision).toBe(0)
  })

  it('keeps the last good snapshot on an invalid reload and refuses edits until the file is repaired', async () => {
    const home = await tempHome()
    const server = await start(home)
    await fs.writeFile(configFile(home), '{"v":1,"limits":{"toolTimeoutMs":-5}}', 'utf8')

    const reload = await call(server, 'POST', '/api/app-config/reload', {})
    expect(reload.status).toBe(400)
    expect(await reload.json()).toMatchObject({ code: 'invalid' })

    const described = await view(server)
    expect(described.document).toBeNull()
    expect(described.hash).toBeNull()
    expect(typeof described.error).toBe('string')
    expect(described.active.revision).toBe(0)
    expect(described.active.values.toolTimeoutMs).toBe(DEFAULT_LIMITS.toolTimeoutMs)

    const refused = await call(server, 'PATCH', '/api/app-config', {
      expectedHash: 'anything',
      edits: [{ op: 'set', key: 'toolTimeoutMs', value: 300_000 }],
    })
    expect(refused.status).toBe(400)

    await fs.writeFile(configFile(home), '{"v":1}', 'utf8')
    const repaired = await view(server)
    const saved = await call(server, 'PATCH', '/api/app-config', {
      expectedHash: repaired.hash,
      edits: [{ op: 'set', key: 'toolTimeoutMs', value: 300_000 }],
    })
    expect(saved.status).toBe(200)
  })

  it('publishes a valid manual edit on reload once; a repeated reload is a no-op', async () => {
    const home = await tempHome()
    const server = await start(home)
    await fs.writeFile(configFile(home), '{"v":1,"limits":{"toolTimeoutMs":200000}}', 'utf8')
    expect((await view(server)).outOfSync).toBe(true)

    const first = await call(server, 'POST', '/api/app-config/reload', {})
    expect(first.status).toBe(200)
    const reloaded = (await first.json()) as AppConfigView
    expect(reloaded.active.revision).toBe(1)
    expect(reloaded.active.values.toolTimeoutMs).toBe(200_000)
    expect(reloaded.outOfSync).toBe(false)

    const again = await call(server, 'POST', '/api/app-config/reload')
    expect(again.status).toBe(200)
    expect(((await again.json()) as AppConfigView).active.revision).toBe(1)
  })

  it('maps disk read and write failures to 500 without changing the active snapshot', async () => {
    const home = await tempHome()
    const failures = { read: false, write: false }
    const server = await start(home, {
      appConfigIo: {
        read: async (file) => {
          if (failures.read) throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
          return fs.readFile(file, 'utf8')
        },
        write: async (file, content) => {
          if (failures.write) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
          await fs.writeFile(file, content, 'utf8')
        },
      },
    })
    const before = await view(server)

    failures.write = true
    const write = await call(server, 'PATCH', '/api/app-config', {
      expectedHash: before.hash,
      edits: [{ op: 'set', key: 'toolTimeoutMs', value: 300_000 }],
    })
    expect(write.status).toBe(500)
    expect(await write.json()).toMatchObject({ code: 'io' })
    failures.write = false

    failures.read = true
    expect((await call(server, 'GET', '/api/app-config')).status).toBe(500)
    expect((await call(server, 'POST', '/api/app-config/reload', {})).status).toBe(500)
    failures.read = false

    const after = await view(server)
    expect(after.document).toEqual({ v: 1 })
    expect(after.active).toEqual(before.active)
  })

  it('answers other methods on its routes with 405', async () => {
    const server = await start(await tempHome())
    expect((await call(server, 'GET', '/api/app-config/reload')).status).toBe(405)
    expect((await call(server, 'DELETE', '/api/app-config')).status).toBe(405)
    expect((await call(server, 'PUT', '/api/app-config', {})).status).toBe(405)
    expect((await call(server, 'POST', '/api/app-config', {})).status).toBe(405)
  })
})
