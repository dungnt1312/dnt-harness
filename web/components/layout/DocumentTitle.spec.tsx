// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DocumentTitle, documentTitle } from './DocumentTitle.tsx'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let host: HTMLDivElement | undefined

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = undefined
  host = undefined
  document.title = 'DntHarness'
})

it('tracks the opened profile and its renamed title, falling back while none is selected', async () => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const render = async (name: string | undefined) => {
    await act(async () => root!.render(<DocumentTitle name={name} />))
  }

  await render(undefined)
  expect(document.title).toBe('DntHarness')
  await render('Personal')
  expect(document.title).toBe('Personal')
  await render('Work')
  expect(document.title).toBe('Work')
  await render('Renamed Work')
  expect(document.title).toBe('Renamed Work')
  await render(undefined)
  expect(document.title).toBe('DntHarness')
})

it('puts the host first on a non-loopback domain so installs on different domains stay distinguishable', () => {
  expect(documentTitle(undefined, 'harness.example.com')).toBe('harness.example.com · DntHarness')
  expect(documentTitle('Work', 'harness.example.com')).toBe('harness.example.com · Work')
  expect(documentTitle('Work', undefined)).toBe('Work')
})
