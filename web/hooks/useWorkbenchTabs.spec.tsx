// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useWorkbenchTabs, WORKBENCH_TABS_MAX } from './useWorkbenchTabs.ts'
import { WORKBENCH_STORAGE_KEY, WORKBENCH_TABS_STORAGE_KEY } from '../lib/workbench-preferences.ts'

let root: Root | undefined
let host: HTMLDivElement
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = undefined
  window.localStorage.clear()
})

/** Renders the hook for one conversation key and re-renders when the key changes. */
function TabsProbe({ sessionKey, onTabs }: { readonly sessionKey: string | null; readonly onTabs?: (tabs: unknown) => void }) {
  const { tabs, patchTabs } = useWorkbenchTabs(sessionKey)
  onTabs?.(tabs)
  return (
    <button
      type="button"
      onClick={() => patchTabs({ inspectorTab: 'trajectory', inspectorViews: [...tabs.inspectorViews, 'trajectory'] })}
    >
      open trajectory
    </button>
  )
}

async function mountProbe(sessionKey: string | null, onTabs?: (tabs: unknown) => void) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<TabsProbe sessionKey={sessionKey} {...(onTabs !== undefined ? { onTabs } : {})} />))
}

describe('useWorkbenchTabs', () => {
  it('starts every conversation from defaults and remembers patches per key', async () => {
    const seen: unknown[] = []
    await mountProbe('w1:s1', (tabs) => seen.push(tabs))
    expect(seen.at(-1)).toEqual({ inspectorTab: 'files', inspectorViews: ['files'] })

    await act(async () => (host.querySelector('button') as HTMLButtonElement).click())
    expect(seen.at(-1)).toEqual({ inspectorTab: 'trajectory', inspectorViews: ['files', 'trajectory'] })
    expect(JSON.parse(window.localStorage.getItem(WORKBENCH_TABS_STORAGE_KEY)!)).toMatchObject({
      'w1:s1': { inspectorTab: 'trajectory', inspectorViews: ['files', 'trajectory'] },
    })

    // Another conversation is unaffected; a null key (no workspace yet) reads
    // as defaults and drops patches.
    seen.length = 0
    await act(async () => root!.render(<TabsProbe sessionKey="w1:s2" onTabs={(tabs) => seen.push(tabs)} />))
    expect(seen.at(-1)).toEqual({ inspectorTab: 'files', inspectorViews: ['files'] })
    await act(async () => root!.render(<TabsProbe sessionKey={null} onTabs={(tabs) => seen.push(tabs)} />))
    expect(seen.at(-1)).toEqual({ inspectorTab: 'files', inspectorViews: ['files'] })
    await act(async () => (host.querySelector('button') as HTMLButtonElement).click())
    expect(window.localStorage.getItem(WORKBENCH_TABS_STORAGE_KEY)).not.toContain('"w1:s2"')
  })

  it('seeds conversations without a record from the legacy global tab fields once', async () => {
    window.localStorage.setItem(WORKBENCH_STORAGE_KEY, JSON.stringify({ inspectorTab: 'git', inspectorViews: ['files', 'git'] }))
    const seen: unknown[] = []
    await mountProbe('w1:s1', (tabs) => seen.push(tabs))
    expect(seen.at(-1)).toEqual({ inspectorTab: 'git', inspectorViews: ['files', 'git'] })

    // Writing this conversation's own record leaves the legacy fields intact
    // for nothing — they are read once at load, then the record rules. The
    // patch merges with the seeded strip, so 'git' stays open beside it.
    await act(async () => (host.querySelector('button') as HTMLButtonElement).click())
    expect(JSON.parse(window.localStorage.getItem(WORKBENCH_TABS_STORAGE_KEY)!)).toMatchObject({
      'w1:s1': { inspectorTab: 'trajectory', inspectorViews: ['files', 'git', 'trajectory'] },
    })
  })

  it('an existing per-session record wins over the legacy seed', async () => {
    window.localStorage.setItem(WORKBENCH_STORAGE_KEY, JSON.stringify({ inspectorTab: 'git', inspectorViews: ['files', 'git'] }))
    window.localStorage.setItem(WORKBENCH_TABS_STORAGE_KEY, JSON.stringify({
      'w1:s1': { inspectorTab: 'files', inspectorViews: ['files'] },
    }))
    const seen: unknown[] = []
    await mountProbe('w1:s1', (tabs) => seen.push(tabs))
    expect(seen.at(-1)).toEqual({ inspectorTab: 'files', inspectorViews: ['files'] })
  })

  it('caps the record at the most recent conversations', async () => {
    const seeded: Record<string, { inspectorTab: string; inspectorViews: string[] }> = {}
    for (let index = 0; index < WORKBENCH_TABS_MAX + 4; index += 1) {
      seeded[`w1:old-${index}`] = { inspectorTab: 'files', inspectorViews: ['files'] }
    }
    window.localStorage.setItem(WORKBENCH_TABS_STORAGE_KEY, JSON.stringify(seeded))
    await mountProbe('w1:new')
    await act(async () => (host.querySelector('button') as HTMLButtonElement).click())
    const stored = JSON.parse(window.localStorage.getItem(WORKBENCH_TABS_STORAGE_KEY)!)
    expect(Object.keys(stored)).toHaveLength(WORKBENCH_TABS_MAX)
    // 64 seeded + 1 new = 65; the 5 oldest fall off.
    expect(stored['w1:new']).toBeDefined()
    expect(stored['w1:old-0']).toBeUndefined()
    expect(stored['w1:old-4']).toBeUndefined()
    expect(stored['w1:old-5']).toBeDefined()
  })
})
