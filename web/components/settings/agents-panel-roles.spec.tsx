// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listAgentDefinitions, listModelAliases } from '../../lib/api.ts'
import { AgentsPanel } from './AgentsPanel.tsx'

vi.mock('../../lib/api.ts', () => ({
  cloneAgentToWorkspace: vi.fn(),
  deleteAgentDefinition: vi.fn(),
  importAgentDefinition: vi.fn(),
  listAgentDefinitions: vi.fn(),
  listModelAliases: vi.fn(),
  readAgentFile: vi.fn(),
}))

const mocked = vi.mocked({ listAgentDefinitions, listModelAliases })

let host: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocked.listModelAliases.mockResolvedValue([])
  mocked.listAgentDefinitions.mockResolvedValue([
    { source: 'workspace', definition: { name: 'fixture-agent', description: 'Fixture agent', tools: [], disallowedTools: [] } },
  ] as never)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = null
  root = null
})

describe('AgentsPanel role list', () => {
  it('keeps the collapsible layer header outside the listbox that owns the role options', async () => {
    await act(async () => root!.render(<AgentsPanel workspaceId="ws-1" />))
    await act(async () => { await Promise.resolve() })
    const listbox = document.body.querySelector('[role="listbox"]')
    expect(listbox).not.toBeNull()
    expect([...listbox!.children].every((child) => child.getAttribute('role') === 'option')).toBe(true)
    expect(listbox!.querySelectorAll('[role="option"]')).toHaveLength(1)
    expect(listbox!.querySelector('[aria-expanded]')).toBeNull()
  })
})
