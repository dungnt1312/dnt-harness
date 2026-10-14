// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { FileViewer } from './FileViewer.tsx'

const readProjectFile = vi.fn()
vi.mock('../../lib/api.ts', () => ({
  getSkillFile: vi.fn(),
  readMemoryFile: vi.fn(),
  readProjectFile: (...args: unknown[]) => readProjectFile(...args),
  saveProjectFile: vi.fn(),
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLDivElement
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = undefined
  readProjectFile.mockReset()
})

async function render(path: string): Promise<void> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<FileViewer workspaceId="w" projectId="p" projectPath="/repo" path={path} draft={null} onDraft={() => {}} onSaved={() => {}} />))
}

function segment(label: string): HTMLButtonElement {
  const button = [...host.querySelectorAll<HTMLButtonElement>('[role="group"] button')].find((candidate) => candidate.textContent === label)
  if (button === undefined) throw new Error(`no segment ${label}`)
  return button
}

it('a markdown file opens in Preview and can switch to Code', async () => {
  readProjectFile.mockResolvedValue({ path: 'README.md', size: 20, binary: false, truncated: false, content: '# Title\ntext', editable: true, hash: 'h1' })
  await render('README.md')
  expect(host.textContent).not.toContain('1\n')
  expect(host.querySelector('.md')).not.toBeNull()
  expect(host.textContent).toContain('Title')
  await act(async () => segment('Code').click())
  expect(host.querySelector('pre code')).not.toBeNull()
  expect(host.textContent).toContain('Title')
  await act(async () => segment('Preview').click())
  expect(host.querySelector('.md')).not.toBeNull()
})

it('a csv file opens in Code, previewing only on demand, and the table is capped with a notice', async () => {
  const rows = Array.from({ length: 250 }, (_, index) => `r${index},x`).join('\n')
  readProjectFile.mockResolvedValue({ path: 'data.csv', size: rows.length, binary: false, truncated: false, content: rows, editable: true, hash: 'h1' })
  await render('data.csv')
  expect(host.querySelector('pre code')).not.toBeNull()
  await act(async () => segment('Preview').click())
  expect(host.querySelectorAll('td').length).toBeGreaterThan(0)
  expect(host.textContent).toContain('Showing the first 200 of 250 rows.')
  await act(async () => segment('Code').click())
  expect(host.querySelector('pre code')).not.toBeNull()
})

it('an html file previews in a sandboxed iframe without scripts', async () => {
  readProjectFile.mockResolvedValue({ path: 'page.html', size: 40, binary: false, truncated: false, content: '<p>hello</p><script>window.__ran=true</script>', editable: true, hash: 'h1' })
  await render('page.html')
  expect(host.querySelector('pre code')).not.toBeNull()
  await act(async () => segment('Preview').click())
  const frame = host.querySelector('iframe')
  expect(frame).not.toBeNull()
  expect(frame!.getAttribute('sandbox')).toBe('')
})

it('a ts file has no toggle at all', async () => {
  readProjectFile.mockResolvedValue({ path: 'main.ts', size: 12, binary: false, truncated: false, content: 'const a = 1\n', editable: true, hash: 'h1' })
  await render('main.ts')
  expect(host.querySelector('[role="group"]')).toBeNull()
  expect(host.querySelector('pre code')).not.toBeNull()
})

it('a skill tab previews its SKILL.md', async () => {
  const { getSkillFile } = await import('../../lib/api.ts')
  ;(getSkillFile as ReturnType<typeof vi.fn>).mockResolvedValue({ path: 'SKILL.md', bytes: 20, content: '# Skill\nbody' })
  await render('skill://using-superpowers')
  expect(host.querySelector('.md')).not.toBeNull()
  expect(host.textContent).toContain('Skill')
})
