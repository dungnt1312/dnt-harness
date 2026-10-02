// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DocumentTitle } from './DocumentTitle.tsx'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let host: HTMLDivElement | undefined

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = undefined
  host = undefined
  document.title = 'dnt-harness'
})

it('tracks the opened profile and its renamed title, falling back while none is selected', async () => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const render = async (name: string | undefined) => {
    await act(async () => root!.render(<DocumentTitle name={name} />))
  }

  await render(undefined)
  expect(document.title).toBe('dnt-harness')
  await render('Personal')
  expect(document.title).toBe('Personal')
  await render('Work')
  expect(document.title).toBe('Work')
  await render('Renamed Work')
  expect(document.title).toBe('Renamed Work')
  await render(undefined)
  expect(document.title).toBe('dnt-harness')
})
