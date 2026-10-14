import { createHash } from 'node:crypto'
import type { SessionEvent } from '../session/events.ts'

/**
 * Leaf module (imports only event types) for the identities that compaction
 * recovery, projection and snapshots all need. Keeping it free of other
 * compaction imports is what lets canonical recovery verify an adoption proof
 * without an import cycle.
 */

/** Bump when the digest's input rows change shape. */
export const DIGEST_VERSION = 1

/** Stable JSON: object keys sorted recursively, so equal content hashes equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  const record = value as Record<string, unknown>
  const body = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
  return `{${body.join(',')}}`
}

export const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** Structural identity of a seed: sha256 of the canonical summary text (same as `history.checkpointHash`). */
export function compactionSeedHash(summary: string): string {
  return sha256(summary)
}

/**
 * Digest of what the model could have seen through `cutoff`: user text,
 * assistant content, the EFFECTIVE tool calls (which an authorization hook may
 * have rewritten) and tool results, in log order. Telemetry, hook, manifest
 * and attempt events never take part, and neither do their sequence numbers:
 * interleaving them cannot invalidate a snapshot.
 */
export function sourceDigest(events: readonly SessionEvent[], cutoff: number): string {
  const rows: unknown[] = [DIGEST_VERSION]
  for (const event of events) {
    if (event.seq > cutoff) break
    switch (event.type) {
      case 'user/message':
        rows.push(['u', event.content, event.attachments ?? null])
        break
      case 'assistant/message':
        rows.push(['a', event.stepId, event.content, event.toolCalls?.map((call) => call.id) ?? null])
        break
      case 'tool/call':
        rows.push(['c', event.stepId, event.call])
        break
      case 'tool/result':
        rows.push(['r', event.stepId, event.callId, event.ok, event.output])
        break
      default:
        break
    }
  }
  return sha256(canonicalJson(rows))
}
