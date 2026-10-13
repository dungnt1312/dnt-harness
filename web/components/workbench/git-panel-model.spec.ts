import { describe, expect, it } from 'vitest'
import type { GitChange, GitStaging } from '../../lib/api.ts'
import {
  changeCounts,
  commitButton,
  commitButtonTitle,
  confirmationForEntries,
  groupChanges,
  headerToggleState,
  primaryChangesActionStages,
  remoteButton,
  sectionContains,
  stageIntent,
  stageIntentForSection,
  suggestCommitMessage,
  type CommitButtonInput,
} from './git-panel-model.ts'

interface Spec {
  readonly path: string
  readonly staging?: GitStaging
  readonly created?: boolean
  readonly deleted?: boolean
  readonly conflicted?: boolean
}

/** A change shaped like the server's `GitChange`; the staging default is "unstaged tracked modification". */
function change({ path, staging = 'unstaged', created = false, deleted = false, conflicted = false }: Spec): GitChange {
  return {
    path,
    status: conflicted ? 'conflict' : created ? 'untracked' : deleted ? 'deleted' : 'modified',
    indexStatus: staging === 'unstaged' ? ' ' : 'M',
    worktreeStatus: staging === 'staged' ? ' ' : 'M',
    created,
    deleted,
    conflicted,
    staging,
  }
}

const MIXED: readonly GitChange[] = [
  change({ path: 'src/b.ts', staging: 'staged' }),
  change({ path: 'new.txt', created: true }),
  change({ path: 'src/a.ts', staging: 'partial' }),
  change({ path: 'merge.ts', conflicted: true }),
]

describe('groupChanges (Zed Section / update_visible_entries)', () => {
  it('groups by file status: Conflicts, Tracked, Untracked, empty sections dropped', () => {
    expect(groupChanges(MIXED).map((group) => group.title)).toEqual(['Conflicts', 'Tracked', 'Untracked'])
    expect(groupChanges([change({ path: 'a.ts' })]).map((group) => group.title)).toEqual(['Tracked'])
    expect(groupChanges([])).toEqual([])
  })

  it('sorts entries by path within a section', () => {
    const tracked = groupChanges(MIXED).find((group) => group.section === 'tracked')
    expect(tracked?.entries.map((entry) => entry.path)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('a conflicted file is listed only under Conflicts', () => {
    const groups = groupChanges([change({ path: 'm.ts', conflicted: true, created: true })])
    expect(groups.map((group) => group.section)).toEqual(['conflict'])
  })

  it('grouped by staging state a partially staged file appears in both Staged and Unstaged', () => {
    const groups = groupChanges(MIXED, 'staging')
    expect(groups.map((group) => group.title)).toEqual(['Conflicts', 'Staged', 'Unstaged'])
    const paths = (title: string): string[] => groups.find((group) => group.title === title)!.entries.map((entry) => entry.path)
    expect(paths('Staged')).toEqual(['src/a.ts', 'src/b.ts'])
    expect(paths('Unstaged')).toEqual(['new.txt', 'src/a.ts'])
  })

  it('Staged and Unstaged stay pinned while anything is listed, so the layout is stable', () => {
    const groups = groupChanges([change({ path: 'a.ts', staging: 'staged' })], 'staging')
    expect(groups.map((group) => group.title)).toEqual(['Staged', 'Unstaged'])
    expect(groups[1]!.entries).toEqual([])
    expect(groupChanges([], 'staging')).toEqual([])
  })
})

describe('sectionContains (Zed GitHeaderEntry::contains)', () => {
  const partial = change({ path: 'p.ts', staging: 'partial' })
  const conflict = change({ path: 'c.ts', conflicted: true })
  const created = change({ path: 'n.ts', created: true })

  it('Tracked is not created, Untracked is created', () => {
    expect(sectionContains('tracked', partial)).toBe(true)
    expect(sectionContains('tracked', created)).toBe(false)
    expect(sectionContains('new', created)).toBe(true)
    expect(sectionContains('new', partial)).toBe(false)
  })

  it('Staged and Unstaged sweep partial files but never conflicts', () => {
    expect(sectionContains('staged', partial)).toBe(true)
    expect(sectionContains('unstaged', partial)).toBe(true)
    expect(sectionContains('staged', change({ path: 's.ts', staging: 'staged' }))).toBe(true)
    expect(sectionContains('unstaged', change({ path: 's.ts', staging: 'staged' }))).toBe(false)
    expect(sectionContains('staged', conflict)).toBe(false)
    expect(sectionContains('unstaged', conflict)).toBe(false)
  })

  it('Conflict is the conflicted files', () => {
    expect(sectionContains('conflict', conflict)).toBe(true)
    expect(sectionContains('conflict', partial)).toBe(false)
  })
})

describe('stage intent (Zed StageIntent::resolve_with)', () => {
  it('a partially staged file stages, an unstaged one stages, a staged one unstages', () => {
    expect(stageIntent('partial')).toBe('stage')
    expect(stageIntent('unstaged')).toBe('stage')
    expect(stageIntent('staged')).toBe('unstage')
  })

  it('a section dictates the direction regardless of the file state', () => {
    expect(stageIntentForSection('staged')).toBe('unstage')
    expect(stageIntentForSection('unstaged')).toBe('stage')
    expect(stageIntentForSection('tracked')).toBe('toggle')
    expect(stageIntent('staged', 'stage')).toBe('stage')
    expect(stageIntent('unstaged', 'unstage')).toBe('unstage')
    expect(stageIntent('partial', stageIntentForSection('staged'))).toBe('unstage')
  })
})

describe('headerToggleState (Zed header_state)', () => {
  it('Unselected with nothing staged, Selected when all are, Indeterminate otherwise', () => {
    const tracked = [change({ path: 'a', staging: 'staged' }), change({ path: 'b' })]
    expect(headerToggleState('tracked', tracked)).toBe('indeterminate')
    expect(headerToggleState('tracked', [tracked[0]!])).toBe('selected')
    expect(headerToggleState('tracked', [tracked[1]!])).toBe('unselected')
    expect(headerToggleState('tracked', [change({ path: 'p', staging: 'partial' })])).toBe('selected')
    expect(headerToggleState('tracked', [])).toBe('unselected')
  })

  it('counts New and Conflict apart from Tracked', () => {
    const changes = [change({ path: 'n', created: true, staging: 'staged' }), change({ path: 't' }), change({ path: 'c', conflicted: true })]
    expect(headerToggleState('new', changes)).toBe('selected')
    expect(headerToggleState('tracked', changes)).toBe('unselected')
    expect(headerToggleState('conflict', changes)).toBe('unselected')
  })

  it('Staged is always selected when listed and Unstaged never', () => {
    const changes = [change({ path: 'a' })]
    expect(headerToggleState('staged', changes)).toBe('selected')
    expect(headerToggleState('unstaged', changes)).toBe('unselected')
    expect(headerToggleState('staged', [])).toBe('unselected')
  })
})

describe('changeCounts and the primary action', () => {
  it('counts per Zed update_counts', () => {
    expect(changeCounts(MIXED)).toMatchObject({
      entries: 4,
      conflicted: 1,
      conflictedStaged: 0,
      tracked: 2,
      trackedStaged: 2,
      created: 1,
      createdStaged: 0,
      hasStaged: true,
      hasTracked: true,
      hasUnstagedConflicts: true,
    })
  })

  it('stages when empty or anything is unstaged, unstages when everything is staged', () => {
    expect(primaryChangesActionStages([])).toBe(true)
    expect(primaryChangesActionStages(MIXED)).toBe(true)
    expect(primaryChangesActionStages([change({ path: 'a', staging: 'staged' })])).toBe(false)
    expect(primaryChangesActionStages([change({ path: 'a', staging: 'partial' })])).toBe(true)
  })
})

describe('commitButton (Zed configure_commit_button / commit_button_title)', () => {
  const ready: CommitButtonInput = { conflicts: false, staged: true, tracked: true, amend: false, pending: false, message: true }

  it('is enabled with a title when everything is in order', () => {
    expect(commitButton(ready)).toEqual({ enabled: true, title: 'Commit' })
  })

  it('unresolved conflicts win over every other reason', () => {
    expect(commitButton({ ...ready, conflicts: true, message: false })).toEqual({ enabled: false, title: 'You must resolve conflicts before committing' })
  })

  it('needs something to commit unless amending', () => {
    const empty = { ...ready, staged: false, tracked: false }
    expect(commitButton(empty)).toEqual({ enabled: false, title: 'No changes to commit' })
    expect(commitButton({ ...empty, amend: true })).toEqual({ enabled: true, title: 'Amend' })
  })

  it('reports a commit already running, then a missing message', () => {
    expect(commitButton({ ...ready, pending: true })).toEqual({ enabled: false, title: 'Commit in progress' })
    expect(commitButton({ ...ready, message: false })).toEqual({ enabled: false, title: 'No commit message' })
    expect(commitButton({ ...ready, pending: true, message: false }).title).toBe('Commit in progress')
  })

  it('titles: Commit, Commit Tracked, Amend, Amend Tracked', () => {
    expect(commitButtonTitle({ amend: false, staged: true, tracked: false })).toBe('Commit')
    expect(commitButtonTitle({ amend: false, staged: false, tracked: true })).toBe('Commit Tracked')
    expect(commitButtonTitle({ amend: true, staged: true, tracked: true })).toBe('Amend')
    expect(commitButtonTitle({ amend: true, staged: false, tracked: true })).toBe('Amend Tracked')
    expect(commitButtonTitle({ amend: true, staged: false, tracked: false })).toBe('Amend')
  })
})

describe('remoteButton (Zed render_remote_button)', () => {
  it('tracked and level fetches', () => {
    expect(remoteButton({ kind: 'tracked', ahead: 0, behind: 0 })).toMatchObject({ action: 'fetch', label: 'Fetch', ahead: 0, behind: 0 })
  })

  it('ahead only pushes', () => {
    expect(remoteButton({ kind: 'tracked', ahead: 4, behind: 0 })).toMatchObject({ action: 'push', label: 'Push', ahead: 4, behind: 0 })
  })

  it('behind pulls, whatever the ahead count', () => {
    expect(remoteButton({ kind: 'tracked', ahead: 2, behind: 3 })).toMatchObject({ action: 'pull', label: 'Pull', ahead: 2, behind: 3 })
    expect(remoteButton({ kind: 'tracked', ahead: 0, behind: 1 })).toMatchObject({ action: 'pull', label: 'Pull' })
  })

  it('a gone upstream republishes, no upstream publishes', () => {
    expect(remoteButton({ kind: 'gone' }).label).toBe('Republish')
    expect(remoteButton({ kind: 'gone' })).toMatchObject({ action: 'republish', ahead: 0, behind: 0 })
    expect(remoteButton({ kind: 'none' }).label).toBe('Publish')
    expect(remoteButton({ kind: 'none' }).action).toBe('publish')
  })

  it('carries the Zed tooltip text', () => {
    expect(remoteButton({ kind: 'none' }).tooltip).toBe('Publish branch to remote')
    expect(remoteButton({ kind: 'gone' }).tooltip).toBe('Re-publish branch to remote')
    expect(remoteButton({ kind: 'tracked', ahead: 1, behind: 0 }).tooltip).toBe('Push committed changes to remote')
    expect(remoteButton({ kind: 'tracked', ahead: 0, behind: 0 }).tooltip).toBe('Fetch updates from remote')
  })
})

describe('confirmationForEntries (Zed revert_entries / restore_tracked_files / clean_all)', () => {
  const modified = (path: string): GitChange => change({ path })
  const untracked = (path: string): GitChange => change({ path, created: true })

  it('nothing to confirm for no entries', () => {
    expect(confirmationForEntries([])).toBeNull()
  })

  it('one file: discard, restore (deleted) or trash (created) with the file name in code', () => {
    expect(confirmationForEntries([modified('src/a.ts')])).toEqual({
      title: 'Are you sure you want to discard changes to `a.ts`?',
      confirmLabel: 'Discard Changes',
    })
    expect(confirmationForEntries([change({ path: 'src/gone.ts', deleted: true })])).toEqual({
      title: 'Are you sure you want to restore `gone.ts`?',
      confirmLabel: 'Restore File',
    })
    expect(confirmationForEntries([untracked('x/new.txt')])).toEqual({ title: 'Trash `new.txt`?', confirmLabel: 'Trash' })
  })

  it('several files count tracked and created ones', () => {
    expect(confirmationForEntries([modified('a'), modified('b')])).toEqual({ title: 'Discard changes to 2 files?', confirmLabel: 'Discard' })
    expect(confirmationForEntries([untracked('a'), untracked('b'), untracked('c')])).toEqual({ title: 'Trash 3 files?', confirmLabel: 'Trash' })
    expect(confirmationForEntries([modified('a'), untracked('b'), untracked('c')])).toEqual({
      title: 'Discard changes to 1 files and trash 2 files?',
      confirmLabel: 'Discard and Trash',
    })
  })

  it('menu actions list up to five file names then "and N more…"', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => modified(`dir/${name}.ts`))
    expect(confirmationForEntries(many, 'tracked')).toEqual({
      title: 'Discard changes to these files?',
      details: 'a.ts\nb.ts\nc.ts\nd.ts\ne.ts\nand 2 more…',
      confirmLabel: 'Restore Tracked Files',
    })
    const five = many.slice(0, 5)
    expect(confirmationForEntries(five, 'tracked')?.details).toBe('a.ts\nb.ts\nc.ts\nd.ts\ne.ts')
    const created = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => untracked(`${name}.txt`))
    expect(confirmationForEntries(created, 'untracked')).toEqual({
      title: 'Trash these files?',
      details: 'a.txt\nb.txt\nc.txt\nd.txt\ne.txt\nand 1 more…',
      confirmLabel: 'Trash',
    })
  })

  it('a menu action on one file asks the single-file question', () => {
    expect(confirmationForEntries([modified('a.ts')], 'tracked')?.title).toBe('Are you sure you want to discard changes to `a.ts`?')
  })
})

describe('suggestCommitMessage (Zed suggest_commit_message, git_panel.rs:4047-4083)', () => {
  it('a merge message wins over everything', () => {
    expect(suggestCommitMessage([change({ path: 'a.ts', staging: 'staged' })], "Merge branch 'feature'")).toBe("Merge branch 'feature'")
  })

  it('one staged file names its action and base name', () => {
    expect(suggestCommitMessage([change({ path: 'src/a.ts', staging: 'staged' })])).toBe('Update a.ts')
    expect(suggestCommitMessage([change({ path: 'src/new.ts', staging: 'staged', created: true })])).toBe('Create new.ts')
    expect(suggestCommitMessage([change({ path: 'src/old.ts', staging: 'staged', deleted: true })])).toBe('Delete old.ts')
  })

  it('with nothing staged, exactly one tracked file is suggested', () => {
    expect(suggestCommitMessage([change({ path: 'src/a.ts' })])).toBe('Update a.ts')
    expect(suggestCommitMessage([change({ path: 'src/a.ts' }), change({ path: 'src/b.ts' })])).toBeUndefined()
  })

  it('an untracked file is not tracked, so it alone suggests nothing', () => {
    expect(suggestCommitMessage([change({ path: 'new.txt', created: true })])).toBeUndefined()
  })

  it('two staged files, or a staged file next to others, suggest nothing', () => {
    expect(suggestCommitMessage([change({ path: 'a', staging: 'staged' }), change({ path: 'b', staging: 'staged' })])).toBeUndefined()
  })

  it('a partly staged file counts as staged', () => {
    expect(suggestCommitMessage([change({ path: 'a.ts', staging: 'partial' })])).toBe('Update a.ts')
  })
})
