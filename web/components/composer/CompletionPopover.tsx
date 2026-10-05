import { useEffect, useRef } from 'react'
import Icon from '../common/Icon.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { FileTypeIcon } from '../common/FileTypeIcon.tsx'
import { CHIP_ICON_CLASS, CHIP_ICON_SIZE } from '../common/InlineChip.tsx'
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

  // The `$` menu is skill-only, so it reads under the same catalog caption as
  // the tail of the `/` menu — but without the commands head, always.
  const skillsCaption = kind === 'skillDollar' || items.some((item) => !item.id.startsWith('command:'))

  return (
    <div
      ref={listRef}
      id={id}
      role="listbox"
      aria-label={kind === 'file' ? 'Project files' : 'Skills'}
      className="absolute bottom-full left-0 right-0 z-30 mb-2 max-h-72 overflow-y-auto rounded-2xl border border-line bg-surface p-1.5 shadow-pop animate-fade-up"
    >
      {items.map((item, index) => {
        // Built-in commands open the list unheadered; the catalog reads under
        // its own caption, exactly once, before its first row.
        const isCommand = item.id.startsWith('command:')
        const header = !isCommand && skillsCaption && index === items.findIndex((entry) => !entry.id.startsWith('command:')) ? (
          <div className="px-2.5 pb-0.5 pt-1.5 text-[11px] font-medium uppercase tracking-wider text-fg-faint">Skills</div>
        ) : null
        return (
          <div key={item.id}>
            {header}
            <button
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
              {kind === 'file'
                ? <FileTypeIcon path={item.label} size={16} />
                : isCommand
                  ? null
                  : <Icon name="zap" size={CHIP_ICON_SIZE} className={CHIP_ICON_CLASS.command} />}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{item.label}</span>
                {item.detail !== undefined && item.detail !== '' ? <span className="truncate text-xs text-fg-faint">{item.detail}</span> : null}
              </span>
            </button>
          </div>
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
