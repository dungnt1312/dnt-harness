import { useMemo, useState } from 'react'
import Icon from '../common/Icon.tsx'
import { Badge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import { Field } from '../ui/Field.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { Modal } from '../ui/Modal.tsx'
import { Select } from '../ui/Select.tsx'
import { TextInput } from '../ui/TextInput.tsx'
import {
  THINKING_LABELS,
  getModelInfo,
  getReasoningCapability,
  modelContext,
} from '../../lib/model-info.ts'
import type { ModelSettings } from '../../lib/types.ts'

/** Drop fields left at their catalog default so "unset" never persists as data. */
function pruneModelSettings(entry: ModelSettings): ModelSettings {
  return {
    ...(entry.contextTokens !== undefined && entry.contextTokens > 0 ? { contextTokens: entry.contextTokens } : {}),
    ...(entry.vision !== undefined ? { vision: entry.vision } : {}),
    ...(entry.thinkingLevel !== undefined && entry.thinkingLevel in THINKING_LABELS ? { thinkingLevel: entry.thinkingLevel } : {}),
  }
}

/**
 * One model's id and overrides, edited in a dialog rather than an inline
 * expander: the row list stays scannable at forty models, and an override is
 * committed or abandoned as one decision.
 *
 * Every field defaults to the catalog value, which the label states — an
 * explicit value here is the operator saying the catalog is wrong.
 */
export function ModelSettingsDialog({ model, settings, takenIds, onCancel, onSave }: {
  readonly model: string
  readonly settings?: ModelSettings | undefined
  /** The other model ids on this provider; a rename cannot collide with them. */
  readonly takenIds: readonly string[]
  readonly onCancel: () => void
  readonly onSave: (id: string, settings: ModelSettings) => void
}) {
  const [id, setId] = useState(model)
  const [contextRaw, setContextRaw] = useState(settings?.contextTokens === undefined ? '' : String(settings.contextTokens))
  const [vision, setVision] = useState(settings?.vision === undefined ? 'auto' : settings.vision ? 'yes' : 'no')
  const [thinking, setThinking] = useState(settings?.thinkingLevel ?? '')

  const catalog = modelContext(model)
  const capability = getReasoningCapability(model)
  const catalogVision = getModelInfo(model)?.vision
  const trimmedId = id.trim()
  const contextDigits = contextRaw.trim().replace(/[\s,_.]/g, '')
  const contextInvalid = contextDigits !== '' && !/^[1-9]\d*$/.test(contextDigits)
  const idError = trimmedId === ''
    ? 'A model needs an id.'
    : trimmedId !== model && takenIds.includes(trimmedId)
      ? `“${trimmedId}” is already on this provider.`
      : null

  const save = (): void => {
    if (idError !== null || contextInvalid) return
    onSave(trimmedId, pruneModelSettings({
      ...(contextDigits !== '' ? { contextTokens: Number.parseInt(contextDigits, 10) } : {}),
      ...(vision === 'auto' ? {} : { vision: vision === 'yes' }),
      ...(thinking === '' ? {} : { thinkingLevel: thinking }),
    }))
  }

  return (
    <Modal
      open
      onDismiss={onCancel}
      label="Edit model settings"
      width="md"
      header={(
        <>
          <span className="text-[15px] font-semibold">Edit model settings</span>
          <IconButton label="Close model settings" onClick={onCancel}><Icon name="close" size={16} /></IconButton>
        </>
      )}
    >
      <div className="flex flex-col gap-4">
        <Field label="Model ID" tone={idError === null ? 'default' : 'bad'} hint={idError ?? undefined}>
          <TextInput mono invalid={idError !== null} value={id} onChange={(event) => setId(event.target.value)} />
        </Field>

        <Field
          label={`Context window · default ${catalog.tokens.toLocaleString()}`}
          tone={contextInvalid ? 'bad' : 'default'}
          hint={contextInvalid ? 'Whole number of tokens, or empty for the default.' : undefined}
        >
          <TextInput
            mono
            inputMode="numeric"
            invalid={contextInvalid}
            value={contextRaw}
            placeholder={catalog.tokens.toLocaleString()}
            onChange={(event) => setContextRaw(event.target.value)}
          />
        </Field>

        {/* Types, not a dropdown: text is what every model takes, so it is
            shown locked, and image is the one input worth an override. */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-fg">Input types</span>
          <div role="group" aria-label="Input types" className="flex flex-wrap items-center gap-2">
            <span
              className="flex items-center gap-1.5 rounded-lg border border-line bg-muted px-2.5 py-1.5 text-[13px] text-fg-muted"
              title="Every model accepts text."
            >
              <input type="checkbox" checked disabled aria-label="Text input (always accepted)" className="size-3.5 accent-primary" />
              Text
              <Icon name="lock" size={12} aria-hidden="true" />
            </span>
            <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[13px] hover:bg-hover">
              <input
                type="checkbox"
                className="size-3.5 accent-primary"
                checked={vision === 'auto' ? catalogVision === true : vision === 'yes'}
                onChange={(event) => setVision(event.target.checked ? 'yes' : 'no')}
              />
              Image
            </label>
          </div>
          {vision === 'auto' ? null : (
            <button
              type="button"
              className="self-start text-xs text-fg-muted underline-offset-2 hover:underline"
              onClick={() => setVision('auto')}
            >
              Use the default ({catalogVision === true ? 'accepts images' : catalogVision === false ? 'text only' : 'unknown'})
            </button>
          )}
        </div>

        {capability !== null ? (
          <Field label="Thinking default">
            <Select
              label={`Default thinking level for ${model}`}
              value={thinking}
              options={[
                { value: '', label: 'Model default' },
                ...(capability.canDisable ? [{ value: 'off', label: 'Off' }] : []),
                ...capability.levels.map((level) => ({ value: level as string, label: THINKING_LABELS[level] })),
              ]}
              onChange={setThinking}
            />
          </Field>
        ) : null}

        <div className="flex items-center justify-end gap-2 border-t border-line pt-4">
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" size="sm" disabled={idError !== null || contextInvalid} onClick={save}>Save</Button>
        </div>
      </div>
    </Modal>
  )
}

/**
 * Choose what a sync actually keeps. The endpoint's list is a proposal, not a
 * command: checked models stay, unchecking a synced one removes it, and models
 * this endpoint does not offer are never touched — which is what protects a
 * hand-added id from a provider that has never heard of it.
 */
export function SyncModelsDialog({ providerName, available, current, onCancel, onConfirm }: {
  readonly providerName: string
  /** Exactly what the endpoint answered, in its own order. */
  readonly available: readonly string[]
  /** The list being edited, so already-kept models start checked. */
  readonly current: readonly string[]
  readonly onCancel: () => void
  readonly onConfirm: (models: readonly string[]) => void
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(available.filter((model) => current.includes(model))),
  )
  const [query, setQuery] = useState('')

  const untouched = useMemo(() => current.filter((model) => !available.includes(model)), [current, available])
  const fresh = useMemo(() => available.filter((model) => !current.includes(model)), [available, current])
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle === '' ? available : available.filter((model) => model.toLowerCase().includes(needle))
  }, [available, query])

  const toggle = (model: string): void => setSelected((previous) => {
    const next = new Set(previous)
    if (!next.delete(model)) next.add(model)
    return next
  })

  /** Existing order first, then whatever this sync adds. */
  const confirm = (): void => onConfirm([
    ...current.filter((model) => !available.includes(model) || selected.has(model)),
    ...available.filter((model) => selected.has(model) && !current.includes(model)),
  ])

  return (
    <Modal
      open
      onDismiss={onCancel}
      label={`Sync models — ${providerName}`}
      width="md"
      header={(
        <>
          <span className="text-[15px] font-semibold">Sync models — {providerName}</span>
          <IconButton label="Close model sync" onClick={onCancel}><Icon name="close" size={16} /></IconButton>
        </>
      )}
      bodyClassName="flex flex-col gap-3"
    >
      <p className="m-0 text-[13px] text-fg-muted">
        {available.length} {available.length === 1 ? 'model' : 'models'} offered by this endpoint
        {fresh.length > 0 ? ` (${fresh.length} new)` : ''}. Only checked models are kept; unchecking one removes it.
        {untouched.length > 0
          ? untouched.length === 1
            ? ' 1 model not offered here stays as it is.'
            : ` ${untouched.length} models not offered here stay as they are.`
          : ''}
      </p>

      <TextInput
        value={query}
        placeholder="Search models…"
        aria-label="Search offered models"
        leading={<Icon name="search" size={15} />}
        onChange={(event) => setQuery(event.target.value)}
      />

      <ul className="m-0 flex max-h-[min(50dvh,22rem)] list-none flex-col divide-y divide-line overflow-y-auto rounded-xl border border-line p-0">
        {visible.length === 0 ? (
          <li className="px-3 py-2.5 text-[13px] text-fg-muted">No offered model matches “{query.trim()}”.</li>
        ) : visible.map((model) => (
          <li key={model}>
            <label className="flex cursor-pointer items-center gap-2.5 px-3 py-2.5 hover:bg-hover">
              <input
                type="checkbox"
                className="size-4 shrink-0 accent-primary"
                checked={selected.has(model)}
                onChange={() => toggle(model)}
              />
              <code className="min-w-0 flex-1 break-all font-mono text-[13px]">{model}</code>
              {current.includes(model) ? null : <Badge tone="blue">new</Badge>}
            </label>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
        <span className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set(available))}>Select all</Button>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>Clear</Button>
        </span>
        <span className="flex items-center gap-2">
          <span className="text-xs text-fg-faint">{selected.size} selected</span>
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={confirm}>
            {selected.size === 1 ? 'Sync 1 model' : `Sync ${selected.size} models`}
          </Button>
        </span>
      </div>
    </Modal>
  )
}
