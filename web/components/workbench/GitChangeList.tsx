import { useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import Icon from '../common/Icon.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { Button } from '../ui/Button.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { Menu, menuItemClass } from '../ui/Menu.tsx'
import {
  fetchGitDiff,
  type GitChange,
  type GitChangeStatus,
  type GitDiffReport,
  type GitStaging,
  type GitStatusReport,
} from '../../lib/api.ts'
import { FileTypeIcon } from '../common/FileTypeIcon.tsx'
import { DiffLines, LineCount, diffRowsFromUnified } from '../common/DiffLines.tsx'
import { MediaPreview } from '../common/MediaPreview.tsx'
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
  readonly workspaceId: string
  readonly projectId: string
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
  readonly openPath: string | null
  readonly onToggleDiff: (path: string) => void
  /** A chat card's file click: that row is expanded and scrolled to the top. */
  readonly focusPath?: string
  readonly focusRowRef?: Ref<HTMLButtonElement>
  readonly onFocusedDiffReady?: () => void
}

/**
 * The change list in Zed's sections (Conflicts, Tracked, Untracked), each with
 * a tri-state checkbox, and rows with their own checkbox in the right-hand
 * control slot, a hover-revealed discard/trash menu and the file opener.
 */
export function GitChangeList({
  workspaceId, projectId, report, visibleChanges, pendingStages, onStage, onDiscard, onTrash, onOpenFile,
  openPath, onToggleDiff, focusPath, focusRowRef, onFocusedDiffReady,
}: GitChangeListProps) {
  const groups = groupChanges(withPendingStages(visibleChanges, pendingStages))
  return (
    <div role="group" aria-label="Changed files" className="flex flex-col p-1">
      {groups.map((group) => (
        <Section
          key={group.section}
          group={group}
          onStage={onStage}
        >
          {group.entries.map((change) => (
            <li key={change.path}>
              <ChangeRow
                change={change}
                open={openPath === change.path}
                onToggle={() => onToggleDiff(change.path)}
                onStage={() => onStage([change.path], stageIntent(change.staging))}
                onDiscard={() => onDiscard([change])}
                onTrash={() => onTrash([change])}
                {...(focusPath === change.path && focusRowRef !== undefined ? { rowRef: focusRowRef } : {})}
                {...(onOpenFile !== undefined ? { onOpenFile: () => onOpenFile(change.path) } : {})}
              />
              {openPath === change.path ? (
                <DiffView
                  key={change.path}
                  workspaceId={workspaceId}
                  projectId={projectId}
                  path={change.path}
                  {...(focusPath === change.path && onFocusedDiffReady !== undefined ? { onReady: onFocusedDiffReady } : {})}
                  {...(onOpenFile !== undefined ? { onOpenFile: () => onOpenFile(change.path) } : {})}
                />
              ) : null}
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

function ChangeRow({ change, open, onToggle, onStage, onDiscard, onTrash, onOpenFile, rowRef }: {
  readonly change: GitChange
  readonly open: boolean
  readonly onToggle: () => void
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
    <div className={cn('relative flex items-center rounded-md transition-colors hover:bg-hover group/row', open && 'bg-hover')}>
      <button
        ref={rowRef}
        type="button"
        aria-expanded={open}
        title={change.previousPath !== undefined ? `${change.previousPath} → ${change.path}` : change.path}
        onClick={onToggle}
        // Touch shows the overlays all the time, so only there the row makes room for them.
        className={cn(
          'flex min-h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left text-[13px]',
          onOpenFile !== undefined ? '[@media(pointer:coarse)]:pr-14' : '[@media(pointer:coarse)]:pr-8',
        )}
      >
        <Icon name="chevronRight" size={12} className={cn('shrink-0 text-fg-faint transition-transform', open && 'rotate-90')} />
        <span className={cn('w-3 shrink-0 text-center font-mono text-[11px] font-semibold', markColor(change.status))} aria-label={STATUS_LABEL[change.status]}>{STATUS_MARK[change.status]}</span>
        <FileTypeIcon path={change.path} size={16} />
        <span className="min-w-0 flex-1 truncate">
          <span className={cn(change.status === 'deleted' && 'line-through')}>{name}</span>
          {directory !== '' ? <span className="ml-1.5 text-fg-faint">{directory}</span> : null}
        </span>
        <LineCount
          {...(change.added !== undefined ? { added: change.added } : {})}
          {...(change.removed !== undefined ? { removed: change.removed } : {})}
          className="transition-opacity group-hover/row:opacity-0 group-has-[:focus-visible]/row:opacity-0 [@media(pointer:coarse)]:opacity-100"
        />
      </button>
      {onOpenFile !== undefined ? (
        <IconButton
          label={`Open ${name} in workbench`}
          onClick={onOpenFile}
          // Hover-revealed and overlaid beside the checkbox slot, so the
          // actions take no room and never push the line counts; the counts
          // themselves fade out underneath. `invisible` keeps the hidden
          // button from intercepting the row's clicks. Always on for touch.
          // Keyboard focus reveals it; a mouse click on the row (which keeps
          // focus there) does not, or it would linger beside the diff's own.
          className={OPENER_REVEAL_ROW}
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
        triggerClassName={onOpenFile !== undefined ? MENU_REVEAL_ROW_BESIDE_OPENER : MENU_REVEAL_ROW}
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

/** The unified diff of one changed file, loaded when its row opens. */
function DiffView({ workspaceId, projectId, path, onReady, onOpenFile }: {
  readonly workspaceId: string
  readonly projectId: string
  readonly path: string
  /** Called once the diff (or its error) has rendered — the focused row's cue to scroll. */
  readonly onReady?: () => void
  /** Opens the file itself in the workbench; offered with an opener. */
  readonly onOpenFile?: () => void
}) {
  const [diff, setDiff] = useState<GitDiffReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const name = path.split('/').pop() ?? path
  const generation = useRef(0)
  useEffect(() => {
    if (diff !== null || error !== null) onReady?.()
  }, [diff, error, onReady])

  const load = useCallback(async () => {
    const request = ++generation.current
    setError(null)
    try {
      const next = await fetchGitDiff(workspaceId, projectId, path)
      if (generation.current === request) setDiff(next)
    } catch (cause) {
      if (generation.current === request) setError(String(cause))
    }
  }, [workspaceId, projectId, path])

  useEffect(() => { void load() }, [load])

  if (error !== null) {
    return (
      <div className="flex items-center gap-2 py-1.5 pl-7 pr-2">
        <span className="text-xs text-bad">Could not load diff</span>
        <Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button>
      </div>
    )
  }
  if (diff === null) return <div className="flex items-center gap-2 py-1.5 pl-7 text-xs text-fg-muted" role="status"><Spinner size={12} />Loading diff…</div>
  // A binary the browser can render shows the media itself; the rest say so.
  if (diff.binary) return <div className="relative py-1 pl-5 pr-2 group/diff"><MediaPreview workspaceId={workspaceId} projectId={projectId} path={path} /><DiffOpenFile name={name} {...(onOpenFile !== undefined ? { onOpenFile } : {})} /></div>
  if (diff.lines.length === 0) return <p className="m-0 py-1.5 pl-7 pr-2 text-xs text-fg-muted">No textual diff.</p>
  // The file header rows repeat the name the change row already shows and the
  // hunk header is noise; row numbers are read from the hunk instead. The
  // scroller keeps the focusable region — arrow keys scroll what holds focus —
  // while the hover-revealed opener stays pinned to the frame's corner.
  return (
    <div className="relative border-y border-line bg-muted/40 group/diff">
      <div className="overflow-x-auto" role="region" aria-label={`Diff of ${path}`} tabIndex={0}>
        {diff.truncated ? <p className="m-0 border-b border-line bg-warn-soft px-3 py-1 text-xs text-warn">Diff is larger than 1 MB; only the beginning is shown.</p> : null}
        <DiffLines rows={diffRowsFromUnified(diff.lines)} />
      </div>
      <DiffOpenFile name={name} {...(onOpenFile !== undefined ? { onOpenFile } : {})} />
    </div>
  )
}

/**
 * The diff frame's own file opener: hover-revealed, absolutely placed in the
 * frame's top-right corner so it takes no room in the scrolling body. `invisible`
 * keeps the hidden button from stealing clicks meant for the diff. It keeps the
 * surface background so the diff lines scroll beneath it, not through it.
 */
function DiffOpenFile({ name, onOpenFile }: { readonly name: string; readonly onOpenFile?: () => void }) {
  if (onOpenFile === undefined) return null
  return (
    <IconButton
      label={`Open ${name} in workbench`}
      onClick={onOpenFile}
      className={OPENER_REVEAL_DIFF}
    >
      <Icon name="fileText" size={12} />
    </IconButton>
  )
}

/** Quiet 24px opener: no fill of its own, only a text-color change on hover. */
const OPENER_BASE = 'absolute size-6 rounded-md text-fg-faint hover:bg-transparent hover:text-fg opacity-0 invisible transition-opacity focus-visible:visible focus-visible:opacity-100 [@media(pointer:coarse)]:visible [@media(pointer:coarse)]:opacity-100'
const ROW_REVEAL = 'top-1/2 -translate-y-1/2 group-hover/row:visible group-hover/row:opacity-100 group-has-[:focus-visible]/row:visible group-has-[:focus-visible]/row:opacity-100'
// The checkbox slot (size-8) sits at the row's right edge; the overlays stack left of it.
const OPENER_REVEAL_ROW = cn(OPENER_BASE, 'right-9', ROW_REVEAL)
// The menu trigger stays shown while its menu is open, or the menu would lose its anchor.
const MENU_REVEAL_ROW = cn(OPENER_BASE, 'inline-flex items-center justify-center right-9', ROW_REVEAL, 'data-[state=open]:visible data-[state=open]:opacity-100')
const MENU_REVEAL_ROW_BESIDE_OPENER = cn(MENU_REVEAL_ROW, 'right-16')
// Over diff lines the opener needs a backdrop, or the code shows through it.
const OPENER_REVEAL_DIFF = cn(OPENER_BASE, 'right-1.5 top-1.5 z-10 border border-line bg-surface/90 backdrop-blur-sm hover:bg-surface/90 group-hover/diff:visible group-hover/diff:opacity-100 group-has-[:focus-visible]/diff:visible group-has-[:focus-visible]/diff:opacity-100')
