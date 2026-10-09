import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AttachmentRef } from '../attachments/store.ts'
import type { ToolDefinition, ToolExecution } from './types.ts'

/**
 * Image tools over an OpenAI-compatible Images API. Every result is stored as
 * a workspace attachment; the web renders that attachment inline in the tool
 * row, so the model never needs to narrate where a file went.
 *
 * - `GenerateImage`: `POST {baseUrl}/images/generations` (JSON).
 * - `EditImage`: `POST {baseUrl}/images/edits` as multipart with an `image`
 *   file part. A proxy that rejects the multipart image (CLIProxy answers
 *   `Invalid base64-encoded image`) gets ONE retry as JSON with the image as a
 *   data URL. The source image is never overwritten: the edit is a new
 *   attachment.
 *
 * Both request `response_format: b64_json` so a result never depends on an
 * expiring URL; a provider that answers with a `url` anyway gets one bounded
 * http(s) download.
 */

export const GENERATE_IMAGE_TOOL = 'GenerateImage'
export const EDIT_IMAGE_TOOL = 'EditImage'
export const IMAGE_TOOLS: readonly string[] = [GENERATE_IMAGE_TOOL, EDIT_IMAGE_TOOL]

/** The image endpoint a call resolves at execution time (Settings may change between calls). */
export interface ImageApiConfig {
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
}

/** Either a usable endpoint or the reason Settings cannot provide one. */
export type ImageApiResolution = { readonly ok: true; readonly config: ImageApiConfig } | { readonly ok: false; readonly reason: string }

/** A stored source image's bytes and declared type. */
export interface StoredImage {
  readonly bytes: Buffer
  readonly mediaType: string
}

export interface ImageToolOptions {
  readonly resolve: () => ImageApiResolution
  /** Persist the bytes for the executing workspace; validates they are an image. */
  readonly store: (workspaceId: string, input: { readonly name: string; readonly bytes: Buffer }) => Promise<AttachmentRef>
  /** Read a stored attachment (EditImage source by id); throws when it is not in this workspace. */
  readonly read: (workspaceId: string, id: string) => Promise<StoredImage>
  /**
   * Resolve a file path against the run's grants (EditImage source by path),
   * exactly as `Read` would. Throws when the path is outside the grants.
   */
  readonly resolvePath: (exec: ToolExecution, target: string) => Promise<string>
  /** Whole-call budget (request plus any URL download). */
  readonly timeoutMs?: number
  /** Largest image accepted, in either direction. */
  readonly maxBytes?: number
  /** Test seam. */
  readonly fetch?: typeof fetch
}

/** What both tools answer: the stored reference plus what the provider reported. */
export interface ImageToolOutput {
  readonly attachmentId: string
  readonly mediaType: string
  readonly bytes: number
  readonly model: string
  readonly revisedPrompt: string | null
  /** EditImage only: the attachment the edit started from (when the source was one). */
  readonly sourceAttachmentId?: string
}

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
const SIZE = /^\d{2,5}x\d{2,5}$/
const ATTACHMENT_ID = /^[0-9a-f]{64}$/

/** Leading bytes that prove an image's real type (png/jpeg/gif/webp). */
export function sniffImage(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  const head = bytes.subarray(0, 6).toString('latin1')
  if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif'
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}

const EXTENSION: Readonly<Record<string, string>> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

interface ParsedImage {
  readonly b64?: string
  readonly url?: string
  readonly revisedPrompt: string | null
}

/** First `data[]` item of an images response; one of `b64_json` / `url` is required. */
export function parseImageResponse(body: string): ParsedImage {
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch (error) { throw new Error(`images response is not JSON: ${String(error)}`) }
  const data = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>)['data'] : undefined
  const item = Array.isArray(data) ? data[0] : undefined
  if (item === null || typeof item !== 'object') throw new Error('images response: empty data')
  const record = item as Record<string, unknown>
  const b64 = typeof record['b64_json'] === 'string' && record['b64_json'] !== '' ? record['b64_json'] : undefined
  const url = typeof record['url'] === 'string' && record['url'] !== '' ? record['url'] : undefined
  if (b64 === undefined && url === undefined) throw new Error('images response: missing both b64_json and url')
  const revisedPrompt = typeof record['revised_prompt'] === 'string' ? record['revised_prompt'] : null
  return { ...(b64 !== undefined ? { b64 } : {}), ...(url !== undefined ? { url } : {}), revisedPrompt }
}

/**
 * Whether a failed multipart edit warrants the JSON data-URL retry: a client
 * error that names the image encoding or the multipart body itself.
 */
export function shouldRetryEditAsJson(status: number, body: string): boolean {
  if (status < 400 || status >= 500) return false
  return /base64|invalid[-_ ]argument|invalid image|unsupported image|could not decode|failed to decode|multipart/i.test(body)
}

const excerpt = (text: string, max = 500): string => (text.length > max ? `${text.slice(0, max)}…` : text)
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function parsePrompt(args: Record<string, unknown>): string {
  const prompt = typeof args['prompt'] === 'string' ? args['prompt'].trim() : ''
  if (prompt === '') throw new Error("argument 'prompt' must be a non-empty string")
  return prompt
}

function parseSize(args: Record<string, unknown>): string | undefined {
  const size = args['size']
  if (size === undefined) return undefined
  if (typeof size !== 'string' || !SIZE.test(size.trim())) throw new Error("argument 'size' must look like 1024x1024 when given")
  return size.trim()
}

/** Shared runtime: one budget, the endpoint, and the result → attachment path. */
class ImageRuntime {
  private readonly doFetch: typeof fetch
  readonly maxBytes: number
  private readonly timeoutMs: number

  constructor(readonly options: ImageToolOptions) {
    this.doFetch = options.fetch ?? fetch
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** The workspace and endpoint a call runs against, checked before any I/O. */
  begin(tool: string, exec: ToolExecution): { readonly workspaceId: string; readonly config: ImageApiConfig; readonly signal: AbortSignal } {
    const workspaceId = exec.workspaceId
    if (workspaceId === undefined) throw new Error(`${tool} requires a workspace-scoped execution`)
    const resolution = this.options.resolve()
    if (!resolution.ok) throw new Error(resolution.reason)
    // One budget for the whole call, and the turn's stop cancels it too.
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const signal = exec.signal === undefined ? timeout : AbortSignal.any([exec.signal, timeout])
    return { workspaceId, config: resolution.config, signal }
  }

  url(config: ImageApiConfig, endpoint: string): string {
    return `${config.baseUrl.replace(/\/+$/, '')}/${endpoint}`
  }

  headers(config: ImageApiConfig, json: boolean): Record<string, string> {
    return {
      ...(json ? { 'content-type': 'application/json' } : {}),
      ...(config.apiKey !== '' ? { authorization: `Bearer ${config.apiKey}` } : {}),
    }
  }

  async post(label: string, url: string, init: RequestInit): Promise<{ readonly status: number; readonly ok: boolean; readonly text: string }> {
    let response: Response
    try {
      response = await this.doFetch(url, { ...init, method: 'POST' })
    } catch (error) {
      throw new Error(`${label} request failed: ${message(error)}`)
    }
    return { status: response.status, ok: response.ok, text: await response.text() }
  }

  /** Decode b64 or download the url once, bounded by `maxBytes`. */
  async materialize(image: ParsedImage, signal: AbortSignal): Promise<Buffer> {
    if (image.b64 !== undefined) {
      const bytes = Buffer.from(image.b64.trim(), 'base64')
      if (bytes.length === 0) throw new Error('images response: empty b64_json payload')
      if (bytes.length > this.maxBytes) throw new Error(`returned image is ${bytes.length} bytes; the limit is ${this.maxBytes}`)
      return bytes
    }
    const url = image.url!
    if (!/^https?:\/\//i.test(url)) throw new Error(`images response url is not http(s): ${excerpt(url, 120)}`)
    let download: Response
    try {
      download = await this.doFetch(url, { signal })
    } catch (error) {
      throw new Error(`download image url failed: ${message(error)}`)
    }
    if (!download.ok) throw new Error(`download image url HTTP ${download.status}`)
    const declared = Number(download.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > this.maxBytes) throw new Error(`downloaded image is ${declared} bytes; the limit is ${this.maxBytes}`)
    const bytes = Buffer.from(await download.arrayBuffer())
    if (bytes.length > this.maxBytes) throw new Error(`downloaded image is ${bytes.length} bytes; the limit is ${this.maxBytes}`)
    if (bytes.length === 0) throw new Error('download image url: empty body')
    return bytes
  }

  async finish(workspaceId: string, name: string, model: string, image: ParsedImage, signal: AbortSignal, extra: Partial<ImageToolOutput> = {}): Promise<string> {
    const bytes = await this.materialize(image, signal)
    const stored = await this.options.store(workspaceId, { name: `${name}-${Date.now()}`, bytes })
    const output: ImageToolOutput = {
      attachmentId: stored.id,
      mediaType: stored.mediaType,
      bytes: stored.bytes,
      model,
      revisedPrompt: image.revisedPrompt,
      ...extra,
    }
    return JSON.stringify(output)
  }
}

const RESULT_GUIDANCE = 'The image is shown inline in the chat automatically; after success reply briefly and do not tell the user any file path, attachment id, or how to open the image.'

export function generateImageTool(options: ImageToolOptions): ToolDefinition {
  const runtime = new ImageRuntime(options)
  return {
    name: GENERATE_IMAGE_TOOL,
    description: [
      'Generate an image from a text prompt using the image provider and model chosen in Settings → Providers & Models → Image generation.',
      'Use it when the user asks to create, draw, or generate an image.',
      RESULT_GUIDANCE,
      'Returns JSON with the stored attachment id (pass it to EditImage to refine the image), the model, and any revised prompt.',
    ].join(' '),
    requiresRoot: false,
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Full generation prompt describing the image to create.' },
        size: { type: 'string', description: 'Optional size, e.g. 1024x1024, 1792x1024, 1024x1792 (provider-dependent).' },
      },
      required: ['prompt'],
    },
    async execute(args, exec) {
      const prompt = parsePrompt(args)
      const size = parseSize(args)
      const { workspaceId, config, signal } = runtime.begin(GENERATE_IMAGE_TOOL, exec)
      const body = { model: config.model, prompt, n: 1, response_format: 'b64_json', ...(size !== undefined ? { size } : {}) }
      const response = await runtime.post('image generation', runtime.url(config, 'images/generations'), {
        headers: runtime.headers(config, true),
        body: JSON.stringify(body),
        signal,
      })
      if (!response.ok) throw new Error(`image generation HTTP ${response.status}: ${excerpt(response.text)}`)
      return runtime.finish(workspaceId, 'generated-image', config.model, parseImageResponse(response.text), signal)
    },
  }
}

/** The edit's source: a stored attachment (id) or a granted file (path). */
async function loadSource(
  runtime: ImageRuntime,
  args: Record<string, unknown>,
  exec: ToolExecution,
  workspaceId: string,
): Promise<{ readonly bytes: Buffer; readonly mediaType: string; readonly filename: string; readonly attachmentId?: string }> {
  const id = typeof args['attachmentId'] === 'string' ? args['attachmentId'].trim() : ''
  const target = typeof args['path'] === 'string' ? args['path'].trim() : ''
  if ((id === '') === (target === '')) throw new Error("give exactly one source: 'attachmentId' (a stored image) or 'path' (an image file)")
  let bytes: Buffer
  let filename: string
  if (id !== '') {
    if (!ATTACHMENT_ID.test(id)) throw new Error("argument 'attachmentId' must be a 64-character sha256 hex id from a previous image result or message attachment")
    bytes = (await runtime.options.read(workspaceId, id)).bytes
    filename = `${id.slice(0, 12)}`
  } else {
    const abs = await runtime.options.resolvePath(exec, target)
    const stat = await fs.stat(abs).catch(() => undefined)
    if (stat === undefined || !stat.isFile()) throw new Error(`image path '${target}' is not a file`)
    if (stat.size > runtime.maxBytes) throw new Error(`image '${target}' is ${stat.size} bytes; the limit is ${runtime.maxBytes}`)
    bytes = await fs.readFile(abs)
    filename = path.basename(abs, path.extname(abs)) || 'image'
  }
  if (bytes.length === 0) throw new Error('source image is empty')
  const mediaType = sniffImage(bytes)
  if (mediaType === null) throw new Error('source is not a supported image (png, jpeg, webp, or gif)')
  return { bytes, mediaType, filename: `${filename}.${EXTENSION[mediaType]}`, ...(id !== '' ? { attachmentId: id } : {}) }
}

export function editImageTool(options: ImageToolOptions): ToolDefinition {
  const runtime = new ImageRuntime(options)
  return {
    name: EDIT_IMAGE_TOOL,
    description: [
      'Edit an existing image with a text instruction using the image provider and model chosen in Settings → Providers & Models → Image generation.',
      "Give exactly one source: 'attachmentId' — the id from a previous GenerateImage/EditImage result or of an image the user attached — or 'path' to a png/jpeg/webp/gif file inside the granted folders.",
      'The source is never modified; the edit is saved as a new image.',
      RESULT_GUIDANCE,
      'Returns JSON with the new attachment id, the model, and any revised prompt.',
    ].join(' '),
    requiresRoot: false,
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Edit instruction describing how to change the image.' },
        attachmentId: { type: 'string', description: 'Stored source image id (from a previous image result or a message attachment).' },
        path: { type: 'string', description: 'Source image file inside the granted folders (alternative to attachmentId).' },
        size: { type: 'string', description: 'Optional output size, e.g. 1024x1024 (provider-dependent).' },
      },
      required: ['prompt'],
    },
    async execute(args, exec) {
      const prompt = parsePrompt(args)
      const size = parseSize(args)
      const { workspaceId, config, signal } = runtime.begin(EDIT_IMAGE_TOOL, exec)
      const source = await loadSource(runtime, args, exec, workspaceId)
      const url = runtime.url(config, 'images/edits')

      const form = new FormData()
      form.set('model', config.model)
      form.set('prompt', prompt)
      form.set('n', '1')
      form.set('response_format', 'b64_json')
      if (size !== undefined) form.set('size', size)
      form.set('image', new Blob([new Uint8Array(source.bytes)], { type: source.mediaType }), source.filename)
      // No content-type: fetch sets the multipart boundary itself.
      let response = await runtime.post('image edit', url, { headers: runtime.headers(config, false), body: form, signal })

      if (!response.ok && shouldRetryEditAsJson(response.status, response.text)) {
        const first = response
        const body = {
          model: config.model,
          prompt,
          n: 1,
          response_format: 'b64_json',
          image: `data:${source.mediaType};base64,${source.bytes.toString('base64')}`,
          ...(size !== undefined ? { size } : {}),
        }
        response = await runtime.post('image edit json fallback', url, { headers: runtime.headers(config, true), body: JSON.stringify(body), signal })
        if (!response.ok) {
          throw new Error(`image edit HTTP ${first.status}: ${excerpt(first.text)}; json fallback HTTP ${response.status}: ${excerpt(response.text)}`)
        }
      }
      if (!response.ok) throw new Error(`image edit HTTP ${response.status}: ${excerpt(response.text)}`)
      return runtime.finish(workspaceId, 'edited-image', config.model, parseImageResponse(response.text), signal,
        source.attachmentId !== undefined ? { sourceAttachmentId: source.attachmentId } : {})
    },
  }
}
