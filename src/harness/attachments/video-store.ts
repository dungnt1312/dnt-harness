import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/**
 * Workspace-scoped storage for generated videos.
 *
 * Videos are too large for {@link AttachmentStore}: that store reads whole
 * files into memory under a 10 MiB cap and sniffs images and text. Here the
 * bytes stream to disk under a hard size cap, are content-addressed by sha256
 * (the same video twice costs one file, and an id cannot name a blob nobody
 * stored), and are served back with `Range` so the browser can seek.
 *
 * The declared container is checked against the bytes: only MP4/MOV (`ftyp`)
 * and WebM/Matroska (EBML) are accepted, so a provider that answers with an
 * HTML error page is refused here instead of becoming an unplayable "video".
 */

export class VideoStoreError extends Error {}

export interface VideoRef {
  /** sha256 of the bytes — also the file name in the store. */
  readonly id: string
  readonly mediaType: string
  readonly bytes: number
}

/** Largest video accepted from a provider. */
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024

/** The container the leading bytes prove, or null when none matches. */
export function sniffVideoMediaType(head: Buffer): string | null {
  // ISO base media: size(4) 'ftyp' brand(4). QuickTime brands play as video/quicktime.
  if (head.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp') {
    return head.subarray(8, 12).toString('latin1') === 'qt  ' ? 'video/quicktime' : 'video/mp4'
  }
  // EBML header: WebM and Matroska.
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'video/webm'
  return null
}

const VIDEO_ID = /^[0-9a-f]{64}$/

export class VideoStore {
  constructor(private readonly home: string, private readonly maxBytes: number = MAX_VIDEO_BYTES) {}

  private dir(workspaceId: string): string {
    return path.join(this.home, 'workspaces', workspaceId, 'videos')
  }

  private file(workspaceId: string, id: string): string {
    if (!VIDEO_ID.test(id)) throw new VideoStoreError('video id must be a sha256 hex digest')
    return path.join(this.dir(workspaceId), id)
  }

  /**
   * Store a video from a byte stream (a download body), enforcing the size cap
   * while it streams so an endless or oversize body never fills the disk.
   */
  async putStream(workspaceId: string, source: ReadableStream<Uint8Array> | NodeJS.ReadableStream, signal?: AbortSignal): Promise<VideoRef> {
    const dir = this.dir(workspaceId)
    await fs.mkdir(dir, { recursive: true })
    const temporary = path.join(dir, `.${randomUUID()}.tmp`)
    const hash = createHash('sha256')
    let size = 0
    let head: Buffer = Buffer.alloc(0)
    const maxBytes = this.maxBytes
    const input = 'getReader' in source ? Readable.fromWeb(source as import('node:stream/web').ReadableStream<Uint8Array>) : (source as Readable)
    // Counting, hashing, and the size cap happen as the bytes pass through.
    async function* measure(chunks: AsyncIterable<Buffer | Uint8Array>): AsyncGenerator<Buffer> {
      for await (const chunk of chunks) {
        const buffer = Buffer.from(chunk)
        size += buffer.length
        if (size > maxBytes) throw new VideoStoreError(`video is larger than the ${maxBytes} byte limit`)
        if (head.length < 16) head = Buffer.concat([head, buffer.subarray(0, 16 - head.length)])
        hash.update(buffer)
        yield buffer
      }
    }
    const sink = createWriteStream(temporary, { flags: 'wx' })
    // A failed pipeline destroys the sink, but the file may still be opening.
    // Cleanup must wait for that to settle, or the file appears after it ran.
    const closed = new Promise<void>((resolve) => { sink.once('close', () => resolve()) })
    try {
      await pipeline(input, measure, sink, ...(signal !== undefined ? [{ signal }] : []))
      if (size === 0) throw new VideoStoreError('video body is empty')
      const mediaType = sniffVideoMediaType(head)
      if (mediaType === null) throw new VideoStoreError('response is not a playable video (expected MP4, MOV, or WebM)')
      const id = hash.digest('hex')
      const target = this.file(workspaceId, id)
      // Identical bytes are already stored under this exact name.
      if (await this.exists(target)) await fs.rm(temporary, { force: true })
      else await fs.rename(temporary, target)
      return { id, mediaType, bytes: size }
    } catch (error) {
      await closed
      await fs.rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }

  /** Store an in-memory video (tests, small clips). */
  async put(workspaceId: string, bytes: Buffer): Promise<VideoRef> {
    return this.putStream(workspaceId, Readable.from([bytes]))
  }

  /** Size and type of a stored video without reading its body. */
  async stat(workspaceId: string, id: string): Promise<{ readonly path: string; readonly bytes: number; readonly mediaType: string }> {
    const target = this.file(workspaceId, id)
    const stat = await fs.stat(target).catch(() => null)
    if (stat === null || !stat.isFile()) throw new VideoStoreError(`video '${id}' is not stored in this workspace`)
    const handle = await fs.open(target, 'r')
    try {
      const head = Buffer.alloc(Math.min(16, stat.size))
      await handle.read(head, 0, head.length, 0)
      const mediaType = sniffVideoMediaType(head)
      if (mediaType === null) throw new VideoStoreError(`video '${id}' is not a playable video`)
      return { path: target, bytes: stat.size, mediaType }
    } finally {
      await handle.close()
    }
  }

  /** A byte range of a stored video, for `Range` requests. */
  stream(workspaceId: string, id: string, range?: { readonly start: number; readonly end: number }): NodeJS.ReadableStream {
    return createReadStream(this.file(workspaceId, id), range === undefined ? {} : { start: range.start, end: range.end })
  }

  async has(workspaceId: string, id: string): Promise<boolean> {
    try {
      return await this.exists(this.file(workspaceId, id))
    } catch {
      return false
    }
  }

  private async exists(target: string): Promise<boolean> {
    return (await fs.stat(target).catch(() => null))?.isFile() === true
  }
}
