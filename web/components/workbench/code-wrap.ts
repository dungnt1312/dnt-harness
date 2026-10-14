/**
 * The soft-wrap choice for the workbench editor, kept across files and
 * reloads. Its own module, not CodePane's: the viewer reads it eagerly, and
 * anything imported from CodePane would pull CodeMirror into the main bundle.
 */
const WRAP_KEY = 'dnt.editor.wrap'

export function readWrap(): boolean {
  try { return window.localStorage.getItem(WRAP_KEY) === '1' } catch { return false }
}

export function writeWrap(on: boolean): void {
  try { window.localStorage.setItem(WRAP_KEY, on ? '1' : '0') } catch { /* private mode: the choice just does not persist */ }
}
