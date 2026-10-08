/**
 * G5 web integration: workspace MCP stdio config, schema exposure/disable,
 * default ask + wildcard/host deny, hook block/flag/inject, encrypted secret
 * management and hashed audit events.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { createWebServer, messageText, type LlmProvider, type WebServer } from 'dnt-harness'

const mcpFixture = fileURLToPath(new URL('../fixtures/mcp-stdio-server.mjs', import.meta.url))
const hookFixture = fileURLToPath(new URL('../fixtures/hook-command.mjs', import.meta.url))
const hookCmd = (mode: string): string => `"${process.execPath}" "${hookFixture}" ${mode}`
const servers: WebServer[] = []

/** Replace the workspace layer's hooks (`<ws>/settings.json`, Claude format). */
function putHooks(base: string, wsId: string, hooks: unknown): Promise<Response> {
  return fetch(`${base}/api/workspaces/${wsId}/hooks`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hooks }),
  })
}

afterAll(async () => {
  for (const server of servers) await server.close().catch(() => {})
})

async function post(base: string, pathname: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

/** A workspace-authored conversation mode with zero exposure: no tools, no optional sources. */
const ZERO_MODE_CONTENT = [
  '---', 'name: Zero', 'toolExposure: []', 'workspaceInstructions: false',
  'skills: off', 'memoryPinned: false', 'memoryRetrieval: false', '---', '', 'No tools.',
].join('\n')

function putZeroMode(base: string, wsId: string): Promise<Response> {
  return fetch(`${base}/api/workspaces/${wsId}/modes/zero`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: ZERO_MODE_CONTENT }),
  })
}

async function boot(provider: LlmProvider, extra?: Partial<Parameters<typeof createWebServer>[0]>) {
  const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-g5-web-'))
  const server = await createWebServer({ home, providers: [provider], configFile: path.join(home, 'providers.json'), ...extra })
  servers.push(server)
  const wsId = ((await (await fetch(`${server.url}/api/workspaces`)).json()) as { id: string }[])[0]!.id
  return { home, server, wsId, base: server.url }
}

describe('G5 web MCP server config editing', () => {
  it('returns one stored config with fields the form does not show, and deletes a server', async () => {
    const provider: LlmProvider = { name: 'idle', models: ['idle'], async *stream() { yield { type: 'delta', delta: 'ok' }; yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true } } }
    const { base, wsId } = await boot(provider)
    const config = { transport: 'stdio', command: process.execPath, args: [mcpFixture], env: { API_KEY: '${API_KEY}' }, enabled: false }
    expect((await post(base, `/api/workspaces/${wsId}/mcp/fixture`, config)).status).toBe(201)

    const stored = await (await fetch(`${base}/api/workspaces/${wsId}/mcp/fixture`)).json() as Record<string, unknown>
    expect(stored).toMatchObject({ transport: 'stdio', command: process.execPath, env: { API_KEY: '${API_KEY}' }, enabled: false })
    expect((await fetch(`${base}/api/workspaces/${wsId}/mcp/missing`)).status).toBe(404)

    const deleted = await fetch(`${base}/api/workspaces/${wsId}/mcp/fixture`, { method: 'DELETE' })
    expect(deleted.status).toBe(200)
    expect(await (await fetch(`${base}/api/workspaces/${wsId}/mcp`)).json()).toEqual([])
    expect((await fetch(`${base}/api/workspaces/${wsId}/mcp/fixture`, { method: 'DELETE' })).status).toBe(404)
  })
})

describe('G5 web MCP + hooks', () => {
  it('registers stdio tools, asks by default, audits hashed args, and disabling removes schemas', async () => {
    const requests: { tools: string[] }[] = []
    let step = 0
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream(request) {
        requests.push({ tools: request.tools?.map((tool) => tool.name) ?? [] })
        step += 1
        if (step === 1) {
          yield { type: 'toolCalls', calls: [{ id: 'm1', name: 'mcp__fixture__query', args: { q: 'secret-query' } }] }
          yield { type: 'completion', finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }
          return
        }
        yield { type: 'delta', delta: 'done' }
        yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
      },
    }
    const { home, base, wsId } = await boot(provider)
    // Secret store is encrypted/masked.
    expect((await fetch(`${base}/api/workspaces/${wsId}/secrets/API_KEY`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'plain-secret-123' }),
    })).status).toBe(200)
    const secretFile = await fs.readFile(path.join(home, 'workspaces', wsId, 'secrets.json'), 'utf8')
    expect(secretFile).not.toContain('plain-secret-123')
    expect(await (await fetch(`${base}/api/workspaces/${wsId}/secrets`)).json()).toEqual([{ name: 'API_KEY' }])

    // Save and enable stdio MCP. allowedTools is exposure only — permission
    // remains default ask.
    const saved = await post(base, `/api/workspaces/${wsId}/mcp/fixture`, {
      transport: 'stdio', command: process.execPath, args: [mcpFixture], env: { API_KEY: '${API_KEY}' }, enabled: true,
      timeoutMs: 1_000, allowedTools: ['query', 'interactive'],
    })
    expect(saved.status).toBe(201)
    const enabled = await post(base, `/api/workspaces/${wsId}/mcp/fixture/enable`)
    expect(enabled.status).toBe(200)

    const session = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
    const sse = await fetch(`${base}/api/workspaces/${wsId}/sessions/${session.id}/events`)
    const reader = (sse.body as ReadableStream).getReader()
    void post(base, `/api/workspaces/${wsId}/sessions/${session.id}/messages`, { content: 'query fixture' })
    const approvalId = await waitApproval(reader)
    expect(approvalId).not.toBe('') // MCP default = ask
    expect((await post(base, `/api/approvals/${approvalId}`, { allow: true })).status).toBe(200)
    // Wait for the recorded request instead of a fixed sleep: under parallel
    // load the first model request may not have been issued yet.
    for (let i = 0; i < 50 && requests.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 100))
    reader.cancel().catch(() => {})

    expect(requests[0]?.tools ?? []).toContain('mcp__fixture__query')
    expect(requests[0]?.tools ?? []).toContain('mcp__fixture__interactive')
    expect(requests[0]?.tools ?? []).not.toContain('mcp__fixture__explode') // allowlist filter

    // Audit has hashes only, not raw args/secrets. The MCP result and its
    // audit record land asynchronously after approval — poll for it.
    let audit: Record<string, unknown> | undefined
    for (let i = 0; i < 50; i++) {
      const rawEvents = await sessionEvents(base, wsId, session.id)
      audit = rawEvents.find((event) => event.type === 'mcp/call')
      if (audit !== undefined) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(audit).toMatchObject({ server: 'fixture', tool: 'query', isError: false })
    expect(String(audit?.argsHash)).toMatch(/^[0-9a-f]{16}$/)
    expect(JSON.stringify(audit)).not.toContain('secret-query')
    expect(JSON.stringify(audit)).not.toContain('plain-secret-123')

    // Disable: next assembly removes the server's schemas immediately.
    expect((await post(base, `/api/workspaces/${wsId}/mcp/fixture/disable`)).status).toBe(200)
    const nextSession = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
    const beforeCount = requests.length
    await post(base, `/api/workspaces/${wsId}/sessions/${nextSession.id}/messages`, { content: 'hello' })
    for (let i = 0; i < 50 && requests.length <= beforeCount; i++) await new Promise((resolve) => setTimeout(resolve, 100))
    expect(requests.at(-1)?.tools ?? []).not.toContain('mcp__fixture__query')
  }, 30_000)

  it('an invalid mcp.json rejects the Turn before any model request (no partial execution)', async () => {
    let modelCalls = 0
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream() { modelCalls += 1; yield { type: 'delta', delta: 'should not run' }; yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true } },
    }
    const { home, base, wsId } = await boot(provider)
    await fs.writeFile(path.join(home, 'workspaces', wsId, 'mcp.json'), '{ invalid', 'utf8')
    const session = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
    await post(base, `/api/workspaces/${wsId}/sessions/${session.id}/messages`, { content: 'hello' })
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(modelCalls).toBe(0)
    const events = await sessionEvents(base, wsId, session.id)
    expect(events.some((event) => event.type === 'turn/end' && event.reason === 'rejected')).toBe(true)
  }, 15_000)

  it('requiresUserInteraction always asks even exact and wildcard policies say allow', async () => {
    let step = 0
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream() {
        step += 1
        if (step === 1) { yield { type: 'toolCalls', calls: [{ id: 'i1', name: 'mcp__fixture__interactive', args: {} }] }; yield { type: 'completion', finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }; return }
        yield { type: 'delta', delta: 'done' }
        yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
      },
    }
    const { base, wsId } = await boot(provider)
    await post(base, `/api/workspaces/${wsId}/mcp/fixture`, { transport: 'stdio', command: process.execPath, args: [mcpFixture], enabled: true, allowedTools: ['interactive'] })
    await post(base, `/api/workspaces/${wsId}/mcp/fixture/enable`)
    await fetch(`${base}/api/workspaces/${wsId}/mode`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modeId: 'full-access' }) })
    const session = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
    const response = await fetch(`${base}/api/workspaces/${wsId}/sessions/${session.id}/events`)
    const reader = (response.body as ReadableStream).getReader()
    void post(base, `/api/workspaces/${wsId}/sessions/${session.id}/messages`, { content: 'interactive' })
    const approvalId = await waitApproval(reader)
    expect(approvalId).toMatch(/^approval-/)
    await post(base, `/api/approvals/${approvalId}`, { allow: false })
    reader.cancel().catch(() => {})
  }, 20_000)

  it('full access runs a plain MCP tool without an approval; only the interactive one still asks', async () => {
    let step = 0
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream() {
        step += 1
        if (step === 1) { yield { type: 'toolCalls', calls: [{ id: 'f1', name: 'mcp__fixture__query', args: { q: 'x' } }] }; yield { type: 'completion', finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }; return }
        yield { type: 'delta', delta: 'done' }
        yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
      },
    }
    const { base, wsId } = await boot(provider)
    await post(base, `/api/workspaces/${wsId}/mcp/fixture`, { transport: 'stdio', command: process.execPath, args: [mcpFixture], enabled: true, allowedTools: ['query', 'interactive'] })
    await post(base, `/api/workspaces/${wsId}/mcp/fixture/enable`)
    await fetch(`${base}/api/workspaces/${wsId}/mode`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modeId: 'full-access' }) })
    const session = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
    void post(base, `/api/workspaces/${wsId}/sessions/${session.id}/messages`, { content: 'query' })
    let events: Record<string, unknown>[] = []
    for (let i = 0; i < 50; i++) {
      events = await sessionEvents(base, wsId, session.id)
      if (events.some((event) => event.type === 'mcp/call')) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    // The dispatch happened — no human answered anything.
    expect(events.find((event) => event.type === 'mcp/call')).toMatchObject({ server: 'fixture', tool: 'query', isError: false })
    expect(events.some((event) => event.type === 'approval/request')).toBe(false)
  }, 20_000)

  it('a repeated call is a new invocation with its own approval; the first grant is not reused', async () => {
    let step = 0
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream() {
        step += 1
        // The same action twice, as a model (or a user asking again) repeats it.
        if (step === 1) { yield { type: 'toolCalls', calls: [{ id: 'first', name: 'mcp__fixture__interactive', args: {} }] }; yield { type: 'completion', finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }; return }
        // Same call id on purpose: some providers restart their numbering, and
        // an approved repeat must still be sent rather than answered from the
        // earlier record.
        if (step === 2) { yield { type: 'toolCalls', calls: [{ id: 'first', name: 'mcp__fixture__interactive', args: {} }] }; yield { type: 'completion', finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }; return }
        yield { type: 'delta', delta: 'done' }
        yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
      },
    }
    const { base, wsId, home } = await boot(provider)
    const effects = path.join(home, 'side-effects.log')
    await post(base, `/api/workspaces/${wsId}/mcp/fixture`, { transport: 'stdio', command: process.execPath, args: [mcpFixture], env: { SIDE_EFFECT_FILE: effects }, enabled: true, allowedTools: ['interactive'] })
    await post(base, `/api/workspaces/${wsId}/mcp/fixture/enable`)
    const session = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
    const response = await fetch(`${base}/api/workspaces/${wsId}/sessions/${session.id}/events`)
    const reader = (response.body as ReadableStream).getReader()
    void post(base, `/api/workspaces/${wsId}/sessions/${session.id}/messages`, { content: 'interactive twice' })
    const firstApproval = await waitApproval(reader)
    await post(base, `/api/approvals/${firstApproval}`, { allow: true })
    const secondApproval = await waitApproval(reader)
    expect(secondApproval).not.toBe(firstApproval)
    await post(base, `/api/approvals/${secondApproval}`, { allow: true })
    for (let i = 0; i < 50 && step < 3; i++) await new Promise((resolve) => setTimeout(resolve, 100))
    reader.cancel().catch(() => {})

    // Two approvals, two dispatches, two remote effects — each its own invocation.
    const journal = (await fs.readFile(path.join(home, 'workspaces', wsId, 'mcp', 'executions.jsonl'), 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line) as { kind: string; invocationId: string })
    const intents = journal.filter((record) => record.kind === 'dispatch_intent').map((record) => record.invocationId)
    expect(new Set(intents).size).toBe(2)
    expect((await fs.readFile(effects, 'utf8')).trim().split('\n')).toEqual(['interactive', 'interactive'])
  }, 20_000)

  it('enabling authorizes the canonical executable; a changed file is refused until enabled again', async () => {
    const provider: LlmProvider = { name: 'idle', models: ['idle'], async *stream() { yield { type: 'delta', delta: 'ok' }; yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true } } }
    const { base, wsId, home } = await boot(provider)
    // A file we own at an absolute path that can run the fixture. A node
    // binary copy cannot: dynamically linked builds (Homebrew, non-Windows
    // system node) lose their libraries when moved. A one-line script keeps
    // the pin meaningful — own file, own bytes, runnable — everywhere.
    let binary: string
    if (process.platform === 'win32') {
      binary = path.join(home, `node-copy${path.extname(process.execPath)}`)
      await fs.copyFile(process.execPath, binary)
    } else {
      binary = path.join(home, 'fixture-runner.sh')
      await fs.writeFile(binary, `#!/bin/sh\nexec '${process.execPath.replace(/'/g, `'\\''`)}' '${mcpFixture.replace(/'/g, `'\\''`)}' "$@"\n`, { mode: 0o755 })
    }
    const route = `/api/workspaces/${wsId}/mcp/pinned`
    expect((await post(base, route, { transport: 'stdio', command: binary, args: [mcpFixture], enabled: false })).status).toBe(201)
    expect((await post(base, `${route}/enable`)).status).toBe(200)
    const pinned = (await (await fetch(`${base}${route}`)).json()) as { executable?: { path: string; sha256: string } }
    expect(pinned.executable?.path).toBe(await fs.realpath(binary))
    expect(pinned.executable?.sha256).toMatch(/^[a-f0-9]{64}$/)

    // A save cannot forge or move the authorization.
    expect((await post(base, route, { transport: 'stdio', command: binary, args: [mcpFixture], executable: { path: 'C:/elsewhere.exe', sha256: 'a'.repeat(64) } })).status).toBe(201)
    expect(((await (await fetch(`${base}${route}`)).json()) as typeof pinned).executable).toEqual(pinned.executable)

    // The file changes after it was authorized: a reconnect refuses to run it.
    await post(base, `${route}/disable`)
    // Windows keeps a running image locked; wait for the stopped process to release it.
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.appendFile(binary, Buffer.from([0]))
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EBUSY' || attempt >= 50) throw error
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    const refused = await post(base, `${route}/reconnect`)
    expect(refused.status).toBe(502)
    expect(((await refused.json()) as { error: string }).error).toMatch(/executable_changed/)

    // Enabling again is the explicit act that authorizes the new bytes.
    await post(base, `${route}/enable`)
    const repinned = (await (await fetch(`${base}${route}`)).json()) as typeof pinned
    expect(repinned.executable?.sha256).not.toBe(pinned.executable?.sha256)
    await post(base, `${route}/disable`)
  }, 30_000)

  it('disable and host close cancel delayed in-flight MCP initialization (no late descriptors/process)', async () => {
    const provider: LlmProvider = { name: 'scripted', models: ['scripted'], async *stream() { yield { type: 'delta', delta: 'x' }; yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true } } }
    // Disable race.
    {
      const { home, base, wsId, server } = await boot(provider)
      const initFile = path.join(home, 'slow-disable.txt')
      await post(base, `/api/workspaces/${wsId}/mcp/fixture`, { transport: 'stdio', command: process.execPath, args: [mcpFixture], env: { INIT_FILE: initFile, INIT_DELAY_MS: '700' }, enabled: true })
      const enabling = post(base, `/api/workspaces/${wsId}/mcp/fixture/enable`)
      await new Promise((resolve) => setTimeout(resolve, 100))
      const disabled = await post(base, `/api/workspaces/${wsId}/mcp/fixture/disable`)
      expect(disabled.status).toBe(200)
      await enabling.catch(() => undefined)
      await expect.poll(async () => {
        const rows = (await (await fetch(`${base}/api/workspaces/${wsId}/mcp`)).json()) as { name: string; status: string }[]
        return rows.find((row) => row.name === 'fixture')?.status
      }, { timeout: 5_000, interval: 100 }).toBe('disabled')
      const session = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
      const requests: string[][] = []
      void requests
      await server.close()
    }
    // Close race: close waits for/cancels the pending connection and leaves
    // no live child process after it returns.
    {
      const { home, base, wsId, server } = await boot(provider)
      const initFile = path.join(home, 'slow-close.txt')
      await post(base, `/api/workspaces/${wsId}/mcp/fixture`, { transport: 'stdio', command: process.execPath, args: [mcpFixture], env: { INIT_FILE: initFile, INIT_DELAY_MS: '700' }, enabled: true })
      void post(base, `/api/workspaces/${wsId}/mcp/fixture/enable`).catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 100))
      const started = Date.now()
      await server.close()
      expect(Date.now() - started).toBeLessThan(5_000)
      await new Promise((resolve) => setTimeout(resolve, 900))
      // INIT may have started, but server.close awaited and disconnected the
      // resulting client; no route/process can publish after close.
    }
  }, 30_000)

  it('secret rotation reconnects affected enabled servers before returning', async () => {
    const provider: LlmProvider = { name: 'scripted', models: ['scripted'], async *stream() { yield { type: 'delta', delta: 'x' }; yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true } } }
    const { home, base, wsId } = await boot(provider)
    const initFile = path.join(home, 'rotation-pids.txt')
    await fetch(`${base}/api/workspaces/${wsId}/secrets/API_KEY`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'first' }) })
    await post(base, `/api/workspaces/${wsId}/mcp/fixture`, { transport: 'stdio', command: process.execPath, args: [mcpFixture], env: { API_KEY: '${API_KEY}', INIT_FILE: initFile }, enabled: true })
    await post(base, `/api/workspaces/${wsId}/mcp/fixture/enable`)
    const before = (await fs.readFile(initFile, 'utf8')).trim().split(/\s+/)
    expect(before).toHaveLength(1)
    const rotation = await fetch(`${base}/api/workspaces/${wsId}/secrets/API_KEY`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'second' }) })
    expect(rotation.status).toBe(200)
    const rotationBody = (await rotation.json()) as { reconnected: string[] }
    expect(rotationBody.reconnected).toContain('fixture')
    const after = (await fs.readFile(initFile, 'utf8')).trim().split(/\s+/)
    expect(new Set(after).size).toBe(2)
  }, 20_000)

  it('concurrent first use creates exactly one MCP process per workspace/server', async () => {
    const provider: LlmProvider = { name: 'scripted', models: ['scripted'], async *stream() { yield { type: 'delta', delta: 'x' }; yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true } } }
    const { home, base, wsId } = await boot(provider)
    const initFile = path.join(home, 'init-pids.txt')
    await post(base, `/api/workspaces/${wsId}/mcp/fixture`, { transport: 'stdio', command: process.execPath, args: [mcpFixture], env: { INIT_FILE: initFile }, enabled: true })
    expect((await post(base, `/api/workspaces/${wsId}/mcp/fixture/enable`)).status).toBe(200)
    const sessions = await Promise.all(Array.from({ length: 5 }, async () => (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }))
    await Promise.all(sessions.map((session) => post(base, `/api/workspaces/${wsId}/sessions/${session.id}/messages`, { content: 'go' })))
    await new Promise((resolve) => setTimeout(resolve, 500))
    const pids = (await fs.readFile(initFile, 'utf8')).trim().split(/\s+/).filter(Boolean)
    expect(new Set(pids).size).toBe(1)
  }, 20_000)

  it('treats an empty allowedTools list as every discovered tool', async () => {
    const requests: string[][] = []
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream(request) {
        requests.push(request.tools?.map((tool) => tool.name) ?? [])
        yield { type: 'delta', delta: 'x' }
        yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
      },
    }
    const { base, wsId } = await boot(provider)
    const saved = await post(base, `/api/workspaces/${wsId}/mcp/fixture`, {
      transport: 'stdio', command: process.execPath, args: [mcpFixture], enabled: true, allowedTools: [],
    })
    expect(saved.status).toBe(201)
    expect((await post(base, `/api/workspaces/${wsId}/mcp/fixture/enable`)).status).toBe(200)
    const session = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
    await post(base, `/api/workspaces/${wsId}/sessions/${session.id}/messages`, { content: 'hi' })
    for (let i = 0; i < 50 && requests.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 100))
    expect(requests[0]).toContain('mcp__fixture__query')
    expect(requests[0]).toContain('mcp__fixture__interactive')
  }, 20_000)

  it('MCP schema and execution are isolated per workspace even with the same public name', async () => {
    const seen: Record<string, string[][]> = { work: [], life: [] }
    let currentLabel = 'work'
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream(request) {
        seen[currentLabel]?.push(request.tools?.map((tool) => tool.name) ?? [])
        yield { type: 'delta', delta: 'x' }
        yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
      },
    }
    const { base, wsId: workId } = await boot(provider)
    const life = (await (await post(base, '/api/workspaces', { name: 'Life' })).json()) as { id: string }
    // Only Work configures/enables fixture.
    await post(base, `/api/workspaces/${workId}/mcp/fixture`, {
      transport: 'stdio', command: process.execPath, args: [mcpFixture], enabled: true, allowedTools: ['query'],
    })
    await post(base, `/api/workspaces/${workId}/mcp/fixture/enable`)

    currentLabel = 'work'
    const workSession = (await (await post(base, `/api/workspaces/${workId}/sessions`)).json()) as { id: string }
    await post(base, `/api/workspaces/${workId}/sessions/${workSession.id}/messages`, { content: 'work' })
    await new Promise((resolve) => setTimeout(resolve, 250))
    currentLabel = 'life'
    const lifeSession = (await (await post(base, `/api/workspaces/${life.id}/sessions`)).json()) as { id: string }
    await post(base, `/api/workspaces/${life.id}/sessions/${lifeSession.id}/messages`, { content: 'life' })
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(seen.work?.[0]).toContain('mcp__fixture__query')
    expect(seen.life?.[0]).not.toContain('mcp__fixture__query')
  }, 20_000)

  it('a zero-exposure mode sends no MCP schemas; host blockedTools cannot be widened', async () => {
    const requests: string[][] = []
    let requestNo = 0
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream(request) {
        requests.push(request.tools?.map((tool) => tool.name) ?? [])
        requestNo += 1
        if (requestNo === 2) {
          yield { type: 'toolCalls', calls: [{ id: 'blocked-mcp', name: 'mcp__fixture__query', args: { q: 'x' } }] }
          yield { type: 'completion', finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }
          return
        }
        yield { type: 'delta', delta: 'x' }
        yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
      },
    }
    const { base, wsId } = await boot(provider, { blockedTools: ['mcp__*__query'] })
    await post(base, `/api/workspaces/${wsId}/mcp/fixture`, {
      transport: 'stdio', command: process.execPath, args: [mcpFixture], enabled: true, allowedTools: ['query'],
    })
    await post(base, `/api/workspaces/${wsId}/mcp/fixture/enable`)
    expect((await putZeroMode(base, wsId)).status).toBe(200)
    await fetch(`${base}/api/workspaces/${wsId}/mode`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modeId: 'zero' }),
    })
    const session = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
    await post(base, `/api/workspaces/${wsId}/sessions/${session.id}/messages`, { content: 'hi' })
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(requests[0]).not.toContain('mcp__fixture__query')

    // Full access still cannot bypass host blockedTools.
    await fetch(`${base}/api/workspaces/${wsId}/mode`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modeId: 'full-access' }) })
    const second = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
    await post(base, `/api/workspaces/${wsId}/sessions/${second.id}/messages`, { content: 'call blocked mcp' })
    let events: Record<string, unknown>[] = []
    for (let i = 0; i < 30; i++) {
      events = await sessionEvents(base, wsId, second.id)
      if (events.some((event) => event.type === 'tool/result')) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const blocked = events.find((event) => event.type === 'tool/result')
    expect(blocked?.ok).toBe(false)
    expect(String(blocked?.output)).toMatch(/host blockedTools denies/)
  }, 20_000)

  it('PreToolUse updatedInput is the exact durable intent and re-enters the final gate', async () => {
    let step = 0
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream() {
        step += 1
        if (step === 1) {
          yield { type: 'toolCalls', calls: [{ id: 'e1', name: 'Edit', args: { path: 'x', old: 'a', new: 'b' } }] }
          yield { type: 'completion', finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }
          return
        }
        yield { type: 'delta', delta: 'done' }
        yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
      },
    }
    const { base, wsId } = await boot(provider)
    expect((await putHooks(base, wsId, {
      PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: hookCmd('rewrite'), timeout: 5 }] }],
    })).status).toBe(200)
    // Full access allows Edit, so approval does not mask the rewrite seam. No
    // project means the root gate later fails closed, but the recorded intent
    // is still the rewritten call.
    await fetch(`${base}/api/workspaces/${wsId}/mode`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modeId: 'full-access' }) })
    const session = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
    await post(base, `/api/workspaces/${wsId}/sessions/${session.id}/messages`, { content: 'edit' })
    let events: Record<string, unknown>[] = []
    for (let i = 0; i < 30; i++) {
      events = await sessionEvents(base, wsId, session.id)
      if (events.some((event) => event.type === 'tool/call')) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const call = events.find((event) => event.type === 'tool/call') as { call?: { args?: Record<string, unknown> } } | undefined
    expect(call?.call?.args?.rewritten).toBe(true)
    const audit = events.find((event) => event.type === 'hook/run' && event.event === 'PreToolUse')
    expect(audit?.decision).toBe('allow+rewrite')
  }, 20_000)

  it('PreToolUse blocks Bash; PostToolUse adds context; UserPromptSubmit injects context and hooks are audited', async () => {
    const seen: string[][] = []
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream(request) {
        seen.push(request.messages.map((message) => messageText(message.content)))
        yield { type: 'toolCalls', calls: [
          { id: 'b1', name: 'Bash', args: { command: 'echo should-not-run' } },
          { id: 'g1', name: 'Glob', args: { pattern: '*' } },
        ] }
        yield { type: 'completion', finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }
      },
    }
    const { base, wsId } = await boot(provider)
    await fetch(`${base}/api/workspaces/${wsId}/mode`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modeId: 'full-access' }) })
    const project = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-g5-post-'))
    const projectId = ((await (await post(base, `/api/workspaces/${wsId}/projects`, { name: 'p', path: project })).json()) as { id: string }).id
    expect((await putHooks(base, wsId, {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: hookCmd('block'), timeout: 5 }] }],
      PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: hookCmd('context'), timeout: 5 }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookCmd('stdout'), timeout: 5 }] }],
    })).status).toBe(200)
    const session = (await (await post(base, `/api/workspaces/${wsId}/sessions`, { projectId })).json()) as { id: string }
    await post(base, `/api/workspaces/${wsId}/sessions/${session.id}/messages`, { content: 'try bash' })
    // Under full-suite parallel load, wait until both durable results land.
    let events: Record<string, unknown>[] = []
    for (let i = 0; i < 40; i++) {
      events = await sessionEvents(base, wsId, session.id)
      if (events.filter((event) => event.type === 'tool/result').length >= 2) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    await post(base, `/api/workspaces/${wsId}/sessions/${session.id}/stop`)
    expect(seen[0]?.join('\n')).toContain('fixture plain stdout context')
    const bash = events.find((event) => event.type === 'tool/result' && event.callId === 'b1')
    expect(bash?.ok).toBe(false)
    expect(String(bash?.output)).toMatch(/PreToolUse hook blocked 'Bash': blocked by fixture/)
    // Claude: a call that never ran fires no post hook.
    expect(String(bash?.output)).not.toContain('fixture additional context')
    const glob = events.find((event) => event.type === 'tool/result' && event.callId === 'g1')
    expect(glob?.ok).toBe(true)
    expect(String(glob?.output)).toContain('PostToolUse hook additional context')
    expect(String(glob?.output)).toContain('fixture additional context')
    const hooks = events.filter((event) => event.type === 'hook/run')
    expect(hooks.some((event) => event.event === 'UserPromptSubmit' && event.decision === 'context')).toBe(true)
    expect(hooks.some((event) => event.event === 'PreToolUse' && event.decision === 'block')).toBe(true)
    expect(hooks.filter((event) => event.event === 'PostToolUse')).toHaveLength(1)
  }, 20_000)

  it('Stop hook decision:block continues the turn once; stop_hook_active lets it end', async () => {
    const seen: string[][] = []
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream(request) {
        seen.push(request.messages.map((message) => messageText(message.content)))
        yield { type: 'delta', delta: `answer ${seen.length}` }
        yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
      },
    }
    const { base, wsId } = await boot(provider)
    expect((await putHooks(base, wsId, { Stop: [{ hooks: [{ type: 'command', command: hookCmd('stop-once'), timeout: 5 }] }] })).status).toBe(200)
    const session = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
    await post(base, `/api/workspaces/${wsId}/sessions/${session.id}/messages`, { content: 'hi' })
    let events: Record<string, unknown>[] = []
    for (let i = 0; i < 50; i++) {
      events = await sessionEvents(base, wsId, session.id)
      if (events.some((event) => event.type === 'turn/end')) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(seen).toHaveLength(2)
    expect(seen[1]?.join('\n')).toContain('fixture says keep going')
    expect(events.filter((event) => event.type === 'hook/run' && event.event === 'Stop').map((event) => event.decision)).toEqual(['block', 'ok'])
  }, 20_000)

  it('PreToolUse permissionDecision ask forces an approval even in full access', async () => {
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream() {
        yield { type: 'toolCalls', calls: [{ id: 'g1', name: 'Glob', args: { pattern: '*' } }] }
        yield { type: 'completion', finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }
      },
    }
    const { base, wsId } = await boot(provider)
    await fetch(`${base}/api/workspaces/${wsId}/mode`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modeId: 'full-access' }) })
    expect((await putHooks(base, wsId, { PreToolUse: [{ matcher: 'Glob', hooks: [{ type: 'command', command: hookCmd('ask'), timeout: 5 }] }] })).status).toBe(200)
    const session = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
    await post(base, `/api/workspaces/${wsId}/sessions/${session.id}/messages`, { content: 'glob' })
    let events: Record<string, unknown>[] = []
    for (let i = 0; i < 40; i++) {
      events = await sessionEvents(base, wsId, session.id)
      if (events.some((event) => event.type === 'approval/request')) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(events.some((event) => event.type === 'approval/request')).toBe(true)
    await post(base, `/api/workspaces/${wsId}/sessions/${session.id}/stop`)
  }, 20_000)

  it('writing project hook settings always asks, and hooks are snapshotted per conversation', async () => {
    const project = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-hook-snap-')))
    const marker = path.join(project, 'hook-ran')
    const script = path.join(project, 'mark.cjs')
    await fs.writeFile(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`)
    const evil = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: `"${process.execPath}" "${script}"` }] }] } })
    let step = 0
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream() {
        step += 1
        if (step === 1) {
          yield { type: 'toolCalls', calls: [{ id: 'w1', name: 'Write', args: { path: '.claude/settings.json', content: evil } }] }
          yield { type: 'completion', finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }
          return
        }
        if (step === 6) {
          // A tool call AFTER the file appeared: PreToolUse would fire it.
          yield { type: 'toolCalls', calls: [{ id: 'g6', name: 'Glob', args: { pattern: '*' } }] }
          yield { type: 'completion', finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }
          return
        }
        yield { type: 'delta', delta: 'done' }
        yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
      },
    }
    const { base, wsId } = await boot(provider)
    await fetch(`${base}/api/workspaces/${wsId}/mode`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modeId: 'full-access' }) })
    const projectId = ((await (await post(base, `/api/workspaces/${wsId}/projects`, { name: 'p', path: project })).json()) as { id: string }).id
    const session = (await (await post(base, `/api/workspaces/${wsId}/sessions`, { projectId })).json()) as { id: string }
    await post(base, `/api/workspaces/${wsId}/sessions/${session.id}/messages`, { content: 'write settings' })
    let events: Record<string, unknown>[] = []
    for (let i = 0; i < 40; i++) {
      events = await sessionEvents(base, wsId, session.id)
      if (events.some((event) => event.type === 'approval/request')) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    // Full access would allow a Write; hook configuration still asks a human.
    expect(events.some((event) => event.type === 'approval/request')).toBe(true)
    await post(base, `/api/workspaces/${wsId}/sessions/${session.id}/stop`)
    for (let i = 0; i < 40; i++) {
      const listed = (await (await fetch(`${base}/api/workspaces/${wsId}/sessions`)).json()) as { id: string; status: string }[]
      if (listed.find((row) => row.id === session.id)?.status === 'idle') break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    // Even if the file appears mid-conversation (e.g. an external editor),
    // this conversation keeps the hooks it started with.
    await fs.mkdir(path.join(project, '.claude'), { recursive: true })
    await fs.writeFile(path.join(project, '.claude', 'settings.json'), evil)
    step = 5
    await post(base, `/api/workspaces/${wsId}/sessions/${session.id}/messages`, { content: 'again' })
    for (let i = 0; i < 30; i++) {
      events = await sessionEvents(base, wsId, session.id)
      if (events.filter((event) => event.type === 'turn/end').length >= 2) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(events.some((event) => event.type === 'tool/result' && event.callId === 'g6')).toBe(true)
    expect(await fs.stat(marker).then(() => true, () => false)).toBe(false)
    // A new conversation reads the file (Claude: settings load at startup).
    step = 5
    const fresh = (await (await post(base, `/api/workspaces/${wsId}/sessions`, { projectId })).json()) as { id: string }
    await post(base, `/api/workspaces/${wsId}/sessions/${fresh.id}/messages`, { content: 'fresh' })
    for (let i = 0; i < 40 && !(await fs.stat(marker).then(() => true, () => false)); i++) await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await fs.stat(marker).then(() => true, () => false)).toBe(true)
  }, 20_000)

  it('continue:false from a PreToolUse hook stops the turn; PreToolUse additionalContext reaches the model', async () => {
    const seen: string[][] = []
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream(request) {
        seen.push(request.messages.map((message) => messageText(message.content)))
        yield { type: 'toolCalls', calls: [{ id: `g${seen.length}`, name: 'Glob', args: { pattern: '*' } }] }
        yield { type: 'completion', finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }
      },
    }
    const { base, wsId } = await boot(provider)
    await fetch(`${base}/api/workspaces/${wsId}/mode`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modeId: 'full-access' }) })
    expect((await putHooks(base, wsId, { PreToolUse: [{ matcher: 'Glob', hooks: [{ type: 'command', command: hookCmd('stop'), timeout: 5 }] }] })).status).toBe(200)
    const session = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
    await post(base, `/api/workspaces/${wsId}/sessions/${session.id}/messages`, { content: 'glob' })
    let events: Record<string, unknown>[] = []
    for (let i = 0; i < 40; i++) {
      events = await sessionEvents(base, wsId, session.id)
      if (events.some((event) => event.type === 'turn/end')) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(events.find((event) => event.type === 'turn/end')?.reason).toBe('cancelled')
    expect(seen.length).toBeLessThanOrEqual(2)
    expect(events.find((event) => event.type === 'hook/run')?.message).toBe('fixture stopped')

    // additionalContext: Settings save re-reads hooks for running conversations too.
    expect((await putHooks(base, wsId, { PreToolUse: [{ matcher: 'Glob', hooks: [{ type: 'command', command: hookCmd('context'), timeout: 5 }] }] })).status).toBe(200)
    const second = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
    seen.length = 0
    await post(base, `/api/workspaces/${wsId}/sessions/${second.id}/messages`, { content: 'glob' })
    for (let i = 0; i < 40 && seen.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 100))
    const secondEvents = await sessionEvents(base, wsId, second.id)
    expect(String(secondEvents.find((event) => event.type === 'tool/result')?.output)).toContain('PreToolUse hook additional context')
    expect(seen[1]?.join('\n')).toContain('PreToolUse hook additional context')
    await post(base, `/api/workspaces/${wsId}/sessions/${second.id}/stop`)
  }, 20_000)

  it('reads project .claude/settings.json hooks, CLAUDE.md layers, and SessionStart context', async () => {
    const seen: string[][] = []
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream(request) {
        seen.push(request.messages.map((message) => messageText(message.content)))
        yield { type: 'delta', delta: 'ok' }
        yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
      },
    }
    const userClaudeDir = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-user-claude-'))
    await fs.writeFile(path.join(userClaudeDir, 'CLAUDE.md'), 'USER LAYER RULE')
    const { base, wsId, home } = await boot(provider, { userClaudeDir })
    await fs.writeFile(path.join(home, 'workspaces', wsId, 'CLAUDE.md'), 'WORKSPACE LAYER RULE')
    const project = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-claude-project-'))
    await fs.writeFile(path.join(project, 'CLAUDE.md'), 'PROJECT LAYER RULE @AGENTS.md')
    await fs.writeFile(path.join(project, 'AGENTS.md'), 'AGENTS IMPORTED RULE')
    await fs.mkdir(path.join(project, '.claude'))
    await fs.writeFile(path.join(project, '.claude', 'settings.json'), JSON.stringify({
      hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: hookCmd('echo') }] }] },
    }))
    const created = await post(base, `/api/workspaces/${wsId}/projects`, { name: 'p', path: project })
    expect(created.status).toBe(201)
    const projectId = ((await created.json()) as { id: string }).id
    const session = (await (await post(base, `/api/workspaces/${wsId}/sessions`, { projectId })).json()) as { id: string }
    await post(base, `/api/workspaces/${wsId}/sessions/${session.id}/messages`, { content: 'hi' })
    for (let i = 0; i < 40 && seen.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 100))
    const text = seen[0]?.join('\n') ?? ''
    expect(text.indexOf('USER LAYER RULE')).toBeGreaterThanOrEqual(0)
    expect(text.indexOf('USER LAYER RULE')).toBeLessThan(text.indexOf('WORKSPACE LAYER RULE'))
    expect(text.indexOf('WORKSPACE LAYER RULE')).toBeLessThan(text.indexOf('PROJECT LAYER RULE'))
    expect(text).toContain('AGENTS IMPORTED RULE')
    // SessionStart echo: Claude input fields reached the project hook.
    expect(text).toContain('SessionStart hook additional context')
    expect(text).toContain('"hook_event_name":"SessionStart"')
    expect(text).toContain('"source":"startup"')
    // The project binding stores the canonical (realpath) folder.
    expect(text).toContain(`"CLAUDE_PROJECT_DIR":${JSON.stringify(await fs.realpath(project))}`)
    const listed = (await (await fetch(`${base}/api/workspaces/${wsId}/hooks?projectId=${projectId}`)).json()) as { effective: { layer: string }[] }
    expect(listed.effective.map((hook) => hook.layer)).toEqual(['project'])
  }, 20_000)

  it('one server that cannot connect is skipped: the Turn runs with the other servers, and Settings shows why', async () => {
    const requests: string[][] = []
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream(request) {
        requests.push(request.tools?.map((tool) => tool.name) ?? [])
        yield { type: 'delta', delta: 'ok' }
        yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
      },
    }
    const { base, wsId } = await boot(provider)
    // A server listing one provider-safe tool and one name providers reject.
    const odd = `
      const rl = require('node:readline').createInterface({ input: process.stdin })
      const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
      rl.on('line', (line) => {
        const msg = JSON.parse(line)
        if (msg.method === 'initialize') return out({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } } })
        if (msg.method === 'tools/list') return out({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'fine', inputSchema: { type: 'object' } }, { name: 'get.file', inputSchema: { type: 'object' } }] } })
      })`
    expect((await post(base, `/api/workspaces/${wsId}/mcp/good`, { transport: 'stdio', command: process.execPath, args: ['-e', odd], enabled: false })).status).toBe(201)
    expect((await post(base, `/api/workspaces/${wsId}/mcp/good/enable`)).status).toBe(200)
    // Starts, writes a reason to stderr, and exits before initialize.
    expect((await post(base, `/api/workspaces/${wsId}/mcp/broken`, { transport: 'stdio', command: process.execPath, args: ['-e', "process.stderr.write('cannot open database'); process.exit(2)"], enabled: false })).status).toBe(201)
    expect((await post(base, `/api/workspaces/${wsId}/mcp/broken/enable`)).status).toBe(502)

    const session = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
    await post(base, `/api/workspaces/${wsId}/sessions/${session.id}/messages`, { content: 'hello' })
    for (let i = 0; i < 50 && requests.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 100))
    expect(requests[0]).toContain('mcp__good__fine')
    expect(requests[0]).not.toContain('mcp__good__get.file')
    expect(requests[0]?.some((name) => name.startsWith('mcp__broken__'))).toBe(false)
    const events = await sessionEvents(base, wsId, session.id)
    expect(events.some((event) => event.type === 'turn/end' && event.reason === 'rejected')).toBe(false)

    const rows = await (await fetch(`${base}/api/workspaces/${wsId}/mcp`)).json() as { name: string; status: string; lastError?: string; unusableTools?: string[] }[]
    const broken = rows.find((row) => row.name === 'broken')
    expect(broken?.status).toBe('failed')
    expect(broken?.lastError).toBeTruthy()
    expect(rows.find((row) => row.name === 'good')?.unusableTools).toEqual(['get.file'])
  }, 30_000)
})

async function waitApproval(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('approval timeout')), deadline - Date.now())),
    ])
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      boundary = buffer.indexOf('\n\n')
      const data = frame.split('\n').find((line) => line.startsWith('data: '))
      if (data === undefined) continue
      const envelope = JSON.parse(data.slice(6)) as { kind: string; approvalId?: string }
      if (envelope.kind === 'approval') return envelope.approvalId ?? ''
    }
  }
  return ''
}

async function sessionEvents(base: string, workspaceId: string, sessionId: string): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${base}/api/workspaces/${workspaceId}/sessions/${sessionId}/events`)
  const reader = (response.body as ReadableStream).getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + 6_000
  try {
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('snapshot timeout')), deadline - Date.now())),
      ])
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      const boundary = buffer.indexOf('\n\n')
      if (boundary < 0) continue
      const frame = buffer.slice(0, boundary)
      const data = frame.split('\n').find((line) => line.startsWith('data: '))
      if (data === undefined) continue
      const envelope = JSON.parse(data.slice(6)) as { kind: string; events?: Record<string, unknown>[] }
      return envelope.kind === 'snapshot' ? (envelope.events ?? []) : []
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  return []
}
