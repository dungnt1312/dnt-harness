/**
 * Attachment storage: content addressing, the type allowlist, signature
 * checking, size caps and workspace isolation.
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AttachmentError, AttachmentStore, isSupportedMediaType, sniffImageMediaType } from '../../src/harness/attachments/store.ts'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('body')])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('body')])

let home = ''
let store: AttachmentStore

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-attachments-'))
  store = new AttachmentStore(home, { maxBytes: 1024 })
})

afterAll(async () => { await fs.rm(home, { recursive: true, force: true }) })

describe('attachment store', () => {
  it('addresses blobs by sha256 and stores the bytes once', async () => {
    const first = await store.put('ws-1', { name: 'shot.png', mediaType: 'image/png', bytes: PNG })
    const second = await store.put('ws-1', { name: 'renamed.png', mediaType: 'image/png', bytes: PNG })
    expect(first.id).toBe(createHash('sha256').update(PNG).digest('hex'))
    expect(second.id).toBe(first.id)
    expect(second.name).toBe('renamed.png')
    expect(first.bytes).toBe(PNG.length)
    expect(await fs.readdir(path.join(home, 'workspaces', 'ws-1', 'attachments'))).toEqual([first.id])
    expect(await store.read('ws-1', first.id)).toEqual(PNG)
  })

  it('normalizes the media type and keeps text attachments', async () => {
    const ref = await store.put('ws-1', { name: 'notes.md', mediaType: 'text/markdown; charset=utf-8', bytes: Buffer.from('# hi') })
    expect(ref.mediaType).toBe('text/markdown')
  })

  it('refuses an image whose bytes contradict the declared type', async () => {
    await expect(store.put('ws-1', { name: 'fake.png', mediaType: 'image/png', bytes: JPEG }))
      .rejects.toThrow(/declared image\/png but contains image\/jpeg/)
    await expect(store.put('ws-1', { name: 'fake.png', mediaType: 'image/png', bytes: Buffer.from('not an image') }))
      .rejects.toThrow(/does not contain image data/)
  })

  it('refuses unsupported types, empty files and oversized uploads', async () => {
    await expect(store.put('ws-1', { name: 'report.pdf', mediaType: 'application/pdf', bytes: Buffer.from('%PDF-') }))
      .rejects.toThrow(/unsupported type 'application\/pdf'/)
    await expect(store.put('ws-1', { name: 'empty.txt', mediaType: 'text/plain', bytes: Buffer.alloc(0) }))
      .rejects.toThrow(/is empty/)
    await expect(store.put('ws-1', { name: 'big.txt', mediaType: 'text/plain', bytes: Buffer.alloc(2048, 0x61) }))
      .rejects.toThrow(/the limit is 1024/)
    await expect(store.put('ws-1', { name: '   ', mediaType: 'text/plain', bytes: Buffer.from('x') }))
      .rejects.toThrow(/needs a file name/)
  })

  it('keeps workspaces apart and rejects a malformed id', async () => {
    const ref = await store.put('ws-1', { name: 'shot.png', mediaType: 'image/png', bytes: PNG })
    expect(await store.has('ws-1', ref.id)).toBe(true)
    expect(await store.has('ws-2', ref.id)).toBe(false)
    await expect(store.read('ws-2', ref.id)).rejects.toThrow(AttachmentError)
    await expect(store.read('ws-1', '../escape')).rejects.toThrow(/sha256 hex digest/)
  })

  it('classifies types and sniffs signatures', () => {
    expect(isSupportedMediaType('image/webp')).toBe(true)
    expect(isSupportedMediaType('application/json')).toBe(true)
    expect(isSupportedMediaType('application/zip')).toBe(false)
    expect(sniffImageMediaType(JPEG)).toBe('image/jpeg')
    expect(sniffImageMediaType(Buffer.from('RIFF0000WEBPxx'))).toBe('image/webp')
    expect(sniffImageMediaType(Buffer.from('GIF89a...'))).toBe('image/gif')
    expect(sniffImageMediaType(Buffer.from('plain'))).toBeNull()
  })

  it('applies a cap captured by the caller instead of the static one', async () => {
    const bytes = Buffer.alloc(1500, 0x62)
    await expect(store.put('ws-cap', { name: 'big.txt', mediaType: 'text/plain', bytes })).rejects.toThrow(/the limit is 1024/)
    const ref = await store.put('ws-cap', { name: 'big.txt', mediaType: 'text/plain', bytes }, { maxBytes: 2048 })
    expect(ref.bytes).toBe(1500)
    await expect(store.put('ws-cap', { name: 'small.txt', mediaType: 'text/plain', bytes: Buffer.from('abc') }, { maxBytes: 2 }))
      .rejects.toThrow(/the limit is 2/)
  })

  it('re-projects cached text when the text limit changes', async () => {
    const ref = await store.put('ws-text', { name: 'letters.txt', mediaType: 'text/plain', bytes: Buffer.from('abcdefgh') })
    const at = async (textLimit: number) => {
      const loaded = (await store.load('ws-text', [ref], { textLimit })).get(ref.id)
      return { mediaType: loaded?.mediaType, text: loaded?.text, ...(loaded?.truncated === true ? { truncated: true } : {}) }
    }
    expect(await at(3)).toEqual({ mediaType: 'text/plain', text: 'abc', truncated: true })
    expect(await at(8)).toEqual({ mediaType: 'text/plain', text: 'abcdefgh' })
    expect(await at(2)).toEqual({ mediaType: 'text/plain', text: 'ab', truncated: true })
    expect(await at(3)).toEqual({ mediaType: 'text/plain', text: 'abc', truncated: true })
  })

  it('keys cached entries by normalized media type; images ignore the text limit', async () => {
    const text = await store.put('ws-type', { name: 'data.json', mediaType: 'application/json', bytes: Buffer.from('{"a":1}') })
    const asJson = (await store.load('ws-type', [text], { textLimit: 100 })).get(text.id)
    const asPlain = (await store.load('ws-type', [{ ...text, mediaType: 'Text/Plain; charset=utf-8' }], { textLimit: 100 })).get(text.id)
    expect(asJson?.mediaType).toBe('application/json')
    expect(asPlain?.mediaType).toBe('text/plain')
    const image = await store.put('ws-type', { name: 'shot.png', mediaType: 'image/png', bytes: PNG })
    const first = (await store.load('ws-type', [image], { textLimit: 1 })).get(image.id)
    expect(first).toMatchObject({ mediaType: 'image/png', base64: PNG.toString('base64') })
    expect(first?.text).toBeUndefined()
    // With the blob gone, only the cache can answer: one entry serves every text limit.
    await fs.rm(path.join(home, 'workspaces', 'ws-type', 'attachments', image.id))
    const second = (await store.load('ws-type', [image], { textLimit: 999 })).get(image.id)
    expect(second).toMatchObject({ mediaType: 'image/png', base64: PNG.toString('base64') })
  })

  it('accounts one cache entry once when concurrent loads both miss', async () => {
    const fresh = new AttachmentStore(home, { maxBytes: 1024 })
    const ref = await fresh.put('ws-race', { name: 'race.txt', mediaType: 'text/plain', bytes: Buffer.from('racing bytes') })
    await Promise.all([fresh.load('ws-race', [ref], { textLimit: 100 }), fresh.load('ws-race', [ref], { textLimit: 100 })])
    expect((fresh as unknown as { cachedBytes: number }).cachedBytes).toBe(ref.bytes)
  })
})
