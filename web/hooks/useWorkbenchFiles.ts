import { useCallback, useEffect, useRef, useState } from 'react'

import { isAtOrUnder } from '../lib/file-tree.ts'
import type { FileFocus } from '../lib/tool-facts.ts'

/**
 * The lines the viewer should land on. `seq` rises on every request, so
 * asking for the same window twice scrolls back to it twice.
 */
export interface ViewerFocus extends FileFocus {
  readonly seq: number
}

/** Unsaved editor text for one open file, kept while its tab is open. */
export interface FileDraft {
  readonly text: string
  /** Hash of the file the edit started from; the save sends it back. */
  readonly baseHash: string
  readonly dirty: boolean
}

export interface FilesState {
  /** Folder shown by the Files view (root-relative, '' = root). */
  readonly folder: string
  /** Opened file tabs in opening order. */
  readonly openFiles: readonly string[]
  /** The file tab in front, or null when a fixed view is showing. */
  readonly activeFile: string | null
  /** Where the front tab should land, when it was opened at a window. */
  readonly focus: ViewerFocus | null
  /** Unsaved editor text by path; survives tab switches, dropped when the tab closes. */
  readonly drafts: Readonly<Record<string, FileDraft>>
}

export interface WorkbenchFiles extends FilesState {
  readonly setFolder: (folder: string) => void
  readonly openFile: (path: string, focus?: FileFocus) => void
  readonly closeFile: (path: string) => void
  readonly showFixedView: () => void
  /** A file or folder was renamed in the explorer: rewrite its open tabs. */
  readonly renamePath: (from: string, to: string) => void
  /** A file or folder was deleted in the explorer: close its open tabs. */
  readonly removePath: (path: string) => void
  /** Store (or with null, clear) the unsaved text of an open file. */
  readonly setDraft: (path: string, draft: FileDraft | null) => void
  /** A save of `savedText` finished: drop the draft unless it has newer text (see {@link settleSavedDraft}). */
  readonly settleDraft: (path: string, savedText: string, newHash: string) => void
}

const EMPTY: FilesState = { folder: '', openFiles: [], activeFile: null, focus: null, drafts: {} }

const withoutDraft = (drafts: FilesState['drafts'], keep: (path: string) => boolean): FilesState['drafts'] =>
  Object.fromEntries(Object.entries(drafts).filter(([path]) => keep(path)))

/** Closing the front tab reveals its right neighbour, else its left one, else the fixed view. */
export function closeFileTab(state: FilesState, path: string): FilesState {
  const index = state.openFiles.indexOf(path)
  if (index === -1) return state
  const openFiles = state.openFiles.filter((file) => file !== path)
  const activeFile = state.activeFile !== path ? state.activeFile : openFiles[Math.min(index, openFiles.length - 1)] ?? null
  const drafts = state.drafts[path] === undefined ? state.drafts : withoutDraft(state.drafts, (key) => key !== path)
  // The window belonged to the tab being closed, not to whatever it reveals.
  return { ...state, openFiles, activeFile, focus: null, drafts }
}

/**
 * A save of `savedText` landed on disk as `newHash`. The draft goes only if it
 * still holds that text; text typed while the save was in flight stays, now
 * based on the saved file.
 */
export function settleSavedDraft(state: FilesState, path: string, savedText: string, newHash: string): FilesState {
  const draft = state.drafts[path]
  if (draft === undefined) return state
  if (draft.text === savedText) return { ...state, drafts: withoutDraft(state.drafts, (key) => key !== path) }
  return { ...state, drafts: { ...state.drafts, [path]: { text: draft.text, baseHash: newHash, dirty: true } } }
}

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** Close a tab, asking first when it holds unsaved changes; a refusal keeps everything. */
export function closeFileWithDraft(state: FilesState, path: string, confirm: (message: string) => boolean): FilesState {
  if (state.drafts[path]?.dirty === true && !confirm(`Discard unsaved changes to ${baseName(path)}?`)) return state
  return closeFileTab(state, path)
}

const moved = (path: string, from: string, to: string): string => isAtOrUnder(path, from) ? `${to}${path.slice(from.length)}` : path

/** Rewrites every tab, the front tab and the shown folder at or under `from`. */
export function renameFileTabs(state: FilesState, from: string, to: string): FilesState {
  const touched = state.openFiles.some((file) => isAtOrUnder(file, from)) || isAtOrUnder(state.folder, from)
    || Object.keys(state.drafts).some((file) => isAtOrUnder(file, from))
  if (!touched) return state
  return {
    ...state,
    folder: moved(state.folder, from, to),
    openFiles: state.openFiles.map((file) => moved(file, from, to)),
    activeFile: state.activeFile === null ? null : moved(state.activeFile, from, to),
    drafts: Object.fromEntries(Object.entries(state.drafts).map(([file, draft]) => [moved(file, from, to), draft])),
  }
}

/** Closes every tab at or under `path`, revealing a neighbour like {@link closeFileTab}. */
export function removeFileTabs(state: FilesState, path: string): FilesState {
  const doomed = state.openFiles.filter((file) => isAtOrUnder(file, path))
  const folderGone = state.folder !== '' && isAtOrUnder(state.folder, path)
  const draftsGone = Object.keys(state.drafts).some((file) => isAtOrUnder(file, path))
  if (doomed.length === 0 && !folderGone && !draftsGone) return state
  let next: FilesState = folderGone ? { ...state, folder: '' } : state
  if (draftsGone) next = { ...next, drafts: withoutDraft(next.drafts, (file) => !isAtOrUnder(file, path)) }
  const frontGone = next.activeFile !== null && isAtOrUnder(next.activeFile, path)
  if (!frontGone) {
    return { ...next, openFiles: next.openFiles.filter((file) => !isAtOrUnder(file, path)) }
  }
  // Close the front tab last so the neighbour it reveals is a survivor.
  for (const file of doomed) if (file !== next.activeFile) next = { ...next, openFiles: next.openFiles.filter((open) => open !== file) }
  return closeFileTab(next, next.activeFile as string)
}

const hasDirtyDraft = (state: FilesState): boolean => Object.values(state.drafts).some((draft) => draft.dirty)

/**
 * Moving from one project to another: the state being left is kept in the
 * stash only when it holds an unsaved draft (otherwise any older stash of that
 * project is dropped), and the entered project gets its stash back, else an
 * empty state. A `null` key (no project) never stashes. `stash` is not mutated.
 */
export function switchProject(
  stash: ReadonlyMap<string, FilesState>,
  leavingKey: string | null,
  leaving: FilesState,
  enteringKey: string | null,
): { state: FilesState; stash: Map<string, FilesState> } {
  const next = new Map(stash)
  if (leavingKey !== null) {
    if (hasDirtyDraft(leaving)) next.set(leavingKey, leaving)
    else next.delete(leavingKey)
  }
  const restored = enteringKey === null ? undefined : next.get(enteringKey)
  if (enteringKey !== null) next.delete(enteringKey)
  return { state: restored ?? EMPTY, stash: next }
}

/**
 * Transient file-browsing state for one project. Switching the project (or
 * to no project) resets the folder and closes its file tabs, so paths from
 * one root are never read against another. A project left with unsaved
 * drafts keeps its state aside and gets it back on return.
 */
export function useWorkbenchFiles(projectKey: string | null): WorkbenchFiles {
  const [state, setState] = useState<FilesState>(EMPTY)
  const stash = useRef<ReadonlyMap<string, FilesState>>(new Map())
  const [anyStashed, setAnyStashed] = useState(false)
  const keyRef = useRef(projectKey)
  // The confirm dialog must not run inside a state updater (React may call updaters twice).
  const latest = useRef(state)
  latest.current = state

  useEffect(() => {
    if (keyRef.current === projectKey) return
    const next = switchProject(stash.current, keyRef.current, latest.current, projectKey)
    keyRef.current = projectKey
    stash.current = next.stash
    setAnyStashed(next.stash.size > 0)
    setState(next.state)
  }, [projectKey])

  const setFolder = useCallback((folder: string) => setState((current) => ({ ...current, folder })), [])
  const openFile = useCallback((path: string, focus?: FileFocus) => setState((current) => ({
    ...current,
    openFiles: current.openFiles.includes(path) ? current.openFiles : [...current.openFiles, path],
    activeFile: path,
    focus: focus === undefined ? null : { ...focus, seq: (current.focus?.seq ?? 0) + 1 },
  })), [])
  const closeFile = useCallback((path: string) => {
    if (closeFileWithDraft(latest.current, path, (message) => window.confirm(message)) === latest.current) return
    setState((current) => closeFileTab(current, path))
  }, [])
  const setDraft = useCallback((path: string, draft: FileDraft | null) => setState((current) => {
    if (draft === null) {
      if (current.drafts[path] === undefined) return current
      const { [path]: _gone, ...rest } = current.drafts
      return { ...current, drafts: rest }
    }
    return { ...current, drafts: { ...current.drafts, [path]: draft } }
  }), [])
  const settleDraft = useCallback((path: string, savedText: string, newHash: string) => setState((current) => settleSavedDraft(current, path, savedText, newHash)), [])
  // Only dirty states are stashed, so any stash means unsaved work.
  const anyDirty = hasDirtyDraft(state) || anyStashed
  useEffect(() => {
    if (!anyDirty) return
    const warn = (event: BeforeUnloadEvent): void => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [anyDirty])
  const showFixedView = useCallback(() => setState((current) => ({ ...current, activeFile: null })), [])

  const renamePath = useCallback((from: string, to: string) => setState((current) => renameFileTabs(current, from, to)), [])
  const removePath = useCallback((path: string) => setState((current) => removeFileTabs(current, path)), [])

  return { ...state, setFolder, openFile, closeFile, showFixedView, renamePath, removePath, setDraft, settleDraft }
}
