// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { FileViewer } from './FileViewer.tsx'
import { ToastHost } from '../common/Toast.tsx'

const getSkillFile = vi.fn(async () => ({ path: 'SKILL.md', bytes: 20, content: '# Using superpowers\nbody\n' }))
const readProjectFile = vi.fn()
vi.mock('../../lib/api.ts', () => ({
  getSkillFile: (...args: unknown[]) => (getSkillFile as (...a: unknown[]) => unknown)(...args),
  readProjectFile: (...args: unknown[]) => readProjectFile(...args),
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLDivElement
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = undefined
})

it('a skill tab reads SKILL.md through the skill API, not the project file API', async () => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<ToastHost><FileViewer workspaceId="w" projectId="p" projectPath="/repo" path="skill://using-superpowers" draft={null} onDraft={() => {}} onSaved={() => {}} /></ToastHost>))
  expect(getSkillFile).toHaveBeenCalledWith('w', 'using-superpowers', 'SKILL.md', 'p')
  expect(readProjectFile).not.toHaveBeenCalled()
  // The bar names where it lives; the full location is its tooltip.
  expect(host.textContent).toContain('Skill · using-superpowers')
  expect(host.querySelector('[title="Skill · using-superpowers/SKILL.md"]')).not.toBeNull()
  expect(host.textContent).toContain('Using superpowers')
})
