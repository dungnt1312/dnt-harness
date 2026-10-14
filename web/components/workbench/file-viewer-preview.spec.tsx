// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { FileViewer } from './FileViewer.tsx'
import { editorText, polyfillLayout, settled } from './cm-test.ts'
import type { ViewMode } from '../../hooks/useWorkbenchFiles.ts'

const readProjectFile = vi.fn()
vi.mock('../../lib/api.ts', () => ({
  getSkillFile: vi.fn(),
  readMemoryFile: vi.fn(),
  readProjectFile: (...args: unknown[]) => readProjectFile(...args),
  saveProjectFile: vi.fn(),
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
beforeAll(polyfillLayout)

let root: Root | undefined
let host: HTMLDivElement
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = undefined
  readProjectFile.mockReset()
})

async function render(path: string, extra: { viewMode?: ViewMode; onViewMode?: (mode: ViewMode) => void } = {}): Promise<void> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<FileViewer workspaceId="w" projectId="p" projectPath="/repo" path={path} draft={null} onDraft={() => {}} onSaved={() => {}} {...extra} />))
  await settled(host)
}

function segment(label: string): HTMLButtonElement {
  const button = [...host.querySelectorAll<HTMLButtonElement>('[role="group"] button')].find((candidate) => candidate.textContent === label)
  if (button === undefined) throw new Error(`no segment ${label}`)
  return button
}

it('a markdown file opens rendered and can switch to Code, Split and back', async () => {
  readProjectFile.mockResolvedValue({ path: 'README.md', size: 20, binary: false, truncated: false, content: '# Title\ntext', editable: true, hash: 'h1' })
  await render('README.md')
  expect(host.querySelector('.md')).not.toBeNull()
  expect(host.querySelector('.cm-editor')).toBeNull()
  await act(async () => segment('Code').click())
  await settled(host)
  expect(editorText(host)).toBe('# Title\ntext')
  expect(host.querySelector('.md')).toBeNull()
  await act(async () => segment('Split').click())
  await settled(host)
  expect(host.querySelector('.cm-editor')).not.toBeNull()
  expect(host.querySelector('.md')).not.toBeNull()
  await act(async () => segment('Preview').click())
  expect(host.querySelector('.md')).not.toBeNull()
  expect(host.querySelector('.cm-editor')).toBeNull()
})

it('reports the chosen mode and opens in the one the owner remembered', async () => {
  const chosen: ViewMode[] = []
  readProjectFile.mockResolvedValue({ path: 'README.md', size: 20, binary: false, truncated: false, content: '# Title\ntext', editable: true, hash: 'h1' })
  await render('README.md', { viewMode: 'code', onViewMode: (mode) => chosen.push(mode) })
  expect(host.querySelector('.md')).toBeNull()
  expect(editorText(host)).toBe('# Title\ntext')
  await act(async () => segment('Split').click())
  expect(chosen).toEqual(['split'])
})

it('a csv file opens in Code, previewing only on demand, and the table is capped with a notice', async () => {
  const rows = Array.from({ length: 250 }, (_, index) => `r${index},x`).join('\n')
  readProjectFile.mockResolvedValue({ path: 'data.csv', size: rows.length, binary: false, truncated: false, content: rows, editable: true, hash: 'h1' })
  await render('data.csv')
  expect(host.querySelector('.cm-editor')).not.toBeNull()
  await act(async () => segment('Preview').click())
  expect(host.querySelectorAll('td').length).toBeGreaterThan(0)
  expect(host.textContent).toContain('Showing the first 200 of 250 rows.')
  expect(host.querySelector('td[title]')).not.toBeNull()
  await act(async () => segment('Code').click())
  await settled(host)
  expect(host.querySelector('.cm-editor')).not.toBeNull()
})

it('an html file previews in a sandboxed iframe without scripts', async () => {
  readProjectFile.mockResolvedValue({ path: 'page.html', size: 40, binary: false, truncated: false, content: '<p>hello</p><script>window.__ran=true</script>', editable: true, hash: 'h1' })
  await render('page.html')
  expect(host.querySelector('.cm-editor')).not.toBeNull()
  await act(async () => segment('Preview').click())
  const frame = host.querySelector('iframe')
  expect(frame).not.toBeNull()
  expect(frame!.getAttribute('sandbox')).toBe('')
})

it('a ts file has no view toggle at all and reads in the editor', async () => {
  readProjectFile.mockResolvedValue({ path: 'main.ts', size: 12, binary: false, truncated: false, content: 'const a = 1\n', editable: true, hash: 'h1' })
  await render('main.ts')
  expect(host.querySelector('[aria-label="View mode"]')).toBeNull()
  expect(editorText(host)).toBe('const a = 1\n')
  expect(host.querySelector('.cm-content')!.getAttribute('aria-readonly')).toBe('true')
})

it('a skill tab previews its SKILL.md and is marked read-only', async () => {
  const { getSkillFile } = await import('../../lib/api.ts')
  ;(getSkillFile as ReturnType<typeof vi.fn>).mockResolvedValue({ path: 'SKILL.md', bytes: 20, content: '# Skill\nbody' })
  await render('skill://using-superpowers')
  expect(host.querySelector('.md')).not.toBeNull()
  expect(host.textContent).toContain('Skill')
  expect(host.textContent).toContain('Read-only')
})

it('says why a file cannot be edited instead of hiding the pencil', async () => {
  readProjectFile.mockResolvedValue({ path: 'big.ts', size: 2_000_000, binary: false, truncated: true, content: 'x\n', editable: false })
  await render('big.ts')
  const badge = [...host.querySelectorAll('span')].find((node) => node.textContent === 'Read-only')
  expect(badge?.getAttribute('title')).toContain('1 MB')
  expect(host.querySelector('[aria-label="Edit file"]')).toBeNull()
  expect(host.textContent).toContain('File is larger than 1 MB; only the beginning is shown.')
})

it('states the indent, line ending, encoding and size in the status bar', async () => {
  readProjectFile.mockResolvedValue({ path: 'a.ts', size: 24, binary: false, truncated: false, content: 'if (x) {\r\n    y()\r\n}\r\n', editable: true, hash: 'h1' })
  await render('a.ts')
  const bar = host.textContent ?? ''
  expect(bar).toContain('Spaces: 4')
  expect(bar).toContain('CRLF')
  expect(bar).toContain('UTF-8')
  expect(bar).toContain('24 B')
  expect(bar).toContain('Ln 1, Col 1')
})
