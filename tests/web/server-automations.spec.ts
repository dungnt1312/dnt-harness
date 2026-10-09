/**
 * Automations end to end: CRUD validation, Run now opening a titled session
 * that runs the prompt, the run reaching `done`, and Web Push fan-out.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWebServer, type LlmProvider, type WebServer } from 'dnt-harness'
import type { ModelRequest, StreamEvent } from '../../src/harness/llm/types.ts'
import type { PushSender } from '../../src/web/push.ts'
import type { ChannelFetch } from '../../src/web/notify-channels.ts'
import { FakeScriptedLlm } from './fake-llm.ts'

let home = ''
let server: WebServer | undefined
const pushed: { endpoint: string; payload: { title: string; body: string; url: string } }[] = []
const sender: PushSender = async (subscription, body) => {
  pushed.push({ endpoint: subscription.endpoint, payload: JSON.parse(body) as { title: string; body: string; url: string } })
  return { statusCode: 201 }
}
const posted: { url: string; body: Record<string, unknown> }[] = []
const channelFetch: ChannelFetch = async (url, init) => {
  posted.push({ url, body: JSON.parse(init.body) as Record<string, unknown> })
  return { ok: true, status: 200, text: async () => '' }
}

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-automations-'))
  pushed.length = 0
  posted.length = 0
})
afterEach(async () => {
  await server?.close()
  server = undefined
  await fs.rm(home, { recursive: true, force: true })
})

async function boot(): Promise<{ url: string; ws: string }> {
  server = await createWebServer({
    home,
    providers: [new FakeScriptedLlm(['## Reminder\n**Take your pills** now.'])],
    configFile: path.join(home, 'providers.json'),
    automations: { scheduler: false },
    pushSender: sender,
    channelFetch,
  })
  const rows = await (await fetch(`${server.url}/api/workspaces`)).json() as { id: string; default: boolean }[]
  return { url: server.url, ws: rows.find((row) => row.default)?.id ?? rows[0]!.id }
}

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5_000
  for (;;) {
    const value = await read()
    if (done(value) || Date.now() > deadline) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe('automations API', () => {
  it('validates, creates, previews and deletes', async () => {
    const { url, ws } = await boot()
    const bad = await fetch(`${url}/api/workspaces/${ws}/automations`, json('POST', { prompt: 'x', schedules: [{ cron: 'every day' }] }))
    expect(bad.status).toBe(400)

    const preview = await fetch(`${url}/api/automations/preview`, json('POST', { cron: '0 7 * * *' }))
    expect(((await preview.json()) as { next: number[] }).next).toHaveLength(5)

    const created = await fetch(`${url}/api/workspaces/${ws}/automations`, json('POST', { title: 'Pills', prompt: 'remind me', schedules: [{ cron: '0 7 * * *' }, { cron: '0 19 * * *' }] }))
    expect(created.status).toBe(201)
    const row = await created.json() as { id: string; nextRuns: number[]; enabled: boolean }
    expect(row.enabled).toBe(true)
    expect(row.nextRuns).toHaveLength(3)

    const patched = await (await fetch(`${url}/api/workspaces/${ws}/automations/${row.id}`, json('PATCH', { enabled: false }))).json() as { enabled: boolean; nextRuns: number[] }
    expect(patched).toMatchObject({ enabled: false, nextRuns: [] })

    expect((await fetch(`${url}/api/workspaces/${ws}/automations/${row.id}`, { method: 'DELETE' })).status).toBe(200)
    expect(await (await fetch(`${url}/api/workspaces/${ws}/automations`)).json()).toEqual([])
    const raw = JSON.parse(await fs.readFile(path.join(home, 'workspaces', ws, 'automations.json'), 'utf8')) as { automations: unknown[] }
    expect(raw.automations).toEqual([])
  })

  it('accepts one-time and limited plans, and refuses plans that never run', async () => {
    const { url, ws } = await boot()
    const soon = Date.now() + 60 * 60_000
    const once = await (await fetch(`${url}/api/workspaces/${ws}/automations`, json('POST', { prompt: 'x', schedules: [{ at: soon }] }))).json() as { nextRuns: number[]; finished: boolean }
    expect(once.nextRuns).toEqual([Math.floor(soon / 1000) * 1000])
    expect(once.finished).toBe(false)

    const limited = await (await fetch(`${url}/api/workspaces/${ws}/automations`, json('POST', { prompt: 'x', schedules: [{ cron: '*/10 * * * *' }], maxRuns: 2 }))).json() as { nextRuns: number[] }
    expect(limited.nextRuns).toHaveLength(2)

    const past = await fetch(`${url}/api/workspaces/${ws}/automations`, json('POST', { prompt: 'x', schedules: [{ at: Date.now() - 60_000 }] }))
    expect(past.status).toBe(400)
    const preview = await (await fetch(`${url}/api/automations/preview`, json('POST', { schedules: [{ cron: '0 7 * * *' }], endsAt: Date.now() - 1 }))).json() as { next: number[] }
    expect(preview.next).toEqual([])
  })

  it('Run now opens a titled session, runs the prompt and pushes the reply', async () => {
    const { url, ws } = await boot()
    const sub = await fetch(`${url}/api/push/subscriptions`, json('POST', { subscription: { endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } }, label: 'phone' }))
    expect(sub.status).toBe(201)
    expect(((await (await fetch(`${url}/api/push/key`)).json()) as { publicKey: string }).publicKey.length).toBeGreaterThan(40)

    const row = await (await fetch(`${url}/api/workspaces/${ws}/automations`, json('POST', { title: 'Pills', prompt: 'remind me', schedules: [{ cron: '0 7 * * *' }] }))).json() as { id: string }
    const started = await fetch(`${url}/api/workspaces/${ws}/automations/${row.id}/run`, { method: 'POST' })
    expect(started.status).toBe(202)
    const { sessionId } = await started.json() as { sessionId: string }

    const history = await until(
      async () => await (await fetch(`${url}/api/workspaces/${ws}/automations/${row.id}/runs`)).json() as { status: string; sessionId?: string; summary?: string }[],
      (rows) => rows[0]?.status === 'done',
    )
    expect(history[0]).toMatchObject({ status: 'done', sessionId, summary: 'Reminder Take your pills now.' })

    const sessions = await (await fetch(`${url}/api/workspaces/${ws}/sessions`)).json() as { id: string; title: string; automationId?: string }[]
    expect(sessions.find((s) => s.id === sessionId)).toMatchObject({ automationId: row.id })
    expect(sessions.find((s) => s.id === sessionId)?.title).toMatch(/^⏰ Pills · \d{2}\/\d{2} \d{2}:\d{2}$/)

    await until(async () => pushed.length, (n) => n > 0)
    expect(pushed[0]).toMatchObject({ endpoint: 'https://push.example/1', payload: { title: 'Pills', body: 'Reminder Take your pills now.', url: `/workspaces/${ws}/sessions/${sessionId}` } })
  })

  it('tells the agent it runs unattended, and fans the reply out to channels', async () => {
    const { url, ws } = await boot()
    const bad = await fetch(`${url}/api/notify/channels`, json('POST', { kind: 'discord', config: { webhookUrl: 'https://evil.example/hook' } }))
    expect(bad.status).toBe(400)
    const tg = await (await fetch(`${url}/api/notify/channels`, json('POST', { kind: 'telegram', name: 'Me', config: { botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWX', chatId: '42' } }))).json() as { id: string; summary: string }
    expect(tg.summary).toBe('chat 42')
    expect(JSON.stringify(await (await fetch(`${url}/api/notify/channels`)).json())).not.toContain('ABCDEFGHIJ')
    await fetch(`${url}/api/notify/channels`, json('POST', { kind: 'discord', config: { webhookUrl: 'https://discord.com/api/webhooks/1/abc' } }))
    await fetch(`${url}/api/notify/channels`, json('POST', { kind: 'teams', config: { webhookUrl: 'https://example.webhook.office.com/x' } }))
    expect((await fetch(`${url}/api/notify/channels/${tg.id}/test`, { method: 'POST' })).status).toBe(200)
    posted.length = 0

    const row = await (await fetch(`${url}/api/workspaces/${ws}/automations`, json('POST', { title: 'Pills', prompt: 'remind me', schedules: [{ cron: '0 7 * * *' }] }))).json() as { id: string; notify: boolean }
    expect(row.notify).toBe(true)
    const { sessionId } = await (await fetch(`${url}/api/workspaces/${ws}/automations/${row.id}/run`, { method: 'POST' })).json() as { sessionId: string }
    await until(async () => posted.length, (n) => n >= 3)
    const byHost = Object.fromEntries(posted.map((p) => [new URL(p.url).host, p.body]))
    expect(byHost['api.telegram.org']).toMatchObject({ chat_id: '42', text: 'Pills\n\n## Reminder\n**Take your pills** now.' })
    expect(String(byHost['discord.com']?.['content'])).toContain('**Pills**')
    expect(JSON.stringify(byHost['example.webhook.office.com'])).toContain('AdaptiveCard')

    // The context block reached the model ahead of the prompt, marked as context.
    const log = (await fs.readFile(path.join(home, 'workspaces', ws, 'sessions', sessionId, 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { type: string; content?: string; origin?: string })
    const messages = log.filter((event) => event.type === 'user/message')
    const context = messages.find((event) => event.origin === 'context' && event.content?.includes('unattended scheduled task named "Pills"'))
    expect(context?.content).toContain('Telegram "Me"')
    expect(messages.indexOf(context!)).toBeLessThan(messages.findIndex((event) => event.content === 'remind me'))
  })

  it('stays quiet on success when notify is off', async () => {
    const { url, ws } = await boot()
    await fetch(`${url}/api/push/subscriptions`, json('POST', { subscription: { endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } } }))
    const row = await (await fetch(`${url}/api/workspaces/${ws}/automations`, json('POST', { title: 'Quiet', prompt: 'x', schedules: [{ cron: '0 7 * * *' }], notify: false }))).json() as { id: string }
    await fetch(`${url}/api/workspaces/${ws}/automations/${row.id}/run`, { method: 'POST' })
    await until(async () => (await (await fetch(`${url}/api/workspaces/${ws}/automations/${row.id}/runs`)).json() as { status: string }[])[0]?.status, (status) => status === 'done')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(pushed).toEqual([])
  })

  it('notifies only the selected targets', async () => {
    const { url, ws } = await boot()
    await fetch(`${url}/api/push/subscriptions`, json('POST', { subscription: { endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } } }))
    const discord = await (await fetch(`${url}/api/notify/channels`, json('POST', { kind: 'discord', name: 'Ops', config: { webhookUrl: 'https://discord.com/api/webhooks/1/abc' } }))).json() as { id: string }
    await fetch(`${url}/api/notify/channels`, json('POST', { kind: 'teams', config: { webhookUrl: 'https://example.webhook.office.com/x' } }))
    expect((await fetch(`${url}/api/workspaces/${ws}/automations`, json('POST', { prompt: 'x', schedules: [{ cron: '0 7 * * *' }], notifyTargets: 'push' }))).status).toBe(400)

    const row = await (await fetch(`${url}/api/workspaces/${ws}/automations`, json('POST', { title: 'Only Discord', prompt: 'x', schedules: [{ cron: '0 7 * * *' }], notifyTargets: [discord.id] }))).json() as { id: string; notifyTargets: string[] }
    expect(row.notifyTargets).toEqual([discord.id])
    const { sessionId } = await (await fetch(`${url}/api/workspaces/${ws}/automations/${row.id}/run`, { method: 'POST' })).json() as { sessionId: string }
    await until(async () => posted.length, (n) => n >= 1)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(posted.map((p) => new URL(p.url).host)).toEqual(['discord.com'])
    expect(pushed).toEqual([])
    // The agent is told exactly where its reply goes.
    const log = await fs.readFile(path.join(home, 'workspaces', ws, 'sessions', sessionId, 'events.jsonl'), 'utf8')
    expect(log).toContain('Discord \\"Ops\\"')
    expect(log).not.toContain('Web Push to the user')
  })

  it('runs the conversation itself as a role: role tools, role instructions, no subagent', async () => {
    const requests: ModelRequest[] = []
    const recording: LlmProvider = {
      name: 'scripted',
      models: ['scripted'],
      async *stream(request: ModelRequest): AsyncIterable<StreamEvent> {
        requests.push(request)
        yield { type: 'delta', delta: 'Explored: all good.' }
        yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
      },
    }
    server = await createWebServer({ home, providers: [recording], configFile: path.join(home, 'providers.json'), automations: { scheduler: false }, pushSender: sender, channelFetch })
    const url = server.url
    const ws = ((await (await fetch(`${url}/api/workspaces`)).json()) as { id: string; default: boolean }[]).find((row) => row.default)!.id
    await fetch(`${url}/api/push/subscriptions`, json('POST', { subscription: { endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } } }))
    expect((await fetch(`${url}/api/workspaces/${ws}/automations`, json('POST', { prompt: 'x', schedules: [{ cron: '0 7 * * *' }], agent: 'no-such-role' }))).status).toBe(400)

    const row = await (await fetch(`${url}/api/workspaces/${ws}/automations`, json('POST', { title: 'Explore', prompt: 'look around', schedules: [{ cron: '0 7 * * *' }], agent: 'explorer', modeId: 'full-access' }))).json() as { id: string; agent: string }
    expect(row.agent).toBe('explorer')
    const { sessionId } = await (await fetch(`${url}/api/workspaces/${ws}/automations/${row.id}/run`, { method: 'POST' })).json() as { sessionId: string }
    const history = await until(
      async () => await (await fetch(`${url}/api/workspaces/${ws}/automations/${row.id}/runs`)).json() as { status: string; summary?: string }[],
      (rows) => rows[0]?.status === 'done' || rows[0]?.status === 'failed',
    )
    expect(history[0]).toMatchObject({ status: 'done', summary: 'Explored: all good.' })
    await until(async () => pushed.length, (n) => n > 0)
    expect(pushed[0]?.payload).toMatchObject({ title: 'Explore', url: `/workspaces/${ws}/sessions/${sessionId}` })

    // The run's own conversation ran as explorer: only its read tools reached
    // the model (full-access mode alone would offer Write/Edit/Bash/Agent), and
    // the role's instructions replaced the mode prose.
    const tools = (requests[0]?.tools ?? []).map((tool) => tool.name).sort()
    expect(tools).toEqual(['Glob', 'Grep', 'Read'])
    const system = requests[0]?.messages.find((message) => message.role === 'system')?.content ?? ''
    expect(system).toContain('Role — explorer')
    expect(system).not.toContain('Mode —')
    // No subagent: the prompt and the unattended context sit in the root itself.
    expect(await (await fetch(`${url}/api/workspaces/${ws}/agents/children?root=${sessionId}`)).json()).toEqual([])
    const rootLog = await fs.readFile(path.join(home, 'workspaces', ws, 'sessions', sessionId, 'events.jsonl'), 'utf8')
    expect(rootLog).toContain('"type":"session/role"')
    expect(rootLog).toContain('unattended scheduled task named \\"Explore\\"')
    expect(rootLog).toContain('look around')
  })
})
