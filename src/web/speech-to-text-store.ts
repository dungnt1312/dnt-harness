import type { TranscriptionConfig } from '../harness/stt/transcriptions.ts'
import type { ModelPair } from './model-pair-store.ts'
import { servesKind, type ProviderConfig } from './provider-store.ts'

/** Resolve the stored pair to an endpoint, or the exact Settings fix the user needs. */
export function resolveSttApi(settings: ModelPair, providers: readonly ProviderConfig[]): { readonly ok: true; readonly config: TranscriptionConfig } | { readonly ok: false; readonly reason: string } {
  if (settings.provider === null || settings.model === null) {
    return { ok: false, reason: 'Speech-to-text is not configured. Open Settings → Providers & Models → Speech-to-text and choose a provider and model.' }
  }
  const provider = providers.find((entry) => entry.id === settings.provider)
  if (provider === undefined) {
    return { ok: false, reason: `Speech-to-text provider '${settings.provider}' no longer exists. Open Settings → Providers & Models → Speech-to-text and choose another provider.` }
  }
  if (!provider.enabled) {
    return { ok: false, reason: `Speech-to-text provider '${provider.name}' is disabled. Enable it in Settings → Providers & Models → Providers.` }
  }
  if (!servesKind(provider, 'stt')) {
    return { ok: false, reason: `Speech-to-text provider '${provider.name}' does not serve transcription. Give it the 'stt' kind in Settings → Providers & Models → Providers.` }
  }
  if (provider.baseUrl.trim() === '') {
    return { ok: false, reason: `Speech-to-text provider '${provider.name}' has no base URL. Fix it in Settings → Providers & Models → Providers.` }
  }
  return { ok: true, config: { baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: settings.model } }
}
