import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * Workspace-scoped blob storage for composer attachments.
 *
 * Blobs are content-addressed by sha256, so the same bytes uploaded twice cost
 * one file, and an id cannot name a blob the caller never sent. The durable
 * session log stores only a small {@link AttachmentRef}: megabytes of base64
 * inside a JSONL event would make every replay pay for them forever.
 *
 * The declared media type is checked against the bytes themselves. A file
 * renamed to `.png` is refused here rather than at the provider, where the
 * failure would be a confusing request error.
 */

export class AttachmentError extends Error {}

/** What an event carries: identity plus what the user needs to see. */
export interface AttachmentRef {
  /** sha256 of the bytes — also the file name in the store. */
  readonly id: string
  /** Original file name, for display and for the model's reference. */
  readonly name: string
  readonly mediaType: string
  readonly bytes: number
}

/** Image types the wire format can carry as an image part. */
export const IMAGE_MEDIA_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

export function isImageMediaType(mediaType: string): boolean {
  return IMAGE_MEDIA_TYPES.includes(normalizeMediaType(mediaType))
}

/**
 * Text types inlined into the message. Anything else (PDF, archives, office
 * documents) is refused: the harness has no extractor for it, and pretending
 * otherwise would send the model bytes it cannot read.
 */
export function isTextMediaType(mediaType: string): boolean {
  const type = normalizeMediaType(mediaType)
  return type.startsWith('text/') || type === 'application/json' || type === 'application/xml'
}

export function normalizeMediaType(mediaType: string): string {
  return (mediaType.split(';')[0] ?? '').trim().toLowerCase()
}

export function isSupportedMediaType(mediaType: string): boolean {
  return isImageMediaType(mediaType) || isTextMediaType(mediaType)
}

/** Leading bytes that prove an image's real type. */
const IMAGE_SIGNATURES: readonly { readonly mediaType: string; readonly test: (bytes: Buffer) => boolean }[] = [
  { mediaType: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mediaType: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mediaType: 'image/gif', test: (b) => b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a' },
  { mediaType: 'image/webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
]

/** The type the bytes actually are, or null when no signature matches. */
export function sniffImageMediaType(bytes: Buffer): string | null {
  return IMAGE_SIGNATURES.find((signature) => signature.test(bytes))?.mediaType ?? null
}

export interface AttachmentLimits {
  /** Largest single upload accepted. */
  readonly maxBytes: number
}

/**
 * One attachment's bytes, already read from the store. Images carry base64 for
 * the wire; text files carry decoded text so the model can read them without
 * spending a tool call.
 */
export interface LoadedAttachment {
  readonly mediaType: string
  readonly base64?: string
  readonly text?: string
  /** The text was cut to the host's inline limit. */
  readonly truncated?: boolean
}

/**
 * Attachment bytes by id, resolved by the host before assembly. The session log
 * holds references only, so whoever assembles a request decides what it is
 * willing to load.
 */
export type AttachmentLookup = ReadonlyMap<string, LoadedAttachment>

/** Decoded attachments held across requests, oldest first for eviction. */
const CACHE_BUDGET_BYTES = 64 * 1024 * 1024

export class AttachmentStore {
  /** `workspaceId:id:mediaType[:textLimit]` → decoded content, insertion-ordered for FIFO eviction. */
  private readonly cache = new Map<string, LoadedAttachment & { readonly bytes: number }>()
  private cachedBytes = 0

  constructor(private readonly home: string, private readonly limits: AttachmentLimits) {}

  private dir(workspaceId: string): string {
    return path.join(this.home, 'workspaces', workspaceId, 'attachments')
  }

  private file(workspaceId: string, id: string): string {
    if (!/^[0-9a-f]{64}$/.test(id)) throw new AttachmentError('attachment id must be a sha256 hex digest')
    return path.join(this.dir(workspaceId), id)
  }

  /**
   * Store bytes and return their reference. The declared media type must be
   * supported and, for images, must match the bytes. `limits` is the cap the
   * caller captured when its upload started, so the body read and this check
   * agree; without it the constructor's static cap applies.
   */
  async put(
    workspaceId: string,
    input: { readonly name: string; readonly mediaType: string; readonly bytes: Buffer },
    limits: AttachmentLimits = this.limits,
  ): Promise<AttachmentRef> {
    const mediaType = normalizeMediaType(input.mediaType)
    const name = input.name.trim().replaceAll(/[\r\n\t]/g, ' ').slice(0, 200)
    if (name === '') throw new AttachmentError('attachment needs a file name')
    if (input.bytes.length === 0) throw new AttachmentError(`'${name}' is empty`)
    if (input.bytes.length > limits.maxBytes) {
      throw new AttachmentError(`'${name}' is ${input.bytes.length} bytes; the limit is ${limits.maxBytes}`)
    }
    if (!isSupportedMediaType(mediaType)) {
      throw new AttachmentError(`'${name}' has unsupported type '${mediaType || 'unknown'}'; images and text files are accepted`)
    }
    if (isImageMediaType(mediaType)) {
      const sniffed = sniffImageMediaType(input.bytes)
      if (sniffed === null) throw new AttachmentError(`'${name}' does not contain image data`)
      if (sniffed !== mediaType) throw new AttachmentError(`'${name}' is declared ${mediaType} but contains ${sniffed}`)
    }

    const id = createHash('sha256').update(input.bytes).digest('hex')
    const target = this.file(workspaceId, id)
    await fs.mkdir(path.dirname(target), { recursive: true })
    // Identical bytes are already stored under this exact name; writing again
    // would only rewrite the same content.
    if (!(await this.exists(target))) {
      const temporary = `${target}.${process.pid}.tmp`
      await fs.writeFile(temporary, input.bytes)
      await fs.rename(temporary, target)
    }
    return { id, name, mediaType, bytes: input.bytes.length }
  }

  async read(workspaceId: string, id: string): Promise<Buffer> {
    try {
      return await fs.readFile(this.file(workspaceId, id))
    } catch (error) {
      if (error instanceof AttachmentError) throw error
      throw new AttachmentError(`attachment '${id}' is not stored in this workspace`)
    }
  }

  /**
   * Read every reference a request needs, decoded for the model: base64 for
   * images, bounded text for text files. A reference that cannot be read is
   * simply absent from the result — the projection then tells the model the
   * attachment is unavailable instead of pretending it was never sent.
   *
   * Results are cached under a byte budget: a long conversation would
   * otherwise re-read and re-encode the same screenshots on every step. A
   * text entry is keyed by the limit it was cut at, so a changed limit
   * re-projects instead of reusing text truncated under another cap.
   */
  async load(
    workspaceId: string,
    refs: readonly AttachmentRef[],
    options: { readonly textLimit: number },
  ): Promise<AttachmentLookup> {
    const loaded = new Map<string, LoadedAttachment>()
    for (const ref of refs) {
      if (loaded.has(ref.id)) continue
      const mediaType = normalizeMediaType(ref.mediaType)
      const image = isImageMediaType(mediaType)
      const key = `${workspaceId}:${ref.id}:${mediaType}${image ? '' : `:${options.textLimit}`}`
      const cached = this.cache.get(key)
      if (cached !== undefined) {
        loaded.set(ref.id, cached)
        continue
      }
      const bytes = await this.read(workspaceId, ref.id).catch(() => null)
      if (bytes === null) continue
      const content: LoadedAttachment = image
        ? { mediaType, base64: bytes.toString('base64') }
        : {
            mediaType,
            text: bytes.subarray(0, options.textLimit).toString('utf8'),
            ...(bytes.length > options.textLimit ? { truncated: true } : {}),
          }
      this.remember(key, content, bytes.length)
      loaded.set(ref.id, content)
    }
    return loaded
  }

  private remember(key: string, content: LoadedAttachment, bytes: number): void {
    // Concurrent loads of one key both miss and both remember: replace, never double-count.
    const previous = this.cache.get(key)
    if (previous !== undefined) {
      this.cache.delete(key)
      this.cachedBytes -= previous.bytes
    }
    this.cache.set(key, { ...content, bytes })
    this.cachedBytes += bytes
    for (const [oldest, entry] of this.cache) {
      if (this.cachedBytes <= CACHE_BUDGET_BYTES) break
      if (oldest === key) break // never evict what was just asked for
      this.cache.delete(oldest)
      this.cachedBytes -= entry.bytes
    }
  }

  /**
   * Check a reference a client sent back against what is actually stored: the
   * blob exists, its size matches, and an image's signature still agrees with
   * the declared type. Reads 16 bytes, not the file, so a message carrying
   * several large attachments stays cheap to accept.
   */
  async verify(workspaceId: string, ref: AttachmentRef): Promise<void> {
    const mediaType = normalizeMediaType(ref.mediaType)
    if (!isSupportedMediaType(mediaType)) {
      throw new AttachmentError(`'${ref.name}' has unsupported type '${mediaType || 'unknown'}'`)
    }
    const target = this.file(workspaceId, ref.id)
    const stat = await fs.stat(target).catch(() => null)
    if (stat === null || !stat.isFile()) {
      throw new AttachmentError(`attachment '${ref.name}' is not stored in this workspace`)
    }
    if (stat.size !== ref.bytes) {
      throw new AttachmentError(`attachment '${ref.name}' does not match the stored size`)
    }
    if (!isImageMediaType(mediaType)) return
    const handle = await fs.open(target, 'r')
    try {
      const head = Buffer.alloc(Math.min(16, stat.size))
      await handle.read(head, 0, head.length, 0)
      if (sniffImageMediaType(head) !== mediaType) {
        throw new AttachmentError(`attachment '${ref.name}' is not ${mediaType} data`)
      }
    } finally {
      await handle.close()
    }
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
