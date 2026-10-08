import { useCallback, useEffect, useState } from 'react'
import { createModelAlias, deleteModelAlias, listModelAliases, updateModelAlias } from '../../lib/api.ts'
import type { ModelAliasInput, ModelAliasRow, ProviderSummary } from '../../lib/types.ts'
import { Button } from '../ui/Button.tsx'
import { Field } from '../ui/Field.tsx'
import { Select } from '../ui/Select.tsx'
import { TextInput } from '../ui/TextInput.tsx'
import { useUnsavedChanges } from './unsaved-changes.tsx'
import { expressibleThinkingLevel } from '../../lib/model-info.ts'

const EMPTY: ModelAliasInput = { name: '', provider: '', model: '', thinkingLevel: null }

export function ModelAliasesPanel({ providers }: { readonly providers: readonly ProviderSummary[] }) {
  const [rows, setRows] = useState<readonly ModelAliasRow[]>([])
  const [selected, setSelected] = useState<ModelAliasRow | null>(null)
  const [draft, setDraft] = useState<ModelAliasInput>(EMPTY)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async () => { setRows(await listModelAliases()) }, [])
  useEffect(() => { void refresh().catch((cause) => setError(String(cause))) }, [refresh])
  const dirty = JSON.stringify(draft) !== JSON.stringify(selected === null ? EMPTY : { name: selected.name, provider: selected.provider, model: selected.model, thinkingLevel: selected.thinkingLevel })
  const guardDiscard = useUnsavedChanges(dirty)
  const provider = providers.find((entry) => entry.id === draft.provider)
  const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].filter((level) => expressibleThinkingLevel(draft.model, level) === level)
  const changeModel = (model: string) => setDraft({ ...draft, model, thinkingLevel: draft.thinkingLevel !== null && expressibleThinkingLevel(model, draft.thinkingLevel) !== draft.thinkingLevel ? null : draft.thinkingLevel })
  const nameError = draft.name.trim() === '' || /[\s:@\u0000-\u001f\u007f]/.test(draft.name.trim()) || draft.name.trim() === 'inherit'
    ? 'Use a non-empty name without whitespace, colon, @, controls, or “inherit”.' : null
  const save = async () => {
    if (nameError !== null) return
    try {
      const input = { ...draft, name: draft.name.trim() }
      const row = selected === null ? await createModelAlias(input) : await updateModelAlias(selected.name, { ...input, expectedRevision: selected.revision })
      setSelected(row); setDraft(input); setError(null); await refresh()
    } catch (cause) { setError(String(cause)) }
  }
  const choose = (row: ModelAliasRow) => guardDiscard(() => { setSelected(row); setDraft({ name: row.name, provider: row.provider, model: row.model, thinkingLevel: row.thinkingLevel }); setError(null) })
  const startNew = () => guardDiscard(() => { setSelected(null); setDraft(EMPTY); setError(null) })
  return <div className="flex min-h-0 flex-1 gap-4 p-5">
    <section aria-label="Model aliases" className="w-64 shrink-0">
      <div className="mb-3 flex items-center justify-between"><h2 className="m-0 text-base">Model aliases</h2><Button onClick={startNew}>New</Button></div>
      <ul className="m-0 list-none space-y-1 p-0">{rows.map((row) => <li key={row.name}><button type="button" onClick={() => choose(row)} className="w-full rounded-md px-2 py-2 text-left hover:bg-hover"><strong>{row.name}</strong><span className={`block text-xs ${row.status === 'invalid' ? 'text-bad' : 'text-fg-muted'}`}>{row.provider}:{row.model}{row.status === 'invalid' ? ' · unusable' : ''}</span></button></li>)}</ul>
    </section>
    <section className="min-w-0 flex-1 space-y-4" aria-label="Model alias editor">
      <p className="m-0 text-sm text-fg-muted">Aliases are global. Rename or deletion does not update role files; old names return to normal model resolution.</p>
      <Field label="Alias name" hint={nameError ?? undefined} tone={nameError === null ? 'default' : 'bad'}><TextInput aria-label="Alias name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field>
      <Field label="Provider"><Select label="Alias provider" value={draft.provider} onChange={(value) => setDraft({ ...draft, provider: value, model: '', thinkingLevel: null })} options={[{ value: '', label: 'Select provider' }, ...providers.map((entry) => ({ value: entry.id, label: `${entry.name}${entry.enabled ? '' : ' (disabled)'}`, disabled: !entry.enabled }))]} /></Field>
      <Field label="Model">{provider !== undefined && provider.models.length === 0
        ? <TextInput aria-label="Alias model" value={draft.model} onChange={(event) => changeModel(event.target.value)} placeholder="Concrete model ID" />
        : <Select label="Alias model" value={draft.model} onChange={changeModel} options={[{ value: '', label: 'Select model' }, ...(provider?.models ?? []).map((model) => ({ value: model, label: model }))]} />}</Field>
      <Field label="Thinking"><Select label="Alias thinking" value={draft.thinkingLevel ?? ''} onChange={(value) => setDraft({ ...draft, thinkingLevel: value === '' ? null : value })} options={[{ value: '', label: 'Model default' }, ...thinkingLevels.map((level) => ({ value: level, label: level }))]} /></Field>
      <p className="text-sm text-fg-muted">Target: {draft.provider && draft.model ? `${draft.provider}:${draft.model} · ${draft.thinkingLevel ?? 'model default'}` : 'Select a provider and model'}</p>
      {selected?.status === 'invalid' ? <p role="alert" className="text-sm text-bad">Unusable: {selected.message}. Repair the target or delete this alias.</p> : null}
      {selected?.warnings.map((warning) => <p key={warning} className="text-sm text-warn">Warning: {warning}</p>)}
      {error !== null ? <p role="alert" className="text-sm text-bad">{error}</p> : null}
      <div className="flex gap-2"><Button disabled={nameError !== null || draft.provider === '' || draft.model === ''} onClick={() => void save()}>Save alias</Button>{selected !== null ? <Button onClick={() => guardDiscard(() => { void deleteModelAlias(selected.name, selected.revision).then(() => { setSelected(null); setDraft(EMPTY); return refresh() }).catch((cause) => setError(String(cause))) })}>Delete alias</Button> : null}</div>
    </section>
  </div>
}
