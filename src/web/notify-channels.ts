import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Notification channels beyond Web Push: a Telegram bot, a Microsoft Teams
 * webhook (Workflows or legacy incoming webhook) and a Discord webhook.
 * Host-global like push. Secrets (bot token, webhook URLs) live in
 * `<home>/notify/channels.json` (0600) and never leave the host: the API only
 * returns a masked summary.
 */

export type ChannelKind = 'telegram' | 'teams' | 'discord'

export interface ChannelConfig {
  readonly botToken?: string
  readonly chatId?: string
  readonly webhookUrl?: string
  /** Teams only: people @mentioned on every message (Entra UPN / email). Not secret. */
  readonly mentions?: readonly string[]
}

export interface ChannelRecord {
  readonly id: string
  readonly kind: ChannelKind
  readonly name: string
  readonly enabled: boolean
  readonly config: ChannelConfig
  readonly createdAt: number
}

/** What the API shows: never the secret itself. */
export interface ChannelView {
  readonly id: string
  readonly kind: ChannelKind
  readonly name: string
  readonly enabled: boolean
  readonly summary: string
  /** Teams: who each message @mentions. */
  readonly mentions?: readonly string[]
  readonly createdAt: number
}

export interface ChannelMessage {
  readonly title: string
  readonly body: string
}

export interface ChannelSendResult {
  readonly sent: number
  readonly failed: readonly { readonly id: string; readonly name: string; readonly error: string }[]
}

/** HTTP seam: tests inject a fake; production uses global fetch. */
export type ChannelFetch = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

export class ChannelError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'ChannelError'
  }
}

const KINDS: readonly ChannelKind[] = ['telegram', 'teams', 'discord']
export const CHANNEL_LABELS: Readonly<Record<ChannelKind, string>> = { telegram: 'Telegram', teams: 'Microsoft Teams', discord: 'Discord' }
const SEND_TIMEOUT_MS = 10_000
/** Per-service message limits, with room for the title line. */
const LIMITS: Readonly<Record<ChannelKind, number>> = { telegram: 4000, teams: 20_000, discord: 1900 }

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text
}

function requireHttps(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') throw new ChannelError(400, `'${field}' is required`)
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new ChannelError(400, `'${field}' is not a valid URL`)
  }
  if (url.protocol !== 'https:') throw new ChannelError(400, `'${field}' must be an https URL`)
  return url.toString()
}

/** Validate a kind's config. `previous` fills secrets the client left blank on edit. */
function parseConfig(kind: ChannelKind, raw: unknown, previous?: ChannelConfig): ChannelConfig {
  const body = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const keep = (key: keyof ChannelConfig): unknown => (body[key] === undefined || body[key] === '' ? previous?.[key] : body[key])
  if (kind === 'telegram') {
    const botToken = keep('botToken')
    const chatId = keep('chatId')
    if (typeof botToken !== 'string' || !/^\d+:[\w-]{20,}$/.test(botToken.trim())) throw new ChannelError(400, "'botToken' must look like 123456:ABC… (from @BotFather)")
    if (typeof chatId !== 'string' || !/^(-?\d+|@\w{4,})$/.test(chatId.trim())) throw new ChannelError(400, "'chatId' must be a numeric chat id or @channelname")
    return { botToken: botToken.trim(), chatId: chatId.trim() }
  }
  const webhookUrl = requireHttps(keep('webhookUrl'), 'webhookUrl')
  if (kind === 'discord' && !/^https:\/\/(?:[\w-]+\.)?(?:discord|discordapp)\.com\/api\/webhooks\//.test(webhookUrl)) {
    throw new ChannelError(400, "'webhookUrl' must be a Discord webhook (https://discord.com/api/webhooks/…)")
  }
  if (kind !== 'teams') return { webhookUrl }
  // Mentions are not secret: an explicit value (even empty) replaces them.
  const mentions = body['mentions'] === undefined ? previous?.mentions ?? [] : parseMentions(body['mentions'])
  return { webhookUrl, ...(mentions.length > 0 ? { mentions } : {}) }
}

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/

/** Emails to @mention: a list or a comma/space/semicolon separated string. */
function parseMentions(raw: unknown): string[] {
  const parts = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,;]+/) : null
  if (parts === null) throw new ChannelError(400, "'mentions' must be a list of emails")
  const emails = [...new Set(parts.map((part) => String(part).trim().toLowerCase()).filter((part) => part !== ''))]
  const bad = emails.filter((email) => !EMAIL.test(email))
  if (bad.length > 0) throw new ChannelError(400, `not an email: ${bad.join(', ')}`)
  if (emails.length > 20) throw new ChannelError(400, 'at most 20 mentions')
  return emails
}

function summaryOf(record: ChannelRecord): string {
  if (record.kind === 'telegram') return `chat ${record.config.chatId ?? '?'}`
  try {
    const url = new URL(record.config.webhookUrl ?? '')
    return `${url.host}/…${url.pathname.slice(-4)}`
  } catch {
    return 'webhook'
  }
}

export function viewOf(record: ChannelRecord): ChannelView {
  return {
    id: record.id, kind: record.kind, name: record.name, enabled: record.enabled, summary: summaryOf(record),
    ...(record.config.mentions !== undefined && record.config.mentions.length > 0 ? { mentions: record.config.mentions } : {}),
    createdAt: record.createdAt,
  }
}

/** The request each service expects. Plain text everywhere: model output must never break a parse mode. */
export function buildRequest(record: ChannelRecord, message: ChannelMessage): { url: string; body: unknown } {
  const text = clip(message.body, LIMITS[record.kind])
  switch (record.kind) {
    case 'telegram':
      return {
        url: `https://api.telegram.org/bot${record.config.botToken ?? ''}/sendMessage`,
        body: { chat_id: record.config.chatId, text: `${message.title}\n\n${text}`, disable_web_page_preview: true },
      }
    case 'discord':
      return {
        url: record.config.webhookUrl ?? '',
        body: { username: 'dnt-harness', content: `**${message.title.replace(/[*_~`|]/g, '')}**\n${text}`, allowed_mentions: { parse: [] } },
      }
    case 'teams': {
      // Adaptive Card: accepted by Teams Workflows webhooks and legacy incoming
      // webhooks. Mentions pair an `<at>…</at>` token in the text with an
      // `msteams.entities` entry; the UPN/email is the mentioned id.
      const mentions = record.config.mentions ?? []
      return {
        url: record.config.webhookUrl ?? '',
        body: {
          type: 'message',
          attachments: [{
            contentType: 'application/vnd.microsoft.card.adaptive',
            content: {
              $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
              type: 'AdaptiveCard',
              version: '1.4',
              body: [
                { type: 'TextBlock', text: message.title, weight: 'Bolder', size: 'Medium', wrap: true },
                ...(mentions.length > 0 ? [{ type: 'TextBlock', text: mentions.map((email) => `<at>${email}</at>`).join(' '), wrap: true }] : []),
                { type: 'TextBlock', text, wrap: true },
              ],
              ...(mentions.length > 0
                ? { msteams: { entities: mentions.map((email) => ({ type: 'mention', text: `<at>${email}</at>`, mentioned: { id: email, name: email } })) } }
                : {}),
            },
          }],
        },
      }
    }
  }
}

export class NotifyChannels {
  private rows: ChannelRecord[] | undefined
  private write: Promise<void> = Promise.resolve()

  constructor(private readonly dir: string | undefined, private readonly http: ChannelFetch = (url, init) => fetch(url, init)) {}

  async list(): Promise<readonly ChannelView[]> {
    return (await this.load()).map(viewOf)
  }

  /** Display names of the enabled channels a run would reach (`ids` null = all enabled). */
  async enabledNames(ids: readonly string[] | null = null): Promise<readonly string[]> {
    return (await this.load()).filter((row) => row.enabled && (ids === null || ids.includes(row.id))).map((row) => `${CHANNEL_LABELS[row.kind]} "${row.name}"`)
  }

  async create(body: Record<string, unknown>): Promise<ChannelView> {
    const kind = body['kind']
    if (typeof kind !== 'string' || !KINDS.includes(kind as ChannelKind)) throw new ChannelError(400, "'kind' must be telegram, teams or discord")
    const record: ChannelRecord = {
      id: `chan-${randomUUID()}`,
      kind: kind as ChannelKind,
      name: nameOf(body['name'], CHANNEL_LABELS[kind as ChannelKind]),
      enabled: body['enabled'] !== false,
      config: parseConfig(kind as ChannelKind, body['config']),
      createdAt: Date.now(),
    }
    await this.save([...await this.load(), record])
    return viewOf(record)
  }

  async update(id: string, body: Record<string, unknown>): Promise<ChannelView> {
    const rows = await this.load()
    const current = rows.find((row) => row.id === id)
    if (current === undefined) throw new ChannelError(404, 'no such channel')
    if (body['enabled'] !== undefined && typeof body['enabled'] !== 'boolean') throw new ChannelError(400, "'enabled' must be a boolean")
    const next: ChannelRecord = {
      ...current,
      ...(body['name'] !== undefined ? { name: nameOf(body['name'], current.name) } : {}),
      ...(typeof body['enabled'] === 'boolean' ? { enabled: body['enabled'] } : {}),
      ...(body['config'] !== undefined ? { config: parseConfig(current.kind, body['config'], current.config) } : {}),
    }
    await this.save(rows.map((row) => (row.id === id ? next : row)))
    return viewOf(next)
  }

  async remove(id: string): Promise<void> {
    const rows = await this.load()
    if (!rows.some((row) => row.id === id)) throw new ChannelError(404, 'no such channel')
    await this.save(rows.filter((row) => row.id !== id))
  }

  /** Send to one channel (Send test); throws a ChannelError(502) with the service's answer on failure. */
  async test(id: string): Promise<void> {
    const record = (await this.load()).find((row) => row.id === id)
    if (record === undefined) throw new ChannelError(404, 'no such channel')
    await this.deliver(record, { title: 'dnt-harness', body: 'Notifications are working.' })
  }

  /**
   * Fan out to enabled channels, limited to `ids` when given (null = all).
   * Never throws; failures are reported and logged.
   */
  async send(message: ChannelMessage, ids: readonly string[] | null = null): Promise<ChannelSendResult> {
    let rows: readonly ChannelRecord[]
    try {
      rows = (await this.load()).filter((row) => row.enabled && (ids === null || ids.includes(row.id)))
    } catch (error) {
      console.error(`notify: channels unavailable: ${String(error)}`)
      return { sent: 0, failed: [] }
    }
    const failed: { id: string; name: string; error: string }[] = []
    await Promise.all(rows.map(async (row) => {
      try {
        await this.deliver(row, message)
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error)
        failed.push({ id: row.id, name: row.name, error: text })
        console.error(`notify: ${row.kind} "${row.name}" failed: ${text}`)
      }
    }))
    return { sent: rows.length - failed.length, failed }
  }

  private async deliver(record: ChannelRecord, message: ChannelMessage): Promise<void> {
    const request = buildRequest(record, message)
    let response: Awaited<ReturnType<ChannelFetch>>
    try {
      response = await this.http(request.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      })
    } catch (error) {
      throw new ChannelError(502, `${CHANNEL_LABELS[record.kind]} unreachable: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) {
      const detail = clip((await response.text().catch(() => '')).replace(/\s+/g, ' ').trim(), 200)
      throw new ChannelError(502, `${CHANNEL_LABELS[record.kind]} answered ${response.status}${detail !== '' ? `: ${detail}` : ''}`)
    }
  }

  private async load(): Promise<ChannelRecord[]> {
    if (this.rows !== undefined) return this.rows
    let rows: ChannelRecord[] = []
    if (this.dir !== undefined) {
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(this.dir, 'channels.json'), 'utf8')) as unknown
        if (Array.isArray(parsed)) rows = parsed.filter((row): row is ChannelRecord => typeof row?.id === 'string' && KINDS.includes(row?.kind) && typeof row?.config === 'object')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`notify: channels.json unreadable: ${String(error)}`)
      }
    }
    this.rows = rows
    return rows
  }

  private async save(rows: ChannelRecord[]): Promise<void> {
    this.rows = rows
    if (this.dir === undefined) return
    const dir = this.dir
    const content = JSON.stringify(rows, null, 2)
    this.write = this.write.catch(() => {}).then(async () => {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 })
      const file = path.join(dir, 'channels.json')
      const temp = `${file}.${randomUUID()}.tmp`
      await fs.writeFile(temp, content, { encoding: 'utf8', mode: 0o600 })
      await fs.rename(temp, file)
    })
    await this.write
  }
}

function nameOf(raw: unknown, fallback: string): string {
  if (raw === undefined) return fallback
  if (typeof raw !== 'string') throw new ChannelError(400, "'name' must be a string")
  return raw.trim() === '' ? fallback : raw.trim().slice(0, 60)
}
