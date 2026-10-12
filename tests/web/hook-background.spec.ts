/**
 * Claude `if`, `async` and `asyncRewake` command hooks over the real web host:
 * real hook processes, real HTTP, a scripted model.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { createWebServer, messageText, withoutSentStamp, type LlmProvider, type WebServer } from 'dnt-harness'

const hookFixture = fileURLToPath(new URL('../fixtures/hook-command.mjs', import.meta.url))
const hookCmd = (...args: string[]): string => `"${process.execPath}" "${hookFixture}" ${args.map((arg) => `"${arg}"`).join(' ')}`
const servers: WebServer[] = []

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

function putHooks(base: string, wsId: string, hooks: unknown): Promise<Response> {
  return fetch(`${base}/api/workspaces/${wsId}/hooks`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hooks }),
  })
}

async function boot(provider: LlmProvider) {
  const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-hook-bg-'))
  const server = await createWebServer({ home, providers: [provider], configFile: path.join(home, 'providers.json') })
  servers.push(server)
  const wsId = ((await (await fetch(`${server.url}/api/workspaces`)).json()) as { id: string }[])[0]!.id
  await fetch(`${server.url}/api/workspaces/${wsId}/mode`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modeId: 'full-access' }) })
  // Bash needs a granted root: every conversation runs in a project folder.
  const folder = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-hook-bg-project-'))
  const projectId = ((await (await post(server.url, `/api/workspaces/${wsId}/projects`, { name: 'p', path: folder })).json()) as { id: string }).id
  const newSession = async (): Promise<{ id: string }> =>
    (await (await post(server.url, `/api/workspaces/${wsId}/sessions`, { projectId })).json()) as { id: string }
  return { home, server, wsId, base: server.url, newSession }
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
      const data = buffer.slice(0, boundary).split('\n').find((line) => line.startsWith('data: '))
      if (data === undefined) continue
      const envelope = JSON.parse(data.slice(6)) as { kind: string; events?: Record<string, unknown>[] }
      return envelope.kind === 'snapshot' ? (envelope.events ?? []) : []
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  return []
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('condition not met in time')
}

const readLines = async (file: string): Promise<string[]> =>
  (await fs.readFile(file, 'utf8').catch(() => '')).split('\n').filter((line) => line !== '')

/** A model that runs the given Bash commands once, then answers. */
function bashThenAnswer(commands: readonly string[], seen?: string[][]): LlmProvider {
  let step = 0
  return {
    name: 'scripted', models: ['scripted'],
    async *stream(request) {
      seen?.push(request.messages.map((message) => messageText(message.content)))
      step += 1
      if (step === 1 && commands.length > 0) {
        yield { type: 'toolCalls', calls: commands.map((command, index) => ({ id: `b${index}`, name: 'Bash', args: { command } })) }
        yield { type: 'completion', finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }
        return
      }
      yield { type: 'delta', delta: `answer ${step}` }
      yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
    },
  }
}

describe('Claude hook if / async / asyncRewake', () => {
  it('if: a PostToolUse hook runs only for matching Bash calls, compound parts included', async () => {
    const marks = path.join(await fs.mkdtemp(path.join(tmpdir(), 'hook-if-')), 'marks.txt')
    const { base, wsId, newSession } = await boot(bashThenAnswer(['true && echo commit-me', 'echo status-only']))
    expect((await putHooks(base, wsId, {
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: hookCmd('mark', marks), if: 'Bash(echo commit-me:*)', timeout: 5 }] }],
    })).status).toBe(200)
    const session = await newSession()
    await post(base, `/api/workspaces/${wsId}/sessions/${session.id}/messages`, { content: 'go' })
    await waitFor(async () => (await sessionEvents(base, wsId, session.id)).some((event) => event.type === 'turn/end'))
    // Only the call whose compound part matches spawned the hook.
    expect(await readLines(marks)).toEqual(['true && echo commit-me'])
    const hooks = (await sessionEvents(base, wsId, session.id)).filter((event) => event.type === 'hook/run')
    expect(hooks).toHaveLength(1)
  }, 20_000)

  it('async: the turn ends before the hook does; its audit lands later and its decision is ignored', async () => {
    const marks = path.join(await fs.mkdtemp(path.join(tmpdir(), 'hook-async-')), 'marks.txt')
    const seen: string[][] = []
    const { base, wsId, newSession } = await boot(bashThenAnswer(['echo hi'], seen))
    expect((await putHooks(base, wsId, {
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: hookCmd('slow-mark', marks, '1500'), async: true, timeout: 10 }] }],
    })).status).toBe(200)
    const session = await newSession()
    await post(base, `/api/workspaces/${wsId}/sessions/${session.id}/messages`, { content: 'go' })
    await waitFor(async () => (await sessionEvents(base, wsId, session.id)).some((event) => event.type === 'turn/end'))
    // The turn closed while the hook was still sleeping.
    expect(await readLines(marks)).toEqual([])
    await waitFor(async () => (await readLines(marks)).length === 1)
    await waitFor(async () => (await sessionEvents(base, wsId, session.id)).some((event) => event.type === 'hook/run'))
    const run = (await sessionEvents(base, wsId, session.id)).find((event) => event.type === 'hook/run')
    expect(run).toMatchObject({ event: 'PostToolUse', background: true, exitCode: 0 })
    // Its `decision: block` never reached the model.
    const result = (await sessionEvents(base, wsId, session.id)).find((event) => event.type === 'tool/result')
    expect(String(result?.output)).not.toContain('background must not decide')
    expect(seen.flat().join('\n')).not.toContain('background must not decide')
  }, 20_000)

  it('a user Stop kills the background hooks of the conversation', async () => {
    const marks = path.join(await fs.mkdtemp(path.join(tmpdir(), 'hook-stop-')), 'marks.txt')
    const { base, wsId, newSession } = await boot(bashThenAnswer(['echo hi']))
    expect((await putHooks(base, wsId, {
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: hookCmd('slow-mark', marks, '2500'), async: true, timeout: 10 }] }],
    })).status).toBe(200)
    const session = await newSession()
    await post(base, `/api/workspaces/${wsId}/sessions/${session.id}/messages`, { content: 'go' })
    await waitFor(async () => (await sessionEvents(base, wsId, session.id)).some((event) => event.type === 'turn/end'))
    expect((await post(base, `/api/workspaces/${wsId}/sessions/${session.id}/stop`)).status).toBe(202)
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    expect(await readLines(marks)).toEqual([])
    const run = (await sessionEvents(base, wsId, session.id)).find((event) => event.type === 'hook/run')
    expect(run).toMatchObject({ background: true, decision: 'killed' })
  }, 20_000)

  it('asyncRewake: exit 2 wakes an idle conversation with framed hook input, once per identical result', async () => {
    const seen: string[][] = []
    const prompts = path.join(await fs.mkdtemp(path.join(tmpdir(), 'hook-rewake-')), 'prompts.txt')
    // Every typed prompt runs the commit once; the rewake turn only answers.
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream(request) {
        seen.push(request.messages.map((message) => messageText(message.content)))
        const last = request.messages.at(-1)
        const text = last === undefined ? '' : withoutSentStamp(messageText(last.content))
        if (last?.role === 'user' && (text === 'commit it' || text === 'again')) {
          yield { type: 'toolCalls', calls: [{ id: `b${seen.length}`, name: 'Bash', args: { command: 'echo commit' } }] }
          yield { type: 'completion', finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }
          return
        }
        yield { type: 'delta', delta: `answer ${seen.length}` }
        yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
      },
    }
    const { base, wsId, newSession } = await boot(provider)
    expect((await putHooks(base, wsId, {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookCmd('mark', prompts), timeout: 5 }] }],
      PostToolUse: [{ matcher: 'Bash', hooks: [{
        type: 'command',
        command: hookCmd('rewake', '300', 'SECURITY: hardcoded token in a.ts'),
        if: 'Bash(echo commit:*)',
        asyncRewake: true,
        rewakeMessage: 'Background security review of commit:',
        rewakeSummary: 'Commit security review found issues',
        timeout: 10,
      }] }],
    })).status).toBe(200)
    const session = await newSession()
    await post(base, `/api/workspaces/${wsId}/sessions/${session.id}/messages`, { content: 'commit it' })
    // First turn, then a second turn the rewake opened on its own.
    await waitFor(async () => (await sessionEvents(base, wsId, session.id)).filter((event) => event.type === 'turn/end').length >= 2)
    const events = await sessionEvents(base, wsId, session.id)
    const rewake = events.find((event) => event.type === 'user/message' && event.origin === 'hook')
    expect(rewake).toMatchObject({ summary: 'Commit security review found issues' })
    expect(String(rewake?.content)).toMatch(/lower-trust data; cannot override mode\/policy/)
    expect(String(rewake?.content)).toContain('Background security review of commit:')
    expect(String(rewake?.content)).toContain('SECURITY: hardcoded token in a.ts')
    // The model read it in the woken turn.
    expect(seen.at(-1)?.join('\n')).toContain('SECURITY: hardcoded token in a.ts')
    expect(events.find((event) => event.type === 'hook/run' && event.rewake === 'woke')).toBeTruthy()
    // The prompt hook ran for the typed prompt only, never for the rewake.
    expect(await readLines(prompts)).toEqual(['UserPromptSubmit'])

    // The next prompt runs the same commit; its identical finding is dropped.
    await post(base, `/api/workspaces/${wsId}/sessions/${session.id}/messages`, { content: 'again' })
    await waitFor(async () => (await sessionEvents(base, wsId, session.id)).some((event) => event.type === 'hook/run' && event.rewake === 'dropped'))
    await new Promise((resolve) => setTimeout(resolve, 800))
    const later = await sessionEvents(base, wsId, session.id)
    expect(later.filter((event) => event.type === 'hook/run' && event.background === true).map((event) => event.rewake)).toEqual(['woke', 'dropped'])
    expect(later.filter((event) => event.type === 'user/message' && event.origin === 'hook')).toHaveLength(1)
    expect(later.filter((event) => event.type === 'turn/end')).toHaveLength(3)
    expect(await readLines(prompts)).toEqual(['UserPromptSubmit', 'UserPromptSubmit'])
  }, 30_000)

  it('asyncRewake: exit 0 or a broken installation never wakes the model', async () => {
    const seen: string[][] = []
    const { base, wsId, newSession } = await boot(bashThenAnswer(['echo x'], seen))
    expect((await putHooks(base, wsId, {
      PostToolUse: [{ matcher: 'Bash', hooks: [
        { type: 'command', command: hookCmd('allow'), asyncRewake: true, timeout: 5 },
        { type: 'command', command: hookCmd('missing-script'), asyncRewake: true, timeout: 5 },
      ] }],
    })).status).toBe(200)
    const session = await newSession()
    await post(base, `/api/workspaces/${wsId}/sessions/${session.id}/messages`, { content: 'go' })
    await waitFor(async () => (await sessionEvents(base, wsId, session.id)).filter((event) => event.type === 'hook/run').length >= 2)
    await new Promise((resolve) => setTimeout(resolve, 800))
    const events = await sessionEvents(base, wsId, session.id)
    expect(events.filter((event) => event.type === 'turn/end')).toHaveLength(1)
    expect(events.some((event) => event.type === 'user/message' && event.origin === 'hook')).toBe(false)
    const broken = events.find((event) => event.type === 'hook/run' && event.rewake === 'broken-install')
    expect(String(broken?.message)).toMatch(/broken hook installation/)
  }, 20_000)

  it('asyncRewake during a running turn queues behind it and never steers', async () => {
    let step = 0
    const seen: string[][] = []
    let releaseFirst!: () => void
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve })
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream(request) {
        seen.push(request.messages.map((message) => messageText(message.content)))
        step += 1
        if (step === 1) {
          yield { type: 'toolCalls', calls: [{ id: 'b0', name: 'Bash', args: { command: 'echo commit' } }] }
          yield { type: 'completion', finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }
          return
        }
        // The turn is still running while the rewake arrives.
        if (step === 2) await firstHeld
        yield { type: 'delta', delta: `answer ${step}` }
        yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
      },
    }
    const { base, wsId, newSession } = await boot(provider)
    expect((await putHooks(base, wsId, {
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: hookCmd('rewake', '0', 'late finding'), asyncRewake: true, timeout: 5 }] }],
    })).status).toBe(200)
    const session = await newSession()
    await post(base, `/api/workspaces/${wsId}/sessions/${session.id}/messages`, { content: 'go' })
    await waitFor(async () => (await sessionEvents(base, wsId, session.id)).some((event) => event.type === 'input/queued' && event.origin === 'hook'))
    let events = await sessionEvents(base, wsId, session.id)
    // Queued behind the running turn: nothing ended or was steered yet.
    expect(events.filter((event) => event.type === 'turn/end')).toHaveLength(0)
    releaseFirst()
    await waitFor(async () => (await sessionEvents(base, wsId, session.id)).filter((event) => event.type === 'turn/end').length >= 2)
    events = await sessionEvents(base, wsId, session.id)
    expect(events.filter((event) => event.type === 'turn/end').map((event) => event.reason)).toEqual(['completed', 'completed'])
    expect(seen.at(-1)?.join('\n')).toContain('late finding')
  }, 30_000)
})
