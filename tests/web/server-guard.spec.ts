import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createWebServer, type LlmProvider, type WebServer } from 'dnt-harness'
import { DEFAULT_CONFIG } from '../../src/harness/guard/defaults.ts'
import type { DangerousCommandsConfig } from '../../src/harness/guard/types.ts'
import type { ToolDefinition } from '../../src/harness/tools/types.ts'

let home = ''
const servers: WebServer[] = []

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-guard-web-'))
})

afterAll(async () => {
  for (const s of servers) await s.close().catch(() => {})
  await fs.rm(home, { recursive: true, force: true })
})

async function start(): Promise<WebServer> {
  const h = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-guard-home-'))
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

// ── real host: live guard authority regression matrix ─────────────────────
// A booted createWebServer, a scripted provider, and a FAKE Bash tool swapped
// in for the real one (it records the command text and never spawns a shell).
// Every handshake is event driven: SSE frames wake waiters, and a guard save
// resolves only after its pending reevaluation has fully settled.

interface Frame {
  readonly kind: string
  readonly approvalId?: string
  readonly guardWarning?: string
  readonly event?: { readonly type: string; readonly ok?: boolean; readonly output?: string; readonly decision?: string; readonly [key: string]: unknown }
}

class Stream {
  readonly frames: Frame[] = []
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private readonly waiters = new Set<() => void>()
  private closed = false

  constructor(response: Response) {
    this.reader = (response.body as ReadableStream<Uint8Array>).getReader()
    void this.pump()
  }

  private async pump(): Promise<void> {
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (!this.closed) {
        const chunk = await this.reader.read()
        if (chunk.done) return
        buffer += decoder.decode(chunk.value, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const data = buffer.slice(0, boundary).split('\n').find((line) => line.startsWith('data: '))
          buffer = buffer.slice(boundary + 2)
          boundary = buffer.indexOf('\n\n')
          if (data !== undefined) this.frames.push(JSON.parse(data.slice('data: '.length)) as Frame)
        }
        for (const wake of [...this.waiters]) wake()
      }
    } catch {
      // closed
    }
  }

  /** Resolve when a frame at or after `from` matches; wakes on every arrival. */
  wait(predicate: (frame: Frame) => boolean, what: string, from = 0): Promise<Frame> {
    return new Promise<Frame>((resolve, reject) => {
      const check = (): boolean => {
        const found = this.frames.slice(from).find(predicate)
        if (found === undefined) return false
        this.waiters.delete(check)
        clearTimeout(failsafe)
        resolve(found)
        return true
      }
      const failsafe = setTimeout(() => {
        this.waiters.delete(check)
        reject(new Error(`timed out waiting for ${what}`))
      }, 10_000)
      this.waiters.add(check)
      check()
    })
  }

  close(): void {
    this.closed = true
    this.reader.cancel().catch(() => {})
  }
}

interface GuardHost {
  readonly web: WebServer
  readonly url: string
  readonly wsId: string
  /** Every command the fake Bash body ran. */
  readonly executed: string[]
}

interface Live {
  readonly id: string
  readonly workspaceId: string
  readonly stream: Stream
  /** Ask the scripted model to run one Bash command. */
  run(command: string): Promise<void>
  toolResult(from: number): Promise<Frame>
}

const liveStreams: Stream[] = []
const liveHomes: string[] = []

afterEach(() => {
  for (const stream of liveStreams.splice(0)) stream.close()
})

afterAll(async () => {
  for (const dir of liveHomes.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

function send(method: string, url: string, body?: unknown): Promise<Response> {
  return fetch(url, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
}

const scripted: LlmProvider = {
  name: 'scripted',
  models: ['scripted'],
  async *stream(request) {
    const lastUserIndex = request.messages.map((message) => message.role).lastIndexOf('user')
    const last = request.messages[lastUserIndex]
    const text = typeof last?.content === 'string' ? last.content : ''
    const answered = request.messages.slice(lastUserIndex).some((message) => message.role === 'tool')
    const command = /^run: ([\s\S]+)$/.exec(text)
    if (!answered && command !== null) {
      yield { type: 'toolCalls', calls: [{ id: `c-${randomUUID()}`, name: 'Bash', args: { command: command[1] } }] }
      yield { type: 'completion', finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }
      return
    }
    yield { type: 'delta', delta: 'done' }
    yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
  },
}

async function bootGuardHost(): Promise<GuardHost> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-guard-live-'))
  liveHomes.push(dir)
  const web = await createWebServer({ home: dir, providers: [scripted], configFile: path.join(dir, 'providers.json') })
  servers.push(web)
  const executed: string[] = []
  const fakeBash: ToolDefinition = {
    name: 'Bash',
    description: 'fake bash: records the command, never spawns a shell',
    requiresRoot: false,
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    async execute(args) {
      executed.push(String(args['command']))
      return `fake-ran: ${String(args['command'])}`
    },
  }
  // Replace the host's real Bash definition before any call can reach it.
  const registry = (web.kernel.ctx.tools as unknown as { tools: Map<string, ToolDefinition> }).tools
  expect(registry.has('Bash')).toBe(true)
  registry.set('Bash', fakeBash)
  const wsId = ((await (await fetch(`${web.url}/api/workspaces`)).json()) as { id: string }[])[0]!.id
  return { web, url: web.url, wsId, executed }
}

async function openSession(host: GuardHost, workspaceId: string, modeId?: string): Promise<Live> {
  const created = (await (await send('POST', `${host.url}/api/workspaces/${workspaceId}/sessions`, {})).json()) as { id: string }
  if (modeId !== undefined) {
    expect((await send('PUT', `${host.url}/api/workspaces/${workspaceId}/sessions/${created.id}/mode`, { modeId })).status).toBe(200)
  }
  const stream = new Stream(await fetch(`${host.url}/api/workspaces/${workspaceId}/sessions/${created.id}/events`))
  liveStreams.push(stream)
  await stream.wait((frame) => frame.kind === 'snapshot', 'snapshot')
  return {
    id: created.id,
    workspaceId,
    stream,
    async run(command) {
      expect((await send('POST', `${host.url}/api/workspaces/${workspaceId}/sessions/${created.id}/messages`, { content: `run: ${command}` })).status).toBeLessThan(300)
    },
    toolResult: (from) => stream.wait((frame) => frame.kind === 'session' && frame.event?.type === 'tool/result', 'tool result', from),
  }
}

async function setWorkspaceMode(host: GuardHost, workspaceId: string, modeId: string): Promise<void> {
  expect((await send('PUT', `${host.url}/api/workspaces/${workspaceId}/mode`, { modeId })).status).toBe(200)
}

/** Read-modify-write the workspace guard config; resolves after reevaluation. */
async function saveGuard(host: GuardHost, workspaceId: string, edit: (config: DangerousCommandsConfig) => DangerousCommandsConfig): Promise<number> {
  const current = (await (await fetch(`${host.url}/api/guard/dangerous-commands?workspaceId=${workspaceId}`)).json()) as { config: DangerousCommandsConfig; hash: string }
  const res = await send('PUT', `${host.url}/api/guard/dangerous-commands`, { workspaceId, config: edit(current.config), expectedHash: current.hash })
  return res.status
}

const setPreset = (preset: keyof DangerousCommandsConfig['presets'], action: 'deny' | 'ask' | 'off') =>
  (config: DangerousCommandsConfig): DangerousCommandsConfig => ({ ...config, presets: { ...config.presets, [preset]: action } })

const answer = (host: GuardHost, approvalId: string | undefined, allow: boolean): Promise<Response> =>
  send('POST', `${host.url}/api/approvals/${approvalId}`, { allow })

const isApproval = (frame: Frame): boolean => frame.kind === 'approval'
const decisions = (live: Live): Frame[] => live.stream.frames.filter((frame) => frame.event?.type === 'approval/decision')
const requests = (live: Live): Frame[] => live.stream.frames.filter((frame) => frame.event?.type === 'approval/request')

const DANGEROUS_ASK = 'git reset --hard HEAD~1'

describe('live guard authority on a real host (fake Bash)', () => {
  it('workspace Full access / root Ask: saving an UNCHANGED guard config leaves an innocuous Bash ask pending', async () => {
    const host = await bootGuardHost()
    await setWorkspaceMode(host, host.wsId, 'full-access')
    const root = await openSession(host, host.wsId, 'ask-before-changes')
    await root.run('echo innocuous')
    const question = await root.stream.wait(isApproval, 'approval')
    expect(question.guardWarning).toBeUndefined()

    expect(await saveGuard(host, host.wsId, (config) => config)).toBe(200)

    // The save awaited its reevaluation: no settlement and no body ran.
    expect(host.executed).toEqual([])
    expect(decisions(root)).toEqual([])
    // 200 (not 404) proves the question was still pending and answerable.
    expect((await answer(host, question.approvalId, true)).status).toBe(200)
    expect((await root.toolResult(0)).event?.ok).toBe(true)
    expect(host.executed).toEqual(['echo innocuous'])
    expect(decisions(root).map((frame) => frame.event?.decision)).toEqual(['allow'])
  }, 20_000)

  it('pending guard ask -> preset flipped to deny: the old allow answer stays denied, truthfully', async () => {
    const host = await bootGuardHost()
    await setWorkspaceMode(host, host.wsId, 'full-access')
    const root = await openSession(host, host.wsId)
    await root.run(DANGEROUS_ASK)
    const question = await root.stream.wait(isApproval, 'approval')
    expect(question.guardWarning).toMatch(/Git Destructive/)

    expect(await saveGuard(host, host.wsId, setPreset('gitDestructive', 'deny'))).toBe(200)

    // The question was retired by the save; a late allow cannot revive it.
    expect((await answer(host, question.approvalId, true)).status).toBe(404)
    const result = await root.toolResult(0)
    expect(result.event?.ok).toBe(false)
    expect(result.event?.output).toMatch(/^denied: blocked by Dangerous Commands: matched gitDestructive/)
    expect(host.executed).toEqual([])
    expect(decisions(root).map((frame) => frame.event?.decision)).toEqual(['deny'])
  }, 20_000)

  it('prepared under off -> deny saved before execute: the body never runs', async () => {
    const host = await bootGuardHost()
    await setWorkspaceMode(host, host.wsId, 'full-access')
    expect(await saveGuard(host, host.wsId, setPreset('gitDestructive', 'off'))).toBe(200)
    const root = await openSession(host, host.wsId)
    let reached = false
    let saveStatus: number | undefined
    // Registered after the host gates: runs only once the call was admitted.
    host.web.kernel.ctx.on('tools/pre-execute', async (payload, next) => {
      if (payload.call.name === 'Bash') {
        reached = true
        saveStatus = await saveGuard(host, host.wsId, setPreset('gitDestructive', 'deny'))
      }
      return next()
    })
    await root.run(DANGEROUS_ASK)
    const result = await root.toolResult(0)
    expect(reached).toBe(true)
    expect(saveStatus).toBe(200)
    expect(result.event?.ok).toBe(false)
    expect(result.event?.output).toMatch(/^denied: blocked by Dangerous Commands: matched gitDestructive/)
    expect(host.executed).toEqual([])
    expect(requests(root)).toEqual([])
  }, 20_000)

  it('prepared under off -> ask saved before execute, no human answer: final gate refuses and opens no question', async () => {
    const host = await bootGuardHost()
    await setWorkspaceMode(host, host.wsId, 'full-access')
    expect(await saveGuard(host, host.wsId, setPreset('gitDestructive', 'off'))).toBe(200)
    const root = await openSession(host, host.wsId)
    let saveStatus: number | undefined
    host.web.kernel.ctx.on('tools/pre-execute', async (payload, next) => {
      if (payload.call.name === 'Bash') saveStatus = await saveGuard(host, host.wsId, setPreset('gitDestructive', 'ask'))
      return next()
    })
    await root.run(DANGEROUS_ASK)
    const result = await root.toolResult(0)
    expect(saveStatus).toBe(200)
    expect(result.event?.ok).toBe(false)
    expect(result.event?.output).toMatch(/^denied: current authority requires fresh approval for 'Bash'/)
    expect(requests(root)).toEqual([])
    expect(root.stream.frames.some(isApproval)).toBe(false)
    expect(host.executed).toEqual([])
  }, 20_000)

  it('ask -> off in a mode that itself asks: only the guard requirement drops; the mode ask still needs an answer', async () => {
    const host = await bootGuardHost()
    // Root Ask-before-changes (Bash: ask); the dangerous command adds a guard ask on top.
    const root = await openSession(host, host.wsId, 'ask-before-changes')
    await root.run(DANGEROUS_ASK)
    const question = await root.stream.wait(isApproval, 'approval')
    expect(question.guardWarning).toMatch(/Git Destructive/)

    expect(await saveGuard(host, host.wsId, setPreset('gitDestructive', 'off'))).toBe(200)

    expect(host.executed).toEqual([])
    expect(decisions(root)).toEqual([])
    expect((await answer(host, question.approvalId, true)).status).toBe(200)
    expect((await root.toolResult(0)).event?.ok).toBe(true)
    expect(host.executed).toEqual([DANGEROUS_ASK])
  }, 20_000)

  it('ask -> off where the guard was the ONLY ask: the requirement drops and the question settles itself', async () => {
    const host = await bootGuardHost()
    await setWorkspaceMode(host, host.wsId, 'full-access')
    const root = await openSession(host, host.wsId)
    await root.run(DANGEROUS_ASK)
    const question = await root.stream.wait(isApproval, 'approval')

    expect(await saveGuard(host, host.wsId, setPreset('gitDestructive', 'off'))).toBe(200)

    expect((await root.toolResult(0)).event?.ok).toBe(true)
    expect(host.executed).toEqual([DANGEROUS_ASK])
    expect((await answer(host, question.approvalId, true)).status).toBe(404)
  }, 20_000)

  it('a guard save in workspace A never settles or alters a pending ask in workspace B', async () => {
    const host = await bootGuardHost()
    // A (the default workspace) runs Full access: an ambient-scope fallback
    // would wrongly auto-approve B's mode-level ask.
    await setWorkspaceMode(host, host.wsId, 'full-access')
    const other = ((await (await send('POST', `${host.url}/api/workspaces`, { name: 'Other' })).json()) as { id: string }).id
    const inB = await openSession(host, other)
    await inB.run(DANGEROUS_ASK)
    const question = await inB.stream.wait(isApproval, 'approval in B')

    // Saves in A: unchanged, then a deny for the very preset B's call matched.
    expect(await saveGuard(host, host.wsId, (config) => config)).toBe(200)
    expect(await saveGuard(host, host.wsId, setPreset('gitDestructive', 'deny'))).toBe(200)

    expect(host.executed).toEqual([])
    expect(decisions(inB)).toEqual([])
    expect((await answer(host, question.approvalId, true)).status).toBe(200)
    expect((await inB.toolResult(0)).event?.ok).toBe(true)
    expect(host.executed).toEqual([DANGEROUS_ASK])
  }, 20_000)

  it('an UNRELATED guard edit keeps a pending guard ask answerable and its receipt valid', async () => {
    const host = await bootGuardHost()
    await setWorkspaceMode(host, host.wsId, 'full-access')
    const root = await openSession(host, host.wsId)
    await root.run(DANGEROUS_ASK)
    const question = await root.stream.wait(isApproval, 'approval')

    expect(await saveGuard(host, host.wsId, setPreset('dbDestructive', 'off'))).toBe(200)

    expect(decisions(root)).toEqual([])
    expect((await answer(host, question.approvalId, true)).status).toBe(200)
    const result = await root.toolResult(0)
    expect(result.event?.ok).toBe(true)
    expect(host.executed).toEqual([DANGEROUS_ASK])
  }, 20_000)

  it('a change to the MATCHED rule invalidates the receipt: the answered call is refused for fresh approval', async () => {
    const host = await bootGuardHost()
    await setWorkspaceMode(host, host.wsId, 'full-access')
    const rule = (pattern: string) => (config: DangerousCommandsConfig): DangerousCommandsConfig => ({
      ...config,
      customRules: [{ id: 'cr-deploy', pattern, isRegex: false, action: 'ask' as const }],
    })
    expect(await saveGuard(host, host.wsId, rule('deploy-prod'))).toBe(200)
    const root = await openSession(host, host.wsId)
    await root.run('deploy-prod now')
    const question = await root.stream.wait(isApproval, 'approval')

    // Same rule id, still matches, but the matched pattern changed.
    expect(await saveGuard(host, host.wsId, rule('deploy-pr'))).toBe(200)

    expect((await answer(host, question.approvalId, true)).status).toBe(200)
    const result = await root.toolResult(0)
    expect(result.event?.ok).toBe(false)
    expect(result.event?.output).toMatch(/^denied: current authority requires fresh approval for 'Bash'/)
    expect(host.executed).toEqual([])
  }, 20_000)
})
