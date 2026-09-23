import { useCallback, useEffect, useState } from 'react'

import type { FileFocus } from '../lib/tool-facts.ts'

/**
 * The lines the viewer should land on. `seq` rises on every request, so
 * asking for the same window twice scrolls back to it twice.
 */
export interface ViewerFocus extends FileFocus {
  readonly seq: number
}

interface FilesState {
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

  return { ...state, setFolder, openFile, closeFile, showFixedView }
}
