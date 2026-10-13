/**
 * The Git panel's tree view (Zed `git_panel.rs:864-998`): the changes of one
 * section grouped by directory, directories before files, in name order, and a
 * directory that holds no file and exactly one child directory merged into it
 * (`a/b/c`). Pure, so the rules are pinned by tests and the component only draws.
 */
import type { GitChange } from '../../lib/api.ts'
import { stageIntent, type GitToggleState } from './git-panel-model.ts'

export type GitTreeNode =
  | {
    readonly kind: 'dir'
    /** The full directory path (the compacted one: `a/b/c`); unique, and the collapse key. */
    readonly key: string
    /** What the row shows: the path relative to its parent node (`web`, or `src/web` after compaction at the top). */
    readonly name: string
    readonly path: string
    readonly depth: number
    /** Every change beneath this directory, at any depth. */
    readonly entries: readonly GitChange[]
  }
  | { readonly kind: 'file'; readonly key: string; readonly change: GitChange; readonly depth: number }

interface Dir {
  readonly name: string
  readonly path: string
  readonly dirs: Map<string, Dir>
  readonly files: GitChange[]
  readonly entries: GitChange[]
}

const newDir = (name: string, path: string): Dir => ({ name, path, dirs: new Map(), files: [], entries: [] })

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Flattened pre-order nodes: each directory, then its subdirectories, then its files. */
export function buildTree(entries: readonly GitChange[]): GitTreeNode[] {
  const root = newDir('', '')
  for (const change of entries) {
    const parts = change.path.split('/')
    parts.pop() // the file name; only its directories build the tree
    let cursor = root
    root.entries.push(change)
    let walked = ''
    for (const part of parts) {
      walked = walked === '' ? part : `${walked}/${part}`
      let next = cursor.dirs.get(part)
      if (next === undefined) {
        next = newDir(part, walked)
        cursor.dirs.set(part, next)
      }
      next.entries.push(change)
      cursor = next
    }
    cursor.files.push(change)
  }
  const nodes: GitTreeNode[] = []
  const visit = (dir: Dir, depth: number): void => {
    for (const name of [...dir.dirs.keys()].sort(byName)) {
      let child = dir.dirs.get(name)!
      let label = child.name
      // Zed `compact_directory_chain`: no files, exactly one child directory → merge them.
      while (child.files.length === 0 && child.dirs.size === 1) {
        child = [...child.dirs.values()][0]!
        label = `${label}/${child.name}`
      }
      nodes.push({ kind: 'dir', key: child.path, name: label, path: child.path, depth, entries: child.entries })
      visit(child, depth + 1)
    }
    for (const change of [...dir.files].sort((a, b) => byName(a.path, b.path))) {
      nodes.push({ kind: 'file', key: change.path, change, depth })
    }
  }
  visit(root, 0)
  return nodes
}

/** The nodes the list draws: a collapsed directory hides everything beneath it. */
export function visibleNodes(nodes: readonly GitTreeNode[], collapsed: ReadonlySet<string>): GitTreeNode[] {
  const hidden: string[] = []
  const out: GitTreeNode[] = []
  for (const node of nodes) {
    const path = node.kind === 'dir' ? node.path : node.change.path
    if (hidden.some((prefix) => path.startsWith(`${prefix}/`))) continue
    out.push(node)
    if (node.kind === 'dir' && collapsed.has(node.key)) hidden.push(node.path)
  }
  return out
}

/** Zed `header_state` for a folder: all staged is checked, any staged or partial is indeterminate. */
export function folderToggleState(entries: readonly GitChange[]): GitToggleState {
  // A partly staged file is neither staged nor unstaged: it makes its folder indeterminate.
  const staged = entries.filter((entry) => entry.staging === 'staged').length
  const partial = entries.some((entry) => entry.staging === 'partial')
  if (staged === 0 && !partial) return 'unselected'
  return staged === entries.length ? 'selected' : 'indeterminate'
}

/**
 * What a folder click sends (Zed `toggle_staged_for_entry`): a fully staged
 * folder unstages, anything else stages — and only the descendants that are
 * not already where the click sends them.
 */
export function folderStageTargets(entries: readonly GitChange[], state: GitToggleState): { paths: string[]; intent: 'stage' | 'unstage' } {
  const current = state === 'selected' ? 'staged' : state === 'indeterminate' ? 'partial' : 'unstaged'
  const intent = stageIntent(current)
  const paths = entries
    .filter((change) => intent === 'stage' ? change.staging !== 'staged' : change.staging !== 'unstaged')
    .map((change) => change.path)
  return { paths, intent }
}
