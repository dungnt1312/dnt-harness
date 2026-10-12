import type { VideoApiResolution } from '../harness/tools/video-tools.ts'
import type { ModelPair } from './model-pair-store.ts'
import type { ProviderConfig } from './provider-store.ts'

/** Resolve the stored pair to an endpoint, or the exact Settings fix the user needs. */
export function resolveVideoApi(settings: ModelPair, providers: readonly ProviderConfig[]): VideoApiResolution {
  if (settings.provider === null || settings.model === null) {
    return { ok: false, reason: 'Video generation is not configured. Open Settings → Providers & Models → Video generation and choose a provider and model.' }
  }
  const provider = providers.find((entry) => entry.id === settings.provider)
  if (provider === undefined) {
    return { ok: false, reason: `Video generation provider '${settings.provider}' no longer exists. Open Settings → Providers & Models → Video generation and choose another provider.` }
  }
  if (!provider.enabled) {
    return { ok: false, reason: `Video generation provider '${provider.name}' is disabled. Enable it in Settings → Providers & Models → Providers.` }
  }
  if (provider.baseUrl.trim() === '') {
    return { ok: false, reason: `Video generation provider '${provider.name}' has no base URL. Fix it in Settings → Providers & Models → Providers.` }
  }
  return { ok: true, config: { baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: settings.model } }
}
