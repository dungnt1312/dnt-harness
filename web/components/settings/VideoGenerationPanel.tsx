import { useEffect, useState } from 'react'
import { fetchProviderModels, getVideoGenerationSettings, setVideoGenerationSettings, type VideoGenerationSettings } from '../../lib/api.ts'
import type { ProviderSummary } from '../../lib/types.ts'
import { Button } from '../ui/Button.tsx'
import { Field } from '../ui/Field.tsx'
import { Select, type SelectOption } from '../ui/Select.tsx'
import { TextInput } from '../ui/TextInput.tsx'
import { useUnsavedChanges } from './unsaved-changes.tsx'

const BLANK: VideoGenerationSettings = { provider: null, model: null }
const CUSTOM = '\u0000custom'

/** Video models are rarely among chat models; anything named like one is listed first. */
export function isVideoModelId(id: string): boolean {
  return /video|sora|veo|kling|hailuo|wan[-_.]?\d|runway|pika|luma|seedance|vidu|cogvideo/i.test(id)
}

type LiveModels =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly models: readonly string[] }
  | { readonly state: 'failed'; readonly error: string }

/**
 * Which configured provider and model the GenerateVideo tool calls. The pair references a provider
 * from Settings → Providers & Models → Providers, so its base URL and key are reused, never copied.
 * The provider must serve the asynchronous `POST /videos` + `GET /videos/{id}` API.
 *
 * The model list is probed live from the provider's `/models` endpoint, and a model ID can always be
 * typed by hand.
 */
export function VideoGenerationPanel({ providers }: { readonly providers: readonly ProviderSummary[] }) {
  const [saved, setSaved] = useState<VideoGenerationSettings>(BLANK)
  const [draft, setDraft] = useState<VideoGenerationSettings>(BLANK)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [live, setLive] = useState<LiveModels>({ state: 'loading' })
  const [manual, setManual] = useState(false)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    void getVideoGenerationSettings().then((value) => { setSaved(value); setDraft(value) }, (cause) => setError(String(cause)))
  }, [])

  useEffect(() => {
    if (draft.provider === null) return
    let current = true
    setLive({ state: 'loading' })
    fetchProviderModels(draft.provider).then(
      (outcome) => {
        if (!current) return
        if (outcome.ok && outcome.models.length > 0) setLive({ state: 'ready', models: outcome.models })
        else setLive({ state: 'failed', error: 'the provider returned no models' })
      },
      (cause) => { if (current) setLive({ state: 'failed', error: String(cause instanceof Error ? cause.message : cause) }) },
    )
    return () => { current = false }
  }, [draft.provider, reload])

  const dirty = draft.provider !== saved.provider || draft.model !== saved.model
  useUnsavedChanges(dirty)
  const complete = draft.provider !== null && draft.model !== null && draft.model.trim() !== ''

  const save = async (next: VideoGenerationSettings) => {
    setBusy(true)
    try {
      const value = await setVideoGenerationSettings(next)
      setSaved(value); setDraft(value); setError(null)
      setNotice(value.provider === null ? 'Video generation turned off.' : 'Saved.')
    } catch (cause) {
      setError(String(cause)); setNotice(null)
    } finally {
      setBusy(false)
    }
  }

  const setModel = (model: string | null) => { setNotice(null); setDraft({ ...draft, model }) }
  const models = live.state === 'ready' ? live.models : []
  const videoModels = models.filter(isVideoModelId)
  const otherModels = models.filter((id) => !isVideoModelId(id))
  // A saved ID the endpoint no longer lists stays selectable instead of silently vanishing.
  const orphan = draft.model !== null && draft.model !== '' && !models.includes(draft.model) ? [draft.model] : []
  const options: SelectOption[] = [
    { value: '', label: 'Select model' },
    ...orphan.map((id) => ({ value: id, label: id, provider: 'Current' })),
    ...videoModels.map((id) => ({ value: id, label: id, provider: 'Video models' })),
    ...otherModels.map((id) => ({ value: id, label: id, provider: 'Other models' })),
    { value: CUSTOM, label: 'Enter model ID manually…', provider: 'Custom' },
  ]
  const typing = manual || live.state === 'failed'
  const hint = live.state === 'loading'
    ? 'Loading models from the provider…'
    : live.state === 'failed'
      ? `Could not load models from the provider (${live.error}). Enter a concrete video model ID.`
      : manual
        ? 'Enter a concrete video model ID.'
        : videoModels.length === 0
          ? 'The provider lists no model named like a video model; pick one below or enter its ID manually.'
          : undefined

  return (
    <section className="flex max-w-xl flex-col gap-4" aria-label="Video generation">
      <h3 className="m-0 text-sm font-semibold">Video generation</h3>
      <p className="m-0 text-sm text-fg-muted">
        GenerateVideo calls this provider’s asynchronous <code>/videos</code> API with its base URL and API key from Providers, waits for the job to finish, and shows the video inline in the conversation. A video can take several minutes.
      </p>
      <Field label="Provider">
        <Select
          label="Video provider"
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
          <Field label="Model" hint={hint}>
            {typing ? (
              <TextInput
                aria-label="Video model"
                value={draft.model ?? ''}
                placeholder="e.g. grok-imagine-video"
                spellCheck={false}
                onChange={(event) => setModel(event.target.value === '' ? null : event.target.value)}
              />
            ) : (
              <Select
                label="Video model"
                value={draft.model ?? ''}
                disabled={live.state === 'loading'}
                onChange={(value) => { if (value === CUSTOM) setManual(true); else setModel(value === '' ? null : value) }}
                options={options}
              />
            )}
          </Field>
          <div className="flex gap-2">
            <Button size="sm" disabled={live.state === 'loading'} onClick={() => setReload((n) => n + 1)}>Reload models</Button>
            {manual && live.state === 'ready' ? <Button size="sm" onClick={() => setManual(false)}>Choose from list</Button> : null}
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
