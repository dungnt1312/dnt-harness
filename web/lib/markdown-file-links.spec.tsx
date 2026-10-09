// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Markdown, MarkdownFileLinkContext } from '../Markdown.tsx'
import { parseFileHref, type OpenPathResolver } from './project-paths.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('parseFileHref', () => {
  it.each([
    ['https://example.com/a.ts'],
    ['http://localhost:3000/x'],
    ['mailto:a@b.c'],
    ['javascript:alert(1)'],
    ['#section'],
    [''],
    [undefined],
  ])('%s is not a file', (href) => {
    expect(parseFileHref(href)).toBeNull()
  })

  it.each([
    ['src/a.ts', { path: 'src/a.ts' }],
    ['./src/a.ts', { path: './src/a.ts' }],
    ['/repo/src/a.ts', { path: '/repo/src/a.ts' }],
    ['file:///repo/src/a.ts', { path: '/repo/src/a.ts' }],
    ['src/a.ts:12', { path: 'src/a.ts', focus: { line: 12 } }],
    ['src/a.ts:12:4', { path: 'src/a.ts', focus: { line: 12 } }],
    ['src/a.ts#L5', { path: 'src/a.ts', focus: { line: 5 } }],
    ['src/a.ts#L5-L9', { path: 'src/a.ts', focus: { line: 5, lines: 5 } }],
    ['Makefile:3', { path: 'Makefile', focus: { line: 3 } }],
    ['C:/repo/a.ts', { path: 'C:/repo/a.ts' }],
    ['docs/my%20file.md', { path: 'docs/my file.md' }],
  ])('%s opens as a file', (href, expected) => {
    expect(parseFileHref(href)).toEqual(expected)
  })
})

describe('Markdown links', () => {
  let root: Root | undefined
  let host: HTMLDivElement
  afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    host?.remove()
    root = undefined
  })
  const render = async (content: string, openPath: OpenPathResolver | null): Promise<void> => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root!.render(
      <MarkdownFileLinkContext.Provider value={openPath}><Markdown content={content} /></MarkdownFileLinkContext.Provider>,
    ))
  }
  const link = (): HTMLAnchorElement => host.querySelector('a')!

  it('a web link opens in a new tab', async () => {
    const openPath = vi.fn(() => () => {})
    await render('[site](https://example.com)', openPath)
    expect(link().getAttribute('target')).toBe('_blank')
    expect(openPath).not.toHaveBeenCalled()
  })

  it('a path link opens the file in the workbench instead of navigating', async () => {
    const open = vi.fn()
    const openPath = vi.fn(() => open)
    await render('[a](src/a.ts#L10)', openPath)
    expect(link().getAttribute('target')).toBeNull()
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    await act(async () => { link().dispatchEvent(click) })
    expect(click.defaultPrevented).toBe(true)
    expect(open).toHaveBeenCalledOnce()
    expect(openPath).toHaveBeenCalledWith('src/a.ts', { line: 10 })
  })

  it('a file:// link survives sanitizing and opens in the workbench', async () => {
    const open = vi.fn()
    await render('[a](file:///repo/a.ts)', () => open)
    await act(async () => link().click())
    expect(open).toHaveBeenCalledOnce()
  })

  it('a path outside the project does not navigate', async () => {
    await render('[x](/elsewhere/x.ts)', () => null)
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    await act(async () => { link().dispatchEvent(click) })
    expect(click.defaultPrevented).toBe(true)
  })

  it('without an opener, links keep the plain new-tab behavior', async () => {
    await render('[a](src/a.ts)', null)
    expect(link().getAttribute('target')).toBe('_blank')
  })
})
