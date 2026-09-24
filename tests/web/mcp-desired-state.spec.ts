/**
 * MCP desired-state writes: config and secrets share one per-workspace write
 * queue, so concurrent saves cannot silently erase one another, and a crash
 * between a multi-file write's intent and its commit restores every file.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWebServer, McpConfigStore, type WebServer } from 'mini-dsh'
import { MutationStore } from '../../src/harness/mcp/mutation-store.ts'

let server: WebServer | undefined
let home = ''

afterEach(async () => {
  await server?.close()
  server = undefined
  if (home !== '') await fs.rm(home, { recursive: true, force: true })
  home = ''
})

async function boot(): Promise<{ base: string; wsId: string }> {
  home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-desired-state-'))
  server = await createWebServer({ home, configFile: path.join(home, 'providers.json') })
  const base = server.url
  const wsId = ((await (await fetch(`${base}/api/workspaces`)).json()) as { id: string }[])[0]!.id
  return { base, wsId }
}

function send(base: string, method: string, pathname: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${pathname}`, {
    method,
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })
}

describe('MCP desired-state writes', () => {
  it('keeps every secret when many are saved at once', async () => {
    const { base, wsId } = await boot()
    const keys = Array.from({ length: 10 }, (_, index) => `KEY_${index}`)
    const results = await Promise.all(keys.map((key) => send(base, 'PUT', `/api/workspaces/${wsId}/secrets/${key}`, { value: `value-${key}` })))
    expect(results.map((response) => response.status)).toEqual(keys.map(() => 200))
    const listed = (await (await fetch(`${base}/api/workspaces/${wsId}/secrets`)).json()) as { name: string }[]
    expect(listed.map((row) => row.name).sort()).toEqual([...keys].sort())

    // A delete racing saves removes only its own key.
    await Promise.all([
      send(base, 'DELETE', `/api/workspaces/${wsId}/secrets/KEY_0`),
      send(base, 'PUT', `/api/workspaces/${wsId}/secrets/KEY_10`, { value: 'late' }),
    ])
    const after = ((await (await fetch(`${base}/api/workspaces/${wsId}/secrets`)).json()) as { name: string }[]).map((row) => row.name)
    expect(after).not.toContain('KEY_0')
    expect(after).toContain('KEY_10')
    expect(after).toContain('KEY_9')
  })

  it('keeps every server when concurrent saves, disables, and deletes interleave', async () => {
    const { base, wsId } = await boot()
    const server = (name: string) => ({ transport: 'stdio', command: process.execPath, args: [`${name}.mjs`], enabled: false })
    const names = Array.from({ length: 8 }, (_, index) => `s${index}`)
    const saved = await Promise.all(names.map((name) => send(base, 'POST', `/api/workspaces/${wsId}/mcp/${name}`, server(name))))
    expect(saved.map((response) => response.status)).toEqual(names.map(() => 201))

    await Promise.all([
      send(base, 'DELETE', `/api/workspaces/${wsId}/mcp/s0`),
      send(base, 'POST', `/api/workspaces/${wsId}/mcp/s1/disable`),
      send(base, 'POST', `/api/workspaces/${wsId}/mcp/extra`, server('extra')),
    ])
    const rows = (await (await fetch(`${base}/api/workspaces/${wsId}/mcp`)).json()) as { name: string }[]
    expect(rows.map((row) => row.name).sort()).toEqual(['extra', 's1', 's2', 's3', 's4', 's5', 's6', 's7'])
  })

  it('refuses a save whose revision went stale while it waited for its turn', async () => {
    const { base, wsId } = await boot()
    const initial = (await (await send(base, 'POST', `/api/workspaces/${wsId}/mcp/a`, { transport: 'stdio', command: process.execPath, enabled: false })).json()) as unknown
    void initial
    const rows = (await (await fetch(`${base}/api/workspaces/${wsId}/mcp`)).json()) as { revision: string }[]
    const revision = rows[0]!.revision
    const [first, second] = await Promise.all([
      send(base, 'POST', `/api/workspaces/${wsId}/mcp/a`, { transport: 'stdio', command: process.execPath, args: ['one'], enabled: false, expectedRevision: revision }),
      send(base, 'POST', `/api/workspaces/${wsId}/mcp/a`, { transport: 'stdio', command: process.execPath, args: ['two'], enabled: false, expectedRevision: revision }),
    ])
    expect([first.status, second.status].sort()).toEqual([201, 409])
  })
})

describe('desired-state crash recovery', () => {
  it('restores config and secrets together when a crash leaves both intents open', async () => {
    home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-desired-crash-'))
    const store = new McpConfigStore(home)
    const configFile = store.mcpPath('ws')
    const secretsFile = store.secretsPath('ws')
    await fs.mkdir(path.dirname(configFile), { recursive: true })
    await fs.writeFile(configFile, 'config-before')
    await fs.writeFile(secretsFile, 'secrets-before')

    const crashed = new MutationStore(home)
    await crashed.begin({ mutation: 'config', workspaceId: 'ws', target: configFile, backup: Buffer.from('config-before') })
    await fs.writeFile(configFile, 'config-half-written')
    await crashed.begin({ mutation: 'secrets', workspaceId: 'ws', target: secretsFile, backup: Buffer.from('secrets-before') })
    await fs.writeFile(secretsFile, 'secrets-half-written')
    // The host dies here: neither intent reaches commit.

    const restarted = new MutationStore(home)
    expect(await restarted.recover()).toHaveLength(2)
    expect(await fs.readFile(configFile, 'utf8')).toBe('config-before')
    expect(await fs.readFile(secretsFile, 'utf8')).toBe('secrets-before')
    // Recovery is idempotent: a second restart restores nothing more.
    expect(await new MutationStore(home).recover()).toHaveLength(0)
  })

  it('keeps a committed write and rolls back only the one left open', async () => {
    home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-desired-crash-'))
    const configFile = path.join(home, 'workspaces', 'ws', 'mcp.json')
    const secretsFile = path.join(home, 'workspaces', 'ws', 'secrets.json')
    await fs.mkdir(path.dirname(configFile), { recursive: true })

    const crashed = new MutationStore(home)
    const committed = await crashed.begin({ mutation: 'config', workspaceId: 'ws', target: configFile, backup: undefined })
    await fs.writeFile(configFile, 'config-after')
    await crashed.commit(committed)
    await crashed.begin({ mutation: 'secrets', workspaceId: 'ws', target: secretsFile, backup: undefined })
    await fs.writeFile(secretsFile, 'secrets-orphan')

    await new MutationStore(home).recover()
    expect(await fs.readFile(configFile, 'utf8')).toBe('config-after')
    await expect(fs.stat(secretsFile)).rejects.toThrow()
  })
})
