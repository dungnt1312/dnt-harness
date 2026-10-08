// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useTerminalProjects } from './useTerminalProjects.ts'
import {
  TERMINAL_PROJECTS_STORAGE_KEY,
  WORKBENCH_STORAGE_KEY,
  parseTerminalProjects,
  withProjectTerminalTab,
  type TerminalProjectState,
} from '../lib/workbench-preferences.ts'

let root: Root | undefined
let host: HTMLDivElement
let latest: TerminalProjectState | undefined
let patch: ((change: Partial<TerminalProjectState>) => void) | undefined
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = undefined
  window.localStorage.clear()
})

function Probe({ projectKey, legacyTab = false }: { readonly projectKey: string | null; readonly legacyTab?: boolean }) {
  const hook = useTerminalProjects(projectKey, legacyTab)
  latest = hook.state
  patch = hook.patch
  return null
}

async function render(projectKey: string | null, legacyTab = false) {
  if (root === undefined) {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  }
  await act(async () => root!.render(<Probe projectKey={projectKey} legacyTab={legacyTab} />))
}

describe('useTerminalProjects', () => {
  it('shares state within a folder and keeps folders apart', async () => {
    await render('ws:a')
    expect(latest).toEqual({ footerOpen: false, workbenchTab: false })
    await act(async () => patch!({ footerOpen: true }))
    expect(latest).toEqual({ footerOpen: true, workbenchTab: false })

    // Another folder is untouched by A's footer.
    await render('ws:b')
    expect(latest).toEqual({ footerOpen: false, workbenchTab: false })
    await act(async () => patch!({ workbenchTab: true }))

    // Back to A (any conversation in it): A's own state.
    await render('ws:a')
    expect(latest).toEqual({ footerOpen: true, workbenchTab: false })
    expect(parseTerminalProjects(window.localStorage.getItem(TERMINAL_PROJECTS_STORAGE_KEY))).toEqual({
      'ws:a': { footerOpen: true, workbenchTab: false },
      'ws:b': { footerOpen: false, workbenchTab: true },
    })
  })

  it('reads closed and drops patches while the project binding is unknown', async () => {
    await render(null)
    await act(async () => patch!({ footerOpen: true }))
    expect(latest).toEqual({ footerOpen: false, workbenchTab: false })
    expect(window.localStorage.getItem(TERMINAL_PROJECTS_STORAGE_KEY)).toBeNull()
  })

  it('seeds from the pre-split global footer and session tab on the first load only', async () => {
    window.localStorage.setItem(WORKBENCH_STORAGE_KEY, JSON.stringify({ terminalOpen: true }))
    await render('ws:a', true)
    expect(latest).toEqual({ footerOpen: true, workbenchTab: true })
    await act(async () => root!.unmount())
    root = undefined

    // Once any project has a record, the legacy values no longer seed.
    window.localStorage.setItem(TERMINAL_PROJECTS_STORAGE_KEY, JSON.stringify({ 'ws:x': { footerOpen: false, workbenchTab: false } }))
    await render('ws:a', true)
    expect(latest).toEqual({ footerOpen: false, workbenchTab: false })
  })
})

describe('withProjectTerminalTab', () => {
  it('adds or removes only the Terminal tab, keeping its stored place', () => {
    expect(withProjectTerminalTab(['files', 'git'], true)).toEqual(['files', 'git', 'terminal'])
    expect(withProjectTerminalTab(['files', 'terminal', 'git'], true)).toEqual(['files', 'terminal', 'git'])
    expect(withProjectTerminalTab(['files', 'terminal', 'git'], false)).toEqual(['files', 'git'])
  })
})
