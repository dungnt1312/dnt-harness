import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { editImageTool, generateImageTool, parseImageResponse, shouldRetryEditAsJson, type ImageApiResolution, type ImageToolOptions } from '../../src/harness/tools/image-tools.ts'
import { resolveInGrants } from '../../src/capabilities/fs/grants.ts'
import type { AttachmentRef } from '../../src/harness/attachments/store.ts'
import type { ToolExecution } from '../../src/harness/tools/types.ts'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pixels')])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
const SOURCE_ID = 'c'.repeat(64)
const CONFIGURED: ImageApiResolution = { ok: true, config: { baseUrl: 'https://img.test/v1/', apiKey: 'sk-test', model: 'img-model' } }
const exec: ToolExecution = { root: '/tmp', workspaceId: 'ws-1' }

function options(overrides: { readonly resolve?: () => ImageApiResolution; readonly fetch: typeof fetch; readonly maxBytes?: number }) {
  const stored: { workspaceId: string; bytes: Buffer }[] = []
  const value: ImageToolOptions = {
    resolve: overrides.resolve ?? (() => CONFIGURED),
    fetch: overrides.fetch,
    ...(overrides.maxBytes !== undefined ? { maxBytes: overrides.maxBytes } : {}),
    store: async (workspaceId, input): Promise<AttachmentRef> => {
      stored.push({ workspaceId, bytes: input.bytes })
      return { id: 'a'.repeat(64), name: input.name, mediaType: 'image/png', bytes: input.bytes.length }
    },
    read: async (workspaceId, id) => {
      if (workspaceId !== 'ws-1' || id !== SOURCE_ID) throw new Error(`attachment '${id}' is not stored in this workspace`)
      return { bytes: JPEG, mediaType: 'image/jpeg' }
    },
    resolvePath: (run, target) => resolveInGrants(run, target, 'read'),
  }
  return { value, stored }
}

function setup(overrides: Parameters<typeof options>[0]) {
  const { value, stored } = options(overrides)
  return { tool: generateImageTool(value), stored }
}

function setupEdit(overrides: Parameters<typeof options>[0]) {
  const { value, stored } = options(overrides)
  return { tool: editImageTool(value), stored }
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('GenerateImage tool', () => {
  it('posts an OpenAI images request and stores the decoded b64 bytes in the workspace', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ created: 1, data: [{ b64_json: PNG.toString('base64'), revised_prompt: 'a fluffy cat' }] }))
    const { tool, stored } = setup({ fetch: fetchMock as unknown as typeof fetch })

    const output = JSON.parse(await tool.execute({ prompt: '  a cat ', size: '1024x1024' }, exec)) as Record<string, unknown>

    expect(output).toEqual({ attachmentId: 'a'.repeat(64), mediaType: 'image/png', bytes: PNG.length, model: 'img-model', revisedPrompt: 'a fluffy cat' })
    expect(stored).toEqual([{ workspaceId: 'ws-1', bytes: PNG }])
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://img.test/v1/images/generations')
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer sk-test')
    expect(JSON.parse(String(init.body))).toEqual({ model: 'img-model', prompt: 'a cat', n: 1, response_format: 'b64_json', size: '1024x1024' })
  })

  it('downloads a url-only result once', async () => {
    const fetchMock = vi.fn(async (input: string) => input.endsWith('/images/generations')
      ? jsonResponse({ data: [{ url: 'https://cdn.test/out.png' }] })
      : new Response(new Uint8Array(PNG), { status: 200 }))
    const { tool, stored } = setup({ fetch: fetchMock as unknown as typeof fetch })

    const output = JSON.parse(await tool.execute({ prompt: 'cat' }, exec)) as Record<string, unknown>

    expect(output['revisedPrompt']).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://cdn.test/out.png')
    expect(stored[0]?.bytes).toEqual(PNG)
  })

  it('omits the authorization header for a keyless local gateway', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [{ b64_json: PNG.toString('base64') }] }))
    const { tool } = setup({ fetch: fetchMock as unknown as typeof fetch, resolve: () => ({ ok: true, config: { baseUrl: 'http://127.0.0.1:8317/v1', apiKey: '', model: 'm' } }) })
    await tool.execute({ prompt: 'cat' }, exec)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>)['authorization']).toBeUndefined()
  })

  it('surfaces the Settings reason when image generation is not configured', async () => {
    const fetchMock = vi.fn()
    const { tool } = setup({ fetch: fetchMock as unknown as typeof fetch, resolve: () => ({ ok: false, reason: 'Image generation is not configured. Open Settings → Image generation.' }) })
    await expect(tool.execute({ prompt: 'cat' }, exec)).rejects.toThrow(/Settings → Image generation/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('validates its arguments and execution scope before any request', async () => {
    const fetchMock = vi.fn()
    const { tool } = setup({ fetch: fetchMock as unknown as typeof fetch })
    await expect(tool.execute({}, exec)).rejects.toThrow(/prompt/)
    await expect(tool.execute({ prompt: '   ' }, exec)).rejects.toThrow(/prompt/)
    await expect(tool.execute({ prompt: 'cat', size: 'huge' }, exec)).rejects.toThrow(/size/)
    await expect(tool.execute({ prompt: 'cat' }, { root: '/tmp' })).rejects.toThrow(/workspace/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports provider HTTP errors with the status and an excerpt', async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":"bad model"}', { status: 400 }))
    const { tool, stored } = setup({ fetch: fetchMock as unknown as typeof fetch })
    await expect(tool.execute({ prompt: 'cat' }, exec)).rejects.toThrow(/HTTP 400: \{"error":"bad model"\}/)
    expect(stored).toEqual([])
  })

  it('refuses an oversize image and a non-http url', async () => {
    const big = setup({ fetch: (async () => jsonResponse({ data: [{ b64_json: PNG.toString('base64') }] })) as unknown as typeof fetch, maxBytes: 4 })
    await expect(big.tool.execute({ prompt: 'cat' }, exec)).rejects.toThrow(/limit is 4/)
    const file = setup({ fetch: (async () => jsonResponse({ data: [{ url: 'file:///etc/passwd' }] })) as unknown as typeof fetch })
    await expect(file.tool.execute({ prompt: 'cat' }, exec)).rejects.toThrow(/not http\(s\)/)
  })

  it('honors the turn stop signal', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    const { tool } = setup({ fetch: fetchMock as unknown as typeof fetch })
    const pending = tool.execute({ prompt: 'cat' }, { ...exec, signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toThrow(/request failed: aborted/)
  })
})

describe('parseImageResponse', () => {
  it('needs a data item with b64_json or url', () => {
    expect(() => parseImageResponse('nope')).toThrow(/not JSON/)
    expect(() => parseImageResponse('{"data":[]}')).toThrow(/empty data/)
    expect(() => parseImageResponse('{"data":[{}]}')).toThrow(/missing both/)
    expect(parseImageResponse('{"data":[{"b64_json":"QQ==","revised_prompt":"x"}]}')).toEqual({ b64: 'QQ==', revisedPrompt: 'x' })
  })
})

const ok = (): Response => jsonResponse({ data: [{ b64_json: PNG.toString('base64'), revised_prompt: 'night sky' }] })

describe('EditImage tool', () => {
  it('posts a multipart edit with the stored source image and stores the result as a new attachment', async () => {
    const fetchMock = vi.fn(async () => ok())
    const { tool, stored } = setupEdit({ fetch: fetchMock as unknown as typeof fetch })

    const output = JSON.parse(await tool.execute({ prompt: 'make it night', attachmentId: SOURCE_ID, size: '512x512' }, exec)) as Record<string, unknown>

    expect(output).toMatchObject({ attachmentId: 'a'.repeat(64), sourceAttachmentId: SOURCE_ID, model: 'img-model', revisedPrompt: 'night sky' })
    expect(stored).toEqual([{ workspaceId: 'ws-1', bytes: PNG }])
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://img.test/v1/images/edits')
    const headers = init.headers as Record<string, string>
    expect(headers['authorization']).toBe('Bearer sk-test')
    // fetch must set the multipart boundary itself.
    expect(headers['content-type']).toBeUndefined()
    const form = init.body as FormData
    expect(form.get('model')).toBe('img-model')
    expect(form.get('prompt')).toBe('make it night')
    expect(form.get('response_format')).toBe('b64_json')
    expect(form.get('size')).toBe('512x512')
    const image = form.get('image') as File
    expect(image.type).toBe('image/jpeg')
    expect(image.name).toMatch(/\.jpg$/)
    expect(Buffer.from(await image.arrayBuffer())).toEqual(JPEG)
  })

  it('retries once as JSON with a data URL when the proxy rejects the multipart image', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":"Invalid base64-encoded image"}', { status: 400 }))
      .mockResolvedValueOnce(ok())
    const { tool } = setupEdit({ fetch: fetchMock as unknown as typeof fetch })

    await tool.execute({ prompt: 'night', attachmentId: SOURCE_ID }, exec)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json')
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'img-model', prompt: 'night', n: 1, response_format: 'b64_json',
      image: `data:image/jpeg;base64,${JPEG.toString('base64')}`,
    })
  })

  it('reports both failures when the JSON fallback also fails, and does not retry other errors', async () => {
    const both = vi.fn()
      .mockResolvedValueOnce(new Response('multipart unsupported', { status: 415 }))
      .mockResolvedValueOnce(new Response('still bad', { status: 400 }))
    await expect(setupEdit({ fetch: both as unknown as typeof fetch }).tool.execute({ prompt: 'n', attachmentId: SOURCE_ID }, exec))
      .rejects.toThrow(/HTTP 415: multipart unsupported; json fallback HTTP 400: still bad/)

    const server = vi.fn(async () => new Response('upstream down', { status: 502 }))
    await expect(setupEdit({ fetch: server as unknown as typeof fetch }).tool.execute({ prompt: 'n', attachmentId: SOURCE_ID }, exec))
      .rejects.toThrow(/HTTP 502: upstream down/)
    expect(server).toHaveBeenCalledTimes(1)
  })

  it('reads a path source through the grants and refuses one outside them', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'dnt-edit-image-'))
    try {
      await fs.writeFile(path.join(root, 'photo.png'), PNG)
      await fs.writeFile(path.join(root, 'notes.txt'), 'not an image')
      const fetchMock = vi.fn(async () => ok())
      const { tool } = setupEdit({ fetch: fetchMock as unknown as typeof fetch })
      const run: ToolExecution = { root, workspaceId: 'ws-1' }

      const output = JSON.parse(await tool.execute({ prompt: 'night', path: 'photo.png' }, run)) as Record<string, unknown>
      expect(output['sourceAttachmentId']).toBeUndefined()
      const image = ((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as FormData).get('image') as File
      expect(image.name).toBe('photo.png')
      expect(Buffer.from(await image.arrayBuffer())).toEqual(PNG)

      await expect(tool.execute({ prompt: 'night', path: 'notes.txt' }, run)).rejects.toThrow(/not a supported image/)
      await expect(tool.execute({ prompt: 'night', path: '/etc/hosts' }, run)).rejects.toThrow(/escapes the workspace root/)
      await expect(tool.execute({ prompt: 'night', path: 'missing.png' }, run)).rejects.toThrow()
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('needs exactly one valid source and a configured endpoint before any request', async () => {
    const fetchMock = vi.fn()
    const { tool } = setupEdit({ fetch: fetchMock as unknown as typeof fetch })
    await expect(tool.execute({ prompt: 'n' }, exec)).rejects.toThrow(/exactly one source/)
    await expect(tool.execute({ prompt: 'n', attachmentId: SOURCE_ID, path: 'x.png' }, exec)).rejects.toThrow(/exactly one source/)
    await expect(tool.execute({ prompt: 'n', attachmentId: '../x' }, exec)).rejects.toThrow(/sha256/)
    await expect(tool.execute({ prompt: 'n', attachmentId: 'd'.repeat(64) }, exec)).rejects.toThrow(/not stored in this workspace/)
    await expect(tool.execute({ attachmentId: SOURCE_ID }, exec)).rejects.toThrow(/prompt/)
    const unconfigured = setupEdit({ fetch: fetchMock as unknown as typeof fetch, resolve: () => ({ ok: false, reason: 'Image generation is not configured.' }) })
    await expect(unconfigured.tool.execute({ prompt: 'n', attachmentId: SOURCE_ID }, exec)).rejects.toThrow(/not configured/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('shouldRetryEditAsJson', () => {
  it('retries only client errors that name the image encoding or multipart', () => {
    expect(shouldRetryEditAsJson(400, 'Invalid base64-encoded image')).toBe(true)
    expect(shouldRetryEditAsJson(415, 'multipart not supported')).toBe(true)
    expect(shouldRetryEditAsJson(400, 'invalid_argument: image')).toBe(true)
    expect(shouldRetryEditAsJson(400, 'model not found')).toBe(false)
    expect(shouldRetryEditAsJson(500, 'Invalid base64')).toBe(false)
  })
})
