import { useEffect, useState } from 'react'
import { getCommitMessageSettings, setCommitMessageSettings, type CommitMessageSettings } from '../../lib/api.ts'
import type { ProviderSummary } from '../../lib/types.ts'
import { Button } from '../ui/Button.tsx'
import { Field } from '../ui/Field.tsx'
import { Select } from '../ui/Select.tsx'
import { TextInput } from '../ui/TextInput.tsx'
import { useUnsavedChanges } from './unsaved-changes.tsx'

const BLANK: CommitMessageSettings = { provider: null, model: null }

/** The model behind the Git panel's Generate Commit Message button (Zed `commit_message_model`). */
export function CommitMessagePanel({ providers }: { readonly providers: readonly ProviderSummary[] }) {
  const [saved, setSaved] = useState<CommitMessageSettings>(BLANK)
  const [draft, setDraft] = useState<CommitMessageSettings>(BLANK)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { void getCommitMessageSettings().then((value) => { setSaved(value); setDraft(value) }, (cause) => setError(String(cause))) }, [])
  const dirty = draft.provider !== saved.provider || draft.model !== saved.model
  useUnsavedChanges(dirty)
  const provider = providers.find((entry) => entry.id === draft.provider)

  const save = async (next: CommitMessageSettings) => {
    setBusy(true)
    try {
      const value = await setCommitMessageSettings(next)
      setSaved(value); setDraft(value); setError(null); setNotice(value.provider === null ? 'Commit message model cleared.' : 'Saved.')
    } catch (cause) { setError(String(cause)); setNotice(null) } finally { setBusy(false) }
  }

  return <section className="flex max-w-xl flex-col gap-4" aria-label="Commit message">
    <p className="m-0 text-sm text-fg-muted">
      The Git panel&apos;s Generate Commit Message button writes the message with this model, from your staged changes. Not configured uses the &quot;fast&quot; model alias.
    </p>
    <Field label="Provider"><Select label="Commit message provider" value={draft.provider ?? ''} onChange={(value) => { setNotice(null); setDraft({ provider: value === '' ? null : value, model: null }) }} options={[{ value: '', label: 'Not configured' }, ...providers.map((entry) => ({ value: entry.id, label: `${entry.name}${entry.enabled ? '' : ' (disabled)'}`, disabled: !entry.enabled }))]} /></Field>
    {draft.provider !== null ? <Field label="Model" hint={provider !== undefined && provider.models.length === 0 ? 'Enter a concrete model ID.' : undefined}>{provider !== undefined && provider.models.length === 0
      ? <TextInput aria-label="Commit message model" value={draft.model ?? ''} placeholder="e.g. gpt-4o-mini" spellCheck={false} onChange={(event) => { setNotice(null); setDraft({ ...draft, model: event.target.value === '' ? null : event.target.value }) }} />
      : <Select label="Commit message model" value={draft.model ?? ''} onChange={(value) => { setNotice(null); setDraft({ ...draft, model: value === '' ? null : value }) }} options={[{ value: '', label: 'Select model' }, ...(provider?.models ?? []).map((model) => ({ value: model, label: model }))]} />}</Field> : null}
    {error !== null ? <p role="alert" className="m-0 text-sm text-bad">{error}</p> : null}
    {notice !== null ? <p role="status" className="m-0 text-sm text-ok">{notice}</p> : null}
    <div className="flex gap-2">
      <Button disabled={busy || !dirty || (draft.provider !== null && (draft.model?.trim() ?? '') === '')} onClick={() => void save(draft.provider === null ? BLANK : { provider: draft.provider, model: draft.model?.trim() ?? null })}>Save</Button>
      {dirty ? <Button disabled={busy} onClick={() => { setDraft(saved); setNotice(null) }}>Discard</Button> : null}
    </div>
  </section>
}
