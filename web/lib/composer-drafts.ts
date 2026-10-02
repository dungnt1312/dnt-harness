/**
 * Unsent composer drafts, kept per workspace+session so a reload (or a crash)
 * never costs typed work. Storage is best-effort — every caller must work when
 * it is unavailable.
 */
import { emptyDraft, normalizeDraft, textDraft, type AttachmentRef, type DraftSegment, type RichDraft } from './composer-draft.ts'
import { isSkillName, parseMessageText } from './inline-chips.ts'

export const DRAFTS_STORAGE_KEY = 'dnt-harness.drafts.v1'
/** Newest drafts kept; older conversations drop out rather than grow forever. */
export const MAX_STORED_DRAFTS = 20
/** Per-draft text ceiling; a pasted novel is truncated instead of blocking storage. */
export const MAX_DRAFT_CHARS = 20_000

export type StoredDrafts = Readonly<Record<string, RichDraft>>

function parseAttachment(raw: unknown): AttachmentRef | null {
  if (raw === null || typeof raw !== 'object') return null
  const ref = raw as Record<string, unknown>
  if (
    typeof ref['id'] !== 'string' || !/^[0-9a-f]{64}$/.test(ref['id']) ||
    typeof ref['name'] !== 'string' || typeof ref['mediaType'] !== 'string' ||
    typeof ref['bytes'] !== 'number' || !Number.isFinite(ref['bytes']) || ref['bytes'] < 0
  ) return null
  return { id: ref['id'], name: ref['name'], mediaType: ref['mediaType'], bytes: ref['bytes'] }
}

function parseSegment(raw: unknown): DraftSegment | AttachmentRef | null {
  if (raw === null || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  if (row['kind'] === 'text' && typeof row['text'] === 'string') {
    return { kind: 'text', text: row['text'].slice(0, MAX_DRAFT_CHARS) }
  }
  if (row['kind'] === 'mention' && typeof row['path'] === 'string' && row['path'] !== '') {
    return { kind: 'mention', path: row['path'] }
  }
  if (row['kind'] === 'command') {
    if (typeof row['name'] === 'string' && isSkillName(row['name'])) return { kind: 'command', name: row['name'] }
    // Legacy command chips stored their wire text instead of the skill name.
    const legacy = typeof row['text'] === 'string' ? parseMessageText(row['text']) : []
    return legacy.length === 1 && legacy[0]?.kind === 'command' ? legacy[0] : null
  }
  // Legacy drafts stored attachment chips among inline editor segments.
  if (row['kind'] === 'attachment') return parseAttachment(row['ref'])
  return null
}

function parseDraft(raw: unknown): RichDraft {
  // A draft written before chips existed was a bare string.
  if (typeof raw === 'string') return textDraft(raw.slice(0, MAX_DRAFT_CHARS))
  if (raw === null || typeof raw !== 'object') return emptyDraft
  const row = raw as Record<string, unknown>
  const rawSegments = row['segments']
  if (!Array.isArray(rawSegments)) return emptyDraft

  const segments: DraftSegment[] = []
  const attachments: AttachmentRef[] = []
  for (const entry of rawSegments) {
    const parsed = parseSegment(entry)
    if (parsed === null) continue
    if ('kind' in parsed) segments.push(parsed)
    else attachments.push(parsed)
  }
  if (Array.isArray(row['attachments'])) {
    for (const entry of row['attachments']) {
      const attachment = parseAttachment(entry)
      if (attachment !== null) attachments.push(attachment)
    }
  }
  return normalizeDraft(segments, attachments)
}

export function parseDrafts(raw: string | null): StoredDrafts {
  if (raw === null) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const drafts: Record<string, RichDraft> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const draft = parseDraft(value)
      if (draft.segments.length > 0 || draft.attachments.length > 0) drafts[key] = draft
    }
    return drafts
  } catch {
    return {}
  }
}

/** Drop empty drafts and keep only the newest {@link MAX_STORED_DRAFTS} keys. */
export function serializeDrafts(drafts: StoredDrafts): string {
  const kept = Object.entries(drafts)
    .map(([key, draft]) => [key, normalizeDraft(draft.segments, draft.attachments)] as const)
    .filter(([, draft]) => draft.segments.length > 0 || draft.attachments.length > 0)
    .slice(-MAX_STORED_DRAFTS)
  return JSON.stringify(Object.fromEntries(kept))
}

export function readDrafts(): StoredDrafts {
  try {
    return parseDrafts(window.localStorage.getItem(DRAFTS_STORAGE_KEY))
  } catch {
    return {}
  }
}

export function persistDrafts(drafts: StoredDrafts): void {
  try {
    window.localStorage.setItem(DRAFTS_STORAGE_KEY, serializeDrafts(drafts))
  } catch {
    // A full or blocked store must never break typing.
  }
}
