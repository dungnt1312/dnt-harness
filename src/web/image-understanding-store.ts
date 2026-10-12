import type { VisionApiResolution } from '../harness/tools/describe-image.ts'
import type { ModelPair } from './model-pair-store.ts'
import type { ProviderConfig } from './provider-store.ts'

/** Resolve against the live provider list; unknown model ids are accepted intentionally. */
export function resolveVisionApi(settings: ModelPair, providers: readonly ProviderConfig[]): VisionApiResolution {
  if (settings.provider === null || settings.model === null) {
    return { ok: false, reason: 'Image understanding is not configured. Open Settings → Providers & Models → Image understanding and choose a vision-capable provider and model.' }
  }
  const provider = providers.find((entry) => entry.id === settings.provider)
  if (provider === undefined) return { ok: false, reason: `Image understanding provider '${settings.provider}' no longer exists. Re-select it in Settings → Providers & Models → Image understanding.` }
  if (!provider.enabled) return { ok: false, reason: `Image understanding provider '${provider.name}' is disabled. Enable it in Settings → Providers & Models → Providers.` }
  return { ok: true, config: { provider: provider.id, model: settings.model } }
}
