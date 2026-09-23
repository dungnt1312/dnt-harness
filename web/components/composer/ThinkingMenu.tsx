import Icon from '../common/Icon.tsx'
import { Menu, menuItemClass } from '../ui/Menu.tsx'
import { composerChipClass } from './composer-chip.ts'
import { THINKING_LABELS, defaultThinkingLevel, effectiveThinking, getReasoningCapability } from '../../lib/model-info.ts'
import type { ModelSettings } from '../../lib/types.ts'

/**
 * Live thinking-level control. Rows: `Model default` (clears the override)
 * plus the levels the model documents — `Off` only when the provider can
 * really disable thinking. The chip shows the level the next request carries.
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

  const rows: readonly { readonly level: string | null; readonly label: string }[] = [
    { level: null, label: 'Model default' },
    ...(capability.canDisable ? [{ level: 'off', label: 'Off' }] : []),
    ...capability.levels.map((level) => ({ level: level as string, label: THINKING_LABELS[level] })),
  ]
  const shown = effective.fromOverride ? THINKING_LABELS[effective.level] : THINKING_LABELS[defaultThinkingLevel(capability)]

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
            const active = row.level === null ? value === null : value === row.level
            return (
              <button
                key={row.level ?? 'default'}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                className={menuItemClass}
                onClick={() => { onSelect(row.level); close() }}
              >
                <span className="flex-1">{row.label}</span>
                {active ? <Icon name="check" size={15} /> : null}
              </button>
            )
          })}
        </>
      )}
    </Menu>
  )
}
