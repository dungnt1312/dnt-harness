/**
 * Image tools end to end: Settings → Image generation over the web API, and
 * scripted turns that call GenerateImage and EditImage against a wire-level
 * fake Images API, with the stored attachments the transcript renders.
 */
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWebServer, type WebServer } from 'dnt-harness'
import { FakeScriptedLlm } from './fake-llm.ts'

const png = (tag: string): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tag)])
const GENERATED = png('generated-pixels')
const EDITED = png('edited-pixels')
const PROJECT_PHOTO = png('project-photo')
/** Attachments are content-addressed, so the generated image's id is known up front. */
const GENERATED_ID = createHash('sha256').update(GENERATED).digest('hex')

let home = ''
let project = ''
let server: WebServer
let images: Server
let imagesUrl = ''
let wsId = ''
interface ImageRequest { readonly url: string; readonly authorization: string | undefined; readonly contentType: string; readonly raw: Buffer }
const imageRequests: ImageRequest[] = []

const json = (pathname: string, method: string, body?: unknown): Promise<Response> =>
  fetch(`${server.url}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

type Event = { type: string; ok?: boolean; output?: string; name?: string }

async function events(sessionId: string): Promise<Event[]> {
  const raw = await fs.readFile(path.join(home, 'workspaces', wsId, 'sessions', sessionId, 'events.jsonl'), 'utf8').catch(() => '')
  return raw.trim() === '' ? [] : raw.trim().split('\n').map((line) => JSON.parse(line) as Event)
}

/** Send one message and wait for its turn to settle; answers that turn's tool results. */
async function turn(sessionId: string, content: string): Promise<Event[]> {
  const before = (await events(sessionId)).filter((event) => event.type === 'turn/end').length
  expect((await json(`/api/workspaces/${wsId}/sessions/${sessionId}/messages`, 'POST', { content })).status).toBe(202)
  await expect.poll(async () => (await events(sessionId)).filter((event) => event.type === 'turn/end').length, { timeout: 8_000 }).toBe(before + 1)
  const all = await events(sessionId)
  const start = all.findLastIndex((event) => event.type === 'user/message')
  return all.slice(start).filter((event) => event.type === 'tool/result')
}

async function served(id: string): Promise<Buffer> {
  const response = await fetch(`${server.url}/api/workspaces/${wsId}/attachments/${id}`)
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('image/png')
  return Buffer.from(await response.arrayBuffer())
}

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-genimg-'))
  project = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-genimg-project-'))
  await fs.writeFile(path.join(project, 'photo.png'), PROJECT_PHOTO)
  images = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const route = req.url ?? ''
      if (req.method !== 'POST' || (route !== '/v1/images/generations' && route !== '/v1/images/edits')) { res.writeHead(404).end(); return }
      imageRequests.push({ url: route, authorization: req.headers['authorization'], contentType: String(req.headers['content-type'] ?? ''), raw: Buffer.concat(chunks) })
      const result = route.endsWith('/generations') ? { b64_json: GENERATED.toString('base64'), revised_prompt: 'a fluffy cat' } : { b64_json: EDITED.toString('base64') }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ created: 1, data: [result] }))
    })
  })
  await new Promise<void>((resolve) => images.listen(0, '127.0.0.1', resolve))
  imagesUrl = `http://127.0.0.1:${(images.address() as AddressInfo).port}/v1`

  server = await createWebServer({
    home,
    yolo: true,
    providers: [new FakeScriptedLlm([
      // Turn 1: generate, then refine that exact image by its attachment id.
      { toolCalls: [{ name: 'GenerateImage', args: { prompt: 'a cat', size: '1024x1024' } }] },
      { toolCalls: [{ name: 'EditImage', args: { prompt: 'make it night', attachmentId: GENERATED_ID } }] },
      'Here is your night cat.',
      // Turn 2: edit a file from the project folder.
      { toolCalls: [{ name: 'EditImage', args: { prompt: 'add a hat', path: 'photo.png' } }] },
      'Added a hat.',
    ])],
    activeModel: { provider: 'scripted', model: 'scripted' },
    configFile: path.join(home, 'providers.json'),
  })
  wsId = ((await (await fetch(`${server.url}/api/workspaces`)).json()) as { id: string }[])[0]!.id
})

afterAll(async () => {
  await server?.close().catch(() => {})
  await new Promise<void>((resolve) => images?.close(() => resolve()))
  await fs.rm(home, { recursive: true, force: true })
  await fs.rm(project, { recursive: true, force: true })
})

describe('Settings → Image generation', () => {
  it('starts unconfigured, validates the provider, and persists a pair', async () => {
    expect(await (await json('/api/image-generation', 'GET')).json()).toEqual({ provider: null, model: null })
    expect((await json('/api/image-generation', 'PUT', { provider: 'nope', model: 'm' })).status).toBe(400)
    expect((await json('/api/image-generation', 'PUT', { provider: 'x' })).status).toBe(400)

    const created = await json('/api/providers', 'POST', { name: 'Images', baseUrl: imagesUrl, apiKey: 'sk-img', models: [] })
    expect(created.status).toBe(201)
    const { id } = (await created.json()) as { id: string }
    const saved = await json('/api/image-generation', 'PUT', { provider: id, model: 'gpt-image-1' })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual({ provider: id, model: 'gpt-image-1' })

    const onDisk = JSON.parse(await fs.readFile(path.join(home, 'image-generation.json'), 'utf8')) as unknown
    expect(onDisk).toEqual({ provider: id, model: 'gpt-image-1' })
  })
})

describe('image tools in a turn', () => {
  it('generates an image, then edits it by attachment id, storing each as a new attachment', async () => {
    const { id } = (await (await json(`/api/workspaces/${wsId}/sessions`, 'POST', {})).json()) as { id: string }
    const results = await turn(id, 'draw a cat, then make it night')

    expect(imageRequests.map((request) => request.url)).toEqual(['/v1/images/generations', '/v1/images/edits'])
    const [generate, edit] = imageRequests
    expect(generate!.authorization).toBe('Bearer sk-img')
    expect(JSON.parse(generate!.raw.toString('utf8'))).toEqual({ model: 'gpt-image-1', prompt: 'a cat', n: 1, response_format: 'b64_json', size: '1024x1024' })
    // The edit is multipart, carrying the generated image's own bytes.
    expect(edit!.contentType).toMatch(/^multipart\/form-data; boundary=/)
    expect(edit!.raw.includes('make it night')).toBe(true)
    expect(edit!.raw.includes(GENERATED)).toBe(true)

    expect(results.map((result) => result.ok)).toEqual([true, true])
    const generated = JSON.parse(results[0]!.output ?? '{}') as { attachmentId: string; revisedPrompt: string }
    const edited = JSON.parse(results[1]!.output ?? '{}') as { attachmentId: string; sourceAttachmentId: string }
    expect(generated).toMatchObject({ attachmentId: GENERATED_ID, revisedPrompt: 'a fluffy cat' })
    expect(edited.sourceAttachmentId).toBe(GENERATED_ID)
    expect(edited.attachmentId).not.toBe(GENERATED_ID)
    // The source survives the edit; the edit is its own stored image.
    expect(await served(generated.attachmentId)).toEqual(GENERATED)
    expect(await served(edited.attachmentId)).toEqual(EDITED)
  })

  it('edits a project file through the session grant', async () => {
    const created = await json(`/api/workspaces/${wsId}/projects`, 'POST', { name: 'Photos', path: project })
    expect(created.status).toBe(201)
    const projectId = ((await created.json()) as { id: string }).id
    const { id } = (await (await json(`/api/workspaces/${wsId}/sessions`, 'POST', { projectId })).json()) as { id: string }
    imageRequests.length = 0

    const [result] = await turn(id, 'add a hat to photo.png')

    expect(result?.ok).toBe(true)
    expect(imageRequests).toHaveLength(1)
    expect(imageRequests[0]!.raw.includes(PROJECT_PHOTO)).toBe(true)
    expect(imageRequests[0]!.raw.includes('filename="photo.png"')).toBe(true)
    const output = JSON.parse(result?.output ?? '{}') as { attachmentId: string; sourceAttachmentId?: string }
    expect(output.sourceAttachmentId).toBeUndefined()
    expect(await served(output.attachmentId)).toEqual(EDITED)
    // The project file itself is untouched.
    expect(await fs.readFile(path.join(project, 'photo.png'))).toEqual(PROJECT_PHOTO)
  })
})
