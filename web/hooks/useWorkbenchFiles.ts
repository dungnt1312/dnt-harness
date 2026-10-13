import { useCallback, useEffect, useState } from 'react'

import { isAtOrUnder } from '../lib/file-tree.ts'
import type { FileFocus } from '../lib/tool-facts.ts'

/**
 * The lines the viewer should land on. `seq` rises on every request, so
 * asking for the same window twice scrolls back to it twice.
 */
export interface ViewerFocus extends FileFocus {
  readonly seq: number
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
}

const EMPTY: FilesState = { folder: '', openFiles: [], activeFile: null, focus: null }

/** Closing the front tab reveals its right neighbour, else its left one, else the fixed view. */
export function closeFileTab(state: FilesState, path: string): FilesState {
  const index = state.openFiles.indexOf(path)
  if (index === -1) return state
  const openFiles = state.openFiles.filter((file) => file !== path)
  const activeFile = state.activeFile !== path ? state.activeFile : openFiles[Math.min(index, openFiles.length - 1)] ?? null
  // The window belonged to the tab being closed, not to whatever it reveals.
  return { ...state, openFiles, activeFile, focus: null }
}

const moved = (path: string, from: string, to: string): string => isAtOrUnder(path, from) ? `${to}${path.slice(from.length)}` : path

/** Rewrites every tab, the front tab and the shown folder at or under `from`. */
export function renameFileTabs(state: FilesState, from: string, to: string): FilesState {
  const touched = state.openFiles.some((file) => isAtOrUnder(file, from)) || isAtOrUnder(state.folder, from)
  if (!touched) return state
  return {
    ...state,
    folder: moved(state.folder, from, to),
    openFiles: state.openFiles.map((file) => moved(file, from, to)),
    activeFile: state.activeFile === null ? null : moved(state.activeFile, from, to),
  }
}

/** Closes every tab at or under `path`, revealing a neighbour like {@link closeFileTab}. */
export function removeFileTabs(state: FilesState, path: string): FilesState {
  const doomed = state.openFiles.filter((file) => isAtOrUnder(file, path))
  const folderGone = state.folder !== '' && isAtOrUnder(state.folder, path)
  if (doomed.length === 0 && !folderGone) return state
  let next: FilesState = folderGone ? { ...state, folder: '' } : state
  const frontGone = next.activeFile !== null && isAtOrUnder(next.activeFile, path)
  if (!frontGone) {
    return { ...next, openFiles: next.openFiles.filter((file) => !isAtOrUnder(file, path)) }
  }
  // Close the front tab last so the neighbour it reveals is a survivor.
  for (const file of doomed) if (file !== next.activeFile) next = { ...next, openFiles: next.openFiles.filter((open) => open !== file) }
  return closeFileTab(next, next.activeFile as string)
}

/**
 * Transient file-browsing state for one project. Switching the project (or
 * to no project) resets the folder and closes its file tabs, so paths from
 * one root are never read against another.
 */
export function useWorkbenchFiles(projectKey: string | null): WorkbenchFiles {
  const [state, setState] = useState<FilesState>(EMPTY)

  useEffect(() => { setState(EMPTY) }, [projectKey])

  const setFolder = useCallback((folder: string) => setState((current) => ({ ...current, folder })), [])
  const openFile = useCallback((path: string, focus?: FileFocus) => setState((current) => ({
    ...current,
    openFiles: current.openFiles.includes(path) ? current.openFiles : [...current.openFiles, path],
    activeFile: path,
    focus: focus === undefined ? null : { ...focus, seq: (current.focus?.seq ?? 0) + 1 },
  })), [])
  const closeFile = useCallback((path: string) => setState((current) => closeFileTab(current, path)), [])
  const showFixedView = useCallback(() => setState((current) => ({ ...current, activeFile: null })), [])

  const renamePath = useCallback((from: string, to: string) => setState((current) => renameFileTabs(current, from, to)), [])
  const removePath = useCallback((path: string) => setState((current) => removeFileTabs(current, path)), [])

  return { ...state, setFolder, openFile, closeFile, showFixedView, renamePath, removePath }
}
