import { mkdir, readFileSync, rename, writeFile } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import path from 'node:path'
import { isThinkingLevel } from '../harness/llm/model-catalog.ts'

/** Per-model operator overrides stored on one provider entry. */
export interface ModelSettings {
  readonly contextTokens?: number
  readonly vision?: boolean
  readonly thinkingLevel?: string
}

/** One configured OpenAI-completions provider, persisted as JSON. */
export interface ProviderConfig {
  readonly id: string
  readonly name: string
  readonly baseUrl: string
  readonly apiKey: string
  readonly models: readonly string[]
  readonly enabled: boolean
  readonly modelSettings?: Readonly<Record<string, ModelSettings>>
}

export interface ModelDefaults {
  readonly provider: string | null
  readonly model: string | null
  /** Null delegates to the selected model's configured default. */
  readonly thinkingLevel: string | null
}

export interface ProviderStore {
  readonly version: 2
  readonly defaults: ModelDefaults
  readonly providers: readonly ProviderConfig[]
}

const blankDefaults = (): ModelDefaults => ({ provider: null, model: null, thinkingLevel: null })

/**
 * Select the first usable pair, in declared order: the first enabled provider
 * that advertises a model, using that provider's first advertised model.
 *
 * Model choice is never stored per provider. A provider's `models[0]` is
 * simply the first id it advertises, so callers that need a user-chosen model
 * must supply one explicitly rather than relying on this fallback.
 */
export function preferredDefaults(providers: readonly ProviderConfig[], thinkingLevel: string | null = null): ModelDefaults {
  for (const provider of providers) {
    if (!provider.enabled) continue
    const model = provider.models[0]
    if (model !== undefined) return { provider: provider.id, model, thinkingLevel }
  }
  return blankDefaults()
}

/** Preserve a valid selected pair; otherwise select the stable preferred usable pair. */
export function repairDefaults(defaults: ModelDefaults, providers: readonly ProviderConfig[]): ModelDefaults {
  if (defaults.provider !== null && defaults.model !== null) {
    const selected = providers.find((provider) => provider.id === defaults.provider)
    if (selected?.enabled && selected.models.includes(defaults.model)) return defaults
  }
  return preferredDefaults(providers, defaults.thinkingLevel)
}

/** Load the complete versioned store. Missing or malformed data is empty. */
export function loadProviderStore(file: string): ProviderStore {
  try {
    return parseProviderStore(readFileSync(file, 'utf8'))
  } catch {
    return { version: 2, defaults: blankDefaults(), providers: [] }
  }
}

/** Backwards-compatible list projection for existing callers. */
export function loadProviders(file: string): ProviderConfig[] {
  return [...loadProviderStore(file).providers]
}

/** Parse the versioned envelope, dropping malformed providers. */
export function parseProviderStore(raw: string): ProviderStore {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { version: 2, defaults: blankDefaults(), providers: [] }
    }
    const envelope = parsed as Record<string, unknown>
    if (envelope['version'] !== 2 || !Array.isArray(envelope['providers'])) {
      return { version: 2, defaults: blankDefaults(), providers: [] }
    }
    const providers = parseProviderEntries(envelope['providers'])
    const rawDefaults = envelope['defaults']
    const defaults = rawDefaults !== null && typeof rawDefaults === 'object' && !Array.isArray(rawDefaults)
      ? parseDefaults(rawDefaults as Record<string, unknown>)
      : blankDefaults()
    // The host may supply an injected provider not represented in this file.
    // Keep a syntactically valid envelope selection intact; the server repairs
    // it against its complete runtime catalog at the boundary.
    return { version: 2, defaults, providers }
  } catch {
    return { version: 2, defaults: blankDefaults(), providers: [] }
  }
}

/** Backwards-compatible parser projection. */
export function parseProviders(raw: string): ProviderConfig[] {
  return [...parseProviderStore(raw).providers]
}

function parseDefaults(candidate: Record<string, unknown>): ModelDefaults {
  const provider = typeof candidate['provider'] === 'string' ? candidate['provider'] : null
  const model = typeof candidate['model'] === 'string' ? candidate['model'] : null
  const thinkingLevel = candidate['thinkingLevel'] === null || isThinkingLevel(candidate['thinkingLevel'])
    ? candidate['thinkingLevel'] as string | null
    : null
  return provider === null || model === null ? { provider: null, model: null, thinkingLevel } : { provider, model, thinkingLevel }
}

function parseProviderEntries(entries: readonly unknown[]): ProviderConfig[] {
  const out: ProviderConfig[] = []
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    const candidate = entry as Record<string, unknown>
    const id = candidate['id']; const name = candidate['name']; const baseUrl = candidate['baseUrl']; const apiKey = candidate['apiKey']
    if (typeof id !== 'string' || id === '' || typeof name !== 'string' || name === '' || typeof baseUrl !== 'string' || baseUrl === '' || typeof apiKey !== 'string') continue
    const models = Array.isArray(candidate['models']) ? candidate['models'].filter((model): model is string => typeof model === 'string') : []
    const modelSettings: Record<string, ModelSettings> = {}
    if (candidate['contextLimits'] !== null && typeof candidate['contextLimits'] === 'object' && !Array.isArray(candidate['contextLimits'])) {
      for (const [model, tokens] of Object.entries(candidate['contextLimits'] as Record<string, unknown>)) {
        if (typeof tokens === 'number' && Number.isInteger(tokens) && tokens > 0) modelSettings[model] = { contextTokens: tokens }
      }
    }
    if (candidate['modelSettings'] !== null && typeof candidate['modelSettings'] === 'object' && !Array.isArray(candidate['modelSettings'])) {
      for (const [model, raw] of Object.entries(candidate['modelSettings'] as Record<string, unknown>)) {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
        const settings = raw as Record<string, unknown>
        const value: ModelSettings = {
          ...(typeof settings['contextTokens'] === 'number' && Number.isInteger(settings['contextTokens']) && settings['contextTokens'] > 0 ? { contextTokens: settings['contextTokens'] } : {}),
          ...(typeof settings['vision'] === 'boolean' ? { vision: settings['vision'] } : {}),
          ...(isThinkingLevel(settings['thinkingLevel']) ? { thinkingLevel: settings['thinkingLevel'] } : {}),
        }
        if (Object.keys(value).length > 0) modelSettings[model] = { ...modelSettings[model], ...value }
      }
    }
    out.push({ id, name, baseUrl, apiKey, models, enabled: candidate['enabled'] !== false, ...(Object.keys(modelSettings).length > 0 ? { modelSettings } : {}) })
  }
  return out
}

/** Persist definitions and global defaults together through one atomic rename. */
export async function saveProviderStore(file: string, store: ProviderStore): Promise<void> {
  await new Promise<void>((resolve, reject) => mkdir(path.dirname(file), { recursive: true }, (error) => error === null ? resolve() : reject(error)))
  // A unique sibling avoids colliding with another host/process. Flush both
  // the replacement file and parent directory before reporting a commit.
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await new Promise<void>((resolve, reject) => writeFile(temp, JSON.stringify(store, null, 2), 'utf8', (error) => error === null ? resolve() : reject(error)))
    const replacement = await open(temp, 'r')
    try { await flushIfSupported(replacement) } finally { await replacement.close() }
    await new Promise<void>((resolve, reject) => rename(temp, file, (error) => error === null ? resolve() : reject(error)))
    const directory = await open(path.dirname(file), 'r')
    try { await flushIfSupported(directory) } finally { await directory.close() }
  } catch (error) {
    await import('node:fs/promises').then(({ rm }) => rm(temp, { force: true })).catch(() => {})
    throw error
  }
}

/** Windows/filesystem providers can reject fsync despite successful rename. */
async function flushIfSupported(handle: Awaited<ReturnType<typeof open>>): Promise<void> {
  try {
    await handle.sync()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EPERM' && code !== 'EINVAL' && code !== 'ENOTSUP') throw error
  }
}

/** Compatibility writer: retains the defaults currently on disk where valid. */
export async function saveProviders(file: string, providers: readonly ProviderConfig[]): Promise<void> {
  const current = loadProviderStore(file)
  await saveProviderStore(file, { version: 2, defaults: repairDefaults(current.defaults, providers), providers })
}

export function slugify(name: string): string {
  const slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug === '' ? 'provider' : slug
}

export function maskKey(apiKey: string): string {
  if (apiKey === '') return ''
  if (apiKey.length <= 4) return '••••'
  return `••••${apiKey.slice(-4)}`
}
