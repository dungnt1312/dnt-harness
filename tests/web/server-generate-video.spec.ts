/**
 * GenerateVideo end to end: Settings over the web API, a scripted turn that
 * runs a pending → done job against a wire-level fake Videos API, and the
 * stored video served back with Range support.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWebServer, type WebServer } from 'dnt-harness'
import { FakeScriptedLlm } from './fake-llm.ts'

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz')])
const PROJECT_PHOTO = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('project-photo')])

let home = ''
let project = ''
let server: WebServer
let provider: Server
let providerUrl = ''
let wsId = ''
let polls = 0
interface Seen { readonly method: string; readonly url: string; readonly authorization: string | undefined; readonly body: string }
const seen: Seen[] = []

const json = (pathname: string, method: string, body?: unknown): Promise<Response> =>
  fetch(`${server.url}${pathname}`, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })

type Event = { type: string; ok?: boolean; output?: string }
async function events(sessionId: string): Promise<Event[]> {
  const raw = await fs.readFile(path.join(home, 'workspaces', wsId, 'sessions', sessionId, 'events.jsonl'), 'utf8').catch(() => '')
  return raw.trim() === '' ? [] : raw.trim().split('\n').map((line) => JSON.parse(line) as Event)
}
async function turn(sessionId: string, content: string): Promise<Event[]> {
  const before = (await events(sessionId)).filter((event) => event.type === 'turn/end').length
  expect((await json(`/api/workspaces/${wsId}/sessions/${sessionId}/messages`, 'POST', { content })).status).toBe(202)
  await expect.poll(async () => (await events(sessionId)).filter((event) => event.type === 'turn/end').length, { timeout: 15_000 }).toBe(before + 1)
  const all = await events(sessionId)
  return all.slice(all.findLastIndex((event) => event.type === 'user/message')).filter((event) => event.type === 'tool/result')
}

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-genvideo-'))
  project = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-genvideo-project-'))
  await fs.writeFile(path.join(project, 'frame.png'), PROJECT_PHOTO)
  provider = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const url = req.url ?? ''
      seen.push({ method: req.method ?? '', url, authorization: req.headers['authorization'], body: Buffer.concat(chunks).toString('utf8') })
      if (req.method === 'POST' && url === '/v1/videos') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ request_id: 'rid-9' })); return }
      if (req.method === 'GET' && url === '/v1/videos/rid-9') {
        polls += 1
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(polls < 2 ? { status: 'pending', progress: 50 } : { status: 'done', progress: 100, video: { url: `${providerUrl.replace('/v1', '')}/cdn/out.mp4`, duration: 4 } }))
        return
      }
      if (req.method === 'GET' && url === '/cdn/out.mp4') { res.writeHead(200, { 'content-type': 'video/mp4' }).end(MP4); return }
      res.writeHead(404).end()
    })
  })
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
  providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`

  server = await createWebServer({
    home,
    yolo: true,
    providers: [new FakeScriptedLlm([
      { toolCalls: [{ name: 'GenerateVideo', args: { prompt: 'a cat walking', seconds: '4', size: '1280x720' } }] },
      'Here is your cat video.',
      { toolCalls: [{ name: 'GenerateVideo', args: { prompt: 'animate the photo', path: 'frame.png' } }] },
      'Animated.',
    ])],
    activeModel: { provider: 'scripted', model: 'scripted' },
    configFile: path.join(home, 'providers.json'),
  })
  wsId = ((await (await fetch(`${server.url}/api/workspaces`)).json()) as { id: string }[])[0]!.id
})

afterAll(async () => {
  await server?.close().catch(() => {})
  await new Promise<void>((resolve) => provider?.close(() => resolve()))
  await fs.rm(home, { recursive: true, force: true })
  await fs.rm(project, { recursive: true, force: true })
})

describe('Settings → Video generation', () => {
  it('starts unconfigured, validates the provider, and persists a pair', async () => {
    expect(await (await json('/api/video-generation', 'GET')).json()).toEqual({ provider: null, model: null })
    expect((await json('/api/video-generation', 'PUT', { provider: 'nope', model: 'm' })).status).toBe(400)
    expect((await json('/api/video-generation', 'PUT', { provider: 'x' })).status).toBe(400)
    expect((await json('/api/video-generation', 'DELETE')).status).toBe(405)

    const created = await json('/api/providers', 'POST', { name: 'Videos', baseUrl: providerUrl, apiKey: 'sk-vid', models: [] })
    expect(created.status).toBe(201)
    const { id } = (await created.json()) as { id: string }
    const saved = await json('/api/video-generation', 'PUT', { provider: id, model: 'grok-imagine-video' })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual({ provider: id, model: 'grok-imagine-video' })
    expect(JSON.parse(await fs.readFile(path.join(home, 'video-generation.json'), 'utf8'))).toEqual({ provider: id, model: 'grok-imagine-video' })
    // The other two references are independent files.
    expect(await (await json('/api/image-generation', 'GET')).json()).toEqual({ provider: null, model: null })
  })
})

describe('GenerateVideo in a turn', () => {
  it('runs the async job, stores the video, and serves it with Range', async () => {
    const { id } = (await (await json(`/api/workspaces/${wsId}/sessions`, 'POST', {})).json()) as { id: string }
    const [result] = await turn(id, 'make a cat video')

    expect(result?.ok).toBe(true)
    const output = JSON.parse(result?.output ?? '{}') as { videoId: string; mediaType: string; bytes: number; requestId: string; duration: number; model: string }
    expect(output).toMatchObject({ mediaType: 'video/mp4', bytes: MP4.length, requestId: 'rid-9', duration: 4, model: 'grok-imagine-video' })

    expect(seen[0]).toMatchObject({ method: 'POST', url: '/v1/videos', authorization: 'Bearer sk-vid' })
    expect(JSON.parse(seen[0]!.body)).toEqual({ model: 'grok-imagine-video', prompt: 'a cat walking', seconds: '4', size: '1280x720' })
    expect(seen.filter((entry) => entry.url === '/v1/videos/rid-9').length).toBeGreaterThanOrEqual(2)
    // The CDN download carries no provider credentials.
    expect(seen.find((entry) => entry.url === '/cdn/out.mp4')?.authorization).toBeUndefined()

    const base = `${server.url}/api/workspaces/${wsId}/videos/${output.videoId}`
    const whole = await fetch(base)
    expect(whole.status).toBe(200)
    expect(whole.headers.get('content-type')).toBe('video/mp4')
    expect(whole.headers.get('accept-ranges')).toBe('bytes')
    expect(Buffer.from(await whole.arrayBuffer())).toEqual(MP4)

    const part = await fetch(base, { headers: { range: 'bytes=4-11' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe(`bytes 4-11/${MP4.length}`)
    expect(Buffer.from(await part.arrayBuffer())).toEqual(MP4.subarray(4, 12))

    const tail = await fetch(base, { headers: { range: 'bytes=-6' } })
    expect(tail.status).toBe(206)
    expect(Buffer.from(await tail.arrayBuffer())).toEqual(MP4.subarray(MP4.length - 6))

    const open = await fetch(base, { headers: { range: `bytes=${MP4.length - 3}-` } })
    expect(open.status).toBe(206)
    expect(Buffer.from(await open.arrayBuffer())).toEqual(MP4.subarray(MP4.length - 3))

    expect((await fetch(base, { headers: { range: `bytes=${MP4.length}-` } })).status).toBe(416)
    expect((await fetch(base, { headers: { range: 'bytes=abc' } })).status).toBe(416)
    expect((await fetch(base, { method: 'HEAD' })).headers.get('content-length')).toBe(String(MP4.length))
  })

  it('refuses unknown ids, other workspaces, and writes on the video route', async () => {
    const ghost = await fetch(`${server.url}/api/workspaces/${wsId}/videos/${'0'.repeat(64)}`)
    expect(ghost.status).toBe(404)
    expect((await fetch(`${server.url}/api/workspaces/${wsId}/videos/not-a-digest`)).status).toBe(404)
    expect((await fetch(`${server.url}/api/workspaces/${wsId}/videos/${'0'.repeat(64)}`, { method: 'PUT', body: 'x' })).status).toBe(405)
    expect((await fetch(`${server.url}/api/workspaces/nope/videos/${'0'.repeat(64)}`)).status).toBeGreaterThanOrEqual(400)
  })

  it('animates a project file through the session grant', async () => {
    const created = await json(`/api/workspaces/${wsId}/projects`, 'POST', { name: 'Frames', path: project })
    expect(created.status).toBe(201)
    const projectId = ((await created.json()) as { id: string }).id
    const { id } = (await (await json(`/api/workspaces/${wsId}/sessions`, 'POST', { projectId })).json()) as { id: string }
    seen.length = 0
    polls = 0

    const [result] = await turn(id, 'animate frame.png')

    expect(result?.ok).toBe(true)
    const create = JSON.parse(seen.find((entry) => entry.method === 'POST')!.body) as { image: { url: string } }
    expect(create.image.url).toBe(`data:image/png;base64,${PROJECT_PHOTO.toString('base64')}`)
    expect(await fs.readFile(path.join(project, 'frame.png'))).toEqual(PROJECT_PHOTO)
  })
})
