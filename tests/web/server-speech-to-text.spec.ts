/**
 * Speech-to-text end to end: Settings pair over the same model-pair routes,
 * then `POST /api/speech-to-text/transcribe` proxying a wire-level fake
 * OpenAI-compatible Transcriptions API.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWebServer, type WebServer } from 'dnt-harness'

const AUDIO = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x01])

let home = ''
let server: WebServer
let stt: Server
let wsId = ''
interface SttRequest { readonly url: string; readonly authorization: string | undefined; readonly contentType: string; readonly raw: Buffer }
const sttRequests: SttRequest[] = []

const json = (pathname: string, method: string, body?: unknown): Promise<Response> =>
  fetch(`${server.url}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-stt-'))
  stt = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/v1/audio/transcriptions') { res.writeHead(404).end(); return }
      sttRequests.push({ url: req.url ?? '', authorization: req.headers['authorization'], contentType: String(req.headers['content-type'] ?? ''), raw: Buffer.concat(chunks) })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ text: 'xin chào thế giới' }))
    })
  })
  await new Promise<void>((resolve) => stt.listen(0, '127.0.0.1', resolve))
  const sttUrl = `http://127.0.0.1:${(stt.address() as AddressInfo).port}/v1`

  server = await createWebServer({ home, yolo: true, configFile: path.join(home, 'providers.json') })
  wsId = ((await (await fetch(`${server.url}/api/workspaces`)).json()) as { id: string }[])[0]!.id
  void wsId
  const created = await json('/api/providers', 'POST', { name: 'STT', baseUrl: sttUrl, apiKey: 'sk-stt', models: [], kinds: ['stt'] })
  expect(created.status).toBe(201)
  const { id } = (await created.json()) as { id: string }
  const saved = await json('/api/speech-to-text', 'PUT', { provider: id, model: 'whisper-large-v3' })
  expect(saved.status).toBe(200)
})

afterAll(async () => {
  await server?.close().catch(() => {})
  await new Promise<void>((resolve) => stt?.close(() => resolve()))
  await fs.rm(home, { recursive: true, force: true })
})

describe('Settings → Speech-to-text', () => {
  it('is a model pair like image generation: GET/PUT on its own route', async () => {
    const pair = await (await json('/api/speech-to-text', 'GET')).json()
    expect(pair).toMatchObject({ model: 'whisper-large-v3' })
    expect((await json('/api/speech-to-text', 'PUT', { provider: 'nope', model: 'm' })).status).toBe(400)
  })
})

describe('POST /api/speech-to-text/transcribe', () => {
  it('proxies the audio bytes to the configured provider and returns the text', async () => {
    const response = await fetch(`${server.url}/api/speech-to-text/transcribe`, {
      method: 'POST',
      headers: { 'content-type': 'audio/webm' },
      body: AUDIO,
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ text: 'xin chào thế giới' })
    const seen = sttRequests.at(-1)
    expect(seen?.authorization).toBe('Bearer sk-stt')
    expect(seen?.contentType).toContain('multipart/form-data')
    expect(seen?.raw.includes('whisper-large-v3')).toBe(true)
  })

  it('answers 413 for audio over the attachment limit, before any provider request', async () => {
    const setCap = async (value: number): Promise<void> => {
      const view = await server.appConfig.describe()
      await server.appConfig.edit([{ op: 'set', key: 'maxAttachmentBytes', value }], view.hash!)
    }
    const before = sttRequests.length
    const original = server.appConfig.read().values.maxAttachmentBytes
    await setCap(AUDIO.length - 1)
    try {
      const response = await fetch(`${server.url}/api/speech-to-text/transcribe`, { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: AUDIO })
      expect(response.status).toBe(413)
      expect(((await response.json()) as { error: string }).error).toContain(`${AUDIO.length - 1} byte limit`)
      expect(sttRequests.length).toBe(before)
    } finally {
      await setCap(original)
    }
  })

  it('refuses audio before any provider request when not configured (blank pair)', async () => {
    const saved = await json('/api/speech-to-text', 'PUT', { provider: null, model: null })
    expect(saved.status).toBe(200)
    const before = sttRequests.length
    const response = await fetch(`${server.url}/api/speech-to-text/transcribe`, { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: AUDIO })
    expect(response.status).toBe(400)
    expect(sttRequests.length).toBe(before)
    // Restore the pair for later assertions.
    const providers = (await (await json('/api/providers', 'GET')).json()) as { id: string }[]
    await json('/api/speech-to-text', 'PUT', { provider: providers[0]!.id, model: 'whisper-large-v3' })
  })
})

describe('stt-only providers stay out of chat surfaces', () => {
  it('is creatable, carried with kinds by the registry, hidden from workspace chat lists, and still resolvable by the pair', async () => {
    const created = await json('/api/providers', 'POST', { name: 'Groq voice', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', models: [], kinds: ['stt'] })
    expect(created.status).toBe(201)
    const { id } = (await created.json()) as { id: string }

    // The registry keeps every entry (the Settings rail edits it) but marks it.
    const listed = (await (await json('/api/providers', 'GET')).json()) as { id: string; kinds?: string[] }[]
    expect(listed.some((entry) => entry.id === id && (entry.kinds ?? []).includes('stt'))).toBe(true)

    const saved = await json('/api/speech-to-text', 'PUT', { provider: id, model: 'whisper-large-v3' })
    expect(saved.status).toBe(200)

    // Chat surfaces (composer picker, Environment panel) read workspace meta.
    const workspaces = (await (await fetch(`${server.url}/api/workspaces`)).json()) as { id: string }[]
    for (const workspace of workspaces) {
      const meta = (await (await fetch(`${server.url}/api/workspaces/${workspace.id}/meta`)).json()) as { providers: { id: string }[] }
      expect(meta.providers.some((entry) => entry.id === id)).toBe(false)
    }
  })
})
