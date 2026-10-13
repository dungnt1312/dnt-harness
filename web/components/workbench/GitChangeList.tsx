import { useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import Icon from '../common/Icon.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { Menu } from '../ui/Menu.tsx'
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
import { buildTree, folderStageTargets, folderToggleState, visibleNodes, type GitTreeNode } from './git-tree.ts'
import { ContextMenuPanel, GitEntryMenuItems, useContextMenu, type GitEntryActions } from './GitEntryMenu.tsx'

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
  /** Add these untracked paths to the root .gitignore. */
  readonly onIgnore: (paths: readonly string[]) => void
  /** Absolute project folder, for Copy Path. */
  readonly projectPath: string
  /** List (flat sections) or Tree (folders inside each section). */
  readonly view: 'list' | 'tree'
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
  report, visibleChanges, pendingStages, onStage, onDiscard, onTrash, onOpenFile, onIgnore, projectPath, view,
  selectedPath, onSelect, focusPath, focusRowRef,
}: GitChangeListProps) {
  const groups = groupChanges(withPendingStages(visibleChanges, pendingStages))
  // Tree mode collapses folders in memory only; a reload expands them again.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const toggleFolder = (key: string): void => setCollapsed((current) => {
    const next = new Set(current)
    if (!next.delete(key)) next.add(key)
    return next
  })
  const nodesOf = (group: GitChangeGroup): readonly GitTreeNode[] =>
    view === 'tree' ? visibleNodes(buildTree(group.entries), collapsed) : group.entries.map((change): GitTreeNode => ({ kind: 'file', key: change.path, change, depth: 0 }))
  // Arrow keys walk the files as drawn: a collapsed folder's files are skipped.
  const order = groups.flatMap((group) => nodesOf(group).flatMap((node) => node.kind === 'file' ? [node.change] : []))
  const box = useRef<HTMLDivElement | null>(null)
  const actionsFor = (change: GitChange): GitEntryActions => ({
    onStage, onDiscard, onTrash, onIgnore,
    onOpenDiff: () => onSelect(change.path),
    ...(onOpenFile !== undefined ? { onViewFile: () => onOpenFile(change.path) } : {}),
  })

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
          {nodesOf(group).map((node) => node.kind === 'dir' ? (
            <li key={`dir:${node.key}`} data-tree-dir={node.path}>
              <FolderRow
                node={node}
                collapsed={collapsed.has(node.key)}
                onToggle={() => toggleFolder(node.key)}
                onStage={onStage}
              />
            </li>
          ) : (
            <li key={node.change.path} data-row-path={node.change.path} style={node.depth > 0 ? { paddingLeft: `${node.depth * 12}px` } : undefined}>
              <ChangeRow
                change={node.change}
                selected={selectedPath === node.change.path}
                projectPath={projectPath}
                actions={actionsFor(node.change)}
                onSelect={() => onSelect(node.change.path)}
                onKeyDown={(event) => onKeyDown(event, node.change)}
                onStage={() => onStage([node.change.path], stageIntent(node.change.staging))}
                {...(focusPath === node.change.path && focusRowRef !== undefined ? { rowRef: focusRowRef } : {})}
                {...(onOpenFile !== undefined ? { onOpenFile: () => onOpenFile(node.change.path) } : {})}
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

function ChangeRow({ change, selected, projectPath, actions, onSelect, onKeyDown, onStage, onOpenFile, rowRef }: {
  readonly change: GitChange
  readonly selected: boolean
  readonly projectPath: string
  readonly actions: GitEntryActions
  readonly onSelect: () => void
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
  readonly onStage: () => void
  /** Opens the file itself in the workbench; absent without an opener. */
  readonly onOpenFile?: () => void
  /** The focused row (a chat card's file click), for a scroll into view. */
  readonly rowRef?: Ref<HTMLButtonElement>
}) {
  const name = change.path.split('/').pop() ?? change.path
  const directory = change.path.slice(0, change.path.length - name.length).replace(/\/$/, '')
  const menu = useContextMenu()
  return (
    // One hover surface for the whole line, openers included: the band never
    // breaks where an overlaid button begins.
    <div
      onKeyDown={onKeyDown}
      {...menu.bind}
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
        {(close) => <GitEntryMenuItems entries={[change]} projectPath={projectPath} close={close} actions={actions} />}
      </Menu>
      <StageCheckbox state={toggleStateOf(change.staging)} label={`${change.staging === 'staged' ? 'Unstage' : 'Stage'} ${change.path}`} onToggle={onStage} />
      <ContextMenuPanel at={menu.at} label={`Actions for ${name}`} onClose={menu.close}>
        <GitEntryMenuItems entries={[change]} projectPath={projectPath} close={menu.close} actions={actions} />
      </ContextMenuPanel>
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

/** A directory of the tree: chevron, name, count and a tri-state checkbox over every change beneath it. */
function FolderRow({ node, collapsed, onToggle, onStage }: {
  readonly node: Extract<GitTreeNode, { kind: 'dir' }>
  readonly collapsed: boolean
  readonly onToggle: () => void
  readonly onStage: GitChangeListProps['onStage']
}) {
  const state = folderToggleState(node.entries)
  const label = `${state === 'selected' ? 'Unstage' : 'Stage'} Folder ${node.path}`
  return (
    <div className="flex items-center rounded-md hover:bg-hover" style={{ paddingLeft: `${node.depth * 12}px` }}>
      <button
        type="button"
        data-dir-toggle
        aria-expanded={!collapsed}
        title={node.path}
        onClick={onToggle}
        className="flex min-h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left text-[13px]"
      >
        <Icon name="chevronRight" size={12} className={cn('shrink-0 text-fg-faint transition-transform', !collapsed && 'rotate-90')} />
        <Icon name={collapsed ? 'folder' : 'folderOpen'} size={14} className="shrink-0 text-fg-muted" />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        <span className="font-mono text-[11px] tabular-nums text-fg-faint">{node.entries.length}</span>
      </button>
      <StageCheckbox
        state={state}
        label={label}
        onToggle={() => {
          const { paths, intent } = folderStageTargets(node.entries, state)
          onStage(paths, intent)
        }}
      />
    </div>
  )
}
