/**
 * Claude Code slash commands through the web host: `/name args` expands
 * server-side, inline shell runs through the Bash pipeline under the
 * command's allowed-tools, the Skill tool takes args, and the commands
 * route lists the layered catalog.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createWebServer, SENT_STAMP_LINE as SENT_STAMP, withoutSentStamp, type LlmProvider, type ModelRequest, type WebServer } from 'dnt-harness'

const servers: WebServer[] = []
const dirs: string[] = []

afterAll(async () => {
  for (const server of servers) await server.close().catch(() => {})
  for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true })
})

const temp = async (prefix: string): Promise<string> => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), prefix)))
  dirs.push(dir)
  return dir
}

const write = async (file: string, content: string): Promise<void> => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
}

const post = (base: string, pathname: string, body?: unknown): Promise<Response> =>
  fetch(`${base}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })

interface Started {
  readonly base: string
  readonly home: string
  readonly userClaude: string
  readonly wsId: string
  readonly requests: ModelRequest[]
}

async function start(script: (request: ModelRequest, index: number) => AsyncGenerator<unknown>): Promise<Started> {
  const home = await temp('dnt-cmd-home-')
  const userClaude = await temp('dnt-cmd-user-')
  const requests: ModelRequest[] = []
  const provider: LlmProvider = {
    name: 'scripted', models: ['scripted'],
    async *stream(request) {
      requests.push(request)
      yield * script(request, requests.length - 1) as AsyncGenerator<never>
    },
  }
  const server = await createWebServer({ home, providers: [provider], configFile: path.join(home, 'p.json'), userClaudeDir: userClaude })
  servers.push(server)
  const wsId = (await (await fetch(`${server.url}/api/workspaces`)).json() as { id: string }[])[0]!.id
  return { base: server.url, home, userClaude, wsId, requests }
}

async function* answer(text: string): AsyncGenerator<unknown> {
  yield { type: 'delta', delta: text }
  yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
}

async function events(home: string, wsId: string, sessionId: string): Promise<Array<{ type: string; [key: string]: unknown }>> {
  const raw = await fs.readFile(path.join(home, 'workspaces', wsId, 'sessions', sessionId, 'events.jsonl'), 'utf8').catch(() => '')
  return raw.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as { type: string })
}

async function turnEnd(home: string, wsId: string, sessionId: string, count = 1): Promise<Array<{ type: string; [key: string]: unknown }>> {
  let latest: Array<{ type: string; [key: string]: unknown }> = []
  await expect.poll(async () => {
    latest = await events(home, wsId, sessionId)
    return latest.filter((event) => event.type === 'turn/end').length
  }, { timeout: 8_000 }).toBeGreaterThanOrEqual(count)
  return latest
}

const rawUserTexts = (request: ModelRequest | undefined): string[] =>
  (request?.messages ?? []).filter((message) => message.role === 'user').map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content))

/** The host's `[sent …]` line on a typed message is not part of what the user wrote. */
const userTexts = (request: ModelRequest | undefined): string[] => rawUserTexts(request).map(withoutSentStamp)

describe('slash commands over the web host', () => {
  it('expands a workspace command after the typed text and keeps the typed text as the user message', async () => {
    const s = await start(() => answer('done'))
    await write(path.join(s.home, 'workspaces', s.wsId, 'commands', 'greet.md'), '---\ndescription: Greet\nargument-hint: <who>\n---\nSay hello to $ARGUMENTS politely.')
    const { id } = await (await post(s.base, `/api/workspaces/${s.wsId}/sessions`)).json() as { id: string }
    await post(s.base, `/api/workspaces/${s.wsId}/sessions/${id}/messages`, { content: '/greet Ada' })
    const log = await turnEnd(s.home, s.wsId, id)
    const users = log.filter((event) => event.type === 'user/message')
    expect(users.map((event) => [event['content'], event['origin']])).toEqual([
      ['/greet Ada', undefined],
      ['Say hello to Ada politely.', 'command'],
    ])
    expect(userTexts(s.requests[0])).toEqual(['/greet Ada', 'Say hello to Ada politely.'])
    // Only what the user typed carries the host's send time; the expansion does not.
    const raw = rawUserTexts(s.requests[0])
    expect(raw[0]).toMatch(SENT_STAMP)
    expect(raw[1]).toBe('Say hello to Ada politely.')
  })

  it('project commands win over workspace and user ones; the route lists every layer', async () => {
    const s = await start(() => answer('ok'))
    const project = await temp('dnt-cmd-proj-')
    await write(path.join(s.userClaude, 'commands', 'same.md'), 'USER')
    await write(path.join(s.userClaude, 'commands', 'git', 'commit.md'), '---\nallowed-tools: Bash(git:*)\n---\ncommit')
    await write(path.join(s.home, 'workspaces', s.wsId, 'commands', 'same.md'), 'WORKSPACE')
    await write(path.join(project, '.claude', 'commands', 'same.md'), 'PROJECT')
    const projectId = (await (await post(s.base, `/api/workspaces/${s.wsId}/projects`, { name: 'P', path: project })).json() as { id: string }).id
    const listed = await (await fetch(`${s.base}/api/workspaces/${s.wsId}/commands?projectId=${projectId}`)).json() as { commands: { name: string; source: string; allowedTools?: string[] }[] }
    expect(listed.commands.map((row) => `${row.name}:${row.source}`)).toEqual(['git:commit:user', 'same:project'])
    expect(listed.commands[0]?.allowedTools).toEqual(['Bash(git:*)'])
    const { id } = await (await post(s.base, `/api/workspaces/${s.wsId}/sessions`, { projectId })).json() as { id: string }
    await post(s.base, `/api/workspaces/${s.wsId}/sessions/${id}/messages`, { content: '/same' })
    await turnEnd(s.home, s.wsId, id)
    expect(userTexts(s.requests[0])).toEqual(['/same', 'PROJECT'])
  })

  it('a skill runs as /name with arguments and its base directory', async () => {
    const s = await start(() => answer('ok'))
    const skillDir = path.join(s.home, 'workspaces', s.wsId, 'skills', 'lint')
    await write(path.join(skillDir, 'SKILL.md'), '---\nname: lint\ndescription: Lint files\n---\nLint $0 with ${CLAUDE_SKILL_DIR}/rules.txt')
    const { id } = await (await post(s.base, `/api/workspaces/${s.wsId}/sessions`)).json() as { id: string }
    await post(s.base, `/api/workspaces/${s.wsId}/sessions/${id}/messages`, { content: '/lint src/a.ts' })
    await turnEnd(s.home, s.wsId, id)
    const real = await fs.realpath(skillDir)
    expect(userTexts(s.requests[0])[1]).toBe(`Base directory for this skill: ${real}\n\nLint src/a.ts with ${real}/rules.txt`)
  })

  it('a skill shadows a same-named command, as in Claude', async () => {
    const s = await start(() => answer('ok'))
    await write(path.join(s.userClaude, 'commands', 'dup.md'), 'FROM COMMAND')
    await write(path.join(s.home, 'workspaces', s.wsId, 'skills', 'dup', 'SKILL.md'), '---\nname: dup\ndescription: d\n---\nFROM SKILL')
    const { id } = await (await post(s.base, `/api/workspaces/${s.wsId}/sessions`)).json() as { id: string }
    await post(s.base, `/api/workspaces/${s.wsId}/sessions/${id}/messages`, { content: '/dup' })
    await turnEnd(s.home, s.wsId, id)
    const expanded = userTexts(s.requests[0])[1] ?? ''
    expect(expanded).toContain('FROM SKILL')
    expect(expanded).not.toContain('FROM COMMAND')
  })

  it('an unknown command rejects the prompt; a path is plain text', async () => {
    const s = await start(() => answer('ok'))
    const { id } = await (await post(s.base, `/api/workspaces/${s.wsId}/sessions`)).json() as { id: string }
    await post(s.base, `/api/workspaces/${s.wsId}/sessions/${id}/messages`, { content: '/nope x' })
    const log = await turnEnd(s.home, s.wsId, id)
    expect(log.find((event) => event.type === 'turn/error')?.['message']).toBe('Unknown command: /nope')
    expect(s.requests).toHaveLength(0)
    await post(s.base, `/api/workspaces/${s.wsId}/sessions/${id}/messages`, { content: '/usr/bin/env is a path' })
    await turnEnd(s.home, s.wsId, id, 2)
    expect(userTexts(s.requests[0])).toEqual(['/usr/bin/env is a path'])
  })

  it('inline shell runs through Bash; allowed-tools lifts the ask, the guard still denies', async () => {
    const s = await start(() => answer('ok'))
    const project = await temp('dnt-cmd-shell-')
    await write(path.join(project, 'marker.txt'), 'MARK')
    await write(path.join(project, '.claude', 'commands', 'peek.md'), '---\nallowed-tools: Bash(cat:*)\n---\nFile: !`cat marker.txt`')
    await write(path.join(project, '.claude', 'commands', 'boom.md'), '---\nallowed-tools: Bash\n---\nX !`rm -rf /`')
    const projectId = (await (await post(s.base, `/api/workspaces/${s.wsId}/projects`, { name: 'P', path: project })).json() as { id: string }).id
    // The default mode asks for Bash: allowed-tools must make it run unasked.
    const { id } = await (await post(s.base, `/api/workspaces/${s.wsId}/sessions`, { projectId })).json() as { id: string }
    await fetch(`${s.base}/api/workspaces/${s.wsId}/sessions/${id}/mode`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modeId: 'ask-before-changes' }) })
    await post(s.base, `/api/workspaces/${s.wsId}/sessions/${id}/messages`, { content: '/peek' })
    const log = await turnEnd(s.home, s.wsId, id)
    expect(log.some((event) => event.type === 'approval/request')).toBe(false)
    const commandCall = log.find((event) => event.type === 'command/tool-call')
    const commandResult = log.find((event) => event.type === 'command/tool-result')
    expect(commandCall).toMatchObject({ call: { name: 'Bash', args: { command: 'cat marker.txt' } } })
    expect(commandResult).toMatchObject({ executionId: commandCall?.['executionId'], ok: true })
    expect((commandCall?.['seq'] as number)).toBeLessThan(commandResult?.['seq'] as number)
    expect(userTexts(s.requests[0])).toEqual(['/peek', 'File: MARK'])

    await post(s.base, `/api/workspaces/${s.wsId}/sessions/${id}/messages`, { content: '/boom' })
    const after = await turnEnd(s.home, s.wsId, id, 2)
    expect(String(after.filter((event) => event.type === 'turn/error').at(-1)?.['message'])).toMatch(/^Shell command permission check failed for pattern "!`rm -rf \/`": .*Dangerous Commands/)
    expect(after.filter((event) => event.type === 'command/tool-call').at(-1)).toMatchObject({ call: { name: 'Bash', args: { command: 'rm -rf /' } } })
    expect(after.filter((event) => event.type === 'command/tool-result').at(-1)).toMatchObject({ ok: false })
    expect(s.requests).toHaveLength(1)
  })

  it('the Skill tool runs a command with args and refuses disable-model-invocation', async () => {
    const s = await start(async function* (_request, index) {
      if (index === 0) {
        yield { type: 'toolCalls', calls: [
          { id: 'a', name: 'Skill', args: { name: 'deploy', args: 'staging' } },
          { id: 'b', name: 'Skill', args: { name: 'review', args: '42' } },
        ] }
        yield { type: 'completion', finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }
        return
      }
      yield * answer('ok') as AsyncGenerator<never>
    })
    await write(path.join(s.home, 'workspaces', s.wsId, 'commands', 'deploy.md'), '---\ndisable-model-invocation: true\n---\nDeploy $ARGUMENTS')
    await write(path.join(s.home, 'workspaces', s.wsId, 'commands', 'review.md'), 'Review PR #$0 carefully.')
    const { id } = await (await post(s.base, `/api/workspaces/${s.wsId}/sessions`)).json() as { id: string }
    await post(s.base, `/api/workspaces/${s.wsId}/sessions/${id}/messages`, { content: 'go' })
    const log = await turnEnd(s.home, s.wsId, id)
    const results = log.filter((event) => event.type === 'tool/result').map((event) => String(event['output']))
    expect(results[0]).toMatch(/can only be run by the user/)
    expect(results[1]).toMatch(/^skill 'review' loaded/)
    // The expanded body IS the tool result, in history at the load point —
    // never a system block ahead of the cached prefix.
    expect(results[1]).toContain('Review PR #42 carefully.')
    const systems = (s.requests[1]?.messages ?? []).filter((message) => message.role === 'system').map((message) => String(message.content)).join('\n')
    expect(systems).not.toContain('Review PR #42 carefully.')
    const tools = (s.requests[1]?.messages ?? []).filter((message) => message.role === 'tool').map((message) => String(message.content))
    expect(tools.some((text) => text.includes('Review PR #42 carefully.'))).toBe(true)
    // Loading a skill leaves every message ahead of history byte-identical, so
    // the provider's cached prefix survives the load.
    const prefix = (request: ModelRequest | undefined) => (request?.messages ?? []).filter((message) => message.role === 'system').map((message) => String(message.content))
    expect(prefix(s.requests[1])).toEqual(prefix(s.requests[0]))
    // The next turn still carries the body where it was loaded.
    await post(s.base, `/api/workspaces/${s.wsId}/sessions/${id}/messages`, { content: 'again' })
    await turnEnd(s.home, s.wsId, id, 2)
    const later = s.requests.at(-1)
    expect((later?.messages ?? []).some((message) => message.role === 'tool' && String(message.content).includes('Review PR #42 carefully.'))).toBe(true)
    // The catalog the model sees leaves the user-only command out.
    const first = (s.requests[0]?.messages ?? []).filter((message) => message.role === 'system').map((message) => String(message.content)).join('\n')
    expect(first).toContain('review')
    expect(first).not.toMatch(/\bdeploy\b/)
  })

  it('a model-loaded command applies allowed-tools to later calls in the same turn', async () => {
    const s = await start(async function* (_request, index) {
      if (index === 0) {
        yield { type: 'toolCalls', calls: [{ id: 'load', name: 'Skill', args: { name: 'git-work' } }] }
        yield { type: 'completion', finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }
        return
      }
      if (index === 1) {
        yield { type: 'toolCalls', calls: [{ id: 'bash', name: 'Bash', args: { command: 'git status --short' } }] }
        yield { type: 'completion', finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }
        return
      }
      yield * answer('ok') as AsyncGenerator<never>
    })
    const project = await temp('dnt-command-grant-')
    await write(path.join(project, '.claude', 'commands', 'git-work.md'), '---\nallowed-tools: Bash(git:*)\n---\nUse git.')
    await fs.mkdir(path.join(project, '.git'))
    const projectId = (await (await post(s.base, `/api/workspaces/${s.wsId}/projects`, { name: 'P', path: project })).json() as { id: string }).id
    const { id } = await (await post(s.base, `/api/workspaces/${s.wsId}/sessions`, { projectId })).json() as { id: string }
    await fetch(`${s.base}/api/workspaces/${s.wsId}/sessions/${id}/mode`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modeId: 'ask-before-changes' }) })
    await post(s.base, `/api/workspaces/${s.wsId}/sessions/${id}/messages`, { content: 'load it' })
    const log = await turnEnd(s.home, s.wsId, id)
    expect(log.some((event) => event.type === 'approval/request')).toBe(false)
    expect(log.find((event) => event.type === 'tool/call' && (event['call'] as { id?: string } | undefined)?.id === 'bash')).toBeDefined()
    expect(log.find((event) => event.type === 'tool/result' && event['callId'] === 'bash')).toMatchObject({ ok: true })
  })

  it('a grant ends with its turn: the next turn asks again, and substitutions are never covered', async () => {
    const s = await start(async function* (request) {
      const last = userTexts(request).at(-1) ?? ''
      const answered = request.messages.at(-1)?.role === 'tool'
      if (!answered && last.startsWith('run: ')) {
        yield { type: 'toolCalls', calls: [{ id: `c-${last.length}`, name: 'Bash', args: { command: last.slice('run: '.length) } }] }
        yield { type: 'completion', finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }
        return
      }
      yield * answer('ok') as AsyncGenerator<never>
    })
    const project = await temp('dnt-grant-scope-')
    await write(path.join(project, '.claude', 'commands', 'gitty.md'), '---\nallowed-tools: Bash(git:*)\n---\nrun: git --version')
    const projectId = (await (await post(s.base, `/api/workspaces/${s.wsId}/projects`, { name: 'P', path: project })).json() as { id: string }).id
    const { id } = await (await post(s.base, `/api/workspaces/${s.wsId}/sessions`, { projectId })).json() as { id: string }
    await fetch(`${s.base}/api/workspaces/${s.wsId}/sessions/${id}/mode`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modeId: 'ask-before-changes' }) })
    // Turn 1: the command's grant covers `git --version` unasked.
    await post(s.base, `/api/workspaces/${s.wsId}/sessions/${id}/messages`, { content: '/gitty' })
    const first = await turnEnd(s.home, s.wsId, id)
    expect(first.some((event) => event.type === 'approval/request')).toBe(false)
    expect(first.some((event) => event.type === 'tool/call' && (event['call'] as { name?: string }).name === 'Bash')).toBe(true)
    // Turn 2, no command: the same git call must ask again.
    await post(s.base, `/api/workspaces/${s.wsId}/sessions/${id}/messages`, { content: 'run: git --version' })
    await expect.poll(async () => (await events(s.home, s.wsId, id)).filter((event) => event.type === 'approval/request').length, { timeout: 8_000 }).toBe(1)
  })
})
