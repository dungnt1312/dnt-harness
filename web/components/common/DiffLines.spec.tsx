// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DiffLines, diffRowsFromUnified } from './DiffLines.tsx'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined })

const rows = diffRowsFromUnified([
  { kind: 'hunk', text: '@@ -1,3 +1,4 @@' },
  { kind: 'context', text: 'keep' },
  { kind: 'del', text: 'old a' },
  { kind: 'del', text: 'old b' },
  { kind: 'add', text: 'new a' },
  { kind: 'add', text: 'new b' },
  { kind: 'add', text: 'new c' },
], { keepHunks: true })

async function render(layout: 'unified' | 'split'): Promise<HTMLElement> {
  const host = document.createElement('div')
  root = createRoot(host)
  await act(async () => root!.render(<DiffLines rows={rows} layout={layout} renderHunk={(index) => <b>hunk {index}</b>} />))
  return host
}

it('split pairs a removed run with the added run and pads the shorter side', async () => {
  const host = await render('split')
  const old = [...host.querySelectorAll('[data-side="old"]')].map((cell) => [cell.getAttribute('data-kind'), cell.textContent])
  const added = [...host.querySelectorAll('[data-side="new"]')].map((cell) => [cell.getAttribute('data-kind'), cell.textContent])
  expect(old).toEqual([['context', '1keep'], ['del', '2old a'], ['del', '3old b'], ['empty', ' ']])
  expect(added).toEqual([['context', '1keep'], ['add', '2new a'], ['add', '3new b'], ['add', '4new c']])
  expect(host.querySelectorAll('[data-hunk-index]')).toHaveLength(1)
})

it('unified keeps one row per line', async () => {
  const host = await render('unified')
  expect(host.querySelectorAll('[data-side]')).toHaveLength(0)
  expect(host.querySelectorAll('[data-kind="add"], [data-kind="del"]')).toHaveLength(5)
})
