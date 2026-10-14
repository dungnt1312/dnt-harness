import * as Popover from '@radix-ui/react-popover'
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import Icon from '../common/Icon.tsx'
import ConfirmDialog from '../common/ConfirmDialog.tsx'
import { Menu } from '../ui/Menu.tsx'
import { menuItemClass } from '../ui/Menu.tsx'
import type { GitBranch, GitOperationDone } from '../../lib/api.ts'
import { cn } from '../../lib/cn.ts'
import { fuzzyMatch, normalizeBranchName, orderBranches, type BranchFilter } from './git-panel-model.ts'
import type { GitRun } from './use-git-operation.tsx'

const FILTERS: readonly { readonly value: BranchFilter; readonly label: string }[] = [
  { value: 'all', label: 'All Branches' },
  { value: 'local', label: 'Local Branches' },
  { value: 'remote', label: 'Remote Branches' },
]

/** `3 hours ago`, `yesterday`: the commit time as the picker's meta line shows it. */
function relativeTime(unixSeconds: number): string {
  const seconds = unixSeconds - Math.floor(Date.now() / 1000)
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  const steps: readonly [Intl.RelativeTimeFormatUnit, number][] = [['year', 31_536_000], ['month', 2_592_000], ['week', 604_800], ['day', 86_400], ['hour', 3600], ['minute', 60]]
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit)
  }
  return 'just now'
}

/** The name with the characters the query matched in bold. */
function highlighted(name: string, matched: readonly number[]): ReactNode {
  if (matched.length === 0) return name
  const hits = new Set(matched)
  return [...name].map((char, index) => (hits.has(index) ? <b key={index} className="font-semibold text-fg">{char}</b> : <span key={index}>{char}</span>))
}

type Row =
  | { readonly kind: 'branch'; readonly branch: GitBranch; readonly matched: readonly number[] }
  | { readonly kind: 'create'; readonly name: string }

/**
 * Zed's branch picker: a popover over the footer's branch name with a search
 * box, the local and remote branches (Zed's order), and — when the typed name
 * is no branch — Create Branch. Selecting switches (a remote branch gets a
 * tracking branch on the server), the trash deletes (Alt forces), failures are
 * the panel's usual toast. `onDone` receives each mutating answer.
 */
export function GitBranchPicker({ current, run, enqueue, onDone }: {
  readonly current: string
  readonly run: GitRun
  /** The panel's queue: a switch, create or delete runs after the staging, discard and commit clicks before it. */
  readonly enqueue: (task: () => Promise<void>) => void
  readonly onDone: (done: GitOperationDone | undefined) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<BranchFilter>('all')
  const [list, setList] = useState<readonly GitBranch[]>([])
  const [defaultBranch, setDefaultBranch] = useState<string | undefined>(undefined)
  const [listError, setListError] = useState<string | undefined>(undefined)
  const [highlight, setHighlight] = useState(0)
  const [alt, setAlt] = useState(false)
  const [force, setForce] = useState<GitBranch | null>(null)
  // One mutation at a time: a double Enter or a double click must not send two.
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement | null>(null)

  // Branches are read each time the picker opens.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setHighlight(0)
    let live = true
    void run({ type: 'branches' }).then((done) => {
      if (!live || done === undefined) return
      setList(done.branches ?? [])
      setDefaultBranch(done.defaultBranch)
      setListError(done.error)
    })
    return () => { live = false }
  }, [open, run])

  const ordered = orderBranches(list, filter)
  const normalized = normalizeBranchName(query)
  const rows: Row[] = []
  for (const branch of ordered) {
    const matched = fuzzyMatch(query, branch.name)
    if (matched !== null) rows.push({ kind: 'branch', branch, matched })
  }
  // Zed: the query becomes a branch when no branch has exactly that name.
  const exact = list.some((branch) => branch.name === normalized)
  if (normalized !== '' && !exact) rows.push({ kind: 'create', name: normalized })
  const showSections = filter === 'all' && query === ''

  const finish = (done: GitOperationDone | undefined): void => {
    onDone(done)
    if (done?.ok === true) setOpen(false)
  }

  /**
   * A mutation runs behind the panel's pending clicks (so a stage clicked a
   * moment ago lands on the branch it was clicked on) and one at a time.
   */
  const mutate = (task: () => Promise<void>): void => {
    if (busy) return
    setBusy(true)
    enqueue(async () => {
      try { await task() } finally { setBusy(false) }
    })
  }

  const choose = (row: Row | undefined, base?: string): void => {
    if (row === undefined) return
    if (row.kind === 'create') {
      mutate(async () => finish(await run({ type: 'create-branch', name: row.name, ...(base !== undefined ? { base } : {}) })))
      return
    }
    if (row.branch.current) { setOpen(false); return }
    mutate(async () => finish(await run({ type: 'switch-branch', name: row.branch.name })))
  }

  const remove = (branch: GitBranch, forced: boolean): void => {
    mutate(async () => {
      const done = await run(
        { type: 'delete-branch', name: branch.name, remote: branch.remote, force: forced },
        // Zed asks "Force delete it?" for an unmerged branch instead of failing.
        { quietFailure: (answer) => !forced && /not fully merged/i.test(answer.stderr) },
      )
      if (done === undefined) return
      if (!done.ok && !forced && /not fully merged/i.test(done.stderr)) { setForce(branch); return }
      onDone(done)
      if (done.ok) setList((previous) => previous.filter((entry) => entry.name !== branch.name))
    })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setHighlight((index) => Math.min(index + 1, rows.length - 1)) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setHighlight((index) => Math.max(index - 1, 0)) }
    else if (event.key === 'Enter') { event.preventDefault(); choose(rows[Math.min(highlight, rows.length - 1)]) }
  }

  let lastSection: 'local' | 'remote' | null = null
  return (
    <>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label="Switch Branch"
            title="Switch Branch"
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-left hover:bg-hover"
          >
            <Icon name="gitBranch" size={13} className="shrink-0 text-fg-muted" />
            <span className="min-w-0 flex-1 truncate font-medium" title={current}>{current}</span>
            <Icon name="chevron" size={11} className="shrink-0 text-fg-faint" />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            side="top"
            align="start"
            sideOffset={6}
            collisionPadding={12}
            role="dialog"
            aria-label="Branches"
            onOpenAutoFocus={(event) => { event.preventDefault(); input.current?.focus() }}
            onKeyDown={(event) => setAlt(event.altKey)}
            onKeyUp={(event) => setAlt(event.altKey)}
            className="z-50 flex max-h-[min(70vh,var(--radix-popover-content-available-height))] w-[min(22rem,calc(100vw-24px))] flex-col overflow-hidden rounded-2xl border border-line bg-surface text-fg shadow-pop outline-none animate-fade-up"
          >
            <div className="flex items-center gap-1.5 border-b border-line px-2 py-1.5">
              <input
                ref={input}
                value={query}
                placeholder="Switch or type to create a branch…"
                aria-label="Search branches"
                spellCheck={false}
                onChange={(event) => { setQuery(event.target.value); setHighlight(0) }}
                onKeyDown={onKeyDown}
                className="min-w-0 flex-1 bg-transparent px-1.5 py-1 text-sm outline-none placeholder:text-fg-faint"
              />
              <Menu
                label="Branch filter"
                align="end"
                triggerClassName="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg"
                trigger={() => <Icon name="funnel" size={13} />}
              >
                {(close) => FILTERS.map((entry) => (
                  <button
                    key={entry.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={filter === entry.value}
                    className={menuItemClass}
                    onClick={() => { close(); setFilter(entry.value) }}
                  >
                    <span className="inline-flex w-4 shrink-0 justify-center">{filter === entry.value ? <Icon name="check" size={13} /> : null}</span>
                    {entry.label}
                  </button>
                ))}
              </Menu>
            </div>
            {listError !== undefined ? (
              <p className="m-0 border-b border-line bg-warn-soft px-3 py-1.5 text-xs text-warn">Some branches could not be loaded: {listError}</p>
            ) : null}
            <div role="listbox" aria-label="Branches" className="min-h-0 flex-1 overflow-y-auto p-1">
              {rows.length === 0 ? <p className="m-0 px-3 py-4 text-center text-sm text-fg-muted">No branches found</p> : null}
              {rows.map((row, index) => {
                const heading = row.kind === 'branch' && showSections && lastSection !== (row.branch.remote ? 'remote' : 'local')
                  ? (lastSection = row.branch.remote ? 'remote' : 'local')
                  : null
                const on = index === Math.min(highlight, rows.length - 1)
                return (
                  <div key={row.kind === 'create' ? '\u0000create' : row.branch.name}>
                    {heading !== null ? (
                      <div data-branch-section className="px-2 pb-0.5 pt-2 text-[11px] font-medium uppercase tracking-wide text-fg-faint">
                        {heading === 'local' ? 'Local Branches' : 'Remote Branches'}
                      </div>
                    ) : null}
                    {row.kind === 'create' ? (
                      <div
                        data-create-branch
                        role="option"
                        aria-selected={on}
                        onMouseEnter={() => setHighlight(index)}
                        className={cn('flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm', on && 'bg-hover')}
                      >
                        <button type="button" className="flex min-w-0 flex-1 flex-col text-left" onClick={() => choose(row)}>
                          <span className="truncate font-medium">Create Branch: &quot;{row.name}&quot;…</span>
                          <span className="truncate text-xs text-fg-muted">Based off {current}</span>
                        </button>
                        {defaultBranch !== undefined && defaultBranch !== current ? (
                          <button
                            type="button"
                            className="shrink-0 rounded-md border border-line px-2 py-1 text-xs hover:bg-hover"
                            onClick={() => choose(row, defaultBranch)}
                          >
                            Create New From: {defaultBranch}
                          </button>
                        ) : null}
                      </div>
                    ) : (
                      <div
                        data-branch-row={row.branch.name}
                        role="option"
                        aria-selected={on}
                        aria-current={row.branch.current ? 'true' : undefined}
                        onMouseEnter={() => setHighlight(index)}
                        onClick={() => choose(row)}
                        className={cn('group/branch flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm', on && 'bg-hover')}
                      >
                        <Icon
                          name={row.branch.current ? 'check' : row.branch.remote ? 'server' : 'gitBranch'}
                          size={13}
                          className={cn('shrink-0', row.branch.current ? 'text-primary' : 'text-fg-muted')}
                        />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate">{highlighted(row.branch.name, row.matched)}</span>
                          <span className="truncate text-xs text-fg-muted">
                            {row.branch.unixTime !== undefined
                              ? `${relativeTime(row.branch.unixTime)}${row.branch.subject !== undefined ? ` • ${row.branch.subject}` : ''}`
                              : 'No commits found'}
                          </span>
                        </span>
                        {!row.branch.current ? (
                          <button
                            type="button"
                            aria-label="Delete Branch"
                            title={alt ? 'Force Delete Branch' : 'Delete Branch'}
                            onClick={(event) => { event.stopPropagation(); remove(row.branch, event.altKey) }}
                            className="invisible shrink-0 rounded p-1 text-fg-faint hover:text-bad group-hover/branch:visible focus-visible:visible [@media(pointer:coarse)]:visible"
                          >
                            <Icon name="trash" size={13} />
                          </button>
                        ) : null}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <ConfirmDialog
        open={force !== null}
        title={`Branch "${force?.name ?? ''}" is not fully merged. Force delete it?`}
        confirmLabel="Force Delete"
        onDismiss={() => setForce(null)}
        onConfirm={() => {
          const branch = force
          setForce(null)
          if (branch !== null) remove(branch, true)
        }}
      />
    </>
  )
}
