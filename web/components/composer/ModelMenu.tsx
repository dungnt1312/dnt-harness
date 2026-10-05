import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import Icon from '../common/Icon.tsx'
import { Menu } from '../ui/Menu.tsx'
import { capabilityBadges } from '../../lib/model-info.ts'
import { decodeModelChoice, type ModelOption } from '../../lib/providers.ts'
import { cn } from '../../lib/cn.ts'
import type { ModelSettings, ProviderSummary } from '../../lib/types.ts'
import { composerChipClass } from './composer-chip.ts'

/**
 * Composer model picker: search over a provider column and the previewed
 * provider's models, with a Manage models footer. Selecting a row writes the
 * exact provider/model pair for the selected scope's next request.
 */
export function ModelMenu({ menuLabel, disabled = false, modelLabel, modelValue, options, providers, modelSettings, onModel, onManage }: {
  /** Accessible control label identifies conversation scope or global default. */
  readonly menuLabel: string
  readonly disabled?: boolean
  readonly modelLabel: string
  readonly modelValue: string | null
  readonly options: readonly ModelOption[]
  readonly providers: readonly ProviderSummary[]
  readonly modelSettings?: Readonly<Record<string, ModelSettings>>
  readonly onModel: (value: string) => void
  readonly onManage: () => void
}) {
  const boundary = modelValue !== null ? modelValue.indexOf(':') : -1
  const activeProvider = modelValue !== null && boundary > 0 ? modelValue.slice(0, boundary) : null
  const byProvider = new Map<string, ModelOption[]>()
  for (const option of options) {
    const list = byProvider.get(option.provider) ?? []
    list.push(option)
    byProvider.set(option.provider, list)
  }
  const enabled = providers.filter((provider) => provider.enabled)
  const activeModelId = activeProvider !== null ? decodeModelChoice(modelValue ?? '')?.model ?? null : null
  const slash = modelLabel.indexOf('/')
  const providerName = slash > 0 ? modelLabel.slice(0, slash) : null
  const modelName = slash > 0 ? modelLabel.slice(slash + 1) : modelLabel

  return (
    <Menu
      label={menuLabel}
      disabled={disabled}
      panelRole="dialog"
      side="top"
      align="end"
      compact
      panelClassName="w-[min(560px,calc(100vw-24px))] p-0"
      // The one chip that gives way when the row is tight — but never to
      // nothing: a model chip with no name tells the reader less than a
      // truncated one. On a phone the whole row is icon-only, so the chip
      // collapses to the cpu glyph and the full name lives in the tooltip.
      triggerClassName={`${composerChipClass} min-w-[5.5rem] [@media(pointer:coarse)]:min-w-9`}
      trigger={(open) => (
        <>
          <Icon name="cpu" size={16} className="@min-[30rem]:hidden" />
          <span className="truncate @max-[30rem]:hidden" title={providerName !== null ? `${providerName} / ${modelName}` : modelName}>{modelName}</span>
          <Icon name="chevron" size={13} className={cn('shrink-0 transition-transform @max-[30rem]:hidden', open && 'rotate-180')} />
        </>
      )}
    >
      {(close) => (
        <PickerPanel
          enabled={enabled}
          byProvider={byProvider}
          activeProvider={activeProvider}
          activeModelId={activeModelId}
          modelSettings={modelSettings ?? {}}
          onModel={(value) => { onModel(value); close() }}
          onManage={() => { close(); onManage() }}
        />
      )}
    </Menu>
  )
}

/** Mounted only while open, so search and preview reset on every open. */
function PickerPanel({ enabled, byProvider, activeProvider, activeModelId, modelSettings, onModel, onManage }: {
  readonly enabled: readonly ProviderSummary[]
  readonly byProvider: ReadonlyMap<string, readonly ModelOption[]>
  readonly activeProvider: string | null
  readonly activeModelId: string | null
  readonly modelSettings: Readonly<Record<string, ModelSettings>>
  readonly onModel: (value: string) => void
  readonly onManage: () => void
}) {
  const [query, setQuery] = useState('')
  const [previewId, setPreviewId] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const activeRowRef = useRef<HTMLButtonElement | null>(null)
  const activeProviderRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => { searchRef.current?.focus() }, [])
  // Opening on the active provider's column is only half of it: without a
  // scroll, forty models bury the checked row below the fold and the reader
  // cannot tell which model is live. `nearest` leaves an already-visible row
  // where it is.
  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: 'nearest' })
    activeProviderRef.current?.scrollIntoView({ block: 'nearest' })
  }, [])

  const q = query.trim().toLowerCase()
  const matches = (option: ModelOption): boolean => q === '' || option.model.toLowerCase().includes(q) || option.label.toLowerCase().includes(q)
  const visible = enabled.filter((provider) => q === '' || (byProvider.get(provider.id) ?? []).some(matches))
  const preview = visible.find((provider) => provider.id === previewId)
    ?? visible.find((provider) => provider.id === activeProvider)
    ?? visible[0]
    ?? null
  const previewOptions = preview !== null ? (byProvider.get(preview.id) ?? []).filter(matches) : []

  const onProviderKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (visible.length === 0 || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return
    event.preventDefault()
    const index = visible.findIndex((provider) => provider.id === preview?.id)
    const next = visible[(index + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length]
    if (next !== undefined) setPreviewId(next.id)
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3">
        <Icon name="search" size={15} className="text-fg-faint" />
        <input
          ref={searchRef}
          type="search"
          value={query}
          placeholder="Search models…"
          aria-label="Search models"
          autoComplete="off"
          spellCheck={false}
          className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query !== '') { event.preventDefault(); event.stopPropagation(); setQuery('') }
          }}
        />
      </div>
      <div className="flex h-[min(360px,55dvh)] min-h-0">
        <div className="w-[38%] max-w-44 shrink-0 overflow-y-auto border-r border-line p-1.5" role="listbox" aria-label="Providers" tabIndex={-1} onKeyDown={onProviderKey}>
          {enabled.length === 0 ? <p className="m-0 p-2 text-[13px] text-fg-faint">No providers</p>
            : visible.length === 0 ? <p className="m-0 p-2 text-[13px] text-fg-faint">No matches</p>
              : visible.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  role="option"
                  aria-selected={provider.id === preview?.id}
                  ref={provider.id === activeProvider ? activeProviderRef : undefined}
                  title={provider.name}
                  onMouseEnter={() => setPreviewId(provider.id)}
                  onFocus={() => setPreviewId(provider.id)}
                  onClick={() => setPreviewId(provider.id)}
                  className={cn('flex w-full items-center gap-1.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-fg-muted hover:text-fg', provider.id === preview?.id && 'bg-hover text-fg')}
                >
                  <span className="min-w-0 flex-1 truncate">{provider.name}</span>
                  {provider.id === activeProvider ? <span className="size-1.5 shrink-0 rounded-full bg-fg" aria-label="Active provider" /> : null}
                </button>
              ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5" role="listbox" aria-label="Models">
            {preview === null ? (
              <p className="m-0 p-2 text-[13px] text-fg-faint">{q !== '' ? 'No matching models' : 'No provider selected'}</p>
            ) : previewOptions.length === 0 ? (
              <p className="m-0 p-2 text-[13px] text-fg-faint">{q !== '' ? 'No matching models' : 'No models — sync in Settings'}</p>
            ) : previewOptions.map((option) => {
              const active = option.provider === activeProvider && option.model === activeModelId
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={active}
                  ref={active ? activeRowRef : undefined}
                  title={option.model}
                  onClick={() => onModel(option.value)}
                  className={cn('flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-hover', active && 'bg-hover')}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="break-all text-sm">{option.model}</span>
                    <span className="flex flex-wrap gap-1">
                      {capabilityBadges(option.model, modelSettings[option.model]).map((badge) => (
                        <span key={badge.label} className="rounded bg-muted px-1.5 text-[11px] text-fg-muted">{badge.label}</span>
                      ))}
                    </span>
                  </span>
                  {active ? <Icon name="check" size={16} className="shrink-0" /> : null}
                </button>
              )
            })}
          </div>
          <button type="button" role="menuitem" onClick={onManage} className="flex items-center gap-2 border-t border-line px-4 py-2.5 text-left text-[13px] text-fg-muted hover:bg-hover hover:text-fg">
            <Icon name="sliders" size={14} />
            Manage models
          </button>
        </div>
      </div>
    </div>
  )
}
