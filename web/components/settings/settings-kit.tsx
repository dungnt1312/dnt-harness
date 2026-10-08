import * as Collapsible from '@radix-ui/react-collapsible'
import * as RadixSwitch from '@radix-ui/react-switch'
import { forwardRef, useRef, type ReactNode, type TextareaHTMLAttributes } from 'react'
import { useScopedState } from '../../hooks/useScopedState.ts'
import Icon, { type IconName } from '../common/Icon.tsx'
import { Menu, menuItemClass } from '../ui/Menu.tsx'
import { ErrorNotice } from '../common/ErrorNotice.tsx'
import { Badge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import { cn } from '../../lib/cn.ts'

/**
 * Shared building blocks for the Settings panels, so every tab has the same
 * section headers, lists, notices, confirmations and busy handling.
 */

export type NoticeState = { readonly kind: 'ok' | 'bad' | 'info'; readonly text: string } | null

/** Inline result of the last action: success, failure (with raw details) or info. */
export function Notice({ kind, text }: { readonly kind: 'ok' | 'bad' | 'info'; readonly text: string }) {
  if (kind === 'bad') return <ErrorNotice raw={text} />
  return (
    <p role="status" className={cn('m-0 flex items-start gap-2 rounded-lg px-3 py-2 text-[13px]', kind === 'ok' ? 'bg-ok-soft text-ok' : 'bg-muted text-fg-muted')}>
      <Icon name={kind === 'ok' ? 'check' : 'info'} size={14} className="mt-0.5 shrink-0" />
      <span className="min-w-0">{text}</span>
    </p>
  )
}

/** One short muted paragraph that explains the tab, above its first section. */
export function PanelIntro({ children }: { readonly children: ReactNode }) {
  return <p className="m-0 max-w-3xl text-[13px] leading-5 text-fg-muted">{children}</p>
}

const ISOLATION_TEXT = 'MCP servers, subprocesses, and hooks run with host process privileges. Application controls are not an OS sandbox. Server writes are outside the application writer lease.'

/** Honest isolation statement shown wherever host-privileged execution exists. */
export function IsolationNote() {
  return (
    <p className="m-0 flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">
      <Icon name="alertTriangle" size={14} className="mt-0.5 shrink-0" />
      <span className="min-w-0">
        MCP servers, subprocesses, and hooks run with host process privileges. Application controls are
        <b> not an OS sandbox</b>. Server writes are outside the application writer lease.
      </span>
    </p>
  )
}

/**
 * The isolation warning as one always-visible line, with the full statement
 * one click away. The headline keeps the load-bearing claim — host privileges,
 * no OS sandbox — so collapsing detail never hides the risk itself, and unlike
 * a tooltip it stays readable without a pointer.
 */
export function IsolationSummary() {
  return (
    <Disclosure
      summary={
        <span className="flex items-center gap-1.5 text-warn">
          <Icon name="alertTriangle" size={13} className="shrink-0" />
          Runs with host privileges — not an OS sandbox
        </span>
      }
    >
      <p className="m-0 text-[13px] leading-5 text-fg-muted">{ISOLATION_TEXT}</p>
    </Disclosure>
  )
}

/**
 * A panel whose initial load failed: the error plus a way out. Without it a
 * failed fetch reads as "Loading…" forever and the operator has nothing to do.
 */
export function LoadFailed({ what, error, busy = false, onRetry }: {
  readonly what: string
  readonly error: string
  readonly busy?: boolean
  readonly onRetry: () => void
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2" role="alert">
      <span className="text-sm font-medium text-fg">Could not load {what}.</span>
      <ErrorNotice raw={error} />
      <Button variant="outline" size="sm" className="self-start" disabled={busy} onClick={onRetry}>
        <Icon name="refresh" size={14} />{busy ? 'Retrying…' : 'Retry'}
      </Button>
    </div>
  )
}

export function WorkspaceRequired() {
  return <Notice kind="info" text="Choose a workspace first." />
}

/** Titled block of a panel; `manage-section` is a stable hook for browser tests. */
export const Section = forwardRef<HTMLElement, {
  readonly title: ReactNode
  readonly count?: number
  readonly actions?: ReactNode
  readonly children: ReactNode
  readonly className?: string
}>(function Section({ title, count, actions, children, className }, ref) {
  return (
    <section ref={ref} className={cn('manage-section flex min-w-0 flex-col gap-3', className)}>
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-2">
        <h3 className="m-0 flex min-w-0 items-center gap-2 text-sm font-semibold">
          <span className="truncate">{title}</span>
          {count !== undefined ? <Badge>{count}</Badge> : null}
        </h3>
        {actions !== undefined ? <div className="flex flex-wrap items-center gap-1.5">{actions}</div> : null}
      </div>
      {children}
    </section>
  )
})

/**
 * Stack of panel sections. Full height so a `PanelFooter` rests on the bottom
 * edge even when the sections above it do not fill the dialog.
 */
export function PanelBody({ children }: { readonly children: ReactNode }) {
  return <div className="flex min-h-full min-w-0 flex-col gap-7">{children}</div>
}

/**
 * Result of the last action, pinned to the bottom of the scrolling panel.
 * A save or delete at the far end of a long tab confirms itself in place
 * instead of writing to a heading the operator has already scrolled past.
 */
export function PanelFooter({ notice, children }: { readonly notice?: NoticeState; readonly children?: ReactNode }) {
  if ((notice === null || notice === undefined) && children === undefined) return null
  return (
    <div className={footerShell}>
      {notice !== null && notice !== undefined ? <Notice kind={notice.kind} text={notice.text} /> : null}
      {children !== undefined ? <div className="flex flex-wrap items-center justify-end gap-2">{children}</div> : null}
    </div>
  )
}

/**
 * Flush to the dialog's bottom edge: the scroll pane pads `py-5`, so a plain
 * `bottom-0` footer floats 20px up with content showing through the gap.
 * `-bottom-5` + `-mb-5` cancel that padding; `-mx-5` spans the full width.
 */
const footerShell = 'sticky -bottom-5 z-10 -mx-5 -mb-5 mt-auto flex flex-col gap-2 border-t border-line bg-surface px-5 py-3 shadow-[0_-8px_16px_-12px_rgb(0_0_0/0.35)]'

/**
 * Standard save bar for a panel that edits one document: change state on the
 * left, Discard + Save on the right (primary last), and the last result above.
 * Every editing tab uses this, so Save sits in the same place everywhere.
 */
export function SaveBar({ dirty, busy, saving, onSave, onDiscard, saveLabel = 'Save changes', blocker, notice, extra }: {
  readonly dirty: boolean
  /** Any action running: disables both buttons. */
  readonly busy: boolean
  /** The save itself is running: label reads "Saving…". */
  readonly saving: boolean
  readonly onSave: () => void
  readonly onDiscard: () => void
  readonly saveLabel?: string
  /** Why saving is blocked even though there are changes; shown as text, not a tooltip. */
  readonly blocker?: string | null
  readonly notice?: NoticeState
  /** Secondary tools placed left of Discard (e.g. "Edit raw JSON"). */
  readonly extra?: ReactNode
}) {
  return (
    <div className={footerShell}>
      {notice !== null && notice !== undefined ? <Notice kind={notice.kind} text={notice.text} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn('flex min-w-0 flex-1 items-center gap-2 text-[13px]', dirty ? 'text-warn' : 'text-fg-faint')} role="status">
          <span className={cn('size-1.5 shrink-0 rounded-full', dirty ? 'bg-warn' : 'bg-line-strong')} aria-hidden="true" />
          <span className="truncate">{blocker !== null && blocker !== undefined && dirty ? blocker : dirty ? 'Unsaved changes' : 'All changes saved'}</span>
        </span>
        {extra}
        <Button variant="ghost" size="sm" disabled={busy || !dirty} onClick={onDiscard}>Discard</Button>
        <Button variant="primary" size="sm" disabled={busy || !dirty || (blocker !== null && blocker !== undefined)} onClick={onSave}>
          {saving ? 'Saving…' : saveLabel}
        </Button>
      </div>
    </div>
  )
}

/**
 * Second-level tabs inside a Settings tab (Permissions → Modes / Guard,
 * Skills → Skills / Source folders). One look and one keyboard model:
 * Left/Right/Home/End move between tabs, roving tabindex keeps Tab simple.
 */
export function SubTabs<V extends string>({ label, value, onChange, tabs }: {
  readonly label: string
  readonly value: V
  readonly onChange: (value: V) => void
  readonly tabs: readonly { readonly value: V; readonly label: string; readonly icon?: IconName; readonly count?: number }[]
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const go = (index: number): void => {
    const next = tabs[(index + tabs.length) % tabs.length]
    if (next === undefined) return
    onChange(next.value)
    refs.current[(index + tabs.length) % tabs.length]?.focus()
  }
  return (
    <div role="tablist" aria-label={label} className="flex w-fit shrink-0 items-center gap-1 rounded-xl border border-line bg-muted p-1">
      {tabs.map((tab, index) => {
        const active = tab.value === value
        return (
          <button
            key={tab.value}
            ref={(node) => { refs.current[index] = node }}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            data-state={active ? 'active' : 'inactive'}
            className="inline-flex h-7 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium text-fg-muted outline-none transition-colors hover:text-fg focus-visible:ring-2 focus-visible:ring-link data-[state=active]:bg-surface data-[state=active]:text-fg data-[state=active]:shadow-sm"
            onClick={() => onChange(tab.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight') { event.preventDefault(); go(index + 1) }
              else if (event.key === 'ArrowLeft') { event.preventDefault(); go(index - 1) }
              else if (event.key === 'Home') { event.preventDefault(); go(0) }
              else if (event.key === 'End') { event.preventDefault(); go(tabs.length - 1) }
            }}
          >
            {tab.icon !== undefined ? <Icon name={tab.icon} size={13} aria-hidden="true" /> : null}
            {tab.label}
            {tab.count !== undefined ? <span className="rounded-full bg-hover px-1.5 text-[11px] leading-4 text-fg-faint">{tab.count}</span> : null}
          </button>
        )
      })}
    </div>
  )
}

/** Compact labelled switch for list rows ("In picker", "Enabled"). */
export function InlineSwitch({ label, ariaLabel, checked, disabled = false, title, onChange }: {
  readonly label: string
  readonly ariaLabel: string
  readonly checked: boolean
  readonly disabled?: boolean
  /** Tooltip; use it to say why a switch is locked. */
  readonly title?: string
  readonly onChange: (next: boolean) => void
}) {
  return (
    <label title={title} className={cn('flex cursor-pointer items-center gap-2 text-[13px] text-fg-muted', disabled && 'cursor-default opacity-60')}>
      {label}
      <RadixSwitch.Root
        aria-label={ariaLabel}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-line-strong transition-colors data-[state=checked]:bg-primary"
      >
        <RadixSwitch.Thumb className="block size-4 translate-x-0.5 rounded-full bg-bg shadow transition-transform data-[state=checked]:translate-x-[18px]" />
      </RadixSwitch.Root>
    </label>
  )
}

/** "Changed on disk" banner with the two ways out; one look in every editor. */
export function ConflictBanner({ what = 'file', busy, onReload, onOverwrite }: {
  readonly what?: string
  readonly busy: boolean
  readonly onReload: () => void
  readonly onOverwrite: () => void
}) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">
      <Icon name="alertTriangle" size={14} className="shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 basis-48">The {what} changed on the server since you opened it.</span>
      <Button variant="outline" size="sm" disabled={busy} onClick={onReload}>Reload server version</Button>
      <Button variant="outline-danger" size="sm" disabled={busy} onClick={onOverwrite}>Overwrite anyway</Button>
    </div>
  )
}

/** Form submit row: actions right-aligned, primary last — same order as SaveBar. */
export function FormActions({ children }: { readonly children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">{children}</div>
}

/**
 * Collapsed-by-default block for settings most operators never change.
 * Keeping them out of the first screen is what makes the common path short,
 * so `defaultOpen` exists only for a draft that already sets one of them.
 */
export function Disclosure({ summary, count, defaultOpen = false, open: controlledOpen, onOpenChange, children }: {
  readonly summary: ReactNode
  readonly count?: number
  readonly defaultOpen?: boolean
  /** Controlled mode, for callers that must open it (e.g. "Copy to customize"). */
  readonly open?: boolean
  readonly onOpenChange?: (open: boolean) => void
  readonly children: ReactNode
}) {
  const [ownOpen, setOwnOpen] = useScopedState(defaultOpen)
  const open = controlledOpen ?? ownOpen
  const setOpen = (next: boolean): void => { if (onOpenChange !== undefined) onOpenChange(next); else setOwnOpen(next) }
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="rounded-xl border border-line">
      <Collapsible.Trigger className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3.5 py-2.5 text-left text-[13px] font-medium text-fg outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-link">
        <Icon name="chevronRight" size={14} className={cn('shrink-0 text-fg-faint transition-transform', open && 'rotate-90')} aria-hidden="true" />
        <span className="min-w-0 flex-1">{summary}</span>
        {count !== undefined && count > 0 ? <Badge tone="blue">{count}</Badge> : null}
      </Collapsible.Trigger>
      <Collapsible.Content>
        <div className="flex min-w-0 flex-col gap-4 border-t border-line px-3.5 py-3.5">{children}</div>
      </Collapsible.Content>
    </Collapsible.Root>
  )
}

export function ItemList({ children, label }: { readonly children: ReactNode; readonly label?: string }) {
  return <ul aria-label={label} className="m-0 flex list-none flex-col divide-y divide-line overflow-hidden rounded-xl border border-line p-0">{children}</ul>
}

/** One list row: identity on the left, actions on the right, details below. */
export function ItemRow({ title, meta, actions, children, selected = false }: {
  readonly title: ReactNode
  readonly meta?: ReactNode
  readonly actions?: ReactNode
  readonly children?: ReactNode
  readonly selected?: boolean
}) {
  return (
    <li className={cn('flex min-w-0 flex-col gap-2 px-3.5 py-3', selected && 'bg-hover')}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-medium">{title}</div>
          {meta !== undefined ? <div className="min-w-0 break-words text-xs text-fg-faint">{meta}</div> : null}
        </div>
        {actions !== undefined ? <div className="flex shrink-0 flex-wrap items-center gap-1">{actions}</div> : null}
      </div>
      {children}
    </li>
  )
}

export interface RowAction {
  readonly label: string
  readonly icon: IconName
  readonly onSelect: () => void
  readonly danger?: boolean
  readonly disabled?: boolean
}

/**
 * Overflow menu for a list row. Rows that each carry three or four text
 * buttons read as a wall of words; one "⋯" per row keeps the identity column
 * scannable and puts destructive items last, separated and in red.
 */
export function RowMenu({ label, actions, disabled = false }: {
  /** Accessible name, e.g. "Actions for dnt-harness". */
  readonly label: string
  readonly actions: readonly RowAction[]
  readonly disabled?: boolean
}) {
  const safe = actions.filter((action) => action.danger !== true)
  const danger = actions.filter((action) => action.danger === true)
  const item = (action: RowAction, close: () => void) => (
    <button
      key={action.label}
      type="button"
      role="menuitem"
      disabled={action.disabled}
      className={cn(menuItemClass, action.danger === true && 'text-bad hover:bg-bad-soft focus-visible:bg-bad-soft')}
      onClick={() => { close(); action.onSelect() }}
    >
      <Icon name={action.icon} size={15} className={action.danger === true ? 'text-bad' : 'text-fg-muted'} aria-hidden="true" />
      {action.label}
    </button>
  )
  return (
    <Menu
      label={label}
      align="end"
      disabled={disabled}
      panelClassName="w-52"
      triggerClassName="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-link disabled:pointer-events-none disabled:opacity-40 data-[state=open]:bg-hover data-[state=open]:text-fg"
      trigger={() => <Icon name="dots" size={16} />}
    >
      {(close) => (
        <>
          {safe.map((action) => item(action, close))}
          {safe.length > 0 && danger.length > 0 ? <div role="separator" className="my-1 h-px bg-line" /> : null}
          {danger.map((action) => item(action, close))}
        </>
      )}
    </Menu>
  )
}

export function EmptyState({ children }: { readonly children: ReactNode }) {
  return <p className="m-0 rounded-xl border border-dashed border-line px-3.5 py-4 text-center text-[13px] text-fg-muted">{children}</p>
}

/** Monospace multi-line input; `tall` for whole documents. */
export const CodeArea = forwardRef<HTMLTextAreaElement, { readonly tall?: boolean } & TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function CodeArea({ tall = false, className, rows, ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        spellCheck={false}
        rows={rows ?? (tall ? 14 : 3)}
        className={cn(
          'manage-code w-full min-w-0 resize-y rounded-lg border border-line bg-surface px-3 py-2 font-mono text-[12.5px] leading-5 text-fg outline-none transition-colors placeholder:text-fg-faint focus:border-fg-faint',
          tall && 'manage-code-tall min-h-64',
          className,
        )}
        {...rest}
      />
    )
  },
)

/** Two-step destructive action kept inline, next to the thing it removes. */
export function InlineConfirm({ message, confirmLabel, busy, onConfirm, onCancel, cancelLabel = 'Cancel' }: {
  readonly message: ReactNode
  readonly confirmLabel: string
  readonly busy: boolean
  readonly onConfirm: () => void
  readonly onCancel: () => void
  readonly cancelLabel?: string
}) {
  return (
    <div role="alertdialog" aria-label={confirmLabel} className="flex flex-wrap items-center gap-2 rounded-lg border border-bad/30 bg-bad-soft px-3 py-2 text-[13px]">
      <Icon name="alertTriangle" size={14} className="shrink-0 text-bad" aria-hidden="true" />
      <span className="min-w-0 flex-1 basis-48 text-fg">{message}</span>
      {/* Cancel first, destructive last: the same order as every other action row. */}
      <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>{cancelLabel}</Button>
      <Button variant="danger" size="sm" disabled={busy} onClick={onConfirm}>{busy ? `${confirmLabel.split(' ')[0] === 'Delete' ? 'Deleting' : confirmLabel.split(' ')[0] === 'Remove' ? 'Removing' : 'Working'}…` : confirmLabel}</Button>
    </div>
  )
}

/**
 * One async action at a time per panel. The lock is a ref so a double click
 * in the same frame cannot start a second request; `busy` names the running
 * action so only its button shows progress.
 */
export function useActionRunner(onError: (text: string) => void): {
  readonly busy: string | null
  readonly run: (key: string, action: () => Promise<void>) => Promise<void>
} {
  const [busy, setBusy] = useScopedState<string | null>(null)
  const lock = useRef(false)
  const run = async (key: string, action: () => Promise<void>): Promise<void> => {
    if (lock.current) return
    lock.current = true
    setBusy(key)
    try {
      await action()
    } catch (cause) {
      onError(String(cause))
    } finally {
      lock.current = false
      setBusy(null)
    }
  }
  return { busy, run }
}

/** A positive integer from a text field, or null when blank or invalid. */
export function parsePositiveInt(raw: string): number | null {
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const value = Number.parseInt(trimmed, 10)
  return value > 0 ? value : null
}
