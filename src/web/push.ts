import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import webpush from 'web-push'

/**
 * Web Push for the installed PWA: one VAPID key pair per host (generated on
 * first use) and the list of subscribed devices. Host-global, not per
 * workspace — a phone subscribes once and hears every automation.
 *
 * Files under `<home>/push/`: `vapid.json` (0600) and `subscriptions.json`.
 */

export interface PushSubscriptionRecord {
  readonly id: string
  readonly endpoint: string
  readonly keys: { readonly p256dh: string; readonly auth: string }
  readonly label: string
  readonly createdAt: number
}

export interface PushPayload {
  readonly title: string
  readonly body: string
  /** Same-origin path the notification opens. */
  readonly url: string
  /** Replaces an earlier notification with the same tag. */
  readonly tag?: string
}

export interface PushSendResult {
  readonly sent: number
  readonly removed: number
  readonly failed: number
}

/** Transport seam: the real one calls web-push; tests inject a fake. */
export type PushSender = (subscription: PushSubscriptionRecord, body: string, vapid: VapidKeys) => Promise<{ statusCode: number }>

export interface VapidKeys {
  readonly publicKey: string
  readonly privateKey: string
  /** `mailto:` or URL contact required by push services. */
  readonly subject: string
}

export class PushError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'PushError'
  }
}

const defaultSender: PushSender = async (subscription, body, vapid) => {
  const result = await webpush.sendNotification(
    { endpoint: subscription.endpoint, keys: { ...subscription.keys } },
    body,
    { vapidDetails: vapid, TTL: 6 * 60 * 60, urgency: 'high' },
  )
  return { statusCode: result.statusCode }
}

export class PushService {
  private vapid: VapidKeys | undefined
  private subscriptions: PushSubscriptionRecord[] | undefined
  private write: Promise<void> = Promise.resolve()

  constructor(private readonly dir: string | undefined, private readonly sender: PushSender = defaultSender) {}

  async publicKey(): Promise<string> {
    return (await this.keys()).publicKey
  }

  async list(): Promise<readonly PushSubscriptionRecord[]> {
    return this.load()
  }

  /** Add or refresh a device (same endpoint replaces its record). */
  async subscribe(raw: unknown, label: string): Promise<PushSubscriptionRecord> {
    if (raw === null || typeof raw !== 'object') throw new PushError(400, "body needs a 'subscription' object")
    const { endpoint, keys } = raw as Record<string, unknown>
    if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint)) throw new PushError(400, "'subscription.endpoint' must be an https URL")
    const k = (keys ?? {}) as Record<string, unknown>
    if (typeof k['p256dh'] !== 'string' || typeof k['auth'] !== 'string') throw new PushError(400, "'subscription.keys' needs p256dh and auth")
    const rows = await this.load()
    const record: PushSubscriptionRecord = {
      id: rows.find((row) => row.endpoint === endpoint)?.id ?? `push-${randomUUID()}`,
      endpoint,
      keys: { p256dh: k['p256dh'], auth: k['auth'] },
      label: label.slice(0, 120),
      createdAt: Date.now(),
    }
    await this.save([...rows.filter((row) => row.endpoint !== endpoint), record])
    return record
  }

  async unsubscribe(id: string): Promise<void> {
    const rows = await this.load()
    if (!rows.some((row) => row.id === id)) throw new PushError(404, 'no such subscription')
    await this.save(rows.filter((row) => row.id !== id))
  }

  /** Fan out to every device; gone endpoints (404/410) are dropped. Never throws. */
  async send(payload: PushPayload): Promise<PushSendResult> {
    let rows: readonly PushSubscriptionRecord[]
    let vapid: VapidKeys
    try {
      rows = await this.load()
      if (rows.length === 0) return { sent: 0, removed: 0, failed: 0 }
      vapid = await this.keys()
    } catch (error) {
      console.error(`push: unavailable: ${String(error)}`)
      return { sent: 0, removed: 0, failed: 0 }
    }
    const body = JSON.stringify(payload)
    const gone = new Set<string>()
    let sent = 0
    let failed = 0
    await Promise.all(rows.map(async (row) => {
      try {
        await this.sender(row, body, vapid)
        sent += 1
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode
        if (status === 404 || status === 410) gone.add(row.id)
        else {
          failed += 1
          console.error(`push: delivery to ${row.label || row.id} failed: ${String(error instanceof Error ? error.message : error)}`)
        }
      }
    }))
    if (gone.size > 0) {
      await this.save((await this.load()).filter((row) => !gone.has(row.id))).catch(() => {})
    }
    return { sent, removed: gone.size, failed }
  }

  private async keys(): Promise<VapidKeys> {
    if (this.vapid !== undefined) return this.vapid
    const file = this.dir === undefined ? undefined : path.join(this.dir, 'vapid.json')
    if (file !== undefined) {
      try {
        const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<VapidKeys>
        if (typeof parsed.publicKey === 'string' && typeof parsed.privateKey === 'string') {
          this.vapid = { publicKey: parsed.publicKey, privateKey: parsed.privateKey, subject: parsed.subject ?? 'mailto:dnt-harness@localhost' }
          return this.vapid
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const generated = webpush.generateVAPIDKeys()
    const keys: VapidKeys = { ...generated, subject: 'mailto:dnt-harness@localhost' }
    if (file !== undefined) {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      await fs.writeFile(file, JSON.stringify(keys, null, 2), { encoding: 'utf8', mode: 0o600 })
    }
    this.vapid = keys
    return keys
  }

  private async load(): Promise<PushSubscriptionRecord[]> {
    if (this.subscriptions !== undefined) return this.subscriptions
    let rows: PushSubscriptionRecord[] = []
    if (this.dir !== undefined) {
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(this.dir, 'subscriptions.json'), 'utf8')) as unknown
        if (Array.isArray(parsed)) rows = parsed.filter((row): row is PushSubscriptionRecord => typeof (row as PushSubscriptionRecord)?.endpoint === 'string' && typeof (row as PushSubscriptionRecord)?.id === 'string')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`push: subscriptions unreadable: ${String(error)}`)
      }
    }
    this.subscriptions = rows
    return rows
  }

  private async save(rows: PushSubscriptionRecord[]): Promise<void> {
    this.subscriptions = rows
    if (this.dir === undefined) return
    const dir = this.dir
    const content = JSON.stringify(rows, null, 2)
    this.write = this.write.catch(() => {}).then(async () => {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 })
      const file = path.join(dir, 'subscriptions.json')
      const temp = `${file}.${randomUUID()}.tmp`
      await fs.writeFile(temp, content, { encoding: 'utf8', mode: 0o600 })
      await fs.rename(temp, file)
    })
    await this.write
  }
}
