// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { commandBase, findPathRefs, freeTextLinker, rebase, searchLinker } from './path-links.ts'
import { PATH_LINK_ATTR, ansiToHtml } from './ansi.ts'

const refs = (text: string) => findPathRefs(text).filter((piece) => piece.ref !== undefined).map((piece) => piece.ref)

describe('finding file references in free text', () => {
  it('takes paths with a folder or a known extension, with their line and column', () => {
    expect(refs('error in src/a.ts:12:5 and README.md')).toEqual([
      { path: 'src/a.ts', line: 12, column: 5 },
      { path: 'README.md' },
    ])
    expect(refs('cat ./web/App.tsx ../x/y.json /abs/p.md')).toEqual([
      { path: './web/App.tsx' }, { path: '../x/y.json' }, { path: '/abs/p.md' },
    ])
  })
  it('leaves words, versions, hosts and URLs alone', () => {
    expect(refs('e.g. v1.2.3 github.com node.js 3.14')).toEqual([])
    expect(refs('see https://example.com/a/b.js now')).toEqual([])
  })
  it('keeps the text intact around the matches', () => {
    const text = '  ✓ tests/a.spec.ts (3 tests)'
    expect(findPathRefs(text).map((piece) => piece.text).join('')).toBe(text)
  })
})

describe('where a command\'s relative paths live', () => {
  it('follows one leading absolute cd, and gives up on anything it cannot see', () => {
    expect(commandBase('npx vitest run')).toBeUndefined()
    expect(commandBase('cd /repo/app && npx tsc')).toBe('/repo/app')
    expect(commandBase('cd "/my repo" && ls')).toBe('/my repo')
    expect(commandBase('cd web && ls')).toBeNull()
    expect(commandBase('ls && cd /x && ls')).toBeNull()
    expect(commandBase('cd $HOME && ls')).toBeNull()
  })
  it('re-roots relative refs on that base; absolute refs pass', () => {
    expect(rebase({ path: './a.ts', line: 2 }, '/repo')).toEqual({ path: '/repo/a.ts', line: 2 })
    expect(rebase({ path: 'a.ts' }, undefined)).toEqual({ path: 'a.ts' })
    expect(rebase({ path: 'a.ts' }, null)).toBeNull()
    expect(rebase({ path: '/x/a.ts' }, null)).toEqual({ path: '/x/a.ts' })
  })
})

describe('search output', () => {
  const all = (ref: { path: string }) => ref
  it('Glob links whole lines, extension or not, and skips its notes', () => {
    const link = searchLinker('glob', all)
    expect(link('Makefile')).toEqual([{ start: 0, end: 8, ref: { path: 'Makefile' } }])
    expect(link('… [+3 more matches]')).toEqual([])
    expect(link('no matches')).toEqual([])
  })
  it('Grep links the `path:line` head only', () => {
    const link = searchLinker('grep', all)
    expect(link('src/a.ts:42: const x = "b.ts"')).toEqual([{ start: 0, end: 11, ref: { path: 'src/a.ts', line: 42 } }])
    expect(link('garbage')).toEqual([])
  })
})

describe('rendering links into tool output', () => {
  it('wraps accepted refs in a button carrying path and line, keeps colours, escapes everything else', () => {
    const html = ansiToHtml('\u001b[31mFAIL\u001b[0m src/a.ts:3 <b>', freeTextLinker((ref) => ref))
    expect(html).toContain(`<button type="button" class="path-link" ${PATH_LINK_ATTR}="src/a.ts" data-line="3"`)
    expect(html).toContain('<span style="color:#f14c4c">FAIL</span>')
    expect(html).toContain('&lt;b&gt;')
    expect(html).not.toContain('<b>')
  })
  it('a link may span colour changes; the button wraps whole spans', () => {
    const html = ansiToHtml('\u001b[2msrc/\u001b[0ma.ts', freeTextLinker((ref) => ref))
    const div = document.createElement('div')
    div.innerHTML = html
    const button = div.querySelector('button')!
    expect(button.textContent).toBe('src/a.ts')
    expect(button.querySelectorAll('span')).toHaveLength(2)
  })
  it('a refused ref stays text, and a quote in a path cannot break out of the attribute', () => {
    expect(ansiToHtml('src/a.ts', freeTextLinker(() => null))).not.toContain('<button')
    const html = ansiToHtml('x', () => [{ start: 0, end: 1, ref: { path: 'a"onmouseover="x.ts' } }])
    expect(html).toContain('&quot;onmouseover=&quot;')
  })
})
