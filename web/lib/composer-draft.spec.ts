import { describe, expect, it } from 'vitest'
import {
  appendAttachments,
  draftAttachments,
  draftIsEmpty,
  draftText,
  emptyDraft,
  messageDraft,
  removeAttachment,
  textDraft,
  updateDraftSegments,
  type AttachmentRef,
  type RichDraft,
} from './composer-draft.ts'

const FIRST: AttachmentRef = { id: 'a'.repeat(64), name: 'first.png', mediaType: 'image/png', bytes: 12 }
const SECOND: AttachmentRef = { id: 'b'.repeat(64), name: 'second.txt', mediaType: 'text/plain', bytes: 24 }

describe('RichDraft', () => {
  it('serializes semantic segments without attachment filenames', () => {
    const draft: RichDraft = {
      segments: [
        { kind: 'command', name: 'review' },
        { kind: 'text', text: ' run ' },
        { kind: 'mention', path: 'web/api.ts' },
        { kind: 'text', text: ' and ' },
        { kind: 'mention', path: 'docs/my notes.md' },
      ],
      attachments: [FIRST],
    }

    expect(draftText(draft)).toBe('/review run [@api.ts](./web/api.ts) and [@my notes.md](<./docs/my notes.md>)')
  })

  it('restores chips from a sent message', () => {
    expect(messageDraft('/review check [@api.ts](./web/api.ts)')).toEqual({
      segments: [
        { kind: 'command', name: 'review' },
        { kind: 'text', text: ' check ' },
        { kind: 'mention', path: 'web/api.ts' },
      ],
      attachments: [],
    })
  })

  it('deduplicates tray attachments by first-seen id', () => {
    const replacementFirst = { ...FIRST, name: 'replacement.png' }
    const draft: RichDraft = { segments: [], attachments: [FIRST, SECOND, replacementFirst] }

    expect(draftAttachments(draft)).toEqual([FIRST, SECOND])
  })

  it('treats an attachment-only draft as non-empty', () => {
    expect(draftIsEmpty({ segments: [], attachments: [FIRST] })).toBe(false)
    expect(draftIsEmpty(emptyDraft)).toBe(true)
  })

  it('appends attachments and removes one without changing editor segments', () => {
    const original: RichDraft = { segments: [{ kind: 'text', text: 'keep me' }], attachments: [FIRST] }
    const appended = appendAttachments(original, [SECOND, FIRST])

    expect(appended).toEqual({ segments: original.segments, attachments: [FIRST, SECOND] })
    expect(removeAttachment(appended, FIRST.id)).toEqual({ segments: original.segments, attachments: [SECOND] })
  })

  it('updates editor segments without dropping attachments', () => {
    const original = appendAttachments(textDraft('old'), [FIRST])

    expect(updateDraftSegments(original, [{ kind: 'command', name: 'test' }])).toEqual({
      segments: [{ kind: 'command', name: 'test' }],
      attachments: [FIRST],
    })
  })
})
