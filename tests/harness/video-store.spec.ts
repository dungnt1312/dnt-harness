import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sniffVideoMediaType, VideoStore, VideoStoreError } from '../../src/harness/attachments/video-store.ts'

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.from('....-video-bytes')])
const MOV = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  '), Buffer.from('....')])
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('webm-body')])

let home = ''
beforeEach(async () => { home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-video-store-')) })
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }) })

async function read(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer))
  return Buffer.concat(chunks)
}

describe('video container sniffing', () => {
  it('accepts MP4, QuickTime, and WebM by their leading bytes only', () => {
    expect(sniffVideoMediaType(MP4)).toBe('video/mp4')
    expect(sniffVideoMediaType(MOV)).toBe('video/quicktime')
    expect(sniffVideoMediaType(WEBM)).toBe('video/webm')
    expect(sniffVideoMediaType(Buffer.from('<html>error page</html>'))).toBeNull()
    expect(sniffVideoMediaType(Buffer.alloc(3))).toBeNull()
  })
})

describe('VideoStore', () => {
  it('stores a stream content-addressed and serves exact byte ranges', async () => {
    const store = new VideoStore(home)
    const ref = await store.putStream('ws', Readable.from([MP4.subarray(0, 10), MP4.subarray(10)]))
    expect(ref).toEqual({ id: createHash('sha256').update(MP4).digest('hex'), mediaType: 'video/mp4', bytes: MP4.length })
    expect(await store.stat('ws', ref.id)).toMatchObject({ bytes: MP4.length, mediaType: 'video/mp4' })
    expect(await read(store.stream('ws', ref.id))).toEqual(MP4)
    expect(await read(store.stream('ws', ref.id, { start: 4, end: 11 }))).toEqual(MP4.subarray(4, 12))
    // The same bytes cost one file.
    expect(await store.put('ws', MP4)).toEqual(ref)
    expect((await fs.readdir(path.join(home, 'workspaces', 'ws', 'videos'))).filter((name) => !name.startsWith('.'))).toEqual([ref.id])
  })

  it('accepts a web ReadableStream, as a fetch body arrives', async () => {
    const store = new VideoStore(home)
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(WEBM)); controller.close() } })
    expect(await store.putStream('ws', body)).toMatchObject({ mediaType: 'video/webm', bytes: WEBM.length })
  })

  it('refuses a non-video body, an empty body, and an oversize body without leaving files behind', async () => {
    const store = new VideoStore(home, 32)
    await expect(store.put('ws', Buffer.from('<html>502 Bad Gateway</html>'))).rejects.toThrow(/not a playable video/)
    await expect(store.putStream('ws', Readable.from([]))).rejects.toThrow(/empty/)
    await expect(store.put('ws', Buffer.concat([MP4, Buffer.alloc(64)]))).rejects.toThrow(/larger than the 32 byte limit/)
    const leftovers = await fs.readdir(path.join(home, 'workspaces', 'ws', 'videos'))
    expect(leftovers).toEqual([])
  })

  it('stops reading an aborted download and cleans up', async () => {
    const store = new VideoStore(home)
    const controller = new AbortController()
    const source = Readable.from((async function* () { yield MP4.subarray(0, 8); await new Promise((resolve) => setTimeout(resolve, 20)); yield MP4.subarray(8) })())
    const pending = store.putStream('ws', source, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow()
    expect(await fs.readdir(path.join(home, 'workspaces', 'ws', 'videos'))).toEqual([])
  })

  it('is scoped to its workspace and refuses ids that are not sha256 digests', async () => {
    const store = new VideoStore(home)
    const ref = await store.put('ws-a', MP4)
    await expect(store.stat('ws-b', ref.id)).rejects.toBeInstanceOf(VideoStoreError)
    await expect(store.stat('ws-a', '../../etc/passwd')).rejects.toThrow(/sha256/)
    expect(await store.has('ws-a', ref.id)).toBe(true)
    expect(await store.has('ws-b', ref.id)).toBe(false)
    expect(await store.has('ws-a', 'nope')).toBe(false)
  })
})
