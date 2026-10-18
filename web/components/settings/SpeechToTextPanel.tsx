import { useEffect, useState } from 'react'
import { fetchProviderModels, getSpeechToTextSettings, listProviders, setSpeechToTextSettings, type SpeechToTextSettings } from '../../lib/api.ts'
import type { ProviderSummary } from '../../lib/types.ts'
import { Button } from '../ui/Button.tsx'
import { Field } from '../ui/Field.tsx'
import { Select, type SelectOption } from '../ui/Select.tsx'
import { TextInput } from '../ui/TextInput.tsx'
import { useUnsavedChanges } from './unsaved-changes.tsx'

const BLANK: SpeechToTextSettings = { provider: null, model: null }
const CUSTOM = '\u0000custom'

/** Transcription model IDs the provider lists are surfaced first. */
export function isTranscriptionModelId(id: string): boolean {
  return /whisper|transcri|voxtral|scribe|stt/i.test(id)
}

/**
 * Which configured provider and model the composer's dictation button calls.
 * The pair references a provider from Settings → Providers & Models →
 * Providers; it must serve the OpenAI-compatible `POST /audio/transcriptions`
 * API (OpenAI, Groq, Mistral and self-hosted gateways do).
 */
export function SpeechToTextPanel({ providers: chatProviders }: { readonly providers: readonly ProviderSummary[] }) {
  const [saved, setSaved] = useState<SpeechToTextSettings>(BLANK)
  const [draft, setDraft] = useState<SpeechToTextSettings>(BLANK)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [models, setModels] = useState<readonly string[]>([])
  const [manual, setManual] = useState(false)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    void getSpeechToTextSettings().then((value) => { setSaved(value); setDraft(value) }, (cause) => setError(String(cause)))
  }, [])

  // The workspace meta list excludes stt-only providers by design; the full
  // registry still carries them, so the Voice panel reads it directly.
  const [providers, setProviders] = useState<readonly ProviderSummary[]>(chatProviders)
  useEffect(() => {
    let current = true
    void listProviders().then((all) => { if (current) setProviders(all) }, () => {})
    return () => { current = false }
  }, [])

  useEffect(() => {
    if (draft.provider === null) { setModels([]); return }
    let current = true
    void fetchProviderModels(draft.provider).then(
      (outcome) => { if (current && outcome.ok) setModels(outcome.models) },
      () => { if (current) setModels([]) },
    )
    return () => { current = false }
  }, [draft.provider, reload])

  const dirty = draft.provider !== saved.provider || draft.model !== saved.model
  useUnsavedChanges(dirty)
  const complete = draft.provider !== null && draft.model !== null && draft.model.trim() !== ''

  const save = async (next: SpeechToTextSettings) => {
    setBusy(true)
    try {
      const value = await setSpeechToTextSettings(next)
      setSaved(value); setDraft(value); setError(null)
      setNotice(value.provider === null ? 'Dictation turned off.' : 'Saved.')
    } catch (cause) {
      setError(String(cause)); setNotice(null)
    } finally {
      setBusy(false)
    }
  }

  const setModel = (model: string | null) => { setNotice(null); setDraft({ ...draft, model }) }
  const sttModels = models.filter(isTranscriptionModelId)
  const otherModels = models.filter((id) => !isTranscriptionModelId(id))
  // A saved ID the endpoint no longer lists stays selectable instead of silently vanishing.
  const orphan = draft.model !== null && draft.model !== '' && !models.includes(draft.model) ? [draft.model] : []
  const options: SelectOption[] = [
    { value: '', label: 'Select model' },
    ...orphan.map((id) => ({ value: id, label: id, provider: 'Current' })),
    ...sttModels.map((id) => ({ value: id, label: id, provider: 'Transcription models' })),
    ...otherModels.map((id) => ({ value: id, label: id, provider: 'Other models' })),
    { value: CUSTOM, label: 'Enter model ID manually…', provider: 'Custom' },
  ]

  return (
    <section className="flex max-w-xl flex-col gap-4" aria-label="Speech-to-text">
      <h3 className="m-0 text-sm font-semibold">Speech-to-text</h3>
      <p className="m-0 text-sm text-fg-muted">
        The composer’s dictation button records your voice and sends it to this provider’s OpenAI-compatible <code>/audio/transcriptions</code> API; the returned text lands in the message box. OpenAI (<code>gpt-4o-transcribe</code>), Groq (<code>whisper-large-v3</code>) and Mistral (<code>voxtral-mini-latest</code>) all work.
      </p>
      <Field label="Provider">
        <Select
          label="Speech-to-text provider"
          value={draft.provider ?? ''}
          onChange={(value) => { setNotice(null); setManual(false); setDraft({ provider: value === '' ? null : value, model: null }) }}
          options={[
            { value: '', label: 'Not configured' },
            ...providers.map((entry) => ({ value: entry.id, label: `${entry.name}${entry.enabled ? '' : ' (disabled)'}`, disabled: !entry.enabled })),
          ]}
        />
      </Field>
      {draft.provider !== null ? (
        <div className="flex flex-col gap-2">
          <Field label="Model" hint={manual ? 'Enter a concrete transcription model ID.' : undefined}>
            {manual ? (
              <TextInput
                aria-label="Speech-to-text model"
                value={draft.model ?? ''}
                placeholder="e.g. whisper-large-v3"
                spellCheck={false}
                onChange={(event) => setModel(event.target.value === '' ? null : event.target.value)}
              />
            ) : (
              <Select
                label="Speech-to-text model"
                value={draft.model ?? ''}
                onChange={(value) => { if (value === CUSTOM) setManual(true); else setModel(value === '' ? null : value) }}
                options={options}
              />
            )}
          </Field>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => setReload((n) => n + 1)}>Reload models</Button>
            {manual ? <Button size="sm" onClick={() => setManual(false)}>Choose from list</Button> : null}
          </div>
        </div>
      ) : null}
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
