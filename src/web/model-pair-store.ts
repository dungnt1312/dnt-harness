import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

/**
 * A provider/model reference persisted beside `providers.json`. Image
 * generation, image understanding and video generation each keep one: the
 * pair is only a pointer, resolved against the live provider list on every
 * call, so credentials are never duplicated and a deleted provider degrades
 * to a readable Settings error instead of a stale secret.
 */
export interface ModelPair {
  readonly provider: string | null
  readonly model: string | null
}

export const BLANK_PAIR: ModelPair = { provider: null, model: null }

/** Keep only a complete, trimmed pair. */
export function parsePair(raw: unknown): ModelPair {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return BLANK_PAIR
  const row = raw as Record<string, unknown>
  const provider = typeof row['provider'] === 'string' && row['provider'].trim() !== '' ? row['provider'].trim() : null
  const model = typeof row['model'] === 'string' && row['model'].trim() !== '' ? row['model'].trim() : null
  return provider === null || model === null ? BLANK_PAIR : { provider, model }
}

/** A missing or unreadable file is "not configured", never a startup failure. */
export function loadPair(file: string): ModelPair {
  try { return parsePair(JSON.parse(readFileSync(file, 'utf8'))) } catch { return BLANK_PAIR }
}

/** Atomic replace through a unique sibling. */
export async function savePair(file: string, pair: ModelPair): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, JSON.stringify(pair, null, 2), 'utf8')
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/** A `PUT` body: a complete pair, or an explicit null/'' to clear. */
export function validatePairBody(body: Record<string, unknown>, known: (providerId: string) => boolean): { readonly ok: true; readonly pair: ModelPair } | { readonly ok: false; readonly error: string } {
  const next = parsePair(body)
  const blankRequested = body['provider'] === null || body['provider'] === '' || body['model'] === null || body['model'] === ''
  if (next.provider === null && !blankRequested) return { ok: false, error: "body needs 'provider' and 'model' strings, or null to clear" }
  if (next.provider !== null && !known(next.provider)) return { ok: false, error: `unknown provider '${next.provider}'` }
  return { ok: true, pair: next }
}
