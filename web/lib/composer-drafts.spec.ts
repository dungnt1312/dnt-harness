/** Draft storage: tolerant of junk, bounded in size, empty drafts dropped. */
import { describe, expect, it } from 'vitest'
import { MAX_DRAFT_CHARS, MAX_STORED_DRAFTS, parseDrafts, serializeDrafts } from './composer-drafts.ts'
import { textDraft, type AttachmentRef, type RichDraft } from './composer-draft.ts'

const REF: AttachmentRef = { id: 'b'.repeat(64), name: 'shot.png', mediaType: 'image/png', bytes: 12 }

describe('parseDrafts', () => {
  it('round-trips semantic segments and tray attachments', () => {
    const draft: RichDraft = {
      segments: [
        { kind: 'text', text: 'compare ' },
        { kind: 'mention', path: 'web/api.ts' },
        { kind: 'command', name: 'review' },
      ],
      attachments: [REF],
    }
    expect(parseDrafts(serializeDrafts({ a: draft }))).toEqual({ a: draft })
  })

  it('migrates legacy inline attachments into the tray', () => {
    const payload = JSON.stringify({
      a: {
        segments: [
          { kind: 'text', text: 'before ' },
          { kind: 'attachment', ref: REF },
          { kind: 'text', text: 'after' },
        ],
      },
    })

    expect(parseDrafts(payload)).toEqual({
      a: { segments: [{ kind: 'text', text: 'before after' }], attachments: [REF] },
    })
  })

  it('drops malformed attachment refs from both legacy segments and the tray', () => {
    const payload = JSON.stringify({
      a: {
        segments: [{ kind: 'attachment', ref: { id: 'short', name: 'bad', mediaType: 'image/png', bytes: 1 } }],
        attachments: [{ id: REF.id, name: 'good.png', mediaType: 'image/png', bytes: 'not-a-number' }],
      },
    })

    expect(parseDrafts(payload)).toEqual({})
  })

  it('keeps attachment-only drafts', () => {
    expect(parseDrafts(serializeDrafts({ a: { segments: [], attachments: [REF] } }))).toEqual({
      a: { segments: [], attachments: [REF] },
    })
  })

  it('reads a draft written by the earlier string-only version', () => {
    expect(parseDrafts(JSON.stringify({ a: 'hello' }))).toEqual({ a: textDraft('hello') })
  })

  it('drops segments it cannot trust and keys that end up empty', () => {
    const payload = JSON.stringify({
      a: { segments: [{ kind: 'mention' }, { kind: 'attachment', ref: { id: 'short' } }, { kind: 'text', text: 'kept' }] },
      b: { segments: [{ kind: 'nonsense' }] },
      c: 7,
    })
    expect(parseDrafts(payload)).toEqual({ a: textDraft('kept') })
  })

  it('falls back to empty for missing, malformed or non-object payloads', () => {
    expect(parseDrafts(null)).toEqual({})
    expect(parseDrafts('{oops')).toEqual({})
    expect(parseDrafts(JSON.stringify(['a']))).toEqual({})
  })

  it('truncates an oversized stored draft', () => {
    const parsed = parseDrafts(JSON.stringify({ a: 'x'.repeat(MAX_DRAFT_CHARS + 50) }))
    expect(parsed['a']?.segments[0]).toEqual({ kind: 'text', text: 'x'.repeat(MAX_DRAFT_CHARS) })
  })
})

describe('serializeDrafts', () => {
  it('drops empty drafts and keeps only the newest keys', () => {
    expect(parseDrafts(serializeDrafts({ a: textDraft('keep'), b: textDraft('') }))).toEqual({ a: textDraft('keep') })

    const many = Object.fromEntries(Array.from({ length: MAX_STORED_DRAFTS + 5 }, (_, i) => [`key-${i}`, textDraft(`draft ${i}`)]))
    const kept = parseDrafts(serializeDrafts(many))
    expect(Object.keys(kept)).toHaveLength(MAX_STORED_DRAFTS)
    expect(kept[`key-${MAX_STORED_DRAFTS + 4}`]).toEqual(textDraft(`draft ${MAX_STORED_DRAFTS + 4}`))
    expect(kept['key-0']).toBeUndefined()
  })
})
