/**
 * Composer attachments over the web API: upload validation, serving bytes
 * back, and the durable path that turns a stored reference into what the model
 * actually receives.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWebServer, type LlmProvider, type ModelMessage, type WebServer } from 'dnt-harness'

/** A one-pixel-ish PNG: a real signature is enough for the sniffer. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pixels')])

let home = ''
let server: WebServer
let wsId = ''
/** Messages of the last request the provider served. */
let lastMessages: readonly ModelMessage[] = []

const capturing: LlmProvider = {
  name: 'capturing',
  models: ['capturing'],
  async *stream(request) {
    lastMessages = request.messages
    yield { type: 'delta', delta: 'seen' }
    yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
  },
}

const api = (suffix: string): string => `${server.url}/api/workspaces/${wsId}${suffix}`

async function upload(name: string, mediaType: string, bytes: Buffer): Promise<Response> {
  return fetch(api('/attachments'), {
    method: 'POST',
    headers: { 'content-type': mediaType, 'x-file-name': encodeURIComponent(name) },
    body: new Uint8Array(bytes),
  })
}

async function uploaded(name: string, mediaType: string, bytes: Buffer): Promise<{ id: string; name: string; mediaType: string; bytes: number }> {
  const response = await upload(name, mediaType, bytes)
  expect(response.status).toBe(201)
  return (await response.json()) as { id: string; name: string; mediaType: string; bytes: number }
}

/** Create a conversation and send one message, waiting for the turn to settle. */
async function send(content: string, attachments: unknown[]): Promise<Response> {
  const created = (await (await fetch(api('/sessions'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()) as { id: string }
  const response = await fetch(api(`/sessions/${created.id}/messages`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, attachments }),
  })
  if (response.status === 202) {
    // The turn runs fire-and-forget; wait for the provider to have been asked.
    for (let attempt = 0; attempt < 100 && lastMessages.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  return response
}

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-attach-web-'))
  server = await createWebServer({
    home,
    providers: [capturing],
    activeModel: { provider: 'capturing', model: 'capturing' },
    configFile: path.join(home, 'providers.json'),
  })
  wsId = ((await (await fetch(`${server.url}/api/workspaces`)).json()) as { id: string }[])[0]!.id
})

afterAll(async () => {
  await server?.close().catch(() => {})
  await fs.rm(home, { recursive: true, force: true })
})

describe('attachment uploads', () => {
  it('stores an image and answers with the reference a message carries', async () => {
    const ref = await uploaded('shot.png', 'image/png', PNG)
    expect(ref).toMatchObject({ name: 'shot.png', mediaType: 'image/png', bytes: PNG.length })
    expect(ref.id).toMatch(/^[0-9a-f]{64}$/)
  })

  it('serves stored bytes back with the sniffed type, never the claimed one', async () => {
    const ref = await uploaded('shot.png', 'image/png', PNG)
    const response = await fetch(api(`/attachments/${ref.id}`))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG)
  })

  it('refuses unsupported types and mislabeled images with a reason', async () => {
    const pdf = await upload('report.pdf', 'application/pdf', Buffer.from('%PDF-1.7'))
    expect(pdf.status).toBe(400)
    expect(((await pdf.json()) as { error: string }).error).toMatch(/unsupported type/)

    const lying = await upload('fake.png', 'image/png', Buffer.from('just text'))
    expect(lying.status).toBe(400)
    expect(((await lying.json()) as { error: string }).error).toMatch(/does not contain image data/)
  })

  it('fails closed for an unknown attachment and rejects writes to one', async () => {
    expect((await fetch(api(`/attachments/${'0'.repeat(64)}`))).status).toBe(400)
    expect((await fetch(api('/attachments/nope'))).status).toBe(400)
    expect((await fetch(api(`/attachments/${'0'.repeat(64)}`), { method: 'PUT' })).status).toBe(405)
  })
})

describe('attachments on a message', () => {
  it('sends an image to the model as an image part beside the text', async () => {
    lastMessages = []
    const ref = await uploaded('shot.png', 'image/png', PNG)
    const response = await send('what is this?', [ref])
    expect(response.status).toBe(202)

    const user = lastMessages.find((message) => message.role === 'user')
    expect(Array.isArray(user?.content)).toBe(true)
    expect(user?.content).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image', mediaType: 'image/png', base64: PNG.toString('base64'), name: 'shot.png' },
    ])
  })

  it('inlines a text attachment under its file name and keeps the message a string', async () => {
    lastMessages = []
    const ref = await uploaded('notes.md', 'text/markdown', Buffer.from('# Plan\nship it'))
    await send('read this', [ref])

    const user = lastMessages.find((message) => message.role === 'user')
    expect(typeof user?.content).toBe('string')
    expect(user?.content).toBe('read this\n\nattachment "notes.md":\n```\n# Plan\nship it\n```')
  })

  it('accepts an attachment with no text, since the file is the message', async () => {
    lastMessages = []
    const ref = await uploaded('shot.png', 'image/png', PNG)
    expect((await send('', [ref])).status).toBe(202)
    expect(lastMessages.find((message) => message.role === 'user')?.content).toEqual([
      { type: 'image', mediaType: 'image/png', base64: PNG.toString('base64'), name: 'shot.png' },
    ])
  })

  it('refuses a reference that does not match what is stored', async () => {
    const ref = await uploaded('shot.png', 'image/png', PNG)
    const cases: { attachment: Record<string, unknown>; expected: RegExp }[] = [
      { attachment: { ...ref, bytes: ref.bytes + 5 }, expected: /does not match the stored size/ },
      { attachment: { ...ref, id: 'a'.repeat(64) }, expected: /not stored in this workspace/ },
      { attachment: { ...ref, mediaType: 'image/jpeg' }, expected: /is not image\/jpeg data/ },
      { attachment: { ...ref, mediaType: 'application/zip' }, expected: /unsupported type/ },
      { attachment: { id: ref.id, name: 'x' }, expected: /needs a name and mediaType|stored size/ },
    ]
    for (const { attachment, expected } of cases) {
      const response = await send('hi', [attachment])
      expect(response.status).toBe(400)
      expect(((await response.json()) as { error: string }).error).toMatch(expected)
    }
  })

  it('refuses an empty submission and more attachments than the limit', async () => {
    const ref = await uploaded('shot.png', 'image/png', PNG)
    expect((await send('   ', [])).status).toBe(400)
    const many = await send('hi', Array.from({ length: 11 }, () => ref))
    expect(many.status).toBe(400)
    expect(((await many.json()) as { error: string }).error).toMatch(/at most 10 attachments/)
  })
})
