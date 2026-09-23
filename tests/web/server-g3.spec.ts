/**
 * G3 server behaviors: the live mode control (validated selection, cached
 * definition), the exposure ceiling denying stale-batch calls, Chat sending
 * no tool schemas, mid-Turn mode switches gating the NEXT call, and the
 * manifest endpoint.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWebServer, type LlmProvider, type WebServer } from 'mini-dsh'

let root = ''
const servers: WebServer[] = []
const serverHomes = new WeakMap<WebServer, string>()

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g3-web-'))
})

afterAll(async () => {
  for (const server of servers) await server.close().catch(() => {})
  await fs.rm(root, { recursive: true, force: true })
})

async function start(providers: readonly LlmProvider[]): Promise<WebServer> {
  const home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g3-home-'))
  const server = await createWebServer({ home, providers, configFile: path.join(home, 'p.json') })
  servers.push(server)
  serverHomes.set(server, home)
  return server
}

async function post(base: string, pathname: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

/** Connect, read the snapshot, return event types (cancel the stream). */
async function snapshotTypes(base: string, wsId: string, sessionId: string): Promise<string[]> {
  const response = await fetch(`${base}/api/workspaces/${wsId}/sessions/${sessionId}/events`)
  const reader = (response.body as ReadableStream).getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + 6_000
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now()
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), remaining)),
      ])
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      const boundary = buffer.indexOf('\n\n')
      if (boundary >= 0) {
        const frame = buffer.slice(0, boundary)
        const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
        if (dataLine !== undefined) {
          const envelope = JSON.parse(dataLine.slice('data: '.length)) as { kind: string; events?: { type: string }[] }
          reader.cancel().catch(() => {})
          return envelope.kind === 'snapshot' ? (envelope.events ?? []).map((event) => event.type) : []
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  return []
}

describe('live mode control', () => {
  it('Chat sends no tool schemas and executes no tools', async () => {
    const requests: { tools?: { name: string }[] }[] = []
    const spy: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream(request) {
        const tools = request.tools?.map((schema) => ({ name: schema.name }))
        requests.push(tools !== undefined ? { tools } : {})
        yield { type: 'delta', delta: 'plain answer' }
      },
    }
    const server = await start([spy])
    const base = server.url
    const wsId = (await (await fetch(`${base}/api/workspaces`)).json() as { id: string }[])[0]!.id
    expect((await fetch(`${base}/api/workspaces/${wsId}/mode`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modeId: 'chat' }),
    })).status).toBe(200)

    const { id } = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
    await post(base, `/api/workspaces/${wsId}/sessions/${id}/messages`, { content: 'hello' })
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(requests).toHaveLength(1)
    expect(requests[0]?.tools).toBeUndefined()
    // Unknown modes are refused; the selector validates.
    expect((await fetch(`${base}/api/workspaces/${wsId}/mode`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modeId: 'no-such' }),
    })).status).toBe(404)
  })

  it('a mid-batch mode switch gates unstarted calls: current tool finishes, the rest deny truthfully', async () => {
    let calls = 0
    const loop: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream() {
        calls += 1
        if (calls === 1) {
          yield { type: 'toolCalls', calls: [
            { id: 'c1', name: 'Glob', args: { pattern: '*' } },
            { id: 'c2', name: 'Write', args: { path: 'blocked.txt', content: 'x' } },
          ] }
          return
        }
        yield { type: 'delta', delta: 'done' }
      },
    }
    const server = await start([loop])
    const base = server.url
    const wsId = (await (await fetch(`${base}/api/workspaces`)).json() as { id: string }[])[0]!.id
    // A bound project grants the file tools (G2: no project, no grant).
    const projDir = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g3-proj-'))
    const project = (await (await post(base, `/api/workspaces/${wsId}/projects`, { name: 'P', path: projDir })).json()) as { id: string }

    const { id } = (await (await post(base, `/api/workspaces/${wsId}/sessions`, { projectId: project.id })).json()) as { id: string }
    // Gate c1 so it CANNOT finish before the live mode switch lands: the
    // batch's second call is provably still unstarted at flip time, which is
    // exactly the stale-batch case under test. (Waiting on the log alone
    // races a fast Glob against the PUT under parallel load.)
    let releaseGate: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    // Delay ONLY the first batch call at the authorization boundary (the
    // real Glob tool still runs afterwards). This makes "c2 not yet started
    // when the mode flips" a fact rather than a timing hope.
    server.kernel.ctx.on('tools/pre-execute', async (payload, next) => {
      if (payload.call.id === 'c1' && payload.exec.signal?.aborted !== true) await gate
      return next()
    })
    void post(base, `/api/workspaces/${wsId}/sessions/${id}/messages`, { content: 'go' })
    for (let i = 0; i < 50; i++) {
      const events = await readAllEvents(base, wsId, id)
      if (events.some((event) => event.type === 'tool/call' && (event as { call?: { id?: string } }).call?.id === 'c1')) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect((await fetch(`${base}/api/workspaces/${wsId}/mode`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modeId: 'plan' }),
    })).status).toBe(200)
    // Plan is now the live mode: release the running call so the batch can
    // advance to the (now unexposed) second call.
    releaseGate?.()
    // Wait for the turn to settle before reading the log (generous under
    // parallel-suite load).
    for (let i = 0; i < 60; i++) {
      const listing = (await (await fetch(`${base}/api/workspaces/${wsId}/sessions`)).json()) as { id: string; status: string }[]
      if (listing.find((row) => row.id === id)?.status === 'idle') break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }

    // Retry the snapshot until both tool results have landed.
    let events: { type: string; [key: string]: unknown }[] = []
    for (let i = 0; i < 10; i++) {
      events = await readAllEvents(base, wsId, id)
      const results = events.filter((event) => event.type === 'tool/result')
      if (results.length >= 2) break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    const results = events.filter((event) => event.type === 'tool/result')
    const glob = results.find((event) => (event as { callId?: string }).callId === 'c1')
    const write = results.find((event) => (event as { callId?: string }).callId === 'c2')
    expect(glob !== undefined && (glob as { ok?: boolean }).ok).toBe(true)
    expect(write !== undefined && (write as { ok?: boolean }).ok).toBe(false)
    expect(write !== undefined && (write as { output?: string }).output).toMatch(/no longer exposed|does not expose 'Write'/)
    // The blocked file was never written.
    await expect(fs.readFile(path.join(root, 'blocked.txt'), 'utf8')).rejects.toThrow()
  }, 30_000)

  it('authors a mode over REST: save, list, select, and gate by its own permissions', async () => {
    const server = await start([])
    const base = server.url
    const wsId = (await (await fetch(`${base}/api/workspaces`)).json() as { id: string }[])[0]!.id
    const put = (id: string, body: unknown): Promise<Response> =>
      fetch(`${base}/api/workspaces/${wsId}/modes/${id}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })

    const raw = `---\nname: "Locked"\ntoolExposure: ["Read", "Bash"]\npermissionDefaults: {"Read": "allow", "Bash": "deny", "mcp__github__*": "ask", "*": "deny"}\n---\n\nLocked down.`
    const saved = await put('locked', { content: raw })
    expect(saved.status).toBe(200)
    const hash = ((await saved.json()) as { hash: string }).hash

    // The authoring catalog carries what the mode grants…
    const catalog = (await (await fetch(`${base}/api/workspaces/${wsId}/modes`)).json()) as
      { id: string; source: string; toolExposure: string[]; permissionDefaults: Record<string, string> }[]
    const row = catalog.find((entry) => entry.id === 'locked')
    expect(row?.source).toBe('workspace')
    expect(row?.toolExposure).toEqual(['Read', 'Bash'])
    expect(row?.permissionDefaults).toMatchObject({ Bash: 'deny', 'mcp__github__*': 'ask', '*': 'deny' })
    // …and the selection control offers it too.
    const selection = (await (await fetch(`${base}/api/workspaces/${wsId}/mode`)).json()) as { modes: { id: string }[] }
    expect(selection.modes.map((mode) => mode.id)).toContain('locked')

    // The editor reads the real bytes back.
    const file = (await (await fetch(`${base}/api/workspaces/${wsId}/modes/locked`)).json()) as { raw: string; hash: string }
    expect(file.raw).toBe(raw)
    expect(file.hash).toBe(hash)

    // Selecting it makes those permissions the ones in force.
    const select = await fetch(`${base}/api/workspaces/${wsId}/mode`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modeId: 'locked' }),
    })
    expect(select.status).toBe(200)
  })

  it('enables and disables modes: the picker hides disabled ones until re-enabled', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g3-mode-enabled-'))
    const provider: LlmProvider = { name: 'scripted', models: ['scripted'], async *stream() { yield { type: 'delta', delta: 'hi' } } }
    let server = await createWebServer({ home, providers: [provider], configFile: path.join(home, 'p.json') })
    let base = server.url
    try {
      const wsId = (await (await fetch(`${base}/api/workspaces`)).json() as { id: string }[])[0]!.id
      await fetch(`${base}/api/workspaces/${wsId}/modes/quiet`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '---\nname: "Quiet"\n---\n\nQuiet mode.' }),
      })
      const toggle = (id: string, enabled: boolean): Promise<Response> =>
        fetch(`${base}/api/workspaces/${wsId}/modes/${id}/enabled`, {
          method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }),
        })
      const pickerIds = async (): Promise<string[]> => {
        const selection = (await (await fetch(`${base}/api/workspaces/${wsId}/mode`)).json()) as { modes: { id: string }[] }
        return selection.modes.map((mode) => mode.id)
      }
      const catalogEnabled = async (id: string): Promise<boolean | undefined> => {
        const catalog = (await (await fetch(`${base}/api/workspaces/${wsId}/modes`)).json()) as { id: string; enabled?: boolean }[]
        return catalog.find((row) => row.id === id)?.enabled
      }

      // Malformed body and unknown ids fail before any state changes.
      expect((await fetch(`${base}/api/workspaces/${wsId}/modes/quiet/enabled`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: 'yes' }),
      })).status).toBe(400)
      expect((await toggle('no-such-mode', false)).status).toBe(404)
      expect(await catalogEnabled('quiet')).toBe(true)

      // Disabling a non-selected mode hides it from the picker and refuses
      // direct selection; the authoring catalog still shows the row.
      expect((await toggle('quiet', false)).status).toBe(200)
      expect(await pickerIds()).not.toContain('quiet')
      expect(await catalogEnabled('quiet')).toBe(false)
      expect((await fetch(`${base}/api/workspaces/${wsId}/mode`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modeId: 'quiet' }),
      })).status).toBe(400)

      // The disabled set survives a restart beside the mode files it governs.
      await server.close()
      server = await createWebServer({ home, providers: [provider], configFile: path.join(home, 'p.json') })
      base = server.url
      expect(await pickerIds()).not.toContain('quiet')
      expect(await catalogEnabled('quiet')).toBe(false)

      // Re-enabling puts it back.
      expect((await toggle('quiet', true)).status).toBe(200)
      expect(await pickerIds()).toContain('quiet')
      expect(await catalogEnabled('quiet')).toBe(true)

      // Bundled modes can be hidden the same way…
      expect((await toggle('plan', false)).status).toBe(200)
      expect(await pickerIds()).not.toContain('plan')
      // …but the mode the workspace has selected is protected: moving off it
      // is the honest way to remove it from the picker.
      const selectedNow = ((await (await fetch(`${base}/api/workspaces/${wsId}/mode`)).json()) as { selected: string }).selected
      expect((await toggle(selectedNow, false)).status).toBe(409)
      expect(await pickerIds()).toContain(selectedNow)

      // Saving a mode clears any stale hidden entry: a recreated id is enabled.
      await toggle('quiet', false)
      const existing = (await (await fetch(`${base}/api/workspaces/${wsId}/modes/quiet`)).json()) as { hash: string }
      await fetch(`${base}/api/workspaces/${wsId}/modes/quiet`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '---\nname: "Quiet 2"\n---\n\nRewritten.', expectedHash: existing.hash }),
      })
      expect(await pickerIds()).toContain('quiet')
    } finally {
      await server.close().catch(() => {})
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  it('refuses a stale save, invalid content, and any write to a bundled mode', async () => {
    const server = await start([])
    const base = server.url
    const wsId = (await (await fetch(`${base}/api/workspaces`)).json() as { id: string }[])[0]!.id
    const put = (id: string, body: unknown): Promise<Response> =>
      fetch(`${base}/api/workspaces/${wsId}/modes/${id}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })

    await put('editable', { content: '---\nname: "V1"\n---\n\nv1' })
    // A stale hash is recoverable by re-reading, so it is its own status.
    expect((await put('editable', { content: '---\nname: "V2"\n---\n\nv2', expectedHash: '0000' })).status).toBe(409)
    expect((await (await fetch(`${base}/api/workspaces/${wsId}/modes/editable`)).json() as { raw: string }).raw).toContain('v1')

    // Invalid content is rejected BEFORE anything is written.
    expect((await put('never', { content: '---\npermissionDefaults: {"mcp__*__read": "allow"}\n---\n\nx' })).status).toBe(400)
    expect((await fetch(`${base}/api/workspaces/${wsId}/modes/never`)).status).toBe(404)

    // Bundled modes stay read-only; duplicating is the way to customize.
    expect((await put('plan', { content: '---\nname: "Hacked"\n---\n\nx' })).status).toBe(400)
    expect((await fetch(`${base}/api/workspaces/${wsId}/modes/plan`, { method: 'DELETE' })).status).toBe(400)
    const copy = await post(base, `/api/workspaces/${wsId}/modes/plan/duplicate`, { newId: 'plan-copy' })
    expect(copy.status).toBe(200)
    const copied = (await (await fetch(`${base}/api/workspaces/${wsId}/modes/plan-copy`)).json()) as { raw: string; source: string }
    expect(copied.source).toBe('workspace')
    expect(copied.raw).toContain('"Plan"')
    const planCatalog = (await (await fetch(`${base}/api/workspaces/${wsId}/modes`)).json()) as {
      id: string
      toolExposure: string[]
      permissionDefaults: Record<string, string>
    }[]
    const duplicated = planCatalog.find((mode) => mode.id === 'plan-copy')
    const bundled = planCatalog.find((mode) => mode.id === 'plan')
    expect(duplicated?.toolExposure).toEqual(bundled?.toolExposure)
    expect(duplicated?.permissionDefaults).toEqual(bundled?.permissionDefaults)

    expect((await fetch(`${base}/api/workspaces/${wsId}/modes/plan-copy`, { method: 'DELETE' })).status).toBe(200)
    expect((await fetch(`${base}/api/workspaces/${wsId}/modes/plan-copy`)).status).toBe(404)
  })

  it('rejects traversal and serializes optimistic mode mutations', async () => {
    const server = await start([])
    const base = server.url
    const wsId = (await (await fetch(`${base}/api/workspaces`)).json() as { id: string }[])[0]!.id
    const modeUrl = (id: string): string => `${base}/api/workspaces/${wsId}/modes/${id}`
    const put = (id: string, body: unknown): Promise<Response> => fetch(modeUrl(id), {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    const v1 = '---\nname: "V1"\n---\n\nv1'
    const v2 = '---\nname: "V2"\n---\n\nv2'

    // Creation has no prior file and therefore needs no hash.
    const created = await put('optimistic', { content: v1 })
    expect(created.status).toBe(200)
    const hash = ((await created.json()) as { hash: string }).hash
    // Existing files may only be replaced from a fresh read.
    expect((await put('optimistic', { content: v2 })).status).toBe(409)
    expect((await put('optimistic', { content: v2, expectedHash: hash })).status).toBe(200)

    const current = (await (await fetch(modeUrl('optimistic'))).json()) as { hash: string }
    const competing = await Promise.all([
      put('optimistic', { content: v1, expectedHash: current.hash }),
      put('optimistic', { content: v2, expectedHash: current.hash }),
    ])
    expect(competing.map((response) => response.status).sort()).toEqual([200, 409])

    // A supplied hash describes a former file; do not recreate a deleted one.
    await fetch(modeUrl('optimistic'), { method: 'DELETE' })
    expect((await put('optimistic', { content: v1, expectedHash: current.hash })).status).toBe(409)
    expect((await fetch(modeUrl('optimistic'))).status).toBe(404)
    expect((await fetch(modeUrl('optimistic'), { method: 'DELETE' })).status).toBe(404)

    // IDs are never path fragments: encoded separators and traversal cannot
    // access a file alongside the workspace's modes directory.
    const home = serverHomes.get(server)
    if (home === undefined) throw new Error('test server home is unavailable')
    const secret = path.join(home, 'workspaces', wsId, 'secret.md')
    await fs.writeFile(secret, 'outside modes', 'utf8')
    for (const attack of ['..%2Fsecret', '..%5Csecret', '%2E%2E%2Fsecret']) {
      expect((await fetch(modeUrl(attack))).status).toBe(400)
      expect((await fetch(modeUrl(attack), { method: 'DELETE' })).status).toBe(400)
    }
    await expect(fs.readFile(secret, 'utf8')).resolves.toBe('outside modes')
  })

  it('returns 204 rather than a false 404 before any request has a manifest', async () => {
    const server = await start([])
    const base = server.url
    const wsId = (await (await fetch(`${base}/api/workspaces`)).json() as { id: string }[])[0]!.id
    const { id } = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
    const response = await fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/manifest`)
    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
  })

  it('the manifest endpoint records mode/model/revision and omissions', async () => {
    const server = await start([{
      name: 'scripted', models: ['scripted'],
      async *stream() { yield { type: 'delta', delta: 'hi' } },
    }])
    const base = server.url
    const wsId = (await (await fetch(`${base}/api/workspaces`)).json() as { id: string }[])[0]!.id
    await fetch(`${base}/api/workspaces/${wsId}/mode`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modeId: 'chat' }),
    })
    const { id } = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
    await post(base, `/api/workspaces/${wsId}/sessions/${id}/messages`, { content: 'hello' })
    await new Promise((resolve) => setTimeout(resolve, 250))

    const manifest = (await (await fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/manifest`)).json()) as {
      modeId: string
      modeRevision: number
      sources: { toolSchemas: number }
      omissions: string[]
      budget: { estimated: boolean }
    }
    expect(manifest.modeId).toBe('chat')
    expect(manifest.sources.toolSchemas).toBe(0)
    expect(manifest.omissions.some((line) => line.includes('tool-schemas'))).toBe(true)
    expect(manifest.budget.estimated).toBe(true)
    expect(manifest.modeRevision).toBeGreaterThanOrEqual(2)
  })

  it('workspace meta exposes the selected mode; policy defaults come from the mode', async () => {
    let step = 0
    const server = await start([{
      name: 'scripted', models: ['scripted'],
      async *stream() {
        step += 1
        if (step === 1) { yield { type: 'toolCalls', calls: [{ id: 'revision-read', name: 'Read', args: { path: 'missing.txt' } }] }; return }
        yield { type: 'delta', delta: 'hi' }
      },
    }])
    const base = server.url
    const wsId = (await (await fetch(`${base}/api/workspaces`)).json() as { id: string }[])[0]!.id
    const policyRevision = server.kernel.ctx.tools.policyRevision
    const meta = (await (await fetch(`${base}/api/workspaces/${wsId}/meta`)).json()) as {
      mode: { id: string; revision: number }
      permissionDefaults: Record<string, string>
      yolo?: boolean
    }
    expect(meta.mode.id).toBe('ask-before-changes')
    expect(meta.permissionDefaults.Read).toBe('allow')
    expect(meta.permissionDefaults.Write).toBe('ask')
    expect(meta).not.toHaveProperty('policy')
    expect(meta).not.toHaveProperty('effectivePolicy')
    await fetch(`${base}/api/workspaces/${wsId}/mode`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modeId: 'full-access' }),
    })
    expect(server.kernel.ctx.tools.policyRevision).toBe(policyRevision + 1)
    const after = (await (await fetch(`${base}/api/workspaces/${wsId}/meta`)).json()) as {
      permissionDefaults: Record<string, string>
      mode: { id: string }
    }
    expect(after.mode.id).toBe('full-access')
    expect(after.permissionDefaults.Bash).toBe('allow')
    const session = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
    await post(base, `/api/workspaces/${wsId}/sessions/${session.id}/messages`, { content: 'read for audit revision' })
    const events = await waitForToolCall(base, wsId, session.id)
    const call = events.find((event) => event.type === 'tool/call') as { policyRevision?: number } | undefined
    expect(call?.policyRevision).toBe(policyRevision + 1)
  })

  it('retires non-empty workspace policy files without honoring their overrides', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g3-policy-'))
    const provider: LlmProvider = { name: 'scripted', models: ['scripted'], async *stream() { yield { type: 'delta', delta: 'hi' } } }
    let server: WebServer | undefined
    try {
      server = await createWebServer({ home, providers: [provider], configFile: path.join(home, 'p.json') })
      const wsId = (await (await fetch(`${server.url}/api/workspaces`)).json() as { id: string }[])[0]!.id
      await server.close()
      server = undefined
      const workspaceDir = path.join(home, 'workspaces', wsId)
      const valid = JSON.stringify({ v: 1, policy: { Bash: 'allow', Write: 'deny' } })
      await fs.writeFile(path.join(workspaceDir, 'policy.json'), valid, 'utf8')
      const malformedDir = path.join(home, 'workspaces', 'ws-malformed')
      const emptyDir = path.join(home, 'workspaces', 'ws-empty')
      const adoptedDir = path.join(home, 'workspaces', 'ws-adopted')
      const collisionDir = path.join(home, 'workspaces', 'ws-collision')
      await Promise.all([malformedDir, emptyDir, adoptedDir, collisionDir].map((dir) => fs.mkdir(dir, { recursive: true })))
      await fs.writeFile(path.join(malformedDir, 'policy.json'), JSON.stringify({ v: 1, policy: { Bash: 'nope' } }), 'utf8')
      await fs.writeFile(path.join(emptyDir, 'policy.json'), JSON.stringify({ v: 1, policy: {} }), 'utf8')
      await fs.writeFile(path.join(adoptedDir, 'policy.json'), JSON.stringify({ v: 1, policy: { Read: 'allow' } }), 'utf8')
      const collisionSource = JSON.stringify({ v: 1, policy: { Bash: 'deny' } })
      const collisionTarget = 'preserved earlier migration'
      await fs.writeFile(path.join(collisionDir, 'policy.json'), collisionSource, 'utf8')
      await fs.writeFile(path.join(collisionDir, 'policy.json.migrated'), collisionTarget, 'utf8')
      const warnings: string[] = []
      const warn = console.warn
      console.warn = (message: string): void => { warnings.push(message) }
      let copyAttempts = 0
      try {
        server = await createWebServer({
          home,
          providers: [provider],
          configFile: path.join(home, 'p.json'),
          policyRetirement: {
            copyExclusive: async (source, target) => {
              copyAttempts += 1
              if (copyAttempts < 3) {
                const error = new Error('transient lock') as NodeJS.ErrnoException
                error.code = copyAttempts === 1 ? 'EPERM' : 'EBUSY'
                throw error
              }
              await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL)
            },
            delay: async () => {},
          },
        })
      } finally {
        console.warn = warn
      }
      // Default plus adopted workspace: two transient failures, then one
      // successful exclusive copy for each valid policy file. The collision
      // also calls the exclusive operation once and returns EEXIST.
      expect(copyAttempts).toBe(5)
      expect(await fs.readFile(path.join(workspaceDir, 'policy.json.migrated'), 'utf8')).toBe(valid)
      await expect(fs.stat(path.join(workspaceDir, 'policy.json'))).rejects.toThrow()
      await expect(fs.stat(path.join(adoptedDir, 'policy.json.migrated'))).resolves.toBeDefined()
      await expect(fs.stat(path.join(malformedDir, 'policy.json'))).resolves.toBeDefined()
      await expect(fs.stat(path.join(emptyDir, 'policy.json'))).resolves.toBeDefined()
      expect(await fs.readFile(path.join(collisionDir, 'policy.json'), 'utf8')).toBe(collisionSource)
      expect(await fs.readFile(path.join(collisionDir, 'policy.json.migrated'), 'utf8')).toBe(collisionTarget)
      expect(warnings.join('\n')).toContain(wsId)
      expect(warnings.join('\n')).toContain('"Bash":"allow"')
      expect(warnings.join('\n')).toContain('ws-malformed')
      expect(warnings.join('\n')).toContain('ws-empty')
      expect(warnings.join('\n')).toContain('retained empty policy.json')
      await server.close()
      server = undefined
      // A second boot is a no-op after successful retirement.
      server = await createWebServer({ home, providers: [provider], configFile: path.join(home, 'p.json') })
      const meta = (await (await fetch(`${server.url}/api/workspaces/${wsId}/meta`)).json()) as { permissionDefaults: Record<string, string> }
      expect(meta.permissionDefaults.Bash).toBe('ask')
      expect((await fetch(`${server.url}/api/workspaces/${wsId}/policy`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ Bash: 'allow' }),
      })).status).toBe(404)
      expect((await fetch(`${server.url}/api/policy`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ Bash: 'allow' }),
      })).status).toBe(404)
    } finally {
      await server?.close().catch(() => {})
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  it('preserves both files when an exclusive retirement copy races a new migration target', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g3-policy-race-'))
    const provider: LlmProvider = { name: 'scripted', models: ['scripted'], async *stream() { yield { type: 'delta', delta: 'hi' } } }
    let server: WebServer | undefined
    try {
      server = await createWebServer({ home, providers: [provider], configFile: path.join(home, 'p.json') })
      const wsId = (await (await fetch(`${server.url}/api/workspaces`)).json() as { id: string }[])[0]!.id
      await server.close()
      server = undefined
      const workspaceDir = path.join(home, 'workspaces', wsId)
      const source = JSON.stringify({ v: 1, policy: { Bash: 'deny' } })
      const target = 'competing migration bytes'
      await fs.writeFile(path.join(workspaceDir, 'policy.json'), source, 'utf8')
      const warnings: string[] = []
      const warn = console.warn
      console.warn = (message: string): void => { warnings.push(message) }
      try {
        server = await createWebServer({
          home,
          providers: [provider],
          configFile: path.join(home, 'p.json'),
          policyRetirement: {
            copyExclusive: async (from, to) => {
              await fs.writeFile(to, target, 'utf8')
              const error = new Error('destination appeared') as NodeJS.ErrnoException
              error.code = 'EEXIST'
              throw error
            },
          },
        })
      } finally {
        console.warn = warn
      }
      expect(await fs.readFile(path.join(workspaceDir, 'policy.json'), 'utf8')).toBe(source)
      expect(await fs.readFile(path.join(workspaceDir, 'policy.json.migrated'), 'utf8')).toBe(target)
      expect(warnings.join('\n')).toContain(wsId)
      expect(warnings.join('\n')).toContain('already exists')
    } finally {
      await server?.close().catch(() => {})
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  it('stops after five transient exclusive-copy failures without losing the source', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g3-policy-exhaust-'))
    const provider: LlmProvider = { name: 'scripted', models: ['scripted'], async *stream() { yield { type: 'delta', delta: 'hi' } } }
    let server: WebServer | undefined
    try {
      server = await createWebServer({ home, providers: [provider], configFile: path.join(home, 'p.json') })
      const wsId = (await (await fetch(`${server.url}/api/workspaces`)).json() as { id: string }[])[0]!.id
      await server.close()
      server = undefined
      const workspaceDir = path.join(home, 'workspaces', wsId)
      const source = JSON.stringify({ v: 1, policy: { Bash: 'ask' } })
      await fs.writeFile(path.join(workspaceDir, 'policy.json'), source, 'utf8')
      let attempts = 0
      const warnings: string[] = []
      const warn = console.warn
      console.warn = (message: string): void => { warnings.push(message) }
      try {
        server = await createWebServer({
          home,
          providers: [provider],
          configFile: path.join(home, 'p.json'),
          policyRetirement: {
            copyExclusive: async () => {
              attempts += 1
              const error = new Error('always locked') as NodeJS.ErrnoException
              error.code = attempts % 2 === 0 ? 'EBUSY' : 'EPERM'
              throw error
            },
            delay: async () => {},
          },
        })
      } finally {
        console.warn = warn
      }
      expect(attempts).toBe(5)
      expect(await fs.readFile(path.join(workspaceDir, 'policy.json'), 'utf8')).toBe(source)
      await expect(fs.stat(path.join(workspaceDir, 'policy.json.migrated'))).rejects.toThrow()
      expect(warnings.join('\n')).toContain(wsId)
      expect(warnings.join('\n')).toContain('could not retire policy')
    } finally {
      await server?.close().catch(() => {})
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  it('--yolo preserves a custom mode deny rather than asking or allowing it', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g3-yolo-deny-'))
    const proj = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g3-yolo-deny-proj-'))
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream() { yield { type: 'toolCalls', calls: [{ id: 'b1', name: 'Bash', args: { command: 'printf bad' } }] } },
    }
    const server = await createWebServer({ home, providers: [provider], configFile: path.join(home, 'p.json'), yolo: true })
    try {
      const base = server.url
      const wsId = (await (await fetch(`${base}/api/workspaces`)).json() as { id: string }[])[0]!.id
      const raw = '---\nname: "No Bash"\ntoolExposure: ["Bash"]\npermissionDefaults: {"Bash": "deny"}\n---\n\nNo shell.'
      expect((await fetch(`${base}/api/workspaces/${wsId}/modes/no-bash`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: raw }),
      })).status).toBe(200)
      expect((await fetch(`${base}/api/workspaces/${wsId}/mode`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modeId: 'no-bash' }),
      })).status).toBe(200)
      const project = (await (await post(base, `/api/workspaces/${wsId}/projects`, { name: 'P', path: proj })).json()) as { id: string }
      const session = (await (await post(base, `/api/workspaces/${wsId}/sessions`, { projectId: project.id })).json()) as { id: string }
      void post(base, `/api/workspaces/${wsId}/sessions/${session.id}/messages`, { content: 'run bash' })
      const result = await waitForToolResult(base, wsId, session.id)
      expect(result.ok).toBe(false)
      expect(result.output).toMatch(/policy denies 'Bash'/)
    } finally {
      await server.close()
      await fs.rm(home, { recursive: true, force: true })
      await fs.rm(proj, { recursive: true, force: true })
    }
  })

  it('keeps omitted selected-mode keys on defaultMode under yolo', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g3-yolo-fallback-'))
    const projectRoot = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g3-yolo-fallback-proj-'))
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream() { yield { type: 'toolCalls', calls: [{ id: 'omitted-read', name: 'Read', args: { path: 'missing.txt' } }] } },
    }
    const server = await createWebServer({ home, providers: [provider], configFile: path.join(home, 'p.json'), yolo: true, defaultMode: 'deny' })
    try {
      const base = server.url
      const wsId = (await (await fetch(`${base}/api/workspaces`)).json() as { id: string }[])[0]!.id
      const raw = '---\nname: "Omitted"\ntoolExposure: ["Read"]\npermissionDefaults: {}\n---\n\nFallback only.'
      expect((await fetch(`${base}/api/workspaces/${wsId}/modes/omitted`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: raw }),
      })).status).toBe(200)
      expect((await fetch(`${base}/api/workspaces/${wsId}/mode`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modeId: 'omitted' }),
      })).status).toBe(200)
      const project = (await (await post(base, `/api/workspaces/${wsId}/projects`, { name: 'P', path: projectRoot })).json()) as { id: string }
      const session = (await (await post(base, `/api/workspaces/${wsId}/sessions`, { projectId: project.id })).json()) as { id: string }
      void post(base, `/api/workspaces/${wsId}/sessions/${session.id}/messages`, { content: 'read' })
      const result = await waitForToolResult(base, wsId, session.id)
      expect(result.ok).toBe(false)
      expect(result.output).toMatch(/policy denies 'Read'/)
    } finally {
      await server.close()
      await fs.rm(home, { recursive: true, force: true })
      await fs.rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('keeps omitted selected-mode keys on default ask under yolo', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g3-yolo-ask-fallback-'))
    const provider: LlmProvider = { name: 'scripted', models: ['scripted'], async *stream() { yield { type: 'toolCalls', calls: [{ id: 'omitted', name: 'Read', args: { path: 'missing.txt' } }] } } }
    const server = await createWebServer({ home, providers: [provider], configFile: path.join(home, 'p.json'), yolo: true })
    try {
      const base = server.url
      const wsId = (await (await fetch(`${base}/api/workspaces`)).json() as { id: string }[])[0]!.id
      const raw = '---\nname: "Omitted ask"\ntoolExposure: ["Read"]\npermissionDefaults: {}\n---\n\nFallback only.'
      await fetch(`${base}/api/workspaces/${wsId}/modes/omitted-ask`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: raw }) })
      await fetch(`${base}/api/workspaces/${wsId}/mode`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modeId: 'omitted-ask' }) })
      const session = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
      const events = await fetch(`${base}/api/workspaces/${wsId}/sessions/${session.id}/events`)
      void post(base, `/api/workspaces/${wsId}/sessions/${session.id}/messages`, { content: 'read' })
      await waitForApproval(events)
    } finally {
      await server.close()
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  it('--yolo skips mode ask defaults so Write runs without an approval question', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g3-yolo-'))
    const proj = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g3-yolo-proj-'))
    let step = 0
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream() {
        step += 1
        if (step === 1) {
          yield { type: 'toolCalls', calls: [{ id: 'w1', name: 'Write', args: { path: 'yolo.txt', content: 'ok' } }] }
          return
        }
        yield { type: 'delta', delta: 'wrote' }
      },
    }
    const server = await createWebServer({
      home, providers: [provider], configFile: path.join(home, 'p.json'), yolo: true,
    })
    servers.push(server)
    const base = server.url
    const wsId = (await (await fetch(`${base}/api/workspaces`)).json() as { id: string }[])[0]!.id
    const project = (await (await post(base, `/api/workspaces/${wsId}/projects`, { name: 'P', path: proj })).json()) as { id: string }
    const session = (await (await post(base, `/api/workspaces/${wsId}/sessions`, { projectId: project.id })).json()) as { id: string }
    const response = await fetch(`${base}/api/workspaces/${wsId}/sessions/${session.id}/events`)
    const reader = (response.body as ReadableStream).getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const kinds: string[] = []
    const deadline = Date.now() + 8_000
    void post(base, `/api/workspaces/${wsId}/sessions/${session.id}/messages`, { content: 'write' })
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), deadline - Date.now())),
      ])
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf('\n\n')
        const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
        if (dataLine === undefined) continue
        const envelope = JSON.parse(dataLine.slice('data: '.length)) as { kind: string; event?: { type?: string; ok?: boolean } }
        kinds.push(envelope.kind)
        if (envelope.kind === 'approval') throw new Error('yolo must not ask')
        if (envelope.kind === 'session' && envelope.event?.type === 'turn/end') {
          expect(kinds).not.toContain('approval')
          const written = await fs.readFile(path.join(proj, 'yolo.txt'), 'utf8')
          expect(written).toBe('ok')
          await reader.cancel().catch(() => {})
          return
        }
      }
    }
    throw new Error(`yolo write did not finish; saw ${kinds.join(',')}`)
  }, 15_000)
})

/** Read one session's events via a fresh snapshot connection. */
async function waitForApproval(response: Response): Promise<void> {
  const reader = (response.body as ReadableStream).getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + 6_000
  try {
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), deadline - Date.now())),
      ])
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf('\n\n')
        const data = frame.split('\n').find((line) => line.startsWith('data: '))
        if (data !== undefined && (JSON.parse(data.slice('data: '.length)) as { kind?: string }).kind === 'approval') return
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  throw new Error('no approval observed')
}

async function waitForToolCall(base: string, wsId: string, sessionId: string): Promise<{ type: string; [key: string]: unknown }[]> {
  const deadline = Date.now() + 6_000
  while (Date.now() < deadline) {
    const events = await readAllEvents(base, wsId, sessionId)
    if (events.some((event) => event.type === 'tool/call')) return events
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('no tool/call observed')
}

async function waitForToolResult(base: string, wsId: string, sessionId: string): Promise<{ ok: boolean; output: string }> {
  const deadline = Date.now() + 6_000
  while (Date.now() < deadline) {
    const events = await readAllEvents(base, wsId, sessionId)
    const result = events.find((event) => event.type === 'tool/result') as { ok?: boolean; output?: string } | undefined
    if (result !== undefined) return { ok: result.ok === true, output: result.output ?? '' }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('no tool/result observed')
}

async function readAllEvents(base: string, wsId: string, sessionId: string): Promise<{ type: string; [key: string]: unknown }[]> {
  const response = await fetch(`${base}/api/workspaces/${wsId}/sessions/${sessionId}/events`)
  const reader = (response.body as ReadableStream).getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + 6_000
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now()
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), remaining)),
      ])
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      const boundary = buffer.indexOf('\n\n')
      if (boundary >= 0) {
        const frame = buffer.slice(0, boundary)
        const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
        if (dataLine !== undefined) {
          const envelope = JSON.parse(dataLine.slice('data: '.length)) as { kind: string; events?: { type: string; [key: string]: unknown }[] }
          return envelope.kind === 'snapshot' ? (envelope.events ?? []) : []
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  return []
}
