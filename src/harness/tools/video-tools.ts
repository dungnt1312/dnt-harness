import type { VideoRef } from '../attachments/video-store.ts'
import { loadImageSource, type ImageToolOptions } from './image-tools.ts'
import type { ToolDefinition, ToolExecution } from './types.ts'

/**
 * `GenerateVideo`: an async Videos API job (create → poll → download). The
 * tool blocks until the file is stored — a generated video is the turn's
 * product — so it carries its own poll budget and honors the turn's stop
 * signal between polls.
 *
 * API shape (CLIProxy / xAI native), verified in dntspace-app:
 * - `POST {baseUrl}/videos` → `{ request_id }` (or `{ id }`);
 * - `GET {baseUrl}/videos/{id}` → `{ status, progress?, video?: { url, duration } }`;
 * - on success the bytes come from `video.url`, else `GET {baseUrl}/videos/{id}/content`.
 * An optional reference image is sent as `image.url` (a data URL) for
 * image-to-video; its source rules are EditImage's (stored attachment or a
 * granted file).
 */

export const GENERATE_VIDEO_TOOL = 'GenerateVideo'

export interface VideoApiConfig {
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
}

export type VideoApiResolution = { readonly ok: true; readonly config: VideoApiConfig } | { readonly ok: false; readonly reason: string }

export interface GenerateVideoOptions extends Pick<ImageToolOptions, 'read' | 'resolvePath'> {
  readonly resolve: () => VideoApiResolution
  /** Stream the bytes into the workspace video store (size-capped, container-checked). */
  readonly store: (workspaceId: string, body: ReadableStream<Uint8Array>, signal: AbortSignal) => Promise<VideoRef>
  /** Largest reference image accepted (same bound as image tools). */
  readonly maxImageBytes?: number
  /** Time between status polls. */
  readonly pollIntervalMs?: number
  /** Whole-call budget: create + polls + download. */
  readonly timeoutMs?: number
  /** Per-request budget for create/poll calls. */
  readonly requestTimeoutMs?: number
  /** Test seam. */
  readonly fetch?: typeof fetch
  /** Test seam: resolves after `ms`, rejects with the signal's reason when aborted. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

/** What the tool answers: the stored reference plus what the provider reported. */
export interface GenerateVideoOutput {
  readonly videoId: string
  readonly mediaType: string
  readonly bytes: number
  readonly model: string
  readonly requestId: string
  readonly duration: number | null
  readonly progress: number | null
  /** Set when a reference image was the first frame source. */
  readonly sourceAttachmentId?: string
}

const DEFAULT_POLL_INTERVAL_MS = 2_000
const DEFAULT_TIMEOUT_MS = 10 * 60_000
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024
const VIDEO_SIZE = /^\d{3,5}x\d{3,5}$/

const SUCCESS = new Set(['done', 'completed', 'succeeded', 'success'])
const FAILURE = new Set(['failed', 'error', 'expired', 'cancelled', 'canceled'])

export interface VideoStatus {
  readonly status: string
  readonly progress: number | null
  readonly videoUrl: string | null
  readonly duration: number | null
  readonly error: string | null
}

const excerpt = (text: string, max = 500): string => (text.length > max ? `${text.slice(0, max)}…` : text)
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/** The job id of a create response (`request_id`, else `id`). */
export function parseVideoCreate(body: string): string {
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch (error) { throw new Error(`video create response is not JSON: ${message(error)}; body=${excerpt(body, 200)}`) }
  const record = parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  const id = typeof record['request_id'] === 'string' && record['request_id'] !== '' ? record['request_id'] : typeof record['id'] === 'string' && record['id'] !== '' ? record['id'] : ''
  if (id === '') throw new Error(`video create response has no request_id or id; body=${excerpt(body, 200)}`)
  return id
}

/** One poll response, tolerant of both `video.url` and a flat `video_url`. */
export function parseVideoStatus(body: string): VideoStatus {
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch (error) { throw new Error(`video status response is not JSON: ${message(error)}; body=${excerpt(body, 200)}`) }
  const record = parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  const video = record['video'] !== null && typeof record['video'] === 'object' ? record['video'] as Record<string, unknown> : {}
  const rawError = record['error']
  const error = typeof rawError === 'string' && rawError !== ''
    ? rawError
    : rawError !== null && typeof rawError === 'object' && typeof (rawError as Record<string, unknown>)['message'] === 'string' && (rawError as Record<string, unknown>)['message'] !== ''
      ? (rawError as Record<string, unknown>)['message'] as string
      : null
  const url = typeof video['url'] === 'string' && video['url'] !== '' ? video['url'] : typeof record['video_url'] === 'string' && record['video_url'] !== '' ? record['video_url'] : null
  return {
    status: (typeof record['status'] === 'string' ? record['status'] : '').toLowerCase(),
    progress: finite(record['progress']),
    videoUrl: url,
    duration: finite(video['duration']) ?? finite(record['duration']),
    error,
  }
}

function sleepDefault(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')); return }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = (): void => { clearTimeout(timer); reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')) }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function generateVideoTool(options: GenerateVideoOptions): ToolDefinition {
  const doFetch = options.fetch ?? fetch
  const sleep = options.sleep ?? sleepDefault
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES
  return {
    name: GENERATE_VIDEO_TOOL,
    description: [
      'Generate a short video from a text prompt (optionally animating a reference image) using the video provider and model chosen in Settings → Providers & Models → Video generation.',
      'Use it when the user asks to create or generate a video.',
      "For image-to-video give exactly one of 'attachmentId' (a stored image: a previous GenerateImage/EditImage result or an image the user attached) or 'path' (a png/jpeg/webp/gif inside the granted folders); omit both for text-to-video.",
      'Generation can take several minutes; the call waits until the video is stored.',
      'The video is shown inline in the chat automatically; after success reply briefly and do not tell the user any file path, id, or how to open it.',
      'Returns JSON with the stored video id (for tools only), the model, request id, and duration.',
    ].join(' '),
    requiresRoot: false,
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Full generation prompt describing the video to create.' },
        attachmentId: { type: 'string', description: 'Optional reference image id (image-to-video).' },
        path: { type: 'string', description: 'Optional reference image file inside the granted folders (alternative to attachmentId).' },
        seconds: { type: 'string', description: 'Optional duration in seconds as a string, e.g. "4" or "8" (provider-dependent).' },
        size: { type: 'string', description: 'Optional size/resolution, e.g. 1280x720 (provider-dependent).' },
      },
      required: ['prompt'],
    },
    async execute(args, exec: ToolExecution) {
      const prompt = typeof args['prompt'] === 'string' ? args['prompt'].trim() : ''
      if (prompt === '') throw new Error("argument 'prompt' must be a non-empty string")
      const rawSeconds = args['seconds']
      const seconds = typeof rawSeconds === 'number' ? String(rawSeconds) : typeof rawSeconds === 'string' ? rawSeconds.trim() : ''
      if (seconds !== '' && !/^\d{1,3}$/.test(seconds)) throw new Error("argument 'seconds' must be a whole number of seconds when given")
      const rawSize = args['size']
      if (rawSize !== undefined && (typeof rawSize !== 'string' || !VIDEO_SIZE.test(rawSize.trim()))) throw new Error("argument 'size' must look like 1280x720 when given")
      const size = typeof rawSize === 'string' ? rawSize.trim() : ''
      const hasImage = (typeof args['attachmentId'] === 'string' && args['attachmentId'].trim() !== '') || (typeof args['path'] === 'string' && args['path'].trim() !== '')
      const workspaceId = exec.workspaceId
      if (workspaceId === undefined) throw new Error(`${GENERATE_VIDEO_TOOL} requires a workspace-scoped execution`)
      const resolution = options.resolve()
      if (!resolution.ok) throw new Error(resolution.reason)
      const { config } = resolution

      const image = hasImage
        ? await loadImageSource({ maxBytes: maxImageBytes, options }, args, exec, workspaceId)
        : undefined

      // One budget for create + polls + download; the turn's stop cancels it.
      const budget = AbortSignal.timeout(timeoutMs)
      const signal = exec.signal === undefined ? budget : AbortSignal.any([exec.signal, budget])
      const base = config.baseUrl.replace(/\/+$/, '')
      const headers = (json: boolean): Record<string, string> => ({
        ...(json ? { 'content-type': 'application/json' } : {}),
        ...(config.apiKey !== '' ? { authorization: `Bearer ${config.apiKey}` } : {}),
      })
      const request = async (label: string, url: string, init: RequestInit): Promise<{ readonly ok: boolean; readonly status: number; readonly text: string }> => {
        let response: Response
        try {
          response = await doFetch(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]) })
        } catch (error) {
          if (signal.aborted) throw signal.reason instanceof Error && exec.signal?.aborted === true ? signal.reason : new Error(`video generation ${exec.signal?.aborted === true ? 'cancelled' : `timed out after ${Math.round(timeoutMs / 1000)}s`}`)
          throw new Error(`${label} request failed: ${message(error)}`)
        }
        return { ok: response.ok, status: response.status, text: await response.text() }
      }

      const createBody = {
        model: config.model,
        prompt,
        ...(seconds !== '' ? { seconds } : {}),
        ...(size !== '' ? { size } : {}),
        ...(image !== undefined ? { image: { url: `data:${image.mediaType};base64,${image.bytes.toString('base64')}` } } : {}),
      }
      const created = await request('video create', `${base}/videos`, { method: 'POST', headers: headers(true), body: JSON.stringify(createBody) })
      if (!created.ok) throw new Error(`video create HTTP ${created.status}: ${excerpt(created.text)}`)
      const requestId = parseVideoCreate(created.text)

      let final: VideoStatus | undefined
      while (final === undefined) {
        const polled = await request('video status', `${base}/videos/${encodeURIComponent(requestId)}`, { method: 'GET', headers: headers(false) })
        if (!polled.ok) throw new Error(`video status HTTP ${polled.status}: ${excerpt(polled.text)}; request_id=${requestId}`)
        const status = parseVideoStatus(polled.text)
        if (SUCCESS.has(status.status)) { final = status; break }
        // An error message is terminal whatever the status word says.
        if (status.error !== null) throw new Error(`video generation failed: ${status.error}; request_id=${requestId}`)
        if (FAILURE.has(status.status)) throw new Error(`video generation ended with status '${status.status}'; request_id=${requestId}`)
        try {
          await sleep(pollIntervalMs, signal)
        } catch {
          throw new Error(exec.signal?.aborted === true ? `video generation cancelled; request_id=${requestId}` : `timed out waiting for the video after ${Math.round(timeoutMs / 60_000)} minutes; request_id=${requestId}`)
        }
      }

      // The download: the URL the job reported, else the provider's content endpoint.
      const target = final.videoUrl !== null && /^https?:\/\//i.test(final.videoUrl) ? final.videoUrl : `${base}/videos/${encodeURIComponent(requestId)}/content`
      let download: Response
      try {
        download = await doFetch(target, { headers: target.startsWith(base) ? headers(false) : {}, signal })
      } catch (error) {
        throw new Error(`download video failed: ${message(error)}; request_id=${requestId}`)
      }
      if (!download.ok) throw new Error(`download video HTTP ${download.status}; request_id=${requestId}`)
      if (download.body === null) throw new Error(`download video: empty body; request_id=${requestId}`)
      const stored = await options.store(workspaceId, download.body, signal)

      const output: GenerateVideoOutput = {
        videoId: stored.id,
        mediaType: stored.mediaType,
        bytes: stored.bytes,
        model: config.model,
        requestId,
        duration: final.duration,
        progress: final.progress,
        ...(image?.attachmentId !== undefined ? { sourceAttachmentId: image.attachmentId } : {}),
      }
      return JSON.stringify(output)
    },
  }
}
