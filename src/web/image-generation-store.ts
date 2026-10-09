import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { ProviderConfig } from './provider-store.ts'
import type { ImageApiResolution } from '../harness/tools/image-tools.ts'

/**
 * Settings → Providers & Models → Image generation: which configured provider and model the
 * `GenerateImage` tool calls. App-wide like the provider registry, stored
 * beside `providers.json` so credentials are never duplicated — the pair is a
 * reference that resolves against the live provider list on every call.
 */
export interface ImageGenerationSettings {
  readonly provider: string | null
  readonly model: string | null
}

export const BLANK_IMAGE_SETTINGS: ImageGenerationSettings = { provider: null, model: null }

export function parseImageSettings(raw: unknown): ImageGenerationSettings {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return BLANK_IMAGE_SETTINGS
  const record = raw as Record<string, unknown>
  const provider = typeof record['provider'] === 'string' && record['provider'].trim() !== '' ? record['provider'].trim() : null
  const model = typeof record['model'] === 'string' && record['model'].trim() !== '' ? record['model'].trim() : null
  return provider === null || model === null ? BLANK_IMAGE_SETTINGS : { provider, model }
}

/** A missing or unreadable file is "not configured", never a startup failure. */
export function loadImageSettings(file: string): ImageGenerationSettings {
  try {
    return parseImageSettings(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return BLANK_IMAGE_SETTINGS
  }
}

/** Atomic replace through a unique sibling. */
export async function saveImageSettings(file: string, settings: ImageGenerationSettings): Promise<void> {
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

/** Resolve the stored pair to an endpoint, or the exact Settings fix the user needs. */
export function resolveImageApi(settings: ImageGenerationSettings, providers: readonly ProviderConfig[]): ImageApiResolution {
  if (settings.provider === null || settings.model === null) {
    return { ok: false, reason: 'Image generation is not configured. Open Settings → Providers & Models → Image generation and choose a provider and model.' }
  }
  const provider = providers.find((entry) => entry.id === settings.provider)
  if (provider === undefined) {
    return { ok: false, reason: `Image generation provider '${settings.provider}' no longer exists. Open Settings → Providers & Models → Image generation and choose another provider.` }
  }
  if (!provider.enabled) {
    return { ok: false, reason: `Image generation provider '${provider.name}' is disabled. Enable it in Settings → Providers & Models → Providers.` }
  }
  if (provider.baseUrl.trim() === '') {
    return { ok: false, reason: `Image generation provider '${provider.name}' has no base URL. Fix it in Settings → Providers & Models → Providers.` }
  }
  return { ok: true, config: { baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: settings.model } }
}
