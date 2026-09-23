/**
 * Composer drafts keep semantic editor content separate from uploaded files.
 * Attachments live in a tray, so their names never become part of model text.
 */

import { messageText, parseMessageText } from './inline-chips.ts'

export interface AttachmentRef {
  readonly id: string
  readonly name: string
  readonly mediaType: string
  readonly bytes: number
}

/** Ordered semantic content from the editor. */
export type DraftSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'mention'; readonly path: string }
  /** A skill command; its wire text lives in `inline-chips.ts`. */
  | { readonly kind: 'command'; readonly name: string }

export interface RichDraft {
  readonly segments: readonly DraftSegment[]
  readonly attachments: readonly AttachmentRef[]
}

export const emptyDraft: RichDraft = { segments: [], attachments: [] }

export function textDraft(text: string): RichDraft {
  return text === '' ? emptyDraft : { segments: [{ kind: 'text', text }], attachments: [] }
}

/** A sent message back as an editable draft, its chips restored. */
export function messageDraft(text: string): RichDraft {
  return normalizeDraft(parseMessageText(text))
}

/** Merge neighbouring text and drop empty text, so equal drafts compare equal. */
export function normalizeDraft(segments: readonly DraftSegment[], attachments: readonly AttachmentRef[] = []): RichDraft {
  const merged: DraftSegment[] = []
  for (const segment of segments) {
    if (segment.kind !== 'text') { merged.push(segment); continue }
    if (segment.text === '') continue
    const previous = merged[merged.length - 1]
    if (previous !== undefined && previous.kind === 'text') {
      merged[merged.length - 1] = { kind: 'text', text: previous.text + segment.text }
      continue
    }
    merged.push(segment)
  }
  return { segments: merged, attachments: draftAttachments({ segments: [], attachments }) }
}

/** What the model reads: text plus each chip's wire text. */
export function draftText(draft: RichDraft): string {
  return messageText(draft.segments)
}

/** Uploaded files in first-seen order, with duplicate ids removed. */
export function draftAttachments(draft: RichDraft): readonly AttachmentRef[] {
  const refs: AttachmentRef[] = []
  const seen = new Set<string>()
  for (const ref of draft.attachments) {
    if (!seen.has(ref.id)) {
      seen.add(ref.id)
      refs.push(ref)
    }
  }
  return refs
}

/** Add tray attachments without changing semantic editor content. */
export function appendAttachments(draft: RichDraft, attachments: readonly AttachmentRef[]): RichDraft {
  return { segments: draft.segments, attachments: draftAttachments({ segments: [], attachments: [...draft.attachments, ...attachments] }) }
}

/** Remove one tray attachment without changing semantic editor content. */
export function removeAttachment(draft: RichDraft, id: string): RichDraft {
  return { segments: draft.segments, attachments: draft.attachments.filter((attachment) => attachment.id !== id) }
}

/** Replace semantic editor content while retaining the attachment tray. */
export function updateDraftSegments(draft: RichDraft, segments: readonly DraftSegment[]): RichDraft {
  return normalizeDraft(segments, draft.attachments)
}

/** An attachment alone is a message; only nothing at all is unsendable. */
export function draftIsEmpty(draft: RichDraft): boolean {
  return draftText(draft).trim() === '' && draftAttachments(draft).length === 0
}
