// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ModelMenu } from './ModelMenu.tsx'
import { ThinkingMenu } from './ThinkingMenu.tsx'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

// jsdom does no layout, so it has no scrollIntoView; the model picker calls it
// to bring the active row into view on open.
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {}
}

describe('session control labels', () => {
  it('labels the model control as conversation scoped', () => {
    act(() => root.render(<ModelMenu
      menuLabel="Conversation model (next request)"
      modelLabel="OpenAI/gpt-4o"
      modelValue="openai:gpt-4o"
      options={[{ value: 'openai:gpt-4o', label: 'OpenAI / gpt-4o', provider: 'openai', model: 'gpt-4o' }]}
      providers={[{ id: 'openai', name: 'OpenAI', baseUrl: '', enabled: true, keyMasked: '', models: ['gpt-4o'] }]}
      onModel={() => {}}
      onManage={() => {}}
    />))
    expect(host.querySelector('button')?.getAttribute('aria-label')).toBe('Conversation model (next request)')
  })

  it('labels the draft thinking control as global default scoped', () => {
    act(() => root.render(<ThinkingMenu menuLabel="Default thinking level for new conversations" model="o3" value={null} onSelect={() => {}} />))
    expect(host.querySelector('button')?.getAttribute('aria-label')).toBe('Default thinking level for new conversations')
  })

  it('shows the selected model’s own level, not a saved level it cannot express', () => {
    const chip = (): string | null | undefined => host.querySelector('button')?.textContent
    // Max is documented on gpt-5.6, so the saved override is what the chip shows.
    act(() => root.render(<ThinkingMenu model="gpt-5.6" value="max" onSelect={() => {}} />))
    expect(chip()).toContain('Max')
    // glm-5.1 documents no explicit level: the saved Max cannot ride the next
    // request, so the chip must stop claiming it.
    act(() => root.render(<ThinkingMenu model="glm-5.1" value="max" onSelect={() => {}} />))
    expect(chip()).not.toContain('Max')
    expect(chip()).toContain('Off')
  })

  it('says a saved level is ignored rather than showing it as the chosen row', () => {
    act(() => root.render(<ThinkingMenu model="glm-5.1" value="max" onSelect={() => {}} />))
    act(() => (host.querySelector('button') as HTMLButtonElement).click())
    const rows = Array.from(document.querySelectorAll('[role="menuitemradio"]'))
    // Max is not a row this model offers, so it cannot be the marked one.
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Model default'),
      'Off',
    ])
    expect(rows[0]?.textContent).toContain('Saved Max is not available on this model')
    expect(rows.filter((row) => row.getAttribute('aria-checked') === 'true')).toHaveLength(1)
    expect(rows[0]?.getAttribute('aria-checked')).toBe('true')
  })

  it('marks the active model row and lands the open panel on it', () => {
    const options = [
      { value: 'cliproxy:gpt-6-luna', label: 'cliproxy / gpt-6-luna', provider: 'cliproxy', model: 'gpt-6-luna' },
      { value: 'cliproxy:gpt-6-astra', label: 'cliproxy / gpt-6-astra', provider: 'cliproxy', model: 'gpt-6-astra' },
    ]
    act(() => root.render(<ModelMenu
      menuLabel="Conversation model (next request)"
      modelLabel="cliproxy / gpt-6-astra"
      modelValue="cliproxy:gpt-6-astra"
      options={options}
      providers={[{ id: 'cliproxy', name: 'cliproxy', baseUrl: '', enabled: true, keyMasked: '', models: ['gpt-6-luna', 'gpt-6-astra'] }]}
      onModel={() => {}}
      onManage={() => {}}
    />))
    const scrolled: Element[] = []
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element): void { scrolled.push(this) }
    try {
      act(() => (host.querySelector('button') as HTMLButtonElement).click())
      const modelRow = document.querySelector('[aria-label="Models"] [role="option"][aria-selected="true"]') as HTMLButtonElement | null
      expect(modelRow?.textContent).toContain('gpt-6-astra')
      expect(modelRow?.className).toContain('bg-hover')
      expect(scrolled).toContain(modelRow)
      const providerRow = document.querySelector('[aria-label="Providers"] [role="option"][aria-selected="true"]')
      expect(scrolled).toContain(providerRow)
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })
})
