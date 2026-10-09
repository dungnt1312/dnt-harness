import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChannelError, NotifyChannels, buildRequest, type ChannelFetch } from '../../src/web/notify-channels.ts'

let dir = ''
beforeEach(async () => { dir = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-channels-')) })
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

const ok: ChannelFetch = async () => ({ ok: true, status: 200, text: async () => '' })

describe('NotifyChannels', () => {
  it('validates each kind and stores secrets privately', async () => {
    const channels = new NotifyChannels(dir, ok)
    await expect(channels.create({ kind: 'slack' })).rejects.toBeInstanceOf(ChannelError)
    await expect(channels.create({ kind: 'telegram', config: { botToken: 'nope', chatId: '1' } })).rejects.toThrow(/botToken/)
    await expect(channels.create({ kind: 'teams', config: { webhookUrl: 'http://insecure.example' } })).rejects.toThrow(/https/)
    await expect(channels.create({ kind: 'discord', config: { webhookUrl: 'https://example.com/hook' } })).rejects.toThrow(/Discord webhook/)
    const view = await channels.create({ kind: 'telegram', config: { botToken: '123:ABCDEFGHIJKLMNOPQRSTUVWX', chatId: '-100123' } })
    expect(view).toMatchObject({ kind: 'telegram', name: 'Telegram', enabled: true, summary: 'chat -100123' })
    expect(JSON.stringify(view)).not.toContain('ABCDEF')
    expect((await fs.stat(path.join(dir, 'channels.json'))).mode & 0o777).toBe(0o600)
    // Editing without re-entering the secret keeps it.
    await channels.update(view.id, { name: 'Phone', config: { chatId: '7' } })
    const reloaded = new NotifyChannels(dir, ok)
    expect(await reloaded.list()).toEqual([expect.objectContaining({ name: 'Phone', summary: 'chat 7' })])
  })

  it('builds plain-text requests that model output cannot break', () => {
    const base = { id: 'c', name: 'n', enabled: true, createdAt: 0 }
    const tg = buildRequest({ ...base, kind: 'telegram', config: { botToken: '1:x', chatId: '9' } }, { title: 'T', body: '<b>*hi*</b>' })
    expect(tg).toEqual({ url: 'https://api.telegram.org/bot1:x/sendMessage', body: { chat_id: '9', text: 'T\n\n<b>*hi*</b>', disable_web_page_preview: true } })
    const discord = buildRequest({ ...base, kind: 'discord', config: { webhookUrl: 'https://discord.com/api/webhooks/1/a' } }, { title: 'T', body: '@everyone ' + 'x'.repeat(3000) })
    expect(discord.body).toMatchObject({ allowed_mentions: { parse: [] } })
    expect(String((discord.body as { content: string }).content).length).toBeLessThan(2000)
    const teams = buildRequest({ ...base, kind: 'teams', config: { webhookUrl: 'https://x.webhook.office.com/a' } }, { title: 'T', body: 'b' })
    expect(JSON.stringify(teams.body)).toContain('"type":"AdaptiveCard"')
  })

  it('fans out to enabled channels and reports failures without throwing', async () => {
    const calls: string[] = []
    const http: ChannelFetch = async (url) => {
      calls.push(new URL(url).host)
      return url.includes('discord') ? { ok: false, status: 404, text: async () => '{"message": "Unknown Webhook"}' } : { ok: true, status: 200, text: async () => '' }
    }
    const channels = new NotifyChannels(undefined, http)
    await channels.create({ kind: 'teams', config: { webhookUrl: 'https://x.webhook.office.com/a' } })
    const discord = await channels.create({ kind: 'discord', name: 'Ops', config: { webhookUrl: 'https://discord.com/api/webhooks/1/a' } })
    await channels.create({ kind: 'telegram', enabled: false, config: { botToken: '123:ABCDEFGHIJKLMNOPQRSTUVWX', chatId: '1' } })
    const result = await channels.send({ title: 'T', body: 'b' })
    expect(calls.sort()).toEqual(['discord.com', 'x.webhook.office.com'])
    expect(result.sent).toBe(1)
    expect(result.failed).toEqual([{ id: discord.id, name: 'Ops', error: 'Discord answered 404: {"message": "Unknown Webhook"}' }])
    await expect(channels.test(discord.id)).rejects.toThrow(/Discord answered 404/)
  })
})
