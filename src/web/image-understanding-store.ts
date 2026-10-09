import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { VisionApiResolution } from '../harness/tools/describe-image.ts'
import type { ProviderConfig } from './provider-store.ts'

/** App-wide provider/model reference used by DescribeImage. */
export interface ImageUnderstandingSettings {
  readonly provider: string | null
  readonly model: string | null
}

export const BLANK_IMAGE_UNDERSTANDING: ImageUnderstandingSettings = { provider: null, model: null }

export function parseImageUnderstandingSettings(raw: unknown): ImageUnderstandingSettings {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return BLANK_IMAGE_UNDERSTANDING
  const row = raw as Record<string, unknown>
  const provider = typeof row['provider'] === 'string' && row['provider'].trim() !== '' ? row['provider'].trim() : null
  const model = typeof row['model'] === 'string' && row['model'].trim() !== '' ? row['model'].trim() : null
  return provider === null || model === null ? BLANK_IMAGE_UNDERSTANDING : { provider, model }
}

export function loadImageUnderstandingSettings(file: string): ImageUnderstandingSettings {
  try { return parseImageUnderstandingSettings(JSON.parse(readFileSync(file, 'utf8'))) } catch { return BLANK_IMAGE_UNDERSTANDING }
}

export async function saveImageUnderstandingSettings(file: string, settings: ImageUnderstandingSettings): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, JSON.stringify(settings, null, 2), 'utf8')
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/** Resolve against the live provider list; unknown model ids are accepted intentionally. */
export function resolveVisionApi(settings: ImageUnderstandingSettings, providers: readonly ProviderConfig[]): VisionApiResolution {
  if (settings.provider === null || settings.model === null) {
    return { ok: false, reason: 'Image understanding is not configured. Open Settings → Providers & Models → Image understanding and choose a vision-capable provider and model.' }
  }
  const provider = providers.find((entry) => entry.id === settings.provider)
  if (provider === undefined) return { ok: false, reason: `Image understanding provider '${settings.provider}' no longer exists. Re-select it in Settings → Providers & Models → Image understanding.` }
  if (!provider.enabled) return { ok: false, reason: `Image understanding provider '${provider.name}' is disabled. Enable it in Settings → Providers & Models → Providers.` }
  return { ok: true, config: { provider: provider.id, model: settings.model } }
}
