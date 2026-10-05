/**
 * Task 4: one host exposure resolver. Schema projection, spawn admission, the
 * pre-execute gate, and the final gate ask the same predicate, and Plan MCP
 * exposure requires a concrete non-empty allowlist entry plus a read-safe name.
 * Exposure is never a permission grant.
 *
 * Hermetic tests cover the predicate and resolver contract. The wiring (the
 * final-gate listener and the spawn-admission ceiling in src/web/server.ts) is
 * covered only by the "real host" suites below, which drive a booted
 * createWebServer with fabricated calls.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { createWebServer, serializeModeFile, type LlmProvider, type ModelRequest, type WebServer } from 'dnt-harness'
import {
  createExecutionAuthority,
  exposureRefusal,
  isToolExposed,
  type ExposureMode,
  type ExposureScope,
  type ExposureSnapshot,
} from '../../src/web/execution-authority.ts'
import type { McpConfig, McpServerConfig } from '../../src/harness/mcp/config.ts'
import type { ModeDefinition } from '../../src/harness/modes/types.ts'

// ── hermetic matrix ──────────────────────────────────────────────

const PLAN: ExposureMode = { id: 'plan', name: 'Plan', toolExposure: ['Read', 'Glob', 'Grep', 'Agent'] }
const FULL: ExposureMode = { id: 'full-access', name: 'Full access', toolExposure: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'Agent'] }
const ZERO: ExposureMode = { id: 'zero', name: 'Zero', toolExposure: [] }

function server(name: string, enabled: boolean, allowedTools?: string[]): McpServerConfig {
  return { name, transport: 'stdio', command: 'x', enabled, ...(allowedTools !== undefined ? { allowedTools } : {}) } as McpServerConfig
}

function config(servers: McpServerConfig[]): McpConfig {
  return { version: 2, servers: Object.fromEntries(servers.map((entry) => [entry.name, entry])) }
}

const MCP_TOOLS = ['mcp__s__get_item', 'mcp__s__delete_item', 'mcp__s__list_items']
const BUILTINS = ['Read', 'Write', 'Bash', 'Agent']
const ALL = [...BUILTINS, ...MCP_TOOLS, 'mcp__off__get_item', 'mcp__missing__get_item']

function snap(mode: ExposureMode, servers: McpServerConfig[], blockedTools: string[] = []): ExposureSnapshot {
  return { blockedTools, mode, modeRevision: 1, mcp: config(servers) }
}

const ROOT: ExposureScope = { workspaceId: 'w', sessionId: 'r', rootSessionId: 'r' }

describe('Plan MCP exposure (concrete allowlist + read-safe name)', () => {
  const exposedIn = (mode: ExposureMode, allowed: string[] | undefined) =>
    ALL.filter((name) => isToolExposed(snap(mode, [server('s', true, allowed), server('off', false, ['get_item'])]), ROOT, name))
      .filter((name) => name.startsWith('mcp__'))

  it('omitted allowlist: general modes expose all, Plan exposes none', () => {
    expect(exposedIn(FULL, undefined)).toEqual(MCP_TOOLS)
    expect(exposedIn(PLAN, undefined)).toEqual([])
  })

  it('empty allowlist: general modes expose all, Plan exposes none', () => {
    expect(exposedIn(FULL, [])).toEqual(MCP_TOOLS)
    expect(exposedIn(PLAN, [])).toEqual([])
  })

  it('bare tool name entry exposes only that read-safe tool in Plan', () => {
    expect(exposedIn(PLAN, ['get_item'])).toEqual(['mcp__s__get_item'])
  })

  it('full public name entry exposes that read-safe tool in Plan', () => {
    expect(exposedIn(PLAN, ['mcp__s__list_items'])).toEqual(['mcp__s__list_items'])
  })

  it('nonmatching allowlist exposes nothing in Plan and filters general modes', () => {
    expect(exposedIn(PLAN, ['something_else'])).toEqual([])
    expect(exposedIn(FULL, ['something_else'])).toEqual([])
  })

  it('an allowlisted unsafe-prefix tool stays hidden in Plan but exposed elsewhere', () => {
    expect(exposedIn(PLAN, ['delete_item', 'get_item'])).toEqual(['mcp__s__get_item'])
    expect(exposedIn(FULL, ['delete_item'])).toEqual(['mcp__s__delete_item'])
  })

  it('a disabled or unknown server exposes nothing, even when allowlisted', () => {
    const state = snap(FULL, [server('off', false, ['get_item'])])
    expect(isToolExposed(state, ROOT, 'mcp__off__get_item')).toBe(false)
    expect(exposureRefusal(state, ROOT, 'mcp__off__get_item')).toMatch(/not enabled/)
    expect(isToolExposed(state, ROOT, 'mcp__missing__get_item')).toBe(false)
  })

  it('zero toolExposure means no MCP', () => {
    expect(exposedIn(ZERO, ['get_item'])).toEqual([])
  })

  it('Explorer children get no MCP even when the ceiling lists it', () => {
    const scope: ExposureScope = { ...ROOT, sessionId: 'c', childOf: { definition: 'explorer', toolCeiling: ['Read', 'mcp__s__get_item'] } }
    const state = snap(FULL, [server('s', true, ['get_item'])])
    expect(exposureRefusal(state, scope, 'mcp__s__get_item')).toMatch(/Explorer/)
    expect(isToolExposed(state, scope, 'Read')).toBe(true)
  })

  it('host blockedTools globs win first, and a child cannot call Agent', () => {
    const state = snap(FULL, [server('s', true)], ['mcp__*__get_*', 'Bash'])
    expect(exposureRefusal(state, ROOT, 'mcp__s__get_item')).toMatch(/host blockedTools/)
    expect(exposureRefusal(state, ROOT, 'Bash')).toMatch(/host blockedTools/)
    const child: ExposureScope = { ...ROOT, sessionId: 'c', childOf: { definition: 'worker', toolCeiling: ['Read', 'Agent'] } }
    expect(exposureRefusal(state, child, 'Agent')).toMatch(/cannot delegate/)
    expect(exposureRefusal(state, child, 'Write')).toMatch(/definition ceiling/)
  })
})

describe('resolver contract (hermetic; wiring is covered by the real-host suites)', () => {
  it('refuses a scope without a workspace identity (host scope required), after host blockedTools', async () => {
    const authority = createExecutionAuthority({
      blockedTools: ['Bash'],
      modeOf: () => ({ mode: FULL, revision: 1 }),
      loadMcp: async () => config([server('s', true)]),
    })
    expect(await authority.refusal(undefined, 'Read')).toMatch(/host execution scope required/)
    expect(await authority.refusal({ sessionId: 'r' }, 'mcp__s__get_item')).toMatch(/host execution scope required/)
    expect(await authority.refusal({ rootSessionId: 'r' }, 'Write')).toMatch(/host execution scope required/)
    // The host blockedTools deny stays the outermost, most specific reason.
    expect(await authority.refusal(undefined, 'Bash')).toMatch(/host blockedTools/)
    // A complete host scope is evaluated normally.
    expect(await authority.refusal(ROOT, 'Read')).toBeUndefined()
  })

  it('stale fabricated call: the live gate reads current authority, not a prior projection', async () => {
    let allowed: string[] | undefined = ['get_item']
    let mode = PLAN
    const authority = createExecutionAuthority({
      blockedTools: [],
      modeOf: () => ({ mode, revision: 1 }),
      loadMcp: async () => config([server('s', true, allowed)]),
    })
    expect(await authority.refusal(ROOT, 'mcp__s__get_item')).toBeUndefined()
    allowed = []
    expect(await authority.refusal(ROOT, 'mcp__s__get_item')).toMatch(/Plan/)
    allowed = ['get_item']
    mode = ZERO
    expect(await authority.refusal(ROOT, 'mcp__s__get_item')).toMatch(/exposes no MCP/)
    expect(await authority.refusal(ROOT, 'mcp__never__registered')).toMatch(/exposes no MCP/)
  })

  it('admission keeps bounded revision recheck and fails closed on persistent churn', async () => {
    let revision = 0
    const authority = createExecutionAuthority({
      blockedTools: [],
      modeOf: () => ({ mode: FULL, revision: (revision += 1) }),
      loadMcp: async () => config([server('s', true)]),
    })
    await expect(authority.admissionCeiling({ workspaceId: 'w', rootSessionId: 'r', definition: 'worker', candidates: ['Read'] }))
      .rejects.toThrow(/changed repeatedly/)
    // A single transient change is retried and then succeeds.
    let calls = 0
    const settling = createExecutionAuthority({
      blockedTools: [],
      modeOf: () => { calls += 1; return { mode: FULL, revision: calls <= 1 ? 1 : 2 } },
      loadMcp: async () => config([server('s', true)]),
    })
    expect(await settling.admissionCeiling({ workspaceId: 'w', rootSessionId: 'r', definition: 'worker', candidates: ['Read', 'Agent'] }))
      .toEqual(['Read']) // child cannot call Agent
  })

  it('exposure never implies permission: the resolver exposes no allow/ask surface', () => {
    const authority = createExecutionAuthority({ blockedTools: [], modeOf: () => ({ mode: FULL, revision: 1 }), loadMcp: async () => config([]) })
    expect(Object.keys(authority).sort()).toEqual(['admissionCeiling', 'refusal', 'snapshot', 'stableModeRead'])
  })
})

// ── real host: schema projection and stale fabricated MCP call in Plan ──

const mcpFixture = fileURLToPath(new URL('../fixtures/mcp-stdio-server.mjs', import.meta.url))
const servers: WebServer[] = []
const homes: string[] = []

afterAll(async () => {
  for (const running of servers) await running.close().catch(() => {})
  for (const home of homes) await fs.rm(home, { recursive: true, force: true })
})

async function post(base: string, pathname: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
}

async function put(base: string, pathname: string, body: unknown): Promise<Response> {
  return fetch(`${base}${pathname}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

async function bootPlan(
  provider: LlmProvider,
  allowedTools: string[] | undefined,
  options: { modeId?: string; env?: Record<string, string> } = {},
) {
  const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-hardening-'))
  homes.push(home)
  const web = await createWebServer({ home, providers: [provider], configFile: path.join(home, 'p.json') })
  servers.push(web)
  const base = web.url
  const wsId = ((await (await fetch(`${base}/api/workspaces`)).json()) as { id: string }[])[0]!.id
  expect((await post(base, `/api/workspaces/${wsId}/mcp/fixture`, {
    transport: 'stdio', command: process.execPath, args: [mcpFixture], enabled: true,
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(allowedTools !== undefined ? { allowedTools } : {}),
  })).status).toBe(201)
  expect((await post(base, `/api/workspaces/${wsId}/mcp/fixture/enable`)).status).toBe(200)
  expect((await put(base, `/api/workspaces/${wsId}/mode`, { modeId: options.modeId ?? 'plan' })).status).toBe(200)
  return { web, base, wsId }
}

async function sessionEvents(base: string, workspaceId: string, sessionId: string): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${base}/api/workspaces/${workspaceId}/sessions/${sessionId}/events`)
  const reader = (response.body as ReadableStream).getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      const boundary = buffer.indexOf('\n\n')
      if (boundary < 0) continue
      const data = buffer.slice(0, boundary).split('\n').find((line) => line.startsWith('data: '))
      if (data === undefined) { buffer = buffer.slice(boundary + 2); continue }
      const envelope = JSON.parse(data.slice(6)) as { kind: string; events?: Record<string, unknown>[] }
      return envelope.kind === 'snapshot' ? (envelope.events ?? []) : []
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  return []
}

async function runPlanTurn(allowedTools: string[] | undefined, awaitResult = true): Promise<{ tools: string[]; result: string | undefined }> {
  let step = 0
  let tools: string[] = []
  const provider: LlmProvider = {
    name: 'scripted', models: ['scripted'],
    async *stream(request) {
      step += 1
      if (step === 1) {
        tools = (request.tools ?? []).map((tool) => tool.name)
        // Fabricated call regardless of what the schema exposed.
        yield { type: 'toolCalls', calls: [{ id: 'fab', name: 'mcp__fixture__query', args: { q: 'x' } }] }
        yield { type: 'completion', finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }
        return
      }
      yield { type: 'delta', delta: 'done' }
      yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
    },
  }
  const { base, wsId } = await bootPlan(provider, allowedTools)
  const session = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
  await post(base, `/api/workspaces/${wsId}/sessions/${session.id}/messages`, { content: 'go' })
  let result: string | undefined
  for (let i = 0; awaitResult && i < 40 && result === undefined; i++) {
    const events = await sessionEvents(base, wsId, session.id)
    const found = events.find((event) => event['type'] === 'tool/result')
    if (found !== undefined) result = String(found['output'])
    else await new Promise((resolve) => setTimeout(resolve, 150))
  }
  for (let i = 0; i < 50 && tools.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 100))
  return { tools, result }
}

describe('real host Plan MCP', () => {
  it('omitted allowlist: no MCP schema in Plan and a fabricated call is denied', async () => {
    const { tools, result } = await runPlanTurn(undefined)
    expect(tools).not.toContain('mcp__fixture__query')
    expect(result).toMatch(/Plan/)
  }, 30_000)

  it('empty allowlist: no MCP schema in Plan and a fabricated call is denied', async () => {
    const { tools, result } = await runPlanTurn([])
    expect(tools).not.toContain('mcp__fixture__query')
    expect(result).toMatch(/Plan/)
  }, 30_000)

  it('concrete read-safe allowlist entry: schema is exposed (permission still asks)', async () => {
    const { tools } = await runPlanTurn(['query'], false)
    expect(tools).toContain('mcp__fixture__query')
    expect(tools).not.toContain('mcp__fixture__explode')
  }, 30_000)
})


// ── real host wiring: final-gate listener and spawn-admission ceiling ──
// These drive the booted server (src/web/server.ts) with FABRICATED calls, so
// they fail if the final-gate listener or the admission resolver stop asking
// the shared authority. They are additive: the hermetic matrix cannot see them.

const ZERO_MODE: ModeDefinition = {
  id: 'zero-exposure',
  name: 'Zero exposure',
  instructions: 'Converse only.',
  sources: { history: 'compact', workspaceInstructions: false, skills: 'off', memoryPinned: false, memoryRetrieval: false },
  toolExposure: [],
  permissionDefaults: {},
}

const ASK_MODE: ModeDefinition = {
  ...ZERO_MODE,
  id: 'ask-mcp',
  name: 'Ask MCP',
  toolExposure: [...FULL.toolExposure],
  permissionDefaults: { 'mcp__fixture__query': 'ask' },
}

const MCP_WILDCARD_DENY_MODE: ModeDefinition = {
  ...ASK_MODE,
  id: 'deny-mcp-wildcard',
  name: 'Deny MCP wildcard',
  permissionDefaults: { 'mcp__fixture__*': 'deny', '*': 'allow' },
}

const CATCH_ALL_DENY_MODE: ModeDefinition = {
  ...ASK_MODE,
  id: 'deny-catch-all',
  name: 'Deny catch-all',
  permissionDefaults: { '*': 'deny' },
}

async function effectFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-hardening-fx-'))
  homes.push(dir)
  return path.join(dir, 'side-effects.log')
}

const readEffects = (file: string): Promise<string> => fs.readFile(file, 'utf8').catch(() => '')

/**
 * A full-access root fabricates `mcp__fixture__query`. A listener registered
 * AFTER the host gates runs only if the first pre-execute exposure gate
 * admitted the call; it then saves the narrowing mode on the root, i.e. between
 * prepare and execute. The final-gate listener must refuse at execute time.
 */
async function runFinalGateTurn(narrow: 'none' | 'plan' | 'zero' | 'ask' | 'mcp-wildcard-deny' | 'catch-all-deny'): Promise<{ reached: boolean; narrowStatus: number | undefined; result: string | undefined; effects: string; approvalRequests: number }> {
  const effects = await effectFile()
  let step = 0
  const provider: LlmProvider = {
    name: 'scripted', models: ['scripted'],
    async *stream() {
      step += 1
      if (step === 1) {
        yield { type: 'toolCalls', calls: [{ id: 'fab', name: 'mcp__fixture__query', args: { q: 'x' } }] }
        yield { type: 'completion', finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }
        return
      }
      yield { type: 'delta', delta: 'done' }
      yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
    },
  }
  const { web, base, wsId } = await bootPlan(provider, undefined, { modeId: 'full-access', env: { SIDE_EFFECT_FILE: effects } })
  const customMode = narrow === 'zero' ? ZERO_MODE
    : narrow === 'ask' ? ASK_MODE
      : narrow === 'mcp-wildcard-deny' ? MCP_WILDCARD_DENY_MODE
        : narrow === 'catch-all-deny' ? CATCH_ALL_DENY_MODE
          : undefined
  if (customMode !== undefined) {
    expect((await put(base, `/api/workspaces/${wsId}/modes/${customMode.id}`, { content: serializeModeFile(customMode) })).status).toBe(200)
  }
  const session = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
  let reached = false
  let narrowStatus: number | undefined
  web.kernel.ctx.on('tools/pre-execute', async (payload, next) => {
    if (payload.call.name === 'mcp__fixture__query') {
      reached = true
      if (narrow !== 'none') {
        const modeId = narrow === 'plan' ? 'plan' : customMode!.id
        narrowStatus = (await put(base, `/api/workspaces/${wsId}/sessions/${session.id}/mode`, { modeId })).status
      }
    }
    return next()
  })
  await post(base, `/api/workspaces/${wsId}/sessions/${session.id}/messages`, { content: 'go' })
  let result: string | undefined
  for (let i = 0; i < 60 && result === undefined; i++) {
    const found = (await sessionEvents(base, wsId, session.id)).find((event) => event['type'] === 'tool/result')
    if (found !== undefined) result = String(found['output'])
    else await new Promise((resolve) => setTimeout(resolve, 150))
  }
  const events = await sessionEvents(base, wsId, session.id)
  return { reached, narrowStatus, result, effects: await readEffects(effects), approvalRequests: events.filter((event) => event['type'] === 'approval/request').length }
}

describe('real host final gate (src/web/server.ts tools/final-gate)', () => {
  it('control: unnarrowed full-access root executes the MCP call (the narrowing tests are not vacuous)', async () => {
    const run = await runFinalGateTurn('none')
    expect(run.reached).toBe(true)
    expect(run.result).toMatch(/result:x/)
    expect(run.effects).toContain('query')
  }, 30_000)

  it('Plan without an allowlist, saved between prepare and execute: the fabricated call is denied truthfully and never reaches the server', async () => {
    const run = await runFinalGateTurn('plan')
    // The first (pre-execute) exposure gate admitted it; only the final gate could refuse.
    expect(run.reached).toBe(true)
    expect(run.narrowStatus).toBe(200)
    expect(run.result).toMatch(/^denied: mode 'Plan' does not expose MCP tool 'mcp__fixture__query'/)
    expect(run.effects).toBe('')
  }, 30_000)

  it('zero-exposure mode, saved between prepare and execute: the fabricated call is denied truthfully and never reaches the server', async () => {
    const run = await runFinalGateTurn('zero')
    expect(run.reached).toBe(true)
    expect(run.narrowStatus).toBe(200)
    expect(run.result).toMatch(/^denied: mode 'Zero exposure' exposes no MCP tools/)
    expect(run.effects).toBe('')
  }, 30_000)

  it('allow to ask between prepare and execute denies non-interactively without opening a question', async () => {
    const run = await runFinalGateTurn('ask')
    expect(run.result).toMatch(/^denied: current authority requires fresh approval/)
    expect(run.approvalRequests).toBe(0)
    expect(run.effects).toBe('')
  }, 30_000)

  it.each([
    ['mcp-wildcard-deny', MCP_WILDCARD_DENY_MODE.name],
    ['catch-all-deny', CATCH_ALL_DENY_MODE.name],
  ] as const)('%s between prepare and execute denies the MCP call', async (narrow, _name) => {
    const run = await runFinalGateTurn(narrow)
    expect(run.result).toMatch(/^denied: tool policy denies this call/)
    expect(run.approvalRequests).toBe(0)
    expect(run.effects).toBe('')
  }, 30_000)
})

const MCP_WORKER_ROLE = [
  '---',
  'description: "Worker that may be granted the fixture MCP tool"',
  'tools: ["Read", "Glob", "Grep", "Write", "mcp__fixture__query"]',
  '---',
  'Implement exactly the brief.',
].join('\n')

const systemText = (request: ModelRequest): string => {
  const first = request.messages[0]
  return typeof first?.content === 'string' ? first.content : ''
}

interface ChildRun {
  readonly schemas: string[]
  /** tool/result output by model call id. */
  readonly outputs: Record<string, string>
  readonly effects: string
}

/**
 * Spawn a child from a root in `rootMode` through the real spawn route (the
 * executor's admission resolver -> shared authority). The child's first model
 * request records its schemas and, optionally after the root switched mode,
 * fabricates `calls`.
 */
async function runChild(options: {
  rootMode: string
  role: 'mcp-worker' | 'explorer'
  grantTools: string[]
  calls: { id: string; name: string; args: Record<string, unknown> }[]
  switchRootTo?: string
}): Promise<ChildRun> {
  const effects = await effectFile()
  const schemas: string[] = []
  let step = 0
  let release: () => void = () => {}
  let markStarted: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { markStarted = resolve })
  const provider: LlmProvider = {
    name: 'scripted', models: ['scripted'],
    async *stream(request) {
      if (!systemText(request).includes('You are a subagent')) {
        yield { type: 'delta', delta: 'root' }
        yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
        return
      }
      step += 1
      if (step === 1) {
        schemas.push(...(request.tools ?? []).map((tool) => tool.name))
        markStarted()
        if (options.switchRootTo !== undefined) await gate
        yield { type: 'toolCalls', calls: options.calls }
        yield { type: 'completion', finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }
        return
      }
      yield { type: 'delta', delta: 'child done' }
      yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
    },
  }
  const { base, wsId } = await bootPlan(provider, undefined, { modeId: options.rootMode, env: { SIDE_EFFECT_FILE: effects } })
  if (options.role === 'mcp-worker') {
    expect((await post(base, `/api/workspaces/${wsId}/agents/mcp-worker/import`, { dialect: 'dnt-harness', content: MCP_WORKER_ROLE })).status).toBe(201)
  }
  const root = (await (await post(base, `/api/workspaces/${wsId}/sessions`)).json()) as { id: string }
  const spawned = await post(base, `/api/workspaces/${wsId}/agents/${options.role}`, {
    rootSessionId: root.id, task: { prompt: 'Query it.' }, grantTools: options.grantTools,
  })
  expect(spawned.status).toBe(202)
  const child = (await spawned.json()) as { childSessionId: string }
  await started
  if (options.switchRootTo !== undefined) {
    // Widen the ROOT after admission pinned the child's ceiling.
    expect((await put(base, `/api/workspaces/${wsId}/sessions/${root.id}/mode`, { modeId: options.switchRootTo })).status).toBe(200)
    release()
  }
  await fetch(`${base}/api/workspaces/${wsId}/sessions/${root.id}/children/${child.childSessionId}?waitMs=10000`)
  const outputs: Record<string, string> = {}
  for (let i = 0; i < 60 && Object.keys(outputs).length < options.calls.length; i++) {
    for (const event of await sessionEvents(base, wsId, child.childSessionId)) {
      if (event['type'] === 'tool/result') outputs[String(event['callId'])] = String(event['output'])
    }
    if (Object.keys(outputs).length < options.calls.length) await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return { schemas, outputs, effects: await readEffects(effects) }
}

const QUERY_CALL = { id: 'fab-mcp', name: 'mcp__fixture__query', args: { q: 'x' } }

describe('real host spawn-admission ceiling (executor admissionResolver -> shared authority)', () => {
  it('control: full-access root + explicit MCP grant on a role that lists it: the child is admitted and the call executes', async () => {
    const run = await runChild({ rootMode: 'full-access', role: 'mcp-worker', grantTools: ['Read', 'mcp__fixture__query'], calls: [QUERY_CALL] })
    expect(run.schemas).toContain('mcp__fixture__query')
    expect(run.outputs['fab-mcp']).toMatch(/result:x/)
    expect(run.effects).toContain('query')
  }, 40_000)

  it('Plan root spawns a worker with an explicit MCP grant for an enabled tool: admission pins a ceiling without it, even after the root widens', async () => {
    const run = await runChild({
      rootMode: 'plan', role: 'mcp-worker', grantTools: ['Read', 'mcp__fixture__query'],
      calls: [QUERY_CALL], switchRootTo: 'full-access',
    })
    expect(run.schemas).not.toContain('mcp__fixture__query')
    // The root is now full-access, whose live gate would expose the tool; only
    // the pinned admission ceiling can refuse it, with the ceiling's own reason.
    expect(run.outputs['fab-mcp']).toMatch(/^denied: agent 'mcp-worker' does not expose 'mcp__fixture__query' \(definition ceiling\)/)
    expect(run.effects).toBe('')
  }, 40_000)

  it('an Explorer child excludes everything beyond its role, even with an explicit MCP grant under full-access', async () => {
    const run = await runChild({
      rootMode: 'full-access', role: 'explorer', grantTools: ['Read', 'mcp__fixture__query', 'Write', 'Bash'],
      calls: [QUERY_CALL, { id: 'fab-write', name: 'Write', args: { path: 'x.txt', content: 'x' } }, { id: 'fab-bash', name: 'Bash', args: { command: 'echo x' } }],
    })
    for (const hidden of ['mcp__fixture__query', 'Write', 'Bash', 'Agent']) expect(run.schemas).not.toContain(hidden)
    expect(run.outputs['fab-mcp']).toMatch(/^denied: Explorer exposes zero MCP tools/)
    expect(run.outputs['fab-write']).toMatch(/^denied: agent 'explorer' does not expose 'Write' \(definition ceiling\)/)
    expect(run.outputs['fab-bash']).toMatch(/^denied: agent 'explorer' does not expose 'Bash' \(definition ceiling\)/)
    expect(run.effects).toBe('')
  }, 40_000)
})
