/** How the change list is drawn: Zed's `git_panel.tree_view` setting, kept in this browser. */
export type GitListView = 'list' | 'tree'

const KEY = 'dnt-harness.git.view'

/** List unless the reader chose Tree; anything unreadable is the default. */
export function readView(): GitListView {
  try { return window.localStorage.getItem(KEY) === 'tree' ? 'tree' : 'list' } catch { return 'list' }
}

export function writeView(view: GitListView): void {
  try { window.localStorage.setItem(KEY, view) } catch { /* storage may be unavailable */ }
}

const COMMIT_KEY = 'dnt-harness.git.commitCollapsed'

/** The commit block is open unless the reader folded it. */
export function readCommitCollapsed(): boolean {
  try { return window.localStorage.getItem(COMMIT_KEY) === '1' } catch { return false }
}

export function writeCommitCollapsed(collapsed: boolean): void {
  try { window.localStorage.setItem(COMMIT_KEY, collapsed ? '1' : '0') } catch { /* storage may be unavailable */ }
}

const LAYOUT_KEY = 'dnt-harness.git.diffLayout'

/** Unified (vertical) unless the reader chose Split (side by side). */
export function readDiffLayout(): 'unified' | 'split' {
  try { return window.localStorage.getItem(LAYOUT_KEY) === 'split' ? 'split' : 'unified' } catch { return 'unified' }
}

export function writeDiffLayout(layout: 'unified' | 'split'): void {
  try { window.localStorage.setItem(LAYOUT_KEY, layout) } catch { /* storage may be unavailable */ }
}
