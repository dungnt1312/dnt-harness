import type { ProviderSummary } from '../../lib/types.ts'
import { ImageGenerationPanel } from './ImageGenerationPanel.tsx'
import { ImageUnderstandingPanel } from './ImageUnderstandingPanel.tsx'

/** The two independent image-model settings share one navigation surface. */
export function ImagesPanel({ providers }: { readonly providers: readonly ProviderSummary[] }) {
  return (
    <div className="grid max-w-5xl gap-8 lg:grid-cols-2" aria-label="Image settings">
      <ImageGenerationPanel providers={providers} />
      <ImageUnderstandingPanel providers={providers} />
    </div>
  )
}
