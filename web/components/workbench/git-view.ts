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
