import { useEffect, useRef } from 'react'
import Icon from '../common/Icon.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { fileStyle } from '../../lib/file-icons.ts'
import { cn } from '../../lib/cn.ts'
import type { CompletionItem, CompletionKind } from '../../lib/composer-completion.ts'

/**
 * The `@` / `/` suggestion list, floating above the composer. Focus never
 * leaves the textarea: this is the listbox half of a combobox, so the
 * textarea owns the keyboard and points at the active row with
 * `aria-activedescendant`.
 */
export function CompletionPopover({ id, kind, items, activeIndex, loading, note, onPick, onActivate }: {
  readonly id: string
  readonly kind: CompletionKind
  readonly items: readonly CompletionItem[]
  readonly activeIndex: number
  readonly loading: boolean
  /** Shown instead of rows when there is nothing to list. */
  readonly note: string | null
  readonly onPick: (item: CompletionItem) => void
  readonly onActivate: (index: number) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(`${id}-option-${activeIndex}`)}`)
    active?.scrollIntoView({ block: 'nearest' })
  }, [id, activeIndex, items.length])

  return (
    <div
      ref={listRef}
      id={id}
      role="listbox"
      aria-label={kind === 'file' ? 'Project files' : 'Workspace skills'}
      className="absolute bottom-full left-0 right-0 z-30 mb-2 max-h-72 overflow-y-auto rounded-2xl border border-line bg-surface p-1.5 shadow-pop animate-fade-up"
    >
      {items.map((item, index) => {
        const icon = kind === 'file' ? fileStyle(item.label) : null
        return (
          <button
            key={item.id}
            id={`${id}-option-${index}`}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            // Picking must not blur the textarea, or the caret would be lost.
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => onActivate(index)}
            onClick={() => onPick(item)}
            className={cn(
              'flex w-full min-h-9 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm text-fg outline-none',
              index === activeIndex && 'bg-hover',
            )}
          >
            <Icon name={icon === null ? 'zap' : icon.name} size={15} className={cn('shrink-0', icon === null ? 'text-fg-muted' : icon.className)} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{item.label}</span>
              {item.detail !== undefined && item.detail !== '' ? <span className="truncate text-xs text-fg-faint">{item.detail}</span> : null}
            </span>
          </button>
        )
      })}
      {note !== null ? (
        <p className="m-0 flex items-center gap-2 px-2.5 py-2 text-xs text-fg-faint" role="status" aria-live="polite">
          {loading ? <Spinner size={12} /> : null}
          {note}
        </p>
      ) : null}
    </div>
  )
}
