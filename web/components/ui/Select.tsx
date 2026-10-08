import * as Popover from '@radix-ui/react-popover'
import { cloneElement, isValidElement, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode } from 'react'
import Icon from '../common/Icon.tsx'
import { cn } from '../../lib/cn.ts'

export interface SelectOption { readonly value: string; readonly label: string; readonly provider?: string; readonly disabled?: boolean }

function cloneTrigger(element: ReactElement, id: string | undefined, ariaDescribedBy: string | undefined): ReactElement {
  return cloneElement(element as ReactElement<{ id?: string; 'aria-describedby'?: string }>, {
    ...(id !== undefined ? { id } : {}),
    ...(ariaDescribedBy !== undefined ? { 'aria-describedby': ariaDescribedBy } : {}),
  })
}

/** Searchable controlled selection surface; Radix owns portal, dismissal, and focus restoration. */
export function Select({ value, options, onChange, disabled = false, label, triggerClassName, renderTrigger, id: triggerId, 'aria-describedby': ariaDescribedBy }: {
  readonly value: string
  readonly options: readonly SelectOption[]
  readonly onChange: (value: string) => void
  readonly disabled?: boolean
  readonly label?: string
  readonly triggerClassName?: string
  readonly renderTrigger?: (current: SelectOption | undefined, open: boolean) => ReactNode
  readonly id?: string
  readonly 'aria-describedby'?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const id = useId()
  const current = options.find((option) => option.value === value)
  const visible = options.filter((option) => option.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  const searchable = options.length > 8

  const pick = (index: number): void => {
    const option = visible[index]
    if (option === undefined || option.disabled === true) return
    onChange(option.value)
    setOpen(false)
    triggerRef.current?.focus()
  }
  const onKeyDown = (event: ReactKeyboardEvent): void => {
    if (!open) {
      if (!disabled && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); setOpen(true) }
      return
    }
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
    else if (event.key === 'ArrowDown') { event.preventDefault(); setActive((n) => Math.min(n + 1, visible.length - 1)) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((n) => Math.max(n - 1, 0)) }
    else if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); pick(active) }
  }

  const rendered = renderTrigger?.(current, open)
  const trigger = renderTrigger !== undefined && isValidElement(rendered)
    ? cloneTrigger(rendered as ReactElement, triggerId, ariaDescribedBy)
    : (
        <button
          type="button"
          ref={triggerRef}
          id={triggerId}
          disabled={disabled}
          aria-label={label}
          aria-describedby={ariaDescribedBy}
          aria-haspopup="listbox"
          title={current?.label ?? value}
          className={cn('flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-line bg-surface px-3 text-left text-sm hover:bg-hover disabled:opacity-50', triggerClassName)}
        >
          <span className="truncate">{current?.label ?? value}</span>
          <Icon name="chevron" size={14} className={cn('text-fg-faint transition-transform', open && 'rotate-180')} />
        </button>
      )

  return (
    <Popover.Root open={open} onOpenChange={(next) => { setOpen(next); if (next) { setQuery(''); setActive(Math.max(0, options.findIndex((option) => option.value === value))) } }}>
      <div className="min-w-0" onKeyDown={onKeyDown}>
        <Popover.Trigger asChild>{trigger}</Popover.Trigger>
        <Popover.Portal>
          <Popover.Content sideOffset={6} collisionPadding={12} align="start" className="z-50 max-h-[min(360px,60vh)] w-[max(var(--radix-popover-trigger-width),14rem)] max-w-[calc(100vw-24px)] overflow-y-auto rounded-2xl border border-line bg-surface p-1.5 shadow-pop outline-none">
            {searchable ? (
              <input
                className="select-search mb-1 h-9 w-full rounded-lg bg-muted px-3 text-sm outline-none"
                value={query}
                placeholder="Search…"
                role="combobox"
                aria-expanded
                aria-label={`Search ${label ?? 'options'}`}
                aria-controls={id}
                onChange={(event) => { setQuery(event.target.value); setActive(0) }}
              />
            ) : null}
            <ul id={id} role="listbox" aria-label={label} className="m-0 list-none p-0">
              {visible.map((option, index) => (
                <li key={option.value} role="presentation">
                  {option.provider !== undefined && option.provider !== visible[index - 1]?.provider
                    ? <div className="px-2.5 pb-1 pt-2 text-xs font-medium text-fg-faint">{option.provider}</div>
                    : null}
                  <button
                    type="button"
                    role="option"
                    tabIndex={-1}
                    disabled={option.disabled === true}
                    aria-selected={option.value === value}
                    aria-disabled={option.disabled === true}
                    className={cn('flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50', index === active && option.disabled !== true && 'bg-hover')}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => pick(index)}
                  >
                    <span className="min-w-0 break-words">{option.label}</span>
                    {option.value === value ? <Icon name="check" size={14} /> : null}
                  </button>
                </li>
              ))}
            </ul>
            {visible.length === 0 ? <p className="m-0 px-2.5 py-2 text-sm text-fg-faint" role="status">No results</p> : null}
          </Popover.Content>
        </Popover.Portal>
      </div>
    </Popover.Root>
  )
}
