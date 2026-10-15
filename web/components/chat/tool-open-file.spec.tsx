// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ToolCard } from './MessageParts.tsx'
import type { ViewItem } from '../../lib/project.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLDivElement
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = undefined
})

async function render(node: React.ReactNode): Promise<void> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(node))
}

const tool = (name: string, args: Record<string, unknown>, result?: { ok: boolean; output: string }): Extract<ViewItem, { kind: 'tool' }> => ({
  kind: 'tool',
  call: { id: `c-${name}`, name, args },
  ...(result !== undefined ? { result } : {}),
} as unknown as Extract<ViewItem, { kind: 'tool' }>)

/** The file name on the row, when it is a button. */
const chip = (): HTMLButtonElement | undefined =>
  Array.from(host.querySelectorAll('button')).find((button) => button.getAttribute('aria-label')?.includes('in workbench'))
const expander = (): HTMLButtonElement => host.querySelector<HTMLButtonElement>('button[aria-expanded]')!

it('ApplyPatch renders each landed file diff, including partial failure receipts', async () => {
  const output = JSON.stringify({ tool: 'ApplyPatch', error: 'disk full', files: [
    { path: 'a.ts', type: 'update', edits: [{ old: 'oldA\n', new: 'newA\n', oldLine: 12, newLine: 12 }] },
    { path: 'b.ts', type: 'delete', edits: [{ old: 'oldB\n', new: '', oldLine: 1, newLine: 1 }] },
  ] })
  await render(<ToolCard item={tool('ApplyPatch', { patch_text: '*** Begin Patch\n*** Delete File: b.ts\n*** End Patch' }, { ok: false, output: `error: Error: ${output}` })} />)
  await act(async () => expander().click())
  expect(host.textContent).toContain('newA')
  expect(host.textContent).toContain('oldB')
  expect(host.textContent).toContain('deleted file')
  expect(host.textContent).toContain('disk full')
  expect(host.querySelectorAll('[data-kind="del"]')).toHaveLength(2)
})

it('a Read row: the file name opens the file at the window it read', async () => {
  const open = vi.fn()
  const openPath = vi.fn(() => open)
  await render(<ToolCard item={tool('Read', { path: 'src/a.ts', offset: 10, limit: 5 }, { ok: true, output: 'x' })} openPath={openPath} />)
  await act(async () => chip()!.click())
  expect(open).toHaveBeenCalledOnce()
  expect(openPath).toHaveBeenCalledWith('src/a.ts', { line: 10, lines: 5 })
})

it('a Read row on an image expands to the vision description; a text Read stays a plain row', async () => {
  const output = '[image shots/a.png (image/png), described by the vision model]\nA dark UI with a **sidebar**.'
  await render(<ToolCard item={tool('Read', { path: 'shots/a.png' }, { ok: true, output })} openPath={() => () => undefined} />)
  expect(host.textContent).not.toContain('sidebar')
  await act(async () => expander().click())
  expect(expander().getAttribute('aria-expanded')).toBe('true')
  expect(host.textContent).toContain('A dark UI with a')
  expect(host.textContent).toContain('image/png')
  await act(async () => root!.unmount())
  host.remove()
  root = undefined
  await render(<ToolCard item={tool('Read', { path: 'src/a.ts' }, { ok: true, output: '1\tconst a = 1' })} openPath={() => () => undefined} />)
  expect(host.querySelector('button[aria-expanded]')).toBeNull()
})

it.each([
  ['Write', { path: 'plans/plan.md', content: 'a\nb\n' }],
  ['Edit', { path: 'src/a.ts', old: 'x', new: 'y' }],
])('a landed %s row: the file name opens the file (its own diff is the row body), and does not toggle the row', async (name, args) => {
  const file = vi.fn()
  const openPath = vi.fn((_path: string, _focus?: unknown) => file)
  await render(<ToolCard item={tool(name, args, { ok: true, output: 'ok' })} openPath={openPath} />)
  const button = chip()!
  // Not the git diff: that mixes in every uncommitted change.
  expect(button.getAttribute('aria-label')).not.toContain('diff')
  // Never a button inside a button.
  expect(button.parentElement!.closest('button')).toBeNull()
  await act(async () => button.click())
  expect(openPath.mock.calls[0]?.[0]).toBe(args.path)
  expect(file).toHaveBeenCalledOnce()
  expect(expander().getAttribute('aria-expanded')).toBe('false')
})

it('the rest of a chip row still toggles its diff, from the line or the chevron', async () => {
  await render(<ToolCard item={tool('Edit', { path: 'src/a.ts', old: 'x', new: 'y' }, { ok: true, output: 'ok' })} openPath={() => () => undefined} />)
  const line = expander().parentElement!
  await act(async () => line.click())
  expect(expander().getAttribute('aria-expanded')).toBe('true')
  expect(host.querySelector('[aria-label^="Diff of"]')).not.toBeNull()
  await act(async () => expander().click())
  expect(expander().getAttribute('aria-expanded')).toBe('false')
})

it('a failed, running or unopenable change offers no file link', async () => {
  const any = () => () => undefined
  await render(<ToolCard item={tool('Write', { path: 'p.md', content: 'x' }, { ok: false, output: 'boom' })} openPath={any} />)
  expect(chip()).toBeUndefined()
  await act(async () => root!.render(<ToolCard item={tool('Edit', { path: 'p.md', old: 'a', new: 'b' })} openPath={any} />))
  expect(chip()).toBeUndefined()
  await act(async () => root!.render(<ToolCard item={tool('Edit', { path: '/elsewhere/p.md', old: 'a', new: 'b' }, { ok: true, output: 'ok' })} openPath={() => null} />))
  expect(chip()).toBeUndefined()
})

describe('files named inside a tool body open in the workbench', () => {
  /** A resolver that accepts project paths (relative, or under /repo) and records what it opened. */
  const resolver = () => {
    const opened: Array<{ path: string; focus?: unknown }> = []
    const openPath = (path: string, focus?: unknown) =>
      path.startsWith('/') && !path.startsWith('/repo/') ? null : () => { opened.push({ path, ...(focus !== undefined ? { focus } : {}) }) }
    return { opened, openPath }
  }
  const expand = async () => { await act(async () => host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click()) }
  const links = () => Array.from(host.querySelectorAll<HTMLButtonElement>('button[data-open-path]'))

  it('Grep: each `path:line` opens that file at that line, without toggling the row', async () => {
    const { opened, openPath } = resolver()
    await render(<ToolCard item={tool('Grep', { pattern: 'x' }, { ok: true, output: 'src/a.ts:12: const x\nMakefile:3: x:' })} openPath={openPath} />)
    await expand()
    expect(links().map((link) => link.textContent)).toEqual(['src/a.ts:12', 'Makefile:3'])
    await act(async () => links()[0]!.click())
    expect(opened).toEqual([{ path: 'src/a.ts', focus: { line: 12 } }])
    expect(host.querySelector('button[aria-expanded]')!.getAttribute('aria-expanded')).toBe('true')
  })

  it('Glob: every listed file opens; its notes do not', async () => {
    const { opened, openPath } = resolver()
    await render(<ToolCard item={tool('Glob', { pattern: '**/*' }, { ok: true, output: 'web/App.tsx\nLICENSE\n… [+2 more matches]' })} openPath={openPath} />)
    await expand()
    expect(links().map((link) => link.textContent)).toEqual(['web/App.tsx', 'LICENSE'])
    await act(async () => links()[1]!.click())
    expect(opened).toEqual([{ path: 'LICENSE' }])
  })

  it('Bash: paths in the command and its output open, re-rooted on a leading cd; outside paths stay text', async () => {
    const { opened, openPath } = resolver()
    const output = ' FAIL  tests/a.spec.ts:7:3\n see /etc/hosts\n[exit code: 1]'
    await render(<ToolCard item={tool('Bash', { command: 'cd /repo/web && npx vitest run lib/b.ts' }, { ok: true, output })} openPath={openPath} />)
    await expand()
    expect(links().map((link) => link.getAttribute('data-open-path'))).toEqual(['/repo/web/lib/b.ts', '/repo/web/tests/a.spec.ts'])
    expect(host.textContent).toContain('/etc/hosts')
    await act(async () => links()[1]!.click())
    expect(opened).toEqual([{ path: '/repo/web/tests/a.spec.ts', focus: { line: 7 } }])
  })

  it('a failed search is prose, and no resolver means no links', async () => {
    const { openPath } = resolver()
    await render(<ToolCard item={tool('Grep', { pattern: '(' }, { ok: false, output: 'bad regex in src/a.ts:1: x' })} openPath={openPath} />)
    await expand()
    expect(links()).toHaveLength(0)
    await act(async () => root!.render(<ToolCard item={tool('Glob', { pattern: '*' }, { ok: true, output: 'a.ts' })} />))
    expect(links()).toHaveLength(0)
  })
})

describe('a Skill row', () => {
  const loaded = { ok: true, output: "skill 'using-superpowers' loaded (hash 82c5c8866ad7); its instructions are included in context" }

  it('a loaded skill: its name opens SKILL.md as a skill tab in the workbench', async () => {
    const open = vi.fn()
    const openPath = vi.fn(() => open)
    await render(<ToolCard item={tool('Skill', { name: 'using-superpowers' }, loaded)} openPath={openPath} />)
    await act(async () => chip()!.click())
    expect(openPath).toHaveBeenCalledWith('skill://using-superpowers')
    expect(open).toHaveBeenCalledOnce()
  })

  it('stays a plain row when the skill did not load or nothing can open it', async () => {
    const openPath = vi.fn(() => vi.fn())
    await render(<ToolCard item={tool('Skill', { name: 'nope' }, { ok: true, output: "skill 'nope' not found; use Skill action:\"catalog\"" })} openPath={openPath} />)
    expect(chip()).toBeUndefined()
    await act(async () => root!.render(<ToolCard item={tool('Skill', { name: 'using-superpowers' }, loaded)} openPath={() => null} />))
    expect(chip()).toBeUndefined()
    expect(host.textContent).toContain('using-superpowers')
  })
})
