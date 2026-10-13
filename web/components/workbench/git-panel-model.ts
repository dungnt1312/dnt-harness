/**
 * The Git panel's rules, translated from Zed's `git_ui` (`git_panel.rs`,
 * `git_ui.rs`). Pure functions over the server's status report: no React and
 * no network, so the rules can be pinned by tests and shared by the components.
 */
import type { GitChange, GitStaging, GitUpstreamTrack } from '../../lib/api.ts'

/** Zed `Section`. */
export type GitSection = 'conflict' | 'tracked' | 'new' | 'staged' | 'unstaged'

/** Zed `GitPanelGroupBy`: file status (Tracked/Untracked) or staging state (Staged/Unstaged). */
export type GitGroupBy = 'status' | 'staging'

/** Zed `GitHeaderEntry::title`. */
export const SECTION_TITLE: Readonly<Record<GitSection, string>> = {
  conflict: 'Conflicts',
  tracked: 'Tracked',
  new: 'Untracked',
  staged: 'Staged',
  unstaged: 'Unstaged',
}

export interface GitChangeGroup {
  readonly section: GitSection
  readonly title: string
  readonly entries: readonly GitChange[]
}

const hasStaged = (staging: GitStaging): boolean => staging !== 'unstaged'
const hasUnstaged = (staging: GitStaging): boolean => staging !== 'staged'

/** Rust `RepoPath` order: component by component, not by the raw string. */
function comparePaths(a: string, b: string): number {
  const left = a.split('/')
  const right = b.split('/')
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const l = left[index]!
    const r = right[index]!
    if (l !== r) return l < r ? -1 : 1
  }
  return left.length - right.length
}

const byPath = (entries: readonly GitChange[]): GitChange[] => [...entries].sort((a, b) => comparePaths(a.path, b.path))

/**
 * Zed `update_visible_entries`: the sections the list shows, in order. A
 * conflicted file is listed only under Conflicts. Grouped by staging state, a
 * partially staged file appears under both Staged and Unstaged, and those two
 * stay listed while anything is shown so the layout does not jump.
 */
export function groupChanges(changes: readonly GitChange[], groupBy: GitGroupBy = 'status'): GitChangeGroup[] {
  const conflict: GitChange[] = []
  const tracked: GitChange[] = []
  const created: GitChange[] = []
  const staged: GitChange[] = []
  const unstaged: GitChange[] = []
  for (const change of changes) {
    if (groupBy === 'staging') {
      if (change.conflicted) conflict.push(change)
      else {
        if (hasStaged(change.staging)) staged.push(change)
        if (hasUnstaged(change.staging)) unstaged.push(change)
      }
    } else if (change.conflicted) conflict.push(change)
    else if (change.created) created.push(change)
    else tracked.push(change)
  }
  const sections: (readonly [GitSection, GitChange[]])[] = groupBy === 'staging'
    ? [['conflict', conflict], ['staged', staged], ['unstaged', unstaged]]
    : [['conflict', conflict], ['tracked', tracked], ['new', created]]
  const anything = sections.some(([, entries]) => entries.length > 0)
  return sections
    .filter(([section, entries]) => entries.length > 0 || (groupBy === 'staging' && anything && (section === 'staged' || section === 'unstaged')))
    .map(([section, entries]) => ({ section, title: SECTION_TITLE[section], entries: byPath(entries) }))
}

/**
 * Zed `GitHeaderEntry::contains`: which files a section's bulk action sweeps.
 * Conflicted files are left out of Staged/Unstaged: "Unstage All" must not
 * silently un-resolve a conflict, nor "Stage All" mark one resolved.
 */
export function sectionContains(section: GitSection, change: GitChange): boolean {
  switch (section) {
    case 'conflict': return change.conflicted
    case 'tracked': return !change.created
    case 'new': return change.created
    case 'staged': return !change.conflicted && hasStaged(change.staging)
    case 'unstaged': return !change.conflicted && hasUnstaged(change.staging)
  }
}

/** Zed `StageIntent`. */
export type GitStageIntent = 'stage' | 'unstage' | 'toggle'

/** Zed `StageIntent::for_section`. */
export function stageIntentForSection(section: GitSection): GitStageIntent {
  return section === 'staged' ? 'unstage' : section === 'unstaged' ? 'stage' : 'toggle'
}

/**
 * Zed `StageIntent::resolve_with`: the direction of a staging control. A
 * section dictates one; a toggle reads the file, where a partly staged file
 * stages.
 */
export function stageIntent(staging: GitStaging, intent: GitStageIntent = 'toggle'): 'stage' | 'unstage' {
  if (intent !== 'toggle') return intent
  return staging === 'staged' ? 'unstage' : 'stage'
}

export type GitToggleState = 'unselected' | 'selected' | 'indeterminate'

/** The counts Zed's `update_counts` keeps. A conflict is counted as a conflict only; a created file as new. */
export interface GitChangeCounts {
  readonly entries: number
  readonly conflicted: number
  readonly conflictedStaged: number
  readonly tracked: number
  readonly trackedStaged: number
  readonly created: number
  readonly createdStaged: number
  /** Zed `has_staged_changes`. */
  readonly hasStaged: boolean
  /** Zed `has_tracked_changes`. */
  readonly hasTracked: boolean
  /** Zed `has_unstaged_changes`. */
  readonly hasUnstaged: boolean
  /** Zed `has_unstaged_conflicts`. */
  readonly hasUnstagedConflicts: boolean
}

export function changeCounts(changes: readonly GitChange[]): GitChangeCounts {
  let conflicted = 0
  let conflictedStaged = 0
  let tracked = 0
  let trackedStaged = 0
  let created = 0
  let createdStaged = 0
  let unstaged = false
  let unstagedConflicts = false
  for (const change of changes) {
    const staged = hasStaged(change.staging)
    if (hasUnstaged(change.staging)) {
      unstaged = true
      if (change.conflicted) unstagedConflicts = true
    }
    if (change.conflicted) {
      conflicted++
      if (staged) conflictedStaged++
    } else if (change.created) {
      created++
      if (staged) createdStaged++
    } else {
      tracked++
      if (staged) trackedStaged++
    }
  }
  return {
    entries: changes.length,
    conflicted,
    conflictedStaged,
    tracked,
    trackedStaged,
    created,
    createdStaged,
    hasStaged: trackedStaged + createdStaged + conflictedStaged > 0,
    hasTracked: tracked > 0,
    hasUnstaged: unstaged,
    hasUnstagedConflicts: unstagedConflicts,
  }
}

/** Zed `header_state`: the checkbox of a section header. */
export function headerToggleState(section: GitSection, changes: readonly GitChange[]): GitToggleState {
  const counts = changeCounts(changes)
  const [stagedCount, count] = ((): readonly [number, number] => {
    switch (section) {
      case 'new': return [counts.createdStaged, counts.created]
      case 'tracked': return [counts.trackedStaged, counts.tracked]
      case 'conflict': return [counts.conflictedStaged, counts.conflicted]
      case 'staged': return [counts.entries, counts.entries]
      case 'unstaged': return [0, counts.entries]
    }
  })()
  if (stagedCount === 0) return 'unselected'
  return count === stagedCount ? 'selected' : 'indeterminate'
}

/** Zed `primary_changes_action_stages`: the header's main button stages, or unstages when nothing is left to stage. */
export function primaryChangesActionStages(changes: readonly GitChange[]): boolean {
  return changes.length === 0 || changeCounts(changes).hasUnstaged
}

export interface CommitButtonInput {
  /** Zed `has_unstaged_conflicts`. */
  readonly conflicts: boolean
  readonly staged: boolean
  readonly tracked: boolean
  /** Amend mode is on. */
  readonly amend: boolean
  /** A commit is running. */
  readonly pending: boolean
  /** The message editor has text. */
  readonly message: boolean
}

/** Zed `commit_button_title`. */
export function commitButtonTitle(input: Pick<CommitButtonInput, 'amend' | 'staged' | 'tracked'>): string {
  if (input.amend) return input.staged ? 'Amend' : input.tracked ? 'Amend Tracked' : 'Amend'
  return input.staged ? 'Commit' : 'Commit Tracked'
}

/** Zed `configure_commit_button`: whether the button works and, when it does not, why. */
export function commitButton(input: CommitButtonInput): { readonly enabled: boolean; readonly title: string } {
  if (input.conflicts) return { enabled: false, title: 'You must resolve conflicts before committing' }
  if (!input.staged && !input.tracked && !input.amend) return { enabled: false, title: 'No changes to commit' }
  if (input.pending) return { enabled: false, title: 'Commit in progress' }
  if (!input.message) return { enabled: false, title: 'No commit message' }
  return { enabled: true, title: commitButtonTitle(input) }
}

export type GitRemoteButtonAction = 'fetch' | 'push' | 'pull' | 'publish' | 'republish'

export interface GitRemoteButton {
  readonly action: GitRemoteButtonAction
  readonly label: string
  readonly ahead: number
  readonly behind: number
  readonly tooltip: string
  /** The command named in Zed's tooltip. */
  readonly command: string
}

/**
 * Zed `render_remote_button` (with the fetch button shown): which button the
 * footer renders for the branch's upstream. Level with the upstream fetches,
 * ahead only pushes, behind pulls, a gone upstream republishes, none publishes.
 */
export function remoteButton(track: GitUpstreamTrack): GitRemoteButton {
  if (track.kind === 'none') {
    return { action: 'publish', label: 'Publish', ahead: 0, behind: 0, tooltip: 'Publish branch to remote', command: 'git push --set-upstream' }
  }
  if (track.kind === 'gone') {
    return { action: 'republish', label: 'Republish', ahead: 0, behind: 0, tooltip: 'Re-publish branch to remote', command: 'git push --set-upstream' }
  }
  const { ahead, behind } = track
  if (ahead === 0 && behind === 0) {
    return { action: 'fetch', label: 'Fetch', ahead, behind, tooltip: 'Fetch updates from remote', command: 'git fetch' }
  }
  if (behind === 0) {
    return { action: 'push', label: 'Push', ahead, behind, tooltip: 'Push committed changes to remote', command: 'git push' }
  }
  return { action: 'pull', label: 'Pull', ahead, behind, tooltip: 'Pull', command: 'git pull' }
}

export interface GitConfirmation {
  readonly title: string
  /** File names, one per line, for the menu actions (`restore_tracked_files`, `clean_all`). */
  readonly details?: string
  readonly confirmLabel: string
}

const fileName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** Zed lists at most five names and then `and N more…`. */
function fileNames(entries: readonly GitChange[]): string {
  const names = entries.slice(0, 5).map((entry) => fileName(entry.path)).join('\n')
  return entries.length > 5 ? `${names}\nand ${entries.length - 5} more…` : names
}

/**
 * The question asked before discarding or trashing. `revert_entries` asks per
 * row and per count; the menu actions (`restore_tracked_files` for tracked
 * files, `clean_all` for untracked ones) ask about "these files" with a name
 * list, except for one file, which they hand to `revert_entries`. `null` means
 * there is nothing to do.
 */
export function confirmationForEntries(entries: readonly GitChange[], menu?: 'tracked' | 'untracked'): GitConfirmation | null {
  if (entries.length === 0) return null
  if (entries.length === 1) {
    const entry = entries[0]!
    const name = `\`${fileName(entry.path)}\``
    if (entry.deleted) return { title: `Are you sure you want to restore ${name}?`, confirmLabel: 'Restore File' }
    if (entry.created) return { title: `Trash ${name}?`, confirmLabel: 'Trash' }
    return { title: `Are you sure you want to discard changes to ${name}?`, confirmLabel: 'Discard Changes' }
  }
  if (menu === 'tracked') {
    return { title: 'Discard changes to these files?', details: fileNames(entries), confirmLabel: 'Restore Tracked Files' }
  }
  if (menu === 'untracked') {
    return { title: 'Trash these files?', details: fileNames(entries), confirmLabel: 'Trash' }
  }
  const untracked = entries.filter((entry) => entry.created).length
  const tracked = entries.length - untracked
  if (untracked === 0) return { title: `Discard changes to ${tracked} files?`, confirmLabel: 'Discard' }
  if (tracked === 0) return { title: `Trash ${untracked} files?`, confirmLabel: 'Trash' }
  return { title: `Discard changes to ${tracked} files and trash ${untracked} files?`, confirmLabel: 'Discard and Trash' }
}
