import Icon from '../common/Icon.tsx'
import { Menu, menuItemClass } from '../ui/Menu.tsx'
import { composerChipClass } from './composer-chip.ts'
import { THINKING_LABELS, effectiveThinking, getReasoningCapability } from '../../lib/model-info.ts'
import type { ModelSettings } from '../../lib/types.ts'

/**
 * Live thinking-level control. Rows: `Model default` (clears the override)
 * plus the levels the model documents — `Off` only when the provider can
 * really disable thinking. The chip shows the level the next request carries,
 * which is also the row marked chosen: a saved level this model does not
 * document is reported as ignored rather than shown as if it applied.
 */
export function ThinkingMenu({ menuLabel = 'Default thinking level for new conversations', disabled = false, model, value, settings, onSelect }: {
  /** Accessible control label identifies conversation scope or global default. */
  readonly menuLabel?: string
  readonly disabled?: boolean
  readonly model: string | null
  /** Workspace override; null = the model's configured default. */
  readonly value: string | null
  readonly settings?: ModelSettings
  readonly onSelect: (level: string | null) => void
}) {
  if (model === null) return null
  const capability = getReasoningCapability(model)
  const effective = effectiveThinking(model, value, settings)
  if (capability === null || effective === null) {
    return (
      <button type="button" className={composerChipClass} disabled aria-label="No reasoning capability for this model" title="No reasoning capability for this model">
        <Icon name="lightbulb" size={15} />
        <span className="max-sm:sr-only">Thinking</span>
      </button>
    )
  }

  const ignored = effective.ignoredOverride
  const rows: readonly { readonly level: string | null; readonly label: string; readonly note?: string }[] = [
    {
      level: null,
      label: 'Model default',
      // The saved level is kept in the log but cannot ride this model's
      // request, so the row that governs says so instead of the panel
      // showing Max as if it applied.
      ...(ignored !== undefined
        ? { note: `Saved ${THINKING_LABELS[ignored]} is not available on this model; it returns on one that offers it.` }
        : {}),
    },
    ...(capability.canDisable ? [{ level: 'off', label: 'Off' }] : []),
    ...capability.levels.map((level) => ({ level: level as string, label: THINKING_LABELS[level] })),
  ]
  const shown = THINKING_LABELS[effective.level]

  return (
    <Menu
      label={menuLabel}
      disabled={disabled}
      side="top"
      // Never the chip that gives: the level is two words at most, while the
      // model name beside it is what should truncate when the row is tight.
      triggerClassName={`${composerChipClass} shrink-0`}
      trigger={() => (
        <>
          <Icon name="lightbulb" size={15} />
          <span className="truncate">{shown}</span>
          <Icon name="chevron" size={13} />
        </>
      )}
    >
      {(close) => (
        <>
          <div className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-fg-faint">Thinking</div>
          {rows.map((row) => {
            const active = row.level === null ? !effective.fromOverride : effective.fromOverride && row.level === effective.level
            return (
              <button
                key={row.level ?? 'default'}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                className={menuItemClass}
                onClick={() => { onSelect(row.level); close() }}
              >
                {row.note === undefined ? (
                  <span className="flex-1">{row.label}</span>
                ) : (
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span>{row.label}</span>
                    <span className="text-xs leading-5 text-fg-faint">{row.note}</span>
                  </span>
                )}
                {active ? <Icon name="check" size={15} className="shrink-0" /> : null}
              </button>
            )
          })}
        </>
      )}
    </Menu>
  )
}
