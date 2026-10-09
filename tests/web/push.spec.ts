import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PushError, PushService, type PushSender } from '../../src/web/push.ts'

const sub = (n: number) => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: `p${n}`, auth: `a${n}` } })

let dir = ''
beforeEach(async () => { dir = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-push-')) })
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

describe('PushService', () => {
  it('generates VAPID keys once with private permissions and reuses them', async () => {
    const first = new PushService(dir)
    const key = await first.publicKey()
    expect(key.length).toBeGreaterThan(40)
    const stat = await fs.stat(path.join(dir, 'vapid.json'))
    expect(stat.mode & 0o777).toBe(0o600)
    expect(await new PushService(dir).publicKey()).toBe(key)
  })

  it('validates subscriptions and replaces the same endpoint', async () => {
    const push = new PushService(dir)
    await expect(push.subscribe({ endpoint: 'http://insecure', keys: { p256dh: 'x', auth: 'y' } }, 'x')).rejects.toBeInstanceOf(PushError)
    const a = await push.subscribe(sub(1), 'iPhone')
    const again = await push.subscribe(sub(1), 'iPhone renamed')
    expect(again.id).toBe(a.id)
    expect(await new PushService(dir).list()).toHaveLength(1)
  })

  it('fans out and drops gone endpoints', async () => {
    const delivered: string[] = []
    const sender: PushSender = async (row, body) => {
      if (row.endpoint.endsWith('/2')) throw Object.assign(new Error('gone'), { statusCode: 410 })
      if (row.endpoint.endsWith('/3')) throw Object.assign(new Error('boom'), { statusCode: 500 })
      delivered.push(`${row.endpoint} ${JSON.parse(body).title}`)
      return { statusCode: 201 }
    }
    const push = new PushService(dir, sender)
    for (const n of [1, 2, 3]) await push.subscribe(sub(n), `d${n}`)
    const result = await push.send({ title: 'Pills', body: 'take them', url: '/' })
    expect(result).toEqual({ sent: 1, removed: 1, failed: 1 })
    expect(delivered).toEqual(['https://push.example/1 Pills'])
    expect((await push.list()).map((row) => row.endpoint)).toEqual(['https://push.example/1', 'https://push.example/3'])
  })

  it('sends nothing without subscribers', async () => {
    expect(await new PushService(undefined).send({ title: 't', body: 'b', url: '/' })).toEqual({ sent: 0, removed: 0, failed: 0 })
  })
})
