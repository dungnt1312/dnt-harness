import { useRef, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import Icon from '../common/Icon.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { Menu, menuItemClass } from '../ui/Menu.tsx'
import {
  type GitChange,
  type GitChangeStatus,
  type GitStaging,
  type GitStatusReport,
} from '../../lib/api.ts'
import { FileTypeIcon } from '../common/FileTypeIcon.tsx'
import { LineCount } from '../common/DiffLines.tsx'
import { cn } from '../../lib/cn.ts'
import {
  groupChanges,
  headerToggleState,
  stageIntent,
  stageIntentForSection,
  type GitChangeGroup,
  type GitToggleState,
} from './git-panel-model.ts'

const STATUS_LABEL: Readonly<Record<GitChangeStatus, string>> = {
  modified: 'Modified',
  added: 'Added',
  deleted: 'Deleted',
  renamed: 'Renamed',
  copied: 'Copied',
  untracked: 'Untracked',
  conflict: 'Conflict',
}

/** Letter shown before the file name, the same codes a git UI prints. */
const STATUS_MARK: Readonly<Record<GitChangeStatus, string>> = {
  modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', untracked: 'U', conflict: '!',
}

/** The changes as the reader sees them: a queued staging action already applied. */
export function withPendingStages(changes: readonly GitChange[], pending: ReadonlyMap<string, GitStaging>): readonly GitChange[] {
  if (pending.size === 0) return changes
  return changes.map((change) => {
    const staging = pending.get(change.path)
    return staging === undefined || staging === change.staging ? change : { ...change, staging }
  })
}

export interface GitChangeListProps {
  readonly report: GitStatusReport
  /** The rows to list (the report's changes, or the turn filter's subset). */
  readonly visibleChanges: readonly GitChange[]
  /** Optimistic staging per path, applied over the report until the operation settles. */
  readonly pendingStages: ReadonlyMap<string, GitStaging>
  /** A staging control: stage or unstage exactly these paths. */
  readonly onStage: (paths: readonly string[], intent: 'stage' | 'unstage') => void
  /** Discard (restore) the changes of these tracked entries; the panel confirms first. */
  readonly onDiscard: (entries: readonly GitChange[]) => void
  /** Move these untracked entries to the trash; the panel confirms first. */
  readonly onTrash: (entries: readonly GitChange[]) => void
  /** Opens a changed file itself in the workbench, when a resolver is wired. */
  readonly onOpenFile?: (path: string) => void
  /** The row whose diff the pane shows. */
  readonly selectedPath: string | null
  readonly onSelect: (path: string) => void
  /** A chat card's file click: that row is scrolled to the top. */
  readonly focusPath?: string
  readonly focusRowRef?: Ref<HTMLButtonElement>
}

/**
 * The change list in Zed's sections (Conflicts, Tracked, Untracked), each with
 * a tri-state checkbox, and rows with their own checkbox in the right-hand
 * control slot, a hover-revealed discard/trash menu and the file opener. A row
 * selects (its diff shows in the pane beside the list); the arrow keys move
 * the selection, Space stages or unstages it and Enter opens the file.
 */
export function GitChangeList({
  report, visibleChanges, pendingStages, onStage, onDiscard, onTrash, onOpenFile,
  selectedPath, onSelect, focusPath, focusRowRef,
}: GitChangeListProps) {
  const groups = groupChanges(withPendingStages(visibleChanges, pendingStages))
  const order = groups.flatMap((group) => group.entries)
  const box = useRef<HTMLDivElement | null>(null)

  const move = (from: GitChange, step: 1 | -1): void => {
    const index = order.findIndex((entry) => entry.path === from.path)
    const next = order[index + step]
    if (next === undefined) return
    onSelect(next.path)
    box.current?.querySelector<HTMLElement>(`[data-row-path="${CSS.escape(next.path)}"] [data-row-main]`)?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, change: GitChange): void => {
    if (event.key === 'ArrowDown') { event.preventDefault(); move(change, 1) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(change, -1) }
    else if (event.key === ' ') { event.preventDefault(); onStage([change.path], stageIntent(change.staging)) }
    else if (event.key === 'Enter' && onOpenFile !== undefined) { event.preventDefault(); onOpenFile(change.path) }
  }

  return (
    <div ref={box} role="group" aria-label="Changed files" className="flex flex-col p-1">
      {groups.map((group) => (
        <Section
          key={group.section}
          group={group}
          onStage={onStage}
        >
          {group.entries.map((change) => (
            <li key={change.path} data-row-path={change.path}>
              <ChangeRow
                change={change}
                selected={selectedPath === change.path}
                onSelect={() => onSelect(change.path)}
                onKeyDown={(event) => onKeyDown(event, change)}
                onStage={() => onStage([change.path], stageIntent(change.staging))}
                onDiscard={() => onDiscard([change])}
                onTrash={() => onTrash([change])}
                {...(focusPath === change.path && focusRowRef !== undefined ? { rowRef: focusRowRef } : {})}
                {...(onOpenFile !== undefined ? { onOpenFile: () => onOpenFile(change.path) } : {})}
              />
            </li>
          ))}
        </Section>
      ))}
      {report.truncated ? <p className="m-0 px-3 py-2 text-xs text-fg-faint">Showing the first {visibleChanges.length} changed files.</p> : null}
    </div>
  )
}

function toggleStateOf(staging: GitStaging): GitToggleState {
  return staging === 'staged' ? 'selected' : staging === 'partial' ? 'indeterminate' : 'unselected'
}

function Section({ group, onStage, children }: {
  readonly group: GitChangeGroup
  readonly onStage: GitChangeListProps['onStage']
  readonly children: ReactNode
}) {
  const state = headerToggleState(group.section, group.entries)
  // Zed `toggle_staged_for_entry` on a header: a fully staged section unstages, anything else stages.
  const toggle = (): void => {
    const current: GitStaging = state === 'selected' ? 'staged' : state === 'indeterminate' ? 'partial' : 'unstaged'
    const intent = stageIntent(current, stageIntentForSection(group.section))
    // Only this section's entries that are not already where the click sends them.
    onStage(group.entries.filter((change) => intent === 'stage' ? change.staging !== 'staged' : change.staging !== 'unstaged').map((change) => change.path), intent)
  }
  return (
    <section aria-label={group.title}>
      <div className="flex h-8 items-center gap-1.5 pl-2 text-[11px] font-medium uppercase tracking-wide text-fg-faint">
        <span className="min-w-0 flex-1 truncate">{group.title}</span>
        <span className="font-mono normal-case tabular-nums">{group.entries.length}</span>
        <StageCheckbox state={state} label={`${state === 'selected' ? 'Unstage' : 'Stage'} all ${group.title.toLowerCase()}`} onToggle={toggle} />
      </div>
      <ul aria-label={`${group.title} files`} className="m-0 flex list-none flex-col p-0">{children}</ul>
    </section>
  )
}

/** The tri-state control of a row or a section header: filled when staged, a bar when partly. */
function StageCheckbox({ state, label, onToggle }: {
  readonly state: GitToggleState
  readonly label: string
  readonly onToggle: () => void
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === 'indeterminate' ? 'mixed' : state === 'selected'}
      aria-label={label}
      title={label}
      onClick={onToggle}
      // Exempt from the 44px coarse-pointer floor: the row reserves exactly this 32px slot.
      data-compact-control
      className="flex size-8 shrink-0 items-center justify-center rounded-md"
    >
      <span className={cn('flex size-4 items-center justify-center rounded border', state === 'unselected' ? 'border-line-strong' : 'border-primary bg-primary text-primary-fg')}>
        {state === 'selected' ? <Icon name="check" size={11} /> : null}
        {state === 'indeterminate' ? <span className="h-0.5 w-2 rounded bg-current" /> : null}
      </span>
    </button>
  )
}

function ChangeRow({ change, selected, onSelect, onKeyDown, onStage, onDiscard, onTrash, onOpenFile, rowRef }: {
  readonly change: GitChange
  readonly selected: boolean
  readonly onSelect: () => void
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
  readonly onStage: () => void
  readonly onDiscard: () => void
  readonly onTrash: () => void
  /** Opens the file itself in the workbench; absent without an opener. */
  readonly onOpenFile?: () => void
  /** The focused row (a chat card's file click), for a scroll into view. */
  readonly rowRef?: Ref<HTMLButtonElement>
}) {
  const name = change.path.split('/').pop() ?? change.path
  const directory = change.path.slice(0, change.path.length - name.length).replace(/\/$/, '')
  // Zed `build_context_menu`: a new file is "Trash File", a deleted one "Restore File", the rest "Discard Changes".
  const revert = change.created
    ? { label: 'Trash File', icon: 'trash' as const, run: onTrash }
    : { label: change.deleted ? 'Restore File' : 'Discard Changes', icon: 'refresh' as const, run: onDiscard }
  return (
    // One hover surface for the whole line, openers included: the band never
    // breaks where an overlaid button begins.
    <div
      onKeyDown={onKeyDown}
      className={cn('relative flex items-center rounded-md transition-colors hover:bg-hover group/row', selected && 'bg-hover')}
    >
      <button
        ref={rowRef}
        data-row-main
        type="button"
        aria-current={selected ? 'true' : undefined}
        title={change.previousPath !== undefined ? `${change.previousPath} → ${change.path}` : change.path}
        onClick={onSelect}
        // Touch shows the overlays all the time, so only there the row makes room for them.
        className={cn(
          'flex min-h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left text-[13px]',
          onOpenFile !== undefined ? '[@media(pointer:coarse)]:pr-14' : '[@media(pointer:coarse)]:pr-8',
        )}
      >
        <span className={cn('w-3 shrink-0 text-center font-mono text-[11px] font-semibold', markColor(change.status))} aria-label={STATUS_LABEL[change.status]}>{STATUS_MARK[change.status]}</span>
        <FileTypeIcon path={change.path} size={16} />
        <span className="min-w-0 flex-1 truncate">
          <span className={cn(change.status === 'deleted' && 'line-through')}>{name}</span>
          {directory !== '' ? <span className="ml-1.5 text-fg-faint">{directory}</span> : null}
        </span>
        <LineCount
          {...(change.added !== undefined ? { added: change.added } : {})}
          {...(change.removed !== undefined ? { removed: change.removed } : {})}
          className={cn('transition-opacity group-hover/row:opacity-0 group-has-[:focus-visible]/row:opacity-0 [@media(pointer:coarse)]:opacity-100', selected && 'opacity-0')}
        />
      </button>
      {onOpenFile !== undefined ? (
        <IconButton
          label={`Open ${name} in workbench`}
          onClick={onOpenFile}
          // Hover-revealed and overlaid beside the checkbox slot, so the
          // actions take no room and never push the line counts; the counts
          // themselves fade out underneath. `invisible` keeps the hidden
          // button from intercepting the row's clicks. Always on for touch,
          // and for the selected row, which the pane is showing.
          className={cn(OPENER_REVEAL_ROW, selected && SELECTED_REVEAL)}
          // Keeps its 24px size on touch; the 44px floor would overlap the neighbours.
          data-compact-control
        >
          <Icon name="fileText" size={12} />
        </IconButton>
      ) : null}
      <Menu
        label={`Actions for ${name}`}
        align="end"
        compact
        triggerClassName={cn(onOpenFile !== undefined ? MENU_REVEAL_ROW_BESIDE_OPENER : MENU_REVEAL_ROW, selected && SELECTED_REVEAL)}
        trigger={() => <Icon name="dots" size={12} />}
      >
        {(close) => (
          <button type="button" role="menuitem" className={menuItemClass} onClick={() => { close(); revert.run() }}>
            <Icon name={revert.icon} size={14} className="shrink-0 text-fg-muted" />
            {revert.label}
          </button>
        )}
      </Menu>
      <StageCheckbox state={toggleStateOf(change.staging)} label={`${change.staging === 'staged' ? 'Unstage' : 'Stage'} ${change.path}`} onToggle={onStage} />
    </div>
  )
}

function markColor(status: GitChangeStatus): string {
  if (status === 'deleted' || status === 'conflict') return 'text-bad'
  if (status === 'added' || status === 'untracked') return 'text-ok'
  return 'text-warn'
}

/** Quiet 24px opener: no fill of its own, only a text-color change on hover. */
const OPENER_BASE = 'absolute size-6 rounded-md text-fg-faint hover:bg-transparent hover:text-fg opacity-0 invisible transition-opacity focus-visible:visible focus-visible:opacity-100 [@media(pointer:coarse)]:visible [@media(pointer:coarse)]:opacity-100'
const ROW_REVEAL = 'top-1/2 -translate-y-1/2 group-hover/row:visible group-hover/row:opacity-100 group-has-[:focus-visible]/row:visible group-has-[:focus-visible]/row:opacity-100'
/** The selected row keeps its actions in view: the pane is showing that file. */
const SELECTED_REVEAL = 'visible opacity-100'
// The checkbox slot (size-8) sits at the row's right edge; the overlays stack left of it.
const OPENER_REVEAL_ROW = cn(OPENER_BASE, 'right-9', ROW_REVEAL)
// The menu trigger stays shown while its menu is open, or the menu would lose its anchor.
const MENU_REVEAL_ROW = cn(OPENER_BASE, 'inline-flex items-center justify-center right-9', ROW_REVEAL, 'data-[state=open]:visible data-[state=open]:opacity-100')
const MENU_REVEAL_ROW_BESIDE_OPENER = cn(MENU_REVEAL_ROW, 'right-16')
