import { useEffect, useState } from 'react'
import { getImageGenerationSettings, setImageGenerationSettings, type ImageGenerationSettings } from '../../lib/api.ts'
import type { ProviderSummary } from '../../lib/types.ts'
import { Button } from '../ui/Button.tsx'
import { Field } from '../ui/Field.tsx'
import { Select } from '../ui/Select.tsx'
import { TextInput } from '../ui/TextInput.tsx'
import { useUnsavedChanges } from './unsaved-changes.tsx'

const BLANK: ImageGenerationSettings = { provider: null, model: null }

/**
 * Which configured provider and model the GenerateImage and EditImage tools call. The pair
 * references a provider from Settings → Providers & Models → Providers, so its base URL and key
 * are reused, never copied. The provider must serve the OpenAI-compatible
 * `POST /images/generations` and `POST /images/edits` endpoints.
 */
export function ImageGenerationPanel({ providers }: { readonly providers: readonly ProviderSummary[] }) {
  const [saved, setSaved] = useState<ImageGenerationSettings>(BLANK)
  const [draft, setDraft] = useState<ImageGenerationSettings>(BLANK)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void getImageGenerationSettings().then((value) => { setSaved(value); setDraft(value) }, (cause) => setError(String(cause)))
  }, [])

  const dirty = draft.provider !== saved.provider || draft.model !== saved.model
  useUnsavedChanges(dirty)
  const provider = providers.find((entry) => entry.id === draft.provider)
  const complete = draft.provider !== null && draft.model !== null && draft.model.trim() !== ''

  const save = async (next: ImageGenerationSettings) => {
    setBusy(true)
    try {
      const value = await setImageGenerationSettings(next)
      setSaved(value); setDraft(value); setError(null)
      setNotice(value.provider === null ? 'Image generation turned off.' : 'Saved.')
    } catch (cause) {
      setError(String(cause)); setNotice(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="flex max-w-xl flex-col gap-4" aria-label="Image generation">
      <p className="m-0 text-sm text-fg-muted">
        GenerateImage and EditImage call this provider’s OpenAI-compatible <code>/images/generations</code> and <code>/images/edits</code> endpoints with its base URL and API key from Providers. Results appear inline in the conversation; an edit never overwrites its source.
      </p>
      <Field label="Provider">
        <Select
          label="Image provider"
          value={draft.provider ?? ''}
          onChange={(value) => { setNotice(null); setDraft({ provider: value === '' ? null : value, model: null }) }}
          options={[
            { value: '', label: 'Not configured' },
            ...providers.map((entry) => ({ value: entry.id, label: `${entry.name}${entry.enabled ? '' : ' (disabled)'}`, disabled: !entry.enabled })),
          ]}
        />
      </Field>
      {draft.provider !== null ? (
        <Field label="Model" hint="Image models are often not in a provider's chat model list, so any model ID is accepted.">
          <TextInput
            aria-label="Image model"
            list="image-model-options"
            value={draft.model ?? ''}
            placeholder="e.g. gpt-image-1"
            spellCheck={false}
            onChange={(event) => { setNotice(null); setDraft({ ...draft, model: event.target.value === '' ? null : event.target.value }) }}
          />
        </Field>
      ) : null}
      <datalist id="image-model-options">
        {(provider?.models ?? []).map((model) => <option key={model} value={model} />)}
      </datalist>
      {error !== null ? <p role="alert" className="m-0 text-sm text-bad">{error}</p> : null}
      {notice !== null ? <p role="status" className="m-0 text-sm text-ok">{notice}</p> : null}
      <div className="flex gap-2">
        <Button
          disabled={busy || !dirty || (draft.provider !== null && !complete)}
          onClick={() => void save(draft.provider === null ? BLANK : { provider: draft.provider, model: draft.model?.trim() ?? null })}
        >
          Save
        </Button>
        {dirty ? <Button disabled={busy} onClick={() => { setDraft(saved); setNotice(null) }}>Discard</Button> : null}
      </div>
    </section>
  )
}
