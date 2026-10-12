import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { generateVideoTool, parseVideoCreate, parseVideoStatus, type GenerateVideoOptions, type VideoApiResolution } from '../../src/harness/tools/video-tools.ts'
import { resolveInGrants } from '../../src/capabilities/fs/grants.ts'
import type { VideoRef } from '../../src/harness/attachments/video-store.ts'
import type { ToolExecution } from '../../src/harness/tools/types.ts'

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.from('....-video')])
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('frame')])
const SOURCE_ID = 'c'.repeat(64)
const VIDEO_ID = 'd'.repeat(64)
const CONFIGURED: VideoApiResolution = { ok: true, config: { baseUrl: 'https://vid.test/v1/', apiKey: 'sk-vid', model: 'grok-imagine-video' } }
const exec: ToolExecution = { root: '/tmp', workspaceId: 'ws-1' }

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** A fetch that plays a scripted job: create, N pending polls, then done. */
function job(options: { readonly pending?: number; readonly done?: Record<string, unknown>; readonly downloadStatus?: number } = {}) {
  let polls = 0
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    if (url === 'https://vid.test/v1/videos' && init?.method === 'POST') return json({ request_id: 'rid-1' })
    if (url === 'https://vid.test/v1/videos/rid-1') {
      polls += 1
      if (polls <= (options.pending ?? 0)) return json({ status: 'pending', progress: polls * 25 })
      return json(options.done ?? { status: 'done', progress: 100, video: { url: 'https://cdn.test/out.mp4', duration: 4 } })
    }
    if (url === 'https://cdn.test/out.mp4' || url === 'https://vid.test/v1/videos/rid-1/content') {
      return options.downloadStatus !== undefined ? new Response('nope', { status: options.downloadStatus }) : new Response(new Uint8Array(MP4))
    }
    return new Response('unexpected', { status: 404 })
  })
  return { fetchMock, calls, polls: () => polls }
}

/** `realSleep` keeps the tool's own timer so a real (tiny) budget can expire. */
function setup(fetchMock: typeof fetch, overrides: Partial<GenerateVideoOptions> = {}, realSleep = false) {
  const stored: { workspaceId: string; bytes: Buffer }[] = []
  const sleeps: number[] = []
  const tool = generateVideoTool({
    resolve: () => CONFIGURED,
    fetch: fetchMock,
    ...(realSleep ? {} : { sleep: async (ms: number) => { sleeps.push(ms) } }),
    store: async (workspaceId, body): Promise<VideoRef> => {
      const bytes = Buffer.from(await new Response(body).arrayBuffer())
      stored.push({ workspaceId, bytes })
      return { id: VIDEO_ID, mediaType: 'video/mp4', bytes: bytes.length }
    },
    read: async (workspaceId, id) => {
      if (workspaceId !== 'ws-1' || id !== SOURCE_ID) throw new Error(`attachment '${id}' is not stored in this workspace`)
      return { bytes: PNG, mediaType: 'image/png' }
    },
    resolvePath: (run, target) => resolveInGrants(run, target, 'read'),
    ...overrides,
  })
  return { tool, stored, sleeps }
}

describe('GenerateVideo tool', () => {
  it('creates a job, polls until done, downloads the url, and stores the video', async () => {
    const { fetchMock, calls } = job({ pending: 2 })
    const { tool, stored, sleeps } = setup(fetchMock as unknown as typeof fetch)

    const output = JSON.parse(await tool.execute({ prompt: '  a cat walking ', seconds: '4', size: '1280x720' }, exec)) as Record<string, unknown>

    expect(output).toEqual({ videoId: VIDEO_ID, mediaType: 'video/mp4', bytes: MP4.length, model: 'grok-imagine-video', requestId: 'rid-1', duration: 4, progress: 100 })
    expect(stored).toEqual([{ workspaceId: 'ws-1', bytes: MP4 }])
    expect(sleeps).toEqual([2000, 2000])
    const create = calls[0]!
    expect(create.url).toBe('https://vid.test/v1/videos')
    expect((create.init!.headers as Record<string, string>)['authorization']).toBe('Bearer sk-vid')
    expect(JSON.parse(String(create.init!.body))).toEqual({ model: 'grok-imagine-video', prompt: 'a cat walking', seconds: '4', size: '1280x720' })
    // The provider's CDN gets no credentials.
    const download = calls.find((call) => call.url === 'https://cdn.test/out.mp4')!
    expect(download.init?.headers).toEqual({})
  })

  it('falls back to the content endpoint with credentials when the job reports no url', async () => {
    const { fetchMock, calls } = job({ done: { status: 'completed', progress: 100 } })
    const { tool, stored } = setup(fetchMock as unknown as typeof fetch)
    const output = JSON.parse(await tool.execute({ prompt: 'cat' }, exec)) as Record<string, unknown>
    expect(output['duration']).toBeNull()
    expect(stored[0]?.bytes).toEqual(MP4)
    const content = calls.find((call) => call.url.endsWith('/content'))!
    expect((content.init?.headers as Record<string, string>)['authorization']).toBe('Bearer sk-vid')
  })

  it('sends a stored image as a data URL for image-to-video and records its source', async () => {
    const { fetchMock, calls } = job()
    const { tool } = setup(fetchMock as unknown as typeof fetch)
    const output = JSON.parse(await tool.execute({ prompt: 'animate', attachmentId: SOURCE_ID }, exec)) as Record<string, unknown>
    expect(output['sourceAttachmentId']).toBe(SOURCE_ID)
    expect(JSON.parse(String(calls[0]!.init!.body))['image']).toEqual({ url: `data:image/png;base64,${PNG.toString('base64')}` })
  })

  it('reads a path source through the grants and refuses one outside them', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'dnt-video-tool-'))
    try {
      await fs.writeFile(path.join(root, 'frame.png'), PNG)
      const { fetchMock, calls } = job()
      const { tool } = setup(fetchMock as unknown as typeof fetch)
      const run: ToolExecution = { root, workspaceId: 'ws-1' }
      await tool.execute({ prompt: 'animate', path: 'frame.png' }, run)
      expect(JSON.parse(String(calls[0]!.init!.body))['image']).toBeDefined()
      calls.length = 0
      await expect(tool.execute({ prompt: 'animate', path: '/etc/hosts' }, run)).rejects.toThrow(/escapes the workspace root/)
      expect(calls).toEqual([])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('validates arguments, scope, and configuration before any request', async () => {
    const fetchMock = vi.fn()
    const { tool } = setup(fetchMock as unknown as typeof fetch)
    await expect(tool.execute({}, exec)).rejects.toThrow(/prompt/)
    await expect(tool.execute({ prompt: '  ' }, exec)).rejects.toThrow(/prompt/)
    await expect(tool.execute({ prompt: 'x', seconds: 'soon' }, exec)).rejects.toThrow(/seconds/)
    await expect(tool.execute({ prompt: 'x', size: 'big' }, exec)).rejects.toThrow(/size/)
    await expect(tool.execute({ prompt: 'x', attachmentId: SOURCE_ID, path: 'a.png' }, exec)).rejects.toThrow(/exactly one source/)
    await expect(tool.execute({ prompt: 'x' }, { root: '/tmp' })).rejects.toThrow(/workspace/)
    const unconfigured = setup(fetchMock as unknown as typeof fetch, { resolve: () => ({ ok: false, reason: 'Video generation is not configured.' }) })
    await expect(unconfigured.tool.execute({ prompt: 'x' }, exec)).rejects.toThrow(/not configured/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('accepts seconds as a number', async () => {
    const { fetchMock, calls } = job()
    await setup(fetchMock as unknown as typeof fetch).tool.execute({ prompt: 'x', seconds: 8 }, exec)
    expect(JSON.parse(String(calls[0]!.init!.body))['seconds']).toBe('8')
  })

  it('reports create failures, a missing job id, and terminal job states with the request id', async () => {
    const rejected = vi.fn(async () => new Response('{"error":"bad model"}', { status: 400 }))
    await expect(setup(rejected as unknown as typeof fetch).tool.execute({ prompt: 'x' }, exec)).rejects.toThrow(/video create HTTP 400: \{"error":"bad model"\}/)

    const noId = vi.fn(async () => json({ ok: true }))
    await expect(setup(noId as unknown as typeof fetch).tool.execute({ prompt: 'x' }, exec)).rejects.toThrow(/no request_id or id/)

    for (const status of ['failed', 'expired', 'cancelled']) {
      const { fetchMock } = job({ done: { status } })
      await expect(setup(fetchMock as unknown as typeof fetch).tool.execute({ prompt: 'x' }, exec)).rejects.toThrow(new RegExp(`status '${status}'.*request_id=rid-1`))
    }
    // An error message is terminal even when the status word is unknown or in-progress.
    const { fetchMock } = job({ done: { status: 'running', error: { message: 'moderation blocked' } } })
    await expect(setup(fetchMock as unknown as typeof fetch).tool.execute({ prompt: 'x' }, exec)).rejects.toThrow(/moderation blocked; request_id=rid-1/)
  })

  it('reports download failures and non-video bodies without storing', async () => {
    const down = job({ downloadStatus: 410 })
    await expect(setup(down.fetchMock as unknown as typeof fetch).tool.execute({ prompt: 'x' }, exec)).rejects.toThrow(/download video HTTP 410; request_id=rid-1/)
    const rejecting = setup(job().fetchMock as unknown as typeof fetch, { store: async () => { throw new Error('response is not a playable video') } })
    await expect(rejecting.tool.execute({ prompt: 'x' }, exec)).rejects.toThrow(/not a playable video/)
  })

  it('times out with the request id when the job never finishes', async () => {
    const { fetchMock } = job({ pending: 1_000_000 })
    // A real, tiny budget: the signal aborts while the poll loop sleeps.
    const { tool } = setup(fetchMock as unknown as typeof fetch, { timeoutMs: 30, pollIntervalMs: 5 }, true)
    await expect(tool.execute({ prompt: 'x' }, exec)).rejects.toThrow(/timed out waiting for the video.*request_id=rid-1/)
  })

  it('stops polling when the turn is stopped', async () => {
    const { fetchMock } = job({ pending: 1_000_000 })
    const controller = new AbortController()
    const { tool } = setup(fetchMock as unknown as typeof fetch, {
      sleep: async (_ms, signal) => { controller.abort(); throw signal.reason ?? new Error('aborted') },
    })
    await expect(tool.execute({ prompt: 'x' }, { ...exec, signal: controller.signal })).rejects.toThrow(/cancelled; request_id=rid-1/)
  })
})

describe('video response parsing', () => {
  it('reads the job id from request_id or id', () => {
    expect(parseVideoCreate('{"request_id":"a"}')).toBe('a')
    expect(parseVideoCreate('{"id":"b"}')).toBe('b')
    expect(() => parseVideoCreate('nope')).toThrow(/not JSON/)
    expect(() => parseVideoCreate('{}')).toThrow(/no request_id or id/)
  })

  it('reads status, progress, duration, and url from either shape, and errors from string or object', () => {
    expect(parseVideoStatus('{"status":"DONE","progress":100,"video":{"url":"https://x/y.mp4","duration":8}}')).toEqual({ status: 'done', progress: 100, videoUrl: 'https://x/y.mp4', duration: 8, error: null })
    expect(parseVideoStatus('{"status":"completed","video_url":"https://x/z.mp4","duration":5}')).toMatchObject({ videoUrl: 'https://x/z.mp4', duration: 5 })
    expect(parseVideoStatus('{"status":"failed","error":"boom"}').error).toBe('boom')
    expect(parseVideoStatus('{"error":{"message":"nested"}}').error).toBe('nested')
    expect(parseVideoStatus('{}')).toEqual({ status: '', progress: null, videoUrl: null, duration: null, error: null })
    expect(() => parseVideoStatus('<html>')).toThrow(/not JSON/)
  })
})
